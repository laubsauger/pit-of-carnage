// Owned by: net
/**
 * The selected fighter's thinking in a streamed match: its latest decision (behaviour scores, the
 * steering ring and terms, sensors, guard trips) and what it knows about the others (fog of war),
 * so the inspector works for a room's match as it does for a local one.
 *
 * Opt-in per viewer: a peer tells the host which fighter its inspector shows (`watch`), and only
 * that peer gets that fighter's `mind`, about ten times a second. Everyone else pays nothing.
 * Like frames, a mind is checked field by field against its match before anything uses it.
 */

import { STEER_DIRS, WEAPONS } from '../core';
import type { Decision, GuardTrip, KnownFighter } from '../core';
import { BAD, GUARD_TRIP_KINDS, STANCES, WEAPON_IDS, NO_REFS, isObj, text } from './check';
import type { StreamMatchInfo } from './snapshot';

/** Most entries a mind may carry (a strategy has at most 8 behaviours, 6 move terms, about 90 sensors). */
export const MIND_LIMITS = { scores: 32, terms: 16, sensors: 192, trips: 64, known: 16 } as const;

type Tuple = (number | string)[];
type Named = [string, number];

/** A decision on the wire (short keys; numbers rounded). */
type WireDecision = {
  /** Behaviour. */
  b: string;
  /** Scores per behaviour. */
  s: Named[];
  /** Target as a roster index (-1 = none). */
  g: number;
  /** Heading, speed. */
  h: number;
  v: number;
  /** Steering ring (STEER_DIRS ratings). */
  r: number[];
  /** Terms: label, STEER_DIRS ratings. */
  te: [string, number[]][];
  /** attack 1, parry 2, useSkill 4. */
  x: number;
  /** Stance index. */
  st: number;
  se: Named[];
  /** Guard trips: path, kind index, count. */
  gt: [string, number, number][];
  /** Bark line ('' = none). */
  bk: string;
};

/** What goes over the wire for one mind (see `encodeMind`). */
export type WireMind = {
  t: 'mind';
  /** Match id. */
  m: number;
  /** Host stream time (ms) it was taken, same clock as frames. */
  ms: number;
  /** Tick. */
  k: number;
  /** The fighter as a roster index. */
  f: number;
  d: WireDecision | null;
  /**
   * Knowledge: roster index, squad, x, y, vx, vy, facing, hp, maxHp, weapon index, bits (seen 1,
   * heard 2, fighting 4, winding up 8, bleeding known 16, bleeding 32), estimate error, last seen
   * tick, last seen x, last seen y, ammo, kills.
   */
  n: Tuple[];
};

const K_LEN = 17;
const KB = { seen: 1, heard: 2, fighting: 4, windingUp: 8, bleedingKnown: 16, bleeding: 32 } as const;

export type DecodedMind = {
  matchId: number;
  ms: number;
  tick: number;
  fighterId: string;
  decision: Decision | null;
  knowledge: KnownFighter[];
};

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** Finite or 0: a NaN would turn into null in JSON and refuse the whole mind. */
const fin = (v: number) => (Number.isFinite(v) ? v : 0);

