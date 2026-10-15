/**
 * createMatch: builds the world from a MatchConfig and steps it at TICK_HZ.
 *
 * Tick order (each phase sees the results of the ones before it):
 *  1. timers (cooldowns, buffs, stun, flashes, staff recharge)
 *  2. sudden-death wall position (LOS and projectiles respect it this tick)
 *  3. light at each fighter, then perception (vision, hearing, memory)
 *  4. brains think, every THINK_EVERY_TICKS, staggered by fighter index
 *  5. steering (legs, torso, head, target velocity) from the latest decisions
 *  6. movement and collisions (every body stays inside the playable rectangle: the map, or the
 *     closing wall)
 *  7. attacks (windup -> strike -> recovery), parry rolls, melee damage, shots fired from the muzzle
 *  8. projectiles (swept, first hit), splash, shields
 *  9. skills
 * 10. kegs and amphoras broken this tick go off (chains included)
 * 11. hazards, then the closing wall (contact push, spikes, crushing) and sudden-death damage
 * 12. shrines, pickups, spent ammo
 * 13. placements for this tick's deaths, then the end check (`match_end`): one squad left
 *     (elimination), the bell at the time limit (sudden death off), or the hard cap (sudden death
 *     on: the judges place whoever is still standing, `judges_decision` then `match_end`)
 * Deaths happen inside the phase that dealt the blow (kill event, drops, barks); a fighter dead
 * in phase 7 does not act in phases 8-12.
 */

import {
  COMBAT,
  JUDGES_ORDER,
  MAX_FIGHTERS,
  MIN_FIGHTERS,
  PERCEPTION,
  PICKUP_RULES,
  PROP_RULES,
  Rng,
  THINK_EVERY_TICKS,
  WEAPONS,
  BARK_RULES,
  fighterRadius,
  hashString,
  initialSuddenDeathState,
  matchHardCapTicks,
  maxHp,
  moveSpeed,
  parryChance,
  turnPerTick,
  visionFov,
  visionRange,
  hearingRadius,
} from '../core';
import type {
  BrainFactory,
  Entrant,
  FighterState,
  GameEvent,
  JudgeCriterion,
  MapDef,
  Match,
  MatchConfig,
  MatchEnding,
  MatchResult,
  PerceptionView,
  SuddenDeathState,
  WorldQuery,
  WorldState,
} from '../core';
import { updateAttacks, updateProjectiles, updateSkills } from './combat';
import type { FighterRt, SimCtx } from './context';
import { barkLines } from './copy';
import { GORE_SPOTS, bark, say } from './damage';
import { geoFor } from './geometry';
import { MAPS } from './maps';
import { moveFighters, steer } from './movement';
import { buildView, perceive, updateLight } from './perception';
import { createQuery } from './query';
import { makeHazardRt, resolveBreaks, suddenDeathDamage, updateHazards, updatePickups, updateSuddenDeathWall } from './world';

/** Spawn barks are spread over the first second or so, one fighter after another. */
const SPAWN_BARK_START = 20;
const SPAWN_BARK_GAP = 9;

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

/**
 * Spawn slot for each entrant. Slots are sorted by angle around the centre; n fighters take every
 * (slots / n)-th slot from a random offset, so any count from 2 to 16 is spread evenly. Squads get
 * consecutive slots so teammates start together; FFA order is shuffled.
 */
function spawnSlots(map: MapDef, entrants: readonly Entrant[], rng: Rng): number[] {
  const n = entrants.length;
  const slots = map.spawns.length;
  const order = entrants.map((_, i) => i);
  rng.shuffle(order);
  // Stable squad grouping after the shuffle: squads in order of first appearance.
  const squadRank = new Map<number, number>();
  for (const i of order) if (!squadRank.has(entrants[i]!.squad)) squadRank.set(entrants[i]!.squad, squadRank.size);
  order.sort((a, b) => squadRank.get(entrants[a]!.squad)! - squadRank.get(entrants[b]!.squad)!);
  const offset = rng.int(0, slots - 1);
  const out = new Array<number>(n);
  order.forEach((entrant, k) => {
    out[entrant] = (offset + Math.floor((k * slots) / n)) % slots;
  });
  return out;
}

