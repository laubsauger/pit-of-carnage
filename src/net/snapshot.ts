// Owned by: net
/**
 * Match streaming: the host's `WorldState` packed into a compact frame (tuples instead of objects,
 * rounded numbers, static data left out), and the peer's side that checks every value and rebuilds
 * a full `WorldState` the normal renderer can draw.
 *
 * Static data is sent once per match (`StreamMatchInfo`: roster, map id, rules) or taken from the
 * peer's own copy of the map (walls, props, shrines, pedestals), never from the wire. The map's
 * fingerprint travels with the match so a peer on another game version notices instead of drawing
 * the wrong walls.
 */

import { hashString, initialSuddenDeathState, matchHardCapTicks } from '../core';
import type {
  Attributes, BleedState, FighterState, FloorItem, GameEvent, HazardState, MapDef, MatchFormat, PickupState, ProjectileState, PropState, Rect, SkillId,
  StuckAmmo, StuckIn, SuddenDeathState, WeaponId, WorldState,
} from '../core';
import { MAPS } from '../sim';
import {
  AMMO_KINDS, ANIM_PHASES, BAD, FLOOR_KINDS, HAZARD_KINDS, MATCH_ENDINGS, MATCH_FORMATS, MAX_BEHAVIOUR, SKILL_IDS, STANCES, SUDDEN_DEATH_REASONS, WEAPON_IDS,
  NO_REFS, bool, checkEvent, id, int, isObj, num, oneOf, text,
} from './check';
import type { Bad, Refs } from './check';

/** One fighter of a streamed match: everything about it that never changes during the match. */
export type RosterFighter = {
  id: string;
  entrantId: string;
  squad: number;
  name: string;
  color: string;
  weapon: WeaponId;
  skill: SkillId;
  attributes: Attributes;
  radius: number;
  /** Room member who brought this strategy, or null for a house stack. */
  owner: string | null;
};

/** Sent once when a match starts (and to anyone who joins while it runs). */
export type StreamMatchInfo = {
  /** Host's match counter; frames name the match they belong to. */
  id: number;
  mapId: string;
  /** `mapFingerprint` of the host's map. */
  mapHash: number;
  seed: number;
  format: MatchFormat;
  timeLimitTicks: number;
  suddenDeath: boolean;
  friendlyFire: boolean;
  /** Host stream time (ms) at which the sim starts stepping; before it the countdown runs. */
  fightAt: number;
  fighters: RosterFighter[];
};

/** A frame after checking: the full state to draw and the events since the previous frame. */
export type DecodedFrame = {
  matchId: number;
  tick: number;
  /** Host stream time (ms) when the state was taken. */
  ms: number;
  /** The host's game-time factor then (its slow motion; 0 in hit-stop), 0..4. */
  scale: number;
  state: WorldState;
  events: GameEvent[];
  /** Events refused by the checks (the rest of the frame is still good). */
  droppedEvents: number;
};

/** Most fighters, projectiles, floor items and spilled hazards a frame may carry. */
export const FRAME_LIMITS = { fighters: 16, projectiles: 512, floor: 512, extraHazards: 128, stuck: 256, events: 2000 } as const;
/** Longest fighter name on the wire (strategy names are at most 40 characters; mirrors add " XVI"). */
export const MAX_NAME = 48;