/** Pack one fighter's decision and knowledge. `index` maps fighter ids to roster indices. */
export function encodeMind(
  matchId: number,
  ms: number,
  tick: number,
  fighterId: string,
  decision: Decision | null,
  knowledge: readonly KnownFighter[],
  index: ReadonlyMap<string, number>,
): WireMind {
  const ix = (fid: string | null) => (fid === null ? -1 : (index.get(fid) ?? -1));
  const named = (r: Record<string, number>, max: number): Named[] => Object.entries(r).slice(0, max).map(([k, v]) => [k, r3(fin(v))]);
  const d: WireDecision | null = decision && {
    b: decision.behaviour,
    s: named(decision.scores, MIND_LIMITS.scores),
    g: ix(decision.targetId),
    h: r3(fin(decision.heading)),
    v: r3(fin(decision.speed)),
    r: decision.ring.map((x) => r3(fin(x))),
    te: decision.terms.slice(0, MIND_LIMITS.terms).map((t) => [t.label, t.ratings.map((x) => r3(fin(x)))]),
    x: (decision.attack ? 1 : 0) | (decision.parry ? 2 : 0) | (decision.useSkill ? 4 : 0),
    st: STANCES.indexOf(decision.stance),
    se: named(decision.sensors, MIND_LIMITS.sensors),
    gt: decision.guardTrips.slice(0, MIND_LIMITS.trips).map((g) => [g.path, GUARD_TRIP_KINDS.indexOf(g.kind), g.count]),
    bk: decision.bark ?? '',
  };
  return {
    t: 'mind',
    m: matchId,
    ms: Math.round(ms),
    k: tick,
    f: ix(fighterId),
    d,
    n: knowledge.slice(0, MIND_LIMITS.known).map((k) => {
      const bits =
        (k.seen ? KB.seen : 0) | (k.heard ? KB.heard : 0) | (k.fighting ? KB.fighting : 0) | (k.windingUp ? KB.windingUp : 0) |
        (k.bleeding !== undefined ? KB.bleedingKnown : 0) | (k.bleeding ? KB.bleeding : 0);
      return [
        ix(k.id), k.squad, r2(k.pos.x), r2(k.pos.y), r3(k.vel.x), r3(k.vel.y), r3(k.facing), r2(k.hp), r2(k.maxHp), WEAPON_IDS.indexOf(k.weapon), bits,
        r2(fin(k.estimateError)), k.lastSeenTick, r2(k.lastSeenPos.x), r2(k.lastSeenPos.y), k.ammo, k.kills,
      ];
    }),
  };
}

const BIG = 1e7;
const LABEL = 200;
const label = text(LABEL, 1);

/** A finite number in range, else BAD. */
function n(v: unknown, min: number, max: number): number | typeof BAD {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : BAD;
}

function ints(v: unknown, min: number, max: number): number | typeof BAD {
  const x = n(v, min, max);
  return x !== BAD && Number.isInteger(x) ? x : BAD;
}

/** STEER_DIRS ratings, or null. */
function ratings(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length !== STEER_DIRS) return null;
  const out: number[] = [];
  for (const x of v) {
    const r = n(x, -1e9, 1e9);
    if (r === BAD) return null;
    out.push(r);
  }
  return out;
}