function makeFighter(e: Entrant, i: number, map: MapDef, slot: number): FighterState {
  const a = e.strategy.build.attributes;
  const weapon = e.strategy.build.weapon;
  const sp = map.spawns[slot]!;
  const facing = Math.atan2(map.height / 2 - sp.y, map.width / 2 - sp.x);
  const ammo = WEAPONS[weapon].ammo;
  return {
    id: `f${i}`,
    entrantId: e.id,
    squad: e.squad,
    name: e.name,
    color: e.color,
    weapon,
    skill: e.strategy.build.skill,
    attributes: { ...a },
    pos: { x: sp.x, y: sp.y },
    vel: { x: 0, y: 0 },
    facing,
    headAngle: facing,
    radius: fighterRadius(a),
    hp: maxHp(a),
    maxHp: maxHp(a),
    alive: true,
    diedAtTick: null,
    anim: { phase: 'idle', t: 0, dur: 0 },
    walkPhase: 0,
    attackCd: 0,
    skillCd: COMBAT.skillStartCooldown,
    parryTicks: 0,
    parryCd: 0,
    stunTicks: 0,
    ammo,
    maxAmmo: ammo,
    buffs: { haste: 0, berserk: 0, slow: 0 },
    limbs: { armL: true, armR: true, legL: true, legR: true },
    helmet: true,
    inShadow: false,
    seen: false,
    stance: 'normal',
    hitFlash: 0,
    eyePop: 0,
    behaviour: '',
    targetId: null,
    kills: 0,
    damageDealt: 0,
    damageTaken: 0,
    lastHitBy: null,
    lastHitTick: null,
    place: null,
  };
}

function validate(config: MatchConfig): MapDef {
  const map = MAPS[config.mapId];
  if (!map) throw new Error(`createMatch: unknown map "${config.mapId}". Maps: ${Object.keys(MAPS).join(', ')}.`);
  const n = config.entrants.length;
  if (n < MIN_FIGHTERS || n > MAX_FIGHTERS) throw new Error(`createMatch: ${n} entrants; a match takes ${MIN_FIGHTERS} to ${MAX_FIGHTERS}.`);
  if (n > map.spawns.length) throw new Error(`createMatch: map "${map.id}" has ${map.spawns.length} spawns for ${n} entrants.`);
  const ids = new Set(config.entrants.map((e) => e.id));
  if (ids.size !== n) throw new Error('createMatch: entrant ids must be unique.');
  return map;
}

