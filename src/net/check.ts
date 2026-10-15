// Owned by: net
/**
 * Validation for everything that arrives from another browser. Peer data is never trusted: every
 * value is checked for type, range and length, and a fresh object is built from the known fields
 * only (unknown keys are dropped, so nothing smuggled in reaches the renderer or the pool).
 *
 * A check returns the clean value or `BAD`. Event checks are a table typed against `GameEvent`, so
 * a new event kind or field in `src/core` fails to compile here until the network learns it.
 */

import { HAZARD_RULES, PICKUP_RULES, PROP_RULES, SKILLS, WEAPONS } from '../core';
import type {
  AmmoKind, AnimPhase, BarkKind, DamageSource, GameEvent, GameEventType, HazardKind, JudgedFighter, KillCause, KillFlag, Limb, MatchEnding,
  MatchFormat, PickupKind, PropKind, SkillId, Stance, SuddenDeathReason, Vec2, WeaponId,
} from '../core';

export const BAD: unique symbol = Symbol('bad');
export type Bad = typeof BAD;

/** What a check may look up: the fighter ids of the match the message belongs to. */
export type Refs = { readonly fighters: ReadonlySet<string> };
export const NO_REFS: Refs = { fighters: new Set() };

export type Check<T> = (v: unknown, refs: Refs) => T | Bad;

/** Largest coordinate accepted anywhere (maps are about 2000 px across). */
export const MAX_COORD = 100_000;
/** Longest id accepted (sim ids look like `f3`, `p118`, `amph_2_spill40`). */
export const MAX_ID = 64;
/** Longest behaviour name (strategy idents are at most 24 characters). */
export const MAX_BEHAVIOUR = 64;
/** Longest bark or kill-stamp text. Strategy barks are capped at `BARK_RULES.maxLength` (48). */
export const MAX_LINE = 160;

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const bool: Check<boolean> = (v) => (typeof v === 'boolean' ? v : BAD);

export function num(min: number, max: number): Check<number> {
  return (v) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : BAD);
}

export function int(min: number, max: number): Check<number> {
  return (v) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : BAD);
}

/**
 * Control characters (C0, DEL, C1, line separators) and bidirectional overrides never belong in a
 * name or a line said in the arena: an override would flip the text around it in the UI.
 */
export const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/;

/** A string of at most `max` characters without control characters. */
export function text(max: number, min = 0): Check<string> {
  return (v) => (typeof v === 'string' && v.length >= min && v.length <= max && !CONTROL.test(v) ? v : BAD);
}

const ID = /^[A-Za-z0-9_.:-]+$/;

/** An object id from the sim (projectile, floor item, hazard, prop, shrine, pickup). */
export const id: Check<string> = (v) => (typeof v === 'string' && v.length > 0 && v.length <= MAX_ID && ID.test(v) ? v : BAD);

/** A fighter id of the current match. Unknown ids are refused: renderers look fighters up by id. */
export const fighterId: Check<string> = (v, refs) => (typeof v === 'string' && refs.fighters.has(v) ? v : BAD);

export function nullable<T>(c: Check<T>): Check<T | null> {
  return (v, refs) => (v === null ? null : c(v, refs));
}

export function oneOf<T extends string>(list: readonly T[]): Check<T> {
  return (v) => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : BAD);
}

export const coord = num(-MAX_COORD, MAX_COORD);

export const vec: Check<Vec2> = (v, refs) => {
  if (!isObj(v)) return BAD;
  const x = coord(v.x, refs);
  const y = coord(v.y, refs);
  return x === BAD || y === BAD ? BAD : { x, y };
};

/** Any angle in radians (the sim wraps, but a few turns either way are harmless). */
export const angle = num(-100, 100);

export function listOf<T>(c: Check<T>, max: number): Check<T[]> {
  return (v, refs) => {
    if (!Array.isArray(v) || v.length > max) return BAD;
    const out: T[] = [];
    for (const item of v) {
      const r = c(item, refs);
      if (r === BAD) return BAD;
      out.push(r);
    }
    return out;
  };
}

/** An object with exactly these fields checked (others are dropped). */
export function shape<T extends object>(fields: { [K in keyof T]-?: Check<T[K]> }): Check<T> {
  return (v, refs) => {
    if (!isObj(v)) return BAD;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(fields) as (keyof T & string)[]) {
      const r = fields[k](v[k], refs);
      if (r === BAD) return BAD;
      out[k] = r;
    }
    return out as T;
  };
}

// ---------------------------------------------------------------------------------------------
// Vocabularies. A `Record<Union, true>` literal must name every member exactly once, so these
// lists stay complete when core types grow (the compiler points here). Order is the wire order for
// index-encoded fields, identical on both sides of a room because the protocol version is checked.
// ---------------------------------------------------------------------------------------------

function keysOf<T extends string>(r: Readonly<Record<T, unknown>>): readonly T[] {
  return Object.keys(r) as T[];
}