/** Name -> value pairs without repeats, or null. */
function namedTable(v: unknown, max: number): Record<string, number> | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: Record<string, number> = {};
  for (const pair of v) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const k = label(pair[0], NO_REFS);
    const x = n(pair[1], -1e12, 1e12);
    if (k === BAD || x === BAD || Object.hasOwn(out, k)) return null;
    // Defined as an own data property: a name like "__proto__" stays a plain key.
    Object.defineProperty(out, k, { value: x, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function decodeDecision(v: unknown, roster: StreamMatchInfo['fighters']): Decision | null {
  if (!isObj(v)) return null;
  const behaviour = text(64)(v.b, NO_REFS);
  const scores = namedTable(v.s, MIND_LIMITS.scores);
  const sensors = namedTable(v.se, MIND_LIMITS.sensors);
  const target = ints(v.g, -1, roster.length - 1);
  const heading = n(v.h, -100, 100);
  const speed = n(v.v, -10, 10);
  const ring = ratings(v.r);
  const bits = ints(v.x, 0, 7);
  const stance = ints(v.st, 0, STANCES.length - 1);
  const bark = text(160)(v.bk, NO_REFS);
  if (behaviour === BAD || !scores || !sensors || target === BAD || heading === BAD || speed === BAD || !ring || bits === BAD || stance === BAD || bark === BAD) {
    return null;
  }
  if (!Array.isArray(v.te) || v.te.length > MIND_LIMITS.terms) return null;
  const terms: Decision['terms'] = [];
  for (const t of v.te as unknown[]) {
    if (!Array.isArray(t) || t.length !== 2) return null;
    const l = label(t[0], NO_REFS);
    const r = ratings(t[1]);
    if (l === BAD || !r) return null;
    terms.push({ label: l, ratings: r });
  }
  if (!Array.isArray(v.gt) || v.gt.length > MIND_LIMITS.trips) return null;
  const guardTrips: GuardTrip[] = [];
  for (const g of v.gt as unknown[]) {
    if (!Array.isArray(g) || g.length !== 3) return null;
    const path = label(g[0], NO_REFS);
    const kind = ints(g[1], 0, GUARD_TRIP_KINDS.length - 1);
    const count = ints(g[2], 0, 1e12);
    if (path === BAD || kind === BAD || count === BAD) return null;
    guardTrips.push({ path, kind: GUARD_TRIP_KINDS[kind]!, count });
  }
  const d: Decision = {
    behaviour, scores, targetId: target < 0 ? null : roster[target]!.id, heading, speed, ring, terms,
    attack: (bits & 1) !== 0, parry: (bits & 2) !== 0, useSkill: (bits & 4) !== 0, stance: STANCES[stance]!, sensors, guardTrips,
  };
  if (bark) d.bark = bark;
  return d;
}

function decodeKnown(v: unknown, roster: StreamMatchInfo['fighters'], cap: number): KnownFighter | null {
  if (!Array.isArray(v) || v.length !== K_LEN) return null;
  const f = ints(v[0], 0, roster.length - 1);
  const squad = ints(v[1], 0, 64);
  const nums = [n(v[2], -BIG, BIG), n(v[3], -BIG, BIG), n(v[4], -1000, 1000), n(v[5], -1000, 1000), n(v[6], -100, 100), n(v[7], -BIG, BIG), n(v[8], 0, BIG)];
  const weapon = ints(v[9], 0, WEAPON_IDS.length - 1);
  const bits = ints(v[10], 0, 63);
  const err = n(v[11], 0, BIG);
  const lastSeenTick = ints(v[12], -1, cap);
  const ls = [n(v[13], -BIG, BIG), n(v[14], -BIG, BIG)];
  const ammo = ints(v[15], 0, 1000);
  const kills = ints(v[16], 0, 1000);
  if (f === BAD || squad === BAD || weapon === BAD || bits === BAD || err === BAD || lastSeenTick === BAD || ammo === BAD || kills === BAD) return null;
  if (nums.includes(BAD) || ls.includes(BAD)) return null;
  const [x, y, vx, vy, facing, hp, maxHp] = nums as number[];
  const w = WEAPON_IDS[weapon]!;
  const k: KnownFighter = {
    id: roster[f]!.id, squad, pos: { x: x!, y: y! }, vel: { x: vx!, y: vy! }, facing: facing!, hp: hp!, maxHp: maxHp!, weapon: w, family: WEAPONS[w].family,
    seen: (bits & KB.seen) !== 0, heard: (bits & KB.heard) !== 0, estimateError: err, lastSeenTick, lastSeenPos: { x: ls[0] as number, y: ls[1] as number },
    fighting: (bits & KB.fighting) !== 0, ammo, kills, windingUp: (bits & KB.windingUp) !== 0,
  };
  if (bits & KB.bleedingKnown) k.bleeding = (bits & KB.bleeding) !== 0;
  return k;
}

/** Check a mind against its match, or null when anything about it is wrong (it is dropped whole). */
export function decodeMind(v: unknown, info: StreamMatchInfo, cap: number): DecodedMind | null {
  if (!isObj(v) || v.t !== 'mind' || v.m !== info.id) return null;
  const roster = info.fighters;
  const ms = n(v.ms, 0, 1e13);
  const tick = ints(v.k, 0, cap);
  const f = ints(v.f, 0, roster.length - 1);
  if (ms === BAD || tick === BAD || f === BAD) return null;
  const decision = v.d === null ? null : decodeDecision(v.d, roster);
  if (v.d !== null && !decision) return null;
  if (!Array.isArray(v.n) || v.n.length > Math.min(MIND_LIMITS.known, roster.length)) return null;
  const knowledge: KnownFighter[] = [];
  for (const raw of v.n as unknown[]) {
    const k = decodeKnown(raw, roster, cap);
    if (!k) return null;
    knowledge.push(k);
  }
  return { matchId: info.id, ms, tick, fighterId: roster[f]!.id, decision, knowledge };
}