export function createMatch(config: MatchConfig, brainFactory: BrainFactory): Match {
  const map = validate(config);
  const geo = geoFor(map);
  const root = new Rng(config.seed);
  const slots = spawnSlots(map, config.entrants, root.fork('spawn'));
  const n = config.entrants.length;

  const state: WorldState = {
    tick: 0,
    mapId: map.id,
    fighters: config.entrants.map((e, i) => makeFighter(e, i, map, slots[i]!)),
    projectiles: [],
    floor: [],
    props: map.props.map((p) => ({ ...p, pos: { ...p.pos }, alive: true, hp: PROP_RULES[p.kind].hp })),
    hazards: map.hazards.map((h) => ({ ...h, pos: { ...h.pos }, phase: 0, active: false, ttl: null })),
    shrines: map.shrines.map((s) => ({ id: s.id, pos: { ...s.pos }, cooldown: 0 })),
    pickups: map.pickups.map((p) => ({ id: p.id, kind: p.kind, pos: { ...p.pos }, cooldown: PICKUP_RULES[p.kind].firstSpawnTicks })),
    suddenDeath: initialSuddenDeathState(map),
    finished: false,
    ending: null,
    placements: [],
  };

  const ctx: SimCtx = {
    config,
    map,
    geo,
    state,
    rts: [],
    byId: new Map(state.fighters.map((f, i) => [f.id, i])),
    events: [],
    combatRng: root.fork('combat'),
    barkRng: root.fork('barks'),
    copyRng: root.fork('copy'),
    hazardRts: state.hazards.map((h, k) => makeHazardRt(h, k, n)),
    nextId: 0,
    gore: new Float32Array(GORE_SPOTS * 2),
    goreCount: 0,
    goreNext: 0,
    diedThisTick: [],
    unplaced: n,
    // The same object as the state's, so renderers and brains always read the live wall.
    bounds: state.suddenDeath.bounds,
    breakQueue: [],
    lastChatterTick: -BARK_RULES.cooldownTicks,
    lastFighterDamageTick: 0,
    hearingSalt: root.fork('hearing').nextU32(),
    pointBlank: new Set(),
  };
  const query = createQuery(ctx);
  config.entrants.forEach((e, i) => ctx.rts.push(makeRuntime(e, i, state.fighters[i]!, brainFactory, root, query, n, state.suddenDeath)));

  return {
    config,
    map,
    state,
    get isOver() {
      return state.finished;
    },
    step: () => step(ctx),
    lastDecision(fighterId: string) {
      const i = ctx.byId.get(fighterId);
      return i === undefined ? null : ctx.rts[i]!.decision;
    },
    knowledge(fighterId: string) {
      const i = ctx.byId.get(fighterId);
      return i === undefined ? NO_KNOWLEDGE : ctx.rts[i]!.known;
    },
    result: () => result(ctx),
  };
}

const NO_KNOWLEDGE: readonly never[] = [];