/** Fingerprint of a map's geometry and contents: equal on both sides when both run the same map. */
export function mapFingerprint(map: MapDef): number {
  return hashString(JSON.stringify(map));
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

// Fighter tuple layout (index -> field). Numbers are rounded; ids are roster indices (-1 = none).
const F = {
  x: 0, y: 1, vx: 2, vy: 3, facing: 4, head: 5, hp: 6, maxHp: 7, bits: 8, died: 9, phase: 10, animT: 11, animDur: 12, walk: 13,
  attackCd: 14, skillCd: 15, parryTicks: 16, parryCd: 17, stun: 18, ammo: 19, maxAmmo: 20, haste: 21, berserk: 22, slow: 23,
  flash: 24, eyePop: 25, stance: 26, kills: 27, dealt: 28, taken: 29, lastHitTick: 30, place: 31, target: 32, lastHitBy: 33,
  behaviour: 34, bleedTicks: 35, bleedDamage: 36, bleedSource: 37,
} as const;
const F_LEN = 38;

/** `bleedTicks` when the fighter has no `bleed` field at all, and when it is null (not bleeding). */
const BLEED_ABSENT = -2;
const BLEED_NONE = -1;

/** What a stuck arrow or axe sits in, by wire index. */
const STUCK_IN_KINDS: readonly StuckIn['kind'][] = ['wall', 'prop', 'fighter', 'floor'];
const STUCK_LEN = 16;

const BIT = { alive: 1, helmet: 2, shadow: 4, seen: 8, armL: 16, armR: 32, legL: 64, legR: 128 } as const;

type Tuple = (number | string)[];

/** What goes over the wire for one frame (see `encodeFrame`). */
export type WireFrame = {
  t: 'frame';
  /** Match id. */
  m: number;
  /** Tick of the state. */
  k: number;
  /** Host stream time (ms) when the state was taken. */
  ms: number;
  /** The host's game-time factor (slow motion), rounded. */
  s: number;
  f: Tuple[];
  /** Projectiles: id, owner index, weapon index, x, y, vx, vy, ttl, origin x, origin y. */
  p: Tuple[];
  /** Floor items: id, kind index, x, y, owner index. */
  i: Tuple[];
  /**
   * Stuck arrows and axes: id, kind index, owner index, x, y, angle, what it sits in (index), prop
   * id ('' unless a prop), fighter index (-1 unless a body), u, v, turn, has a pickup spot (0/1),
   * pickup x, pickup y, tick it stuck.
   */
  a: Tuple[];
  /** Props in map order: alive (0/1), hp. */
  o: number[][];
  /** Hazards: id, kind index, x, y, radius, phase, active (0/1), ttl (-1 = permanent). */
  z: Tuple[];
  /** Shrine cooldowns, in map order. */
  sh: number[];
  /** Pedestal cooldowns, in map order. */
  u: number[];
  /** Sudden death: active, reason index, startedAt, inset, bounds (4), warning (4), final (4), closedAt, escalation, everywhere. */
  d: number[];
  /** Finished (0/1), ending index (-1 while running), then placements as roster indices. */
  x: number[];
  e: GameEvent[];
};

const rect = (r: Rect) => [r2(r.x), r2(r.y), r2(r.w), r2(r.h)];

/**
 * Pack `state` (and the events since the last frame, already plain copies) for the wire. `index`
 * maps fighter ids to roster indices.
 */
export function encodeFrame(
  matchId: number,
  ms: number,
  scale: number,
  state: WorldState,
  events: GameEvent[],
  index: ReadonlyMap<string, number>,
): WireFrame {
  const ix = (fid: string | null) => (fid === null ? -1 : (index.get(fid) ?? -1));
  const sd = state.suddenDeath;
  return {
    t: 'frame',
    m: matchId,
    k: state.tick,
    ms: Math.round(ms),
    s: r3(scale),
    f: state.fighters.map((f) => {
      const bits =
        (f.alive ? BIT.alive : 0) | (f.helmet ? BIT.helmet : 0) | (f.inShadow ? BIT.shadow : 0) | (f.seen ? BIT.seen : 0) |
        (f.limbs.armL ? BIT.armL : 0) | (f.limbs.armR ? BIT.armR : 0) | (f.limbs.legL ? BIT.legL : 0) | (f.limbs.legR ? BIT.legR : 0);
      return [
        r2(f.pos.x), r2(f.pos.y), r3(f.vel.x), r3(f.vel.y), r3(f.facing), r3(f.headAngle), r1(f.hp), r1(f.maxHp), bits, f.diedAtTick ?? -1,
        ANIM_PHASES.indexOf(f.anim.phase), r2(f.anim.t), r2(f.anim.dur), r3(f.walkPhase), r2(f.attackCd), r2(f.skillCd), r2(f.parryTicks),
        r2(f.parryCd), r2(f.stunTicks), f.ammo, f.maxAmmo, r2(f.buffs.haste), r2(f.buffs.berserk), r2(f.buffs.slow), r2(f.hitFlash),
        r2(f.eyePop), STANCES.indexOf(f.stance), f.kills, r1(f.damageDealt), r1(f.damageTaken), f.lastHitTick ?? -1, f.place ?? 0,
        ix(f.targetId), ix(f.lastHitBy), f.behaviour,
        f.bleed === undefined ? BLEED_ABSENT : f.bleed === null ? BLEED_NONE : f.bleed.ticks,
        f.bleed ? r2(f.bleed.damagePerTick) : 0, f.bleed ? ix(f.bleed.sourceId) : -1,
      ];
    }),
    p: state.projectiles.map((p) => [p.id, ix(p.ownerId), WEAPON_IDS.indexOf(p.weapon), r2(p.pos.x), r2(p.pos.y), r3(p.vel.x), r3(p.vel.y), r2(p.ttl), r2(p.origin.x), r2(p.origin.y)]),
    i: state.floor.map((it) => [it.id, FLOOR_KINDS.indexOf(it.kind), r2(it.pos.x), r2(it.pos.y), ix(it.ownerId)]),
    a: state.stuck.map((s) => [
      s.id, AMMO_KINDS.indexOf(s.kind), ix(s.ownerId), r2(s.pos.x), r2(s.pos.y), r3(s.angle), STUCK_IN_KINDS.indexOf(s.in.kind),
      s.in.kind === 'prop' ? s.in.propId : '', s.in.kind === 'fighter' ? ix(s.in.fighterId) : -1,
      s.in.kind === 'fighter' ? r2(s.in.u) : 0, s.in.kind === 'fighter' ? r2(s.in.v) : 0, s.in.kind === 'fighter' ? r3(s.in.turn) : 0,
      s.pickupPos ? 1 : 0, s.pickupPos ? r2(s.pickupPos.x) : 0, s.pickupPos ? r2(s.pickupPos.y) : 0, s.tick,
    ]),
    o: state.props.map((p) => [p.alive ? 1 : 0, r1(p.hp)]),
    z: state.hazards.map((h) => [h.id, HAZARD_KINDS.indexOf(h.kind), r2(h.pos.x), r2(h.pos.y), r2(h.radius), r3(h.phase), h.active ? 1 : 0, h.ttl ?? -1]),
    sh: state.shrines.map((s) => s.cooldown),
    u: state.pickups.map((p) => p.cooldown),
    d: [
      sd.active ? 1 : 0, sd.reason ? SUDDEN_DEATH_REASONS.indexOf(sd.reason) : -1, sd.startedAtTick, r2(sd.inset), ...rect(sd.bounds), ...rect(sd.warning),
      ...rect(sd.final), sd.closedAtTick, sd.escalation, sd.everywhere ? 1 : 0,
    ],
    x: [state.finished ? 1 : 0, state.ending ? MATCH_ENDINGS.indexOf(state.ending) : -1, ...state.placements.map((fid) => ix(fid))],
    e: events,
  };
}

// ---------------------------------------------------------------------------------------------
// Peer side
// ---------------------------------------------------------------------------------------------

const COLOR = /^#[0-9a-fA-F]{6}$/;
const attr = int(0, 100);

function checkAttributes(v: unknown): Attributes | Bad {
  if (!isObj(v)) return BAD;
  const out: Attributes = { vitality: 0, power: 0, agility: 0, perception: 0, armor: 0, haste: 0 };
  for (const k of Object.keys(out) as (keyof Attributes)[]) {
    const r = attr(v[k], NO_REFS);
    if (r === BAD) return BAD;
    out[k] = r;
  }
  return out;
}

/** Why a match announcement was refused (shown to the viewer). */
export type InfoProblem = 'malformed' | 'unknown-map' | 'map-mismatch';

/**
 * Check a match announcement. Unknown maps and maps that differ from ours are told apart, so the
 * room can say "the host runs another version of the game" instead of drawing the wrong arena.
 */
export function parseMatchInfo(v: unknown): { info: StreamMatchInfo; map: MapDef } | { problem: InfoProblem } {
  const bad = { problem: 'malformed' as const };
  if (!isObj(v)) return bad;
  const r = NO_REFS;
  const matchId = int(0, 1e9)(v.id, r);
  const mapId = id(v.mapId, r);
  const mapHash = int(0, 0xffffffff)(v.mapHash, r);
  const seed = int(0, 0xffffffff)(v.seed, r);
  const format = oneOf(MATCH_FORMATS)(v.format, r);
  const timeLimitTicks = int(1, 3_600_000)(v.timeLimitTicks, r);
  const suddenDeath = bool(v.suddenDeath, r);
  const friendlyFire = bool(v.friendlyFire, r);
  const fightAt = num(0, 1e13)(v.fightAt, r);
  if ([matchId, mapId, mapHash, seed, format, timeLimitTicks, suddenDeath, friendlyFire, fightAt].includes(BAD)) return bad;
  if (!Array.isArray(v.fighters) || v.fighters.length < 1 || v.fighters.length > FRAME_LIMITS.fighters) return bad;
  const fighters: RosterFighter[] = [];
  const ids = new Set<string>();
  for (const raw of v.fighters as unknown[]) {
    if (!isObj(raw)) return bad;
    const fid = id(raw.id, r);
    const entrantId = id(raw.entrantId, r);
    const squad = int(0, 64)(raw.squad, r);
    const name = text(MAX_NAME, 1)(raw.name, r);
    const color = typeof raw.color === 'string' && COLOR.test(raw.color) ? raw.color : BAD;
    const weapon = oneOf(WEAPON_IDS)(raw.weapon, r);
    const skill = oneOf(SKILL_IDS)(raw.skill, r);
    const attributes = checkAttributes(raw.attributes);
    const radius = num(1, 200)(raw.radius, r);
    const owner = raw.owner === null ? null : text(MAX_NAME, 1)(raw.owner, r);
    if (fid === BAD || entrantId === BAD || squad === BAD || name === BAD || color === BAD || weapon === BAD || skill === BAD) return bad;
    if (attributes === BAD || radius === BAD || owner === BAD || ids.has(fid)) return bad;
    ids.add(fid);
    fighters.push({ id: fid, entrantId, squad, name, color, weapon, skill, attributes, radius, owner });
  }
  const map = Object.hasOwn(MAPS, mapId as string) ? MAPS[mapId as string] : undefined;
  if (!map) return { problem: 'unknown-map' };
  if (mapFingerprint(map) !== mapHash) return { problem: 'map-mismatch' };
  return {
    info: {
      id: matchId as number, mapId: mapId as string, mapHash: mapHash as number, seed: seed as number, format: format as MatchFormat,
      timeLimitTicks: timeLimitTicks as number, suddenDeath: suddenDeath as boolean, friendlyFire: friendlyFire as boolean,
      fightAt: fightAt as number, fighters,
    },
    map,
  };
}

/** Reads tuple fields in order and remembers whether any was bad. */
class Reader {
  bad = false;
  constructor(private readonly t: unknown[]) {}

  n(i: number, min: number, max: number): number {
    const v = this.t[i];
    if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max) return v;
    this.bad = true;
    return 0;
  }

  /** An integer in range; 0 (and bad) otherwise, so a bad index never reaches an array lookup. */
  int(i: number, min: number, max: number): number {
    const v = this.n(i, min, max);
    if (Number.isInteger(v)) return v;
    this.bad = true;
    return 0;
  }

  str(i: number, check: (v: unknown, r: Refs) => string | Bad): string {
    const v = check(this.t[i], NO_REFS);
    if (v === BAD) {
      this.bad = true;
      return '';
    }
    return v;
  }
}

