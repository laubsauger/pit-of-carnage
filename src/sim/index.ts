// Owned by: sim
// Placeholder stub from the architect: fighters stand at their spawns until the time limit. Replace wholesale.
import { WEAPONS, fighterRadius, hashString, maxHp } from '../core';
import type { BrainFactory, Entrant, FighterState, GameEvent, MapDef, Match, MatchConfig, MatchResult, Vec2, WorldState } from '../core';

const W = 1360;
const H = 860;
const T = 24;

function ring(n: number, rx: number, ry: number, offset: number): Vec2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + offset;
    return { x: W / 2 + Math.cos(a) * rx, y: H / 2 + Math.sin(a) * ry };
  });
}

const PIT: MapDef = {
  id: 'pit', name: 'The Pit', width: W, height: H, floor: 'sand', ambient: 0.3,
  walls: [{ x: 0, y: 0, w: W, h: T }, { x: 0, y: H - T, w: W, h: T }, { x: 0, y: 0, w: T, h: H }, { x: W - T, y: 0, w: T, h: H }],
  pillars: ring(8, 230, 170, Math.PI / 8).map((p) => ({ x: p.x - 22, y: p.y - 22, w: 44, h: 44 })),
  lights: [{ id: 'centre', pos: { x: W / 2, y: H / 2 }, radius: 420, intensity: 0.8, color: '#ffd29a', flicker: 0.1, castsShadow: true }],
  hazards: [], props: [], pickups: [],
  shrines: [{ id: 'shrine', pos: { x: W / 2, y: H / 2 } }],
  spawns: ring(16, 520, 330, 0),
};

export const MAPS: Record<string, MapDef> = { pit: PIT };

function spawn(e: Entrant, i: number, map: MapDef): FighterState {
  const a = e.strategy.build.attributes;
  const pos = { ...(map.spawns[i % map.spawns.length] ?? { x: W / 2, y: H / 2 }) };
  const facing = Math.atan2(H / 2 - pos.y, W / 2 - pos.x);
  const weapon = e.strategy.build.weapon;
  return {
    id: `f${i}`, entrantId: e.id, squad: e.squad, name: e.name, color: e.color,
    weapon, skill: e.strategy.build.skill, attributes: { ...a },
    pos, vel: { x: 0, y: 0 }, facing, headAngle: facing, radius: fighterRadius(a),
    hp: maxHp(a), maxHp: maxHp(a), alive: true, diedAtTick: null,
    anim: { phase: 'idle', t: 0, dur: 0 }, walkPhase: 0,
    attackCd: 0, skillCd: 0, parryTicks: 0, parryCd: 0, stunTicks: 0,
    ammo: WEAPONS[weapon].ammo, maxAmmo: WEAPONS[weapon].ammo, buffs: { haste: 0, berserk: 0, slow: 0 },
    limbs: { armL: true, armR: true, legL: true, legR: true }, helmet: true, inShadow: false, seen: false,
    stance: 'normal', hitFlash: 0, eyePop: 0, behaviour: 'idle', targetId: null,
    kills: 0, damageDealt: 0, damageTaken: 0, lastHitBy: null, lastHitTick: null, place: null,
  };
}

export function createMatch(config: MatchConfig, brainFactory: BrainFactory): Match {
  const map = MAPS[config.mapId] ?? PIT;
  const state: WorldState = {
    tick: 0, mapId: map.id, fighters: config.entrants.map((e, i) => spawn(e, i, map)),
    projectiles: [], floor: [], props: [], hazards: [], pickups: [],
    shrines: map.shrines.map((s) => ({ ...s, cooldown: 0 })),
    suddenDeath: { active: false, inset: 0 }, finished: false, placements: [],
  };
  void brainFactory; // stub: no brains yet
  return {
    config, map, state,
    get isOver() {
      return state.finished;
    },
    step(): GameEvent[] {
      if (state.finished) return [];
      state.tick++;
      if (state.tick < config.timeLimitTicks) return [];
      state.finished = true;
      state.placements = state.fighters.map((f) => f.id);
      state.fighters.forEach((f, i) => (f.place = i + 1));
      return [{ tick: state.tick, type: 'match_end', placements: state.placements }];
    },
    lastDecision: () => null,
    result(): MatchResult {
      return {
        seed: config.seed, mapId: map.id, ticks: state.tick, placements: state.placements,
        fighters: state.fighters.map((f) => ({
          id: f.id, entrantId: f.entrantId, name: f.name, place: f.place ?? 0, kills: f.kills,
          damageDealt: f.damageDealt, damageTaken: f.damageTaken, diedAtTick: f.diedAtTick,
        })),
      };
    },
  };
}

/** Stub hash: FNV-1a of the JSON state. */
export function stateHash(state: WorldState): string {
  return hashString(JSON.stringify(state)).toString(16).padStart(8, '0');
}