function makeRuntime(e: Entrant, i: number, f: FighterState, brainFactory: BrainFactory, root: Rng, world: WorldQuery, n: number, zone: SuddenDeathState): FighterRt {
  const a = f.attributes;
  const known: PerceptionView['known'] = [];
  const allies: PerceptionView['allies'] = [];
  return {
    f,
    idx: i,
    strategy: e.strategy,
    brain: brainFactory(e.strategy),
    rng: root.fork(`brain:${e.id}`),
    decision: null,
    view: { tick: 0, self: f, known, allies, lastAttackerId: null, suddenDeath: false, arena: zone.bounds, zone, world },
    known,
    allies,
    mem: new Array(n).fill(null),
    memTick: new Int32Array(n).fill(-1),
    heardAt: new Int32Array(n).fill(-1),
    allyMem: new Array(n).fill(null),
    baseSpeed: moveSpeed(a, f.weapon),
    turn: turnPerTick(a, f.weapon),
    vision: visionRange(a, f.weapon),
    fov: visionFov(a, f.weapon),
    hearing: hearingRadius(a),
    parryChance: parryChance(a),
    light: 0,
    moveDir: f.facing,
    lastCombatTick: -100000,
    hitByTick: -100000,
    attackTarget: -1,
    punching: false,
    holdTicks: 0,
    spawnPos: { x: f.pos.x, y: f.pos.y },
    spawnFacing: f.facing,
    barks: barkLines(e.strategy),
    lastBarkTick: -BARK_RULES.cooldownTicks,
    lowHpBarked: false,
    spawnBarkTick: SPAWN_BARK_START + i * SPAWN_BARK_GAP,
    lastKillTick: -100000,
    killStreak: 0,
    killedSquads: [],
    bloodySteps: 0,
    stepCount: 0,
    ammoRegen: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------------------------

function step(ctx: SimCtx): GameEvent[] {
  const state = ctx.state;
  if (state.finished) return [];
  ctx.events = [];
  state.tick++;

  tickTimers(ctx);
  updateSuddenDeathWall(ctx);
  updateLight(ctx);
  perceive(ctx);
  think(ctx);
  steer(ctx);
  moveFighters(ctx);
  updateAttacks(ctx);
  updateProjectiles(ctx);
  updateSkills(ctx);
  resolveBreaks(ctx);
  updateHazards(ctx);
  suddenDeathDamage(ctx);
  updatePickups(ctx);
  place(ctx);
  return ctx.events;
}

function dec(v: number): number {
  return v > 0 ? v - 1 : 0;
}

function tickTimers(ctx: SimCtx): void {
  for (const rt of ctx.rts) {
    const f = rt.f;
    if (!f.alive) continue;
    f.attackCd = dec(f.attackCd);
    f.skillCd = dec(f.skillCd);
    f.parryTicks = dec(f.parryTicks);
    f.parryCd = dec(f.parryCd);
    f.stunTicks = dec(f.stunTicks);
    f.hitFlash = dec(f.hitFlash);
    f.eyePop = dec(f.eyePop);
    f.buffs.haste = dec(f.buffs.haste);
    f.buffs.berserk = dec(f.buffs.berserk);
    f.buffs.slow = dec(f.buffs.slow);
    // Staff charges come back one at a time.
    if (rt.ammoRegen > 0 && --rt.ammoRegen === 0 && f.ammo < f.maxAmmo) {
      f.ammo++;
      if (f.ammo < f.maxAmmo) rt.ammoRegen = WEAPONS[f.weapon].ammoRegenTicks;
    }
  }
}

function think(ctx: SimCtx): void {
  const tick = ctx.state.tick;
  for (const rt of ctx.rts) {
    const f = rt.f;
    if (!f.alive) continue;
    if (tick === rt.spawnBarkTick) bark(ctx, rt, 'spawn');
    if ((tick + rt.idx) % THINK_EVERY_TICKS !== 0) continue;
    const d = rt.brain.think(buildView(ctx, rt), rt.rng);
    rt.decision = d;
    f.behaviour = d.behaviour;
    f.targetId = d.targetId;
    f.stance = d.stance;
    if (d.bark && tick - rt.lastBarkTick >= BARK_RULES.cooldownTicks) say(ctx, rt, 'taunt', d.bark, false);
    else if (!d.bark && tick - rt.lastCombatTick > PERCEPTION.fightingWindowTicks && seesEnemy(rt)) bark(ctx, rt, 'taunt');
  }
}

function seesEnemy(rt: FighterRt): boolean {
  for (const k of rt.known) if (k.seen) return true;
  return false;
}

/** Place this tick's dead (reverse order of death) and end the match when one side is left. */
function place(ctx: SimCtx): void {
  const state = ctx.state;
  const rts = ctx.rts;
  if (ctx.diedThisTick.length > 0) {
    // Same-tick deaths take places from the bottom, worst record first (fewer kills, then less
    // damage dealt), so the better fighter keeps the better place.
    const died = ctx.diedThisTick;
    died.sort((a, b) => worseRecord(rts[a]!.f, rts[b]!.f) || b - a);
    for (const i of died) rts[i]!.f.place = ctx.unplaced--;
    died.length = 0;
  }

  // Without sudden death the bell ends the match at the time limit; with it the match runs until
  // one squad is left, or the judges decide at the hard cap (which escalation should never let happen).
  const left = contested(rts);
  const timeUp = left && !ctx.config.suddenDeath && state.tick >= ctx.config.timeLimitTicks;
  const judges = left && ctx.config.suddenDeath && state.tick >= matchHardCapTicks(ctx.config.timeLimitTicks);
  if (left && !timeUp && !judges) return;

  // Survivors take the top places: by kills then HP after an elimination, by HP share at the bell,
  // by JUDGES_ORDER at the hard cap.
  const survivors = rts.filter((rt) => rt.f.alive).map((rt) => rt.f);
  const ending: MatchEnding = timeUp ? 'time' : judges ? 'judges' : 'elimination';
  survivors.sort(ending === 'time' ? byStanding : ending === 'judges' ? (a, b) => byJudges(a, b) || ctx.byId.get(a.id)! - ctx.byId.get(b.id)! : byElimination);
  survivors.forEach((f, k) => (f.place = k + 1));
  if (ending === 'judges') {
    const judged = survivors.map((f) => ({ id: f.id, hpFraction: f.hp / f.maxHp, damageDealt: f.damageDealt, kills: f.kills }));
    ctx.events.push({ type: 'judges_decision', tick: state.tick, survivors: judged });
  }
  if (ending === 'elimination') {
    // The last kill of this tick decided the match (GameEvent `kill.final`).
    for (let i = ctx.events.length - 1; i >= 0; i--) {
      const e = ctx.events[i]!;
      if (e.tick !== state.tick) break;
      if (e.type === 'kill') {
        e.final = true;
        break;
      }
    }
  }
  state.placements = [...state.fighters].sort((a, b) => a.place! - b.place!).map((f) => f.id);
  state.finished = true;
  state.ending = ending;
  ctx.events.push({ type: 'match_end', tick: state.tick, placements: [...state.placements], ending });
}

const JUDGED: Readonly<Record<JudgeCriterion, (f: FighterState) => number>> = {
  hp_fraction: (f) => f.hp / f.maxHp,
  damage_dealt: (f) => f.damageDealt,
  kills: (f) => f.kills,
};

/** Judges' order: each criterion of JUDGES_ORDER, higher first; 0 on a full tie (the caller keeps roster order). */
function byJudges(a: FighterState, b: FighterState): number {
  for (const c of JUDGES_ORDER) {
    const d = JUDGED[c](b) - JUDGED[c](a);
    if (d !== 0) return d;
  }
  return 0;
}

/** True while fighters of two or more squads are alive. */
function contested(rts: readonly FighterRt[]): boolean {
  let first: number | null = null;
  for (const rt of rts) {
    if (!rt.f.alive) continue;
    if (first === null) first = rt.f.squad;
    else if (rt.f.squad !== first) return true;
  }
  return false;
}

/** Negative when `a` has the worse record of two fighters who died on the same tick. */
function worseRecord(a: FighterState, b: FighterState): number {
  return a.kills - b.kills || a.damageDealt - b.damageDealt;
}

function byElimination(a: FighterState, b: FighterState): number {
  return b.kills - a.kills || b.hp - a.hp || (a.id < b.id ? -1 : 1);
}

function byStanding(a: FighterState, b: FighterState): number {
  return b.hp / b.maxHp - a.hp / a.maxHp || b.kills - a.kills || (a.id < b.id ? -1 : 1);
}

function result(ctx: SimCtx): MatchResult {
  const s = ctx.state;
  return {
    seed: ctx.config.seed,
    mapId: s.mapId,
    ticks: s.tick,
    placements: [...s.placements],
    // A result taken before the end (the gym's safety stop) is overwritten by its caller.
    ending: s.ending ?? 'capped',
    fighters: s.fighters.map((f, i) => ({
      id: f.id,
      entrantId: f.entrantId,
      name: f.name,
      place: f.place ?? 0,
      kills: f.kills,
      damageDealt: f.damageDealt,
      damageTaken: f.damageTaken,
      diedAtTick: f.diedAtTick,
      guardTrips: (ctx.rts[i]!.decision?.guardTrips ?? []).map((t) => ({ ...t })),
    })),
  };
}

/**
 * Short fingerprint of a world state (FNV-1a over its JSON). Equal states give equal hashes, so
 * two runs of the same config can be compared tick for tick. For tests and replay checks, not per frame.
 */
export function stateHash(state: WorldState): string {
  return hashString(JSON.stringify(state)).toString(16).padStart(8, '0');
}