function tuple(v: unknown, len: number): Reader | null {
  return Array.isArray(v) && v.length === len ? new Reader(v) : null;
}

const BIG = 1e7;

/**
 * Check a frame against its match and rebuild the full state, or null when anything about the
 * state is wrong. Events are checked one by one; a bad event is dropped (and counted), not the frame.
 */
export function decodeFrame(v: unknown, info: StreamMatchInfo, map: MapDef): DecodedFrame | null {
  if (!isObj(v) || v.t !== 'frame' || v.m !== info.id) return null;
  const cap = matchHardCapTicks(info.timeLimitTicks) + 600;
  const head = new Reader([v.k, v.ms, v.s]);
  const tick = head.int(0, 0, cap);
  const ms = head.n(1, 0, 1e13);
  const scale = head.n(2, 0, 4);
  if (head.bad) return null;

  const roster = info.fighters;
  const n = roster.length;
  const who = (i: number) => (i < 0 ? null : roster[i]!.id);

  if (!Array.isArray(v.f) || v.f.length !== n) return null;
  const fighters: FighterState[] = [];
  for (let i = 0; i < n; i++) {
    const t = tuple(v.f[i], F_LEN);
    if (!t) return null;
    const ro = roster[i]!;
    const bits = t.int(F.bits, 0, 255);
    const died = t.int(F.died, -1, cap);
    const lastHitTick = t.int(F.lastHitTick, -1, cap);
    const place = t.int(F.place, 0, n);
    const bleedTicks = t.int(F.bleedTicks, BLEED_ABSENT, cap);
    const bleed: BleedState | null = bleedTicks < 0 ? null : { ticks: bleedTicks, damagePerTick: t.n(F.bleedDamage, 0, 10_000), sourceId: who(t.int(F.bleedSource, -1, n - 1)) };
    const fighter: FighterState = {
      id: ro.id, entrantId: ro.entrantId, squad: ro.squad, name: ro.name, color: ro.color, weapon: ro.weapon, skill: ro.skill,
      attributes: { ...ro.attributes }, radius: ro.radius,
      pos: { x: t.n(F.x, -BIG, BIG), y: t.n(F.y, -BIG, BIG) },
      vel: { x: t.n(F.vx, -1000, 1000), y: t.n(F.vy, -1000, 1000) },
      facing: t.n(F.facing, -100, 100),
      headAngle: t.n(F.head, -100, 100),
      hp: t.n(F.hp, -BIG, BIG),
      maxHp: t.n(F.maxHp, 0, BIG),
      alive: (bits & BIT.alive) !== 0,
      diedAtTick: died < 0 ? null : died,
      anim: { phase: ANIM_PHASES[t.int(F.phase, 0, ANIM_PHASES.length - 1)]!, t: t.n(F.animT, 0, BIG), dur: t.n(F.animDur, 0, BIG) },
      walkPhase: t.n(F.walk, -BIG, BIG),
      attackCd: t.n(F.attackCd, -BIG, BIG),
      skillCd: t.n(F.skillCd, -BIG, BIG),
      parryTicks: t.n(F.parryTicks, -BIG, BIG),
      parryCd: t.n(F.parryCd, -BIG, BIG),
      stunTicks: t.n(F.stun, -BIG, BIG),
      ammo: t.int(F.ammo, 0, 1000),
      maxAmmo: t.int(F.maxAmmo, 0, 1000),
      buffs: { haste: t.n(F.haste, 0, BIG), berserk: t.n(F.berserk, 0, BIG), slow: t.n(F.slow, 0, BIG) },
      limbs: { armL: (bits & BIT.armL) !== 0, armR: (bits & BIT.armR) !== 0, legL: (bits & BIT.legL) !== 0, legR: (bits & BIT.legR) !== 0 },
      helmet: (bits & BIT.helmet) !== 0,
      inShadow: (bits & BIT.shadow) !== 0,
      seen: (bits & BIT.seen) !== 0,
      stance: STANCES[t.int(F.stance, 0, STANCES.length - 1)]!,
      hitFlash: t.n(F.flash, 0, BIG),
      eyePop: t.n(F.eyePop, 0, BIG),
      behaviour: t.str(F.behaviour, text(MAX_BEHAVIOUR)),
      targetId: who(t.int(F.target, -1, n - 1)),
      kills: t.int(F.kills, 0, 1000),
      damageDealt: t.n(F.dealt, 0, BIG),
      damageTaken: t.n(F.taken, 0, BIG),
      lastHitBy: who(t.int(F.lastHitBy, -1, n - 1)),
      lastHitTick: lastHitTick < 0 ? null : lastHitTick,
      place: place === 0 ? null : place,
    };
    if (bleedTicks !== BLEED_ABSENT) fighter.bleed = bleed;
    fighters.push(fighter);
    if (t.bad) return null;
  }

  if (!Array.isArray(v.p) || v.p.length > FRAME_LIMITS.projectiles) return null;
  const projectiles: ProjectileState[] = [];
  for (const raw of v.p as unknown[]) {
    const t = tuple(raw, 10);
    if (!t) return null;
    const owner = t.int(1, 0, n - 1);
    projectiles.push({
      id: t.str(0, id), ownerId: roster[owner]!.id, weapon: WEAPON_IDS[t.int(2, 0, WEAPON_IDS.length - 1)]!,
      pos: { x: t.n(3, -BIG, BIG), y: t.n(4, -BIG, BIG) }, vel: { x: t.n(5, -1000, 1000), y: t.n(6, -1000, 1000) },
      ttl: t.n(7, -BIG, BIG), origin: { x: t.n(8, -BIG, BIG), y: t.n(9, -BIG, BIG) },
    });
    if (t.bad) return null;
  }

  if (!Array.isArray(v.i) || v.i.length > FRAME_LIMITS.floor) return null;
  const floor: FloorItem[] = [];
  for (const raw of v.i as unknown[]) {
    const t = tuple(raw, 5);
    if (!t) return null;
    floor.push({ id: t.str(0, id), kind: FLOOR_KINDS[t.int(1, 0, FLOOR_KINDS.length - 1)]!, pos: { x: t.n(2, -BIG, BIG), y: t.n(3, -BIG, BIG) }, ownerId: who(t.int(4, -1, n - 1)) });
    if (t.bad) return null;
  }

  if (!Array.isArray(v.a) || v.a.length > FRAME_LIMITS.stuck) return null;
  const stuck: StuckAmmo[] = [];
  for (const raw of v.a as unknown[]) {
    const t = tuple(raw, STUCK_LEN);
    if (!t) return null;
    const kind = STUCK_IN_KINDS[t.int(6, 0, STUCK_IN_KINDS.length - 1)]!;
    let where: StuckIn;
    if (kind === 'prop') where = { kind, propId: t.str(7, id) };
    else if (kind === 'fighter') where = { kind, fighterId: roster[t.int(8, 0, n - 1)]!.id, u: t.n(9, -BIG, BIG), v: t.n(10, -BIG, BIG), turn: t.n(11, -100, 100) };
    else where = { kind };
    const pickup = t.int(12, 0, 1) === 1;
    stuck.push({
      id: t.str(0, id), kind: AMMO_KINDS[t.int(1, 0, AMMO_KINDS.length - 1)]!, ownerId: who(t.int(2, -1, n - 1)),
      pos: { x: t.n(3, -BIG, BIG), y: t.n(4, -BIG, BIG) }, angle: t.n(5, -100, 100), in: where,
      pickupPos: pickup ? { x: t.n(13, -BIG, BIG), y: t.n(14, -BIG, BIG) } : null, tick: t.int(15, 0, cap),
    });
    if (t.bad) return null;
  }

  if (!Array.isArray(v.o) || v.o.length !== map.props.length) return null;
  const props: PropState[] = [];
  for (let i = 0; i < map.props.length; i++) {
    const t = tuple(v.o[i], 2);
    if (!t) return null;
    const def = map.props[i]!;
    props.push({ ...def, pos: { ...def.pos }, alive: t.int(0, 0, 1) === 1, hp: t.n(1, -BIG, BIG) });
    if (t.bad) return null;
  }

  if (!Array.isArray(v.z) || v.z.length > map.hazards.length + FRAME_LIMITS.extraHazards) return null;
  const hazards: HazardState[] = [];
  for (const raw of v.z as unknown[]) {
    const t = tuple(raw, 8);
    if (!t) return null;
    const hid = t.str(0, id);
    const ttl = t.n(7, -1, BIG);
    // Map hazards keep their patrol path and cycle from our own map data.
    const def = map.hazards.find((h) => h.id === hid);
    const h: HazardState = {
      id: hid, kind: HAZARD_KINDS[t.int(1, 0, HAZARD_KINDS.length - 1)]!, pos: { x: t.n(2, -BIG, BIG), y: t.n(3, -BIG, BIG) }, radius: t.n(4, 0, 10_000),
      phase: t.n(5, 0, 1), active: t.int(6, 0, 1) === 1, ttl: ttl < 0 ? null : ttl,
    };
    if (def?.path) h.path = def.path.map((p) => ({ ...p }));
    if (def?.period !== undefined) h.period = def.period;
    hazards.push(h);
    if (t.bad) return null;
  }

  const cooldowns = (raw: unknown, len: number): number[] | null => {
    if (!Array.isArray(raw) || raw.length !== len) return null;
    const t = new Reader(raw);
    const out = raw.map((_, i) => t.n(i, -BIG, BIG));
    return t.bad ? null : out;
  };
  const sh = cooldowns(v.sh, map.shrines.length);
  const u = cooldowns(v.u, map.pickups.length);
  if (!sh || !u) return null;
  const shrines = map.shrines.map((s, i) => ({ id: s.id, pos: { ...s.pos }, cooldown: sh[i]! }));
  const pickups: PickupState[] = map.pickups.map((p, i) => ({ id: p.id, kind: p.kind, pos: { ...p.pos }, cooldown: u[i]! }));

  const d = tuple(v.d, 19);
  if (!d) return null;
  const rectAt = (i: number): Rect => ({ x: d.n(i, -BIG, BIG), y: d.n(i + 1, -BIG, BIG), w: d.n(i + 2, 0, BIG), h: d.n(i + 3, 0, BIG) });
  const reason = d.int(1, -1, SUDDEN_DEATH_REASONS.length - 1);
  const suddenDeath: SuddenDeathState = {
    ...initialSuddenDeathState(map),
    active: d.int(0, 0, 1) === 1,
    reason: reason < 0 ? null : SUDDEN_DEATH_REASONS[reason]!,
    startedAtTick: d.int(2, -1, cap),
    inset: d.n(3, 0, BIG),
    bounds: rectAt(4),
    warning: rectAt(8),
    final: rectAt(12),
    closedAtTick: d.int(16, -1, cap),
    escalation: d.int(17, 0, 100_000),
    everywhere: d.int(18, 0, 1) === 1,
  };
  if (d.bad) return null;

  if (!Array.isArray(v.x) || v.x.length < 2 || v.x.length > 2 + n) return null;
  const x = new Reader(v.x);
  const finished = x.int(0, 0, 1) === 1;
  const endingIx = x.int(1, -1, MATCH_ENDINGS.length - 1);
  const placements: string[] = [];
  for (let i = 2; i < v.x.length; i++) placements.push(roster[x.int(i, 0, n - 1)]!.id);
  if (x.bad || new Set(placements).size !== placements.length) return null;

  if (!Array.isArray(v.e) || v.e.length > FRAME_LIMITS.events) return null;
  const refs: Refs = { fighters: new Set(roster.map((f) => f.id)) };
  const events: GameEvent[] = [];
  let droppedEvents = 0;
  for (const raw of v.e as unknown[]) {
    // Events since the previous frame: never from the future, and not from long ago.
    const e = checkEvent(raw, refs, { min: Math.max(0, tick - 600), max: tick });
    if (e === BAD) droppedEvents++;
    else events.push(e);
  }

  const state: WorldState = {
    tick, mapId: map.id, fighters, projectiles, floor, props, hazards, shrines, stuck, pickups, suddenDeath, finished,
    ending: endingIx < 0 ? null : MATCH_ENDINGS[endingIx]!, placements,
  };
  return { matchId: info.id, tick, ms, scale, state, events, droppedEvents };
}

/** Plain copy of an event for the wire (sim events may share objects with the live state). */
export function cloneEvent(e: GameEvent): GameEvent {
  return JSON.parse(JSON.stringify(e)) as GameEvent;
}