export const WEAPON_IDS = keysOf<WeaponId>(WEAPONS);
export const SKILL_IDS = keysOf<SkillId>(SKILLS);
export const HAZARD_KINDS = keysOf<HazardKind>(HAZARD_RULES);
export const PROP_KINDS = keysOf<PropKind>(PROP_RULES);
export const PICKUP_KINDS = keysOf<'shrine' | PickupKind>(PICKUP_RULES).filter((k): k is PickupKind => k !== 'shrine');
export const ANIM_PHASES = keysOf<AnimPhase>({ idle: 1, windup: 1, strike: 1, recovery: 1 });
export const STANCES = keysOf<Stance>({ normal: 1, creep: 1, guard: 1 });
export const LIMBS = keysOf<Limb>({ armL: 1, armR: 1, legL: 1, legR: 1 });
export const KILL_CAUSES = keysOf<KillCause>({ weapon: 1, skill: 1, hazard: 1, keg: 1, friendly: 1, sudden_death: 1 });
export const DAMAGE_SOURCES = keysOf<DamageSource>({ weapon: 1, punch: 1, skill: 1, reflect: 1, hazard: 1, keg: 1, sudden_death: 1 });
export const KILL_FLAGS = keysOf<KillFlag>({
  backstab: 1, crit: 1, unseen: 1, ranged: 1, splash: 1, reflect: 1, multi: 1, revenge: 1, overkill: 1, crushed: 1,
});
export const BARK_KINDS = keysOf<BarkKind>({ spawn: 1, kill: 1, hit: 1, low_hp: 1, death: 1, skill: 1, taunt: 1 });
export const AMMO_KINDS = keysOf<AmmoKind>({ arrow: 1, axe: 1 });
export const FLOOR_KINDS = keysOf<'arrow' | 'axe' | 'weapon' | 'helmet'>({ arrow: 1, axe: 1, weapon: 1, helmet: 1 });
export const SUDDEN_DEATH_REASONS = keysOf<SuddenDeathReason>({ time: 1, stalemate: 1 });
export const MATCH_ENDINGS = keysOf<MatchEnding>({ elimination: 1, time: 1, judges: 1, capped: 1 });
export const MATCH_FORMATS = keysOf<MatchFormat>({ ffa: 1, squads: 1, duel: 1 });

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

type EventOf<K extends GameEventType> = Extract<GameEvent, { type: K }>;
type EventFields<K extends GameEventType> = { [F in Exclude<keyof EventOf<K>, 'type' | 'tick'>]-?: Check<EventOf<K>[F]> };

const weapon = oneOf(WEAPON_IDS);
const amount = num(0, 1_000_000);
const behaviour = text(MAX_BEHAVIOUR);

const judged = shape<JudgedFighter>({ id: fighterId, hpFraction: num(0, 1), damageDealt: amount, kills: int(0, 1000) });

/** Every event kind with a check per field. The compiler insists on all kinds and all fields. */
const EVENT_FIELDS: { [K in GameEventType]: EventFields<K> } = {
  swing: { fighterId, weapon },
  hit: {
    attackerId: nullable(fighterId), victimId: fighterId, amount, pos: vec, dir: angle, crit: bool, backstab: bool,
    weapon: nullable(weapon), knockback: num(-10_000, 10_000), source: oneOf(DAMAGE_SOURCES),
  },
  parry: { fighterId, attackerId: fighterId, pos: vec },
  projectile: { projectileId: id, ownerId: fighterId, weapon, pos: vec, dir: angle },
  projectile_end: { projectileId: id, pos: vec, hitId: nullable(fighterId) },
  dismember: { attackerId: nullable(fighterId), victimId: fighterId, limb: oneOf(LIMBS), pos: vec, vel: vec },
  kill: {
    killerId: nullable(fighterId), victimId: fighterId, cause: oneOf(KILL_CAUSES), pos: vec, dir: angle, title: text(MAX_LINE, 1),
    killerBehaviour: nullable(behaviour), victimBehaviour: behaviour, weapon: nullable(weapon), flags: listOf(oneOf(KILL_FLAGS), KILL_FLAGS.length),
    hazard: nullable(oneOf(HAZARD_KINDS)), final: bool,
  },
  explosion: { pos: vec, radius: num(0, 10_000) },
  skill: { fighterId, skill: oneOf(SKILL_IDS), pos: vec },
  bark: { fighterId, kind: oneOf(BARK_KINDS), text: text(MAX_LINE) },
  footstep: { fighterId, pos: vec, bloody: bool },
  pickup: { fighterId, kind: oneOf<PickupKind | AmmoKind>([...PICKUP_KINDS, ...AMMO_KINDS]), pos: vec },
  pickup_spawn: { pickupId: id, kind: oneOf(PICKUP_KINDS), pos: vec },
  heal: { fighterId, amount, pos: vec, shrineId: nullable(id) },
  wall_contact: { fighterId, damage: amount, pos: vec },
  hazard: { hazardId: id, victimId: nullable(fighterId), pos: vec },
  prop_break: { propId: id, kind: oneOf(PROP_KINDS), pos: vec },
  sudden_death: { reason: oneOf(SUDDEN_DEATH_REASONS) },
  escalation: { level: int(0, 10_000), damage: amount, everywhere: bool },
  judges_decision: { survivors: listOf(judged, 64) },
  match_end: { placements: listOf(fighterId, 64), ending: oneOf(MATCH_ENDINGS) },
};

/**
 * One event from the wire, rebuilt from its known fields, or BAD. `ticks` bounds the event's tick
 * (an event from far in the future or past of its frame is refused).
 */
export function checkEvent(v: unknown, refs: Refs, ticks: { min: number; max: number }): GameEvent | Bad {
  if (!isObj(v) || typeof v.type !== 'string' || !Object.hasOwn(EVENT_FIELDS, v.type)) return BAD;
  const tick = int(ticks.min, ticks.max)(v.tick, refs);
  if (tick === BAD) return BAD;
  const fields = EVENT_FIELDS[v.type as GameEventType] as Record<string, Check<unknown>>;
  const out: Record<string, unknown> = { type: v.type, tick };
  for (const k of Object.keys(fields)) {
    const r = fields[k]!(v[k], refs);
    if (r === BAD) return BAD;
    out[k] = r;
  }
  return out as GameEvent;
}
