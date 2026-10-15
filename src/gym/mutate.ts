/**
 * Variation operators for evolution, and the niche descriptor MAP-Elites sorts strategies by.
 *
 * Operators never touch their input; they return a changed copy plus plain-words descriptions of
 * what changed ("kite: keep_range max 300 -> 340"). They aim to produce valid strategies (attributes
 * stay legal, limits respected), but the evolution loop still runs every child through the strategy
 * validator before it is played: the operators only know the language's shape, not its vocabulary.
 *
 * Niche = weapon family x preferred range x aggression, read from the strategy's build and move
 * terms, with each behaviour weighted by how long it ran in the strategy's matches:
 * - preferred range: mean distance its move terms try to hold from enemies;
 * - aggression: how much its movement closes in on enemies versus backs away.
 */

import { ATTRIBUTE_KEYS, ATTRIBUTE_MAX, ATTRIBUTE_MIN, MAX_BEHAVIOURS, SKILL_IDS, WEAPONS, WEAPON_IDS, attributePointsLeft, clamp } from '../core';
import type { AttributeKey, Behaviour, MoveTerm, Rng, Strategy, WeaponFamily } from '../core';

// ---------------------------------------------------------------------------------------------
// Move terms
// ---------------------------------------------------------------------------------------------

type TermKind = 'seek' | 'flee' | 'keep_range' | 'orbit' | 'avoid' | 'prefer';
const PLACE_KINDS: readonly TermKind[] = ['seek', 'flee', 'keep_range', 'orbit'];

function termKind(t: MoveTerm): TermKind {
  if ('seek' in t) return 'seek';
  if ('flee' in t) return 'flee';
  if ('keep_range' in t) return 'keep_range';
  if ('orbit' in t) return 'orbit';
  if ('avoid' in t) return 'avoid';
  return 'prefer';
}

/** The place (seek/flee/keep_range/orbit) or zone (avoid/prefer) a term refers to. */
function termArg(t: MoveTerm): string {
  if ('seek' in t) return t.seek;
  if ('flee' in t) return t.flee;
  if ('keep_range' in t) return t.keep_range[0];
  if ('orbit' in t) return t.orbit[0];
  if ('avoid' in t) return t.avoid;
  return t.prefer;
}

/** "keep_range [target, 200, 300]", "avoid seen_by(enemies)": how mutations name a term. */
export function termLabel(t: MoveTerm): string {
  if ('keep_range' in t) return `keep_range [${t.keep_range.join(', ')}]`;
  if ('orbit' in t) return `orbit [${t.orbit.join(', ')}]`;
  return `${termKind(t)} ${termArg(t)}`;
}

/** Every move term of these behaviours and strategies (deep copies), for the term-swap mutation. */
export function collectTerms(behaviours: readonly Behaviour[], strategies: readonly Strategy[] = []): MoveTerm[] {
  const all = [...behaviours, ...strategies.flatMap((s) => Object.values(s.behaviours))];
  return all.flatMap((b) => b.move.map((t) => structuredClone(t)));
}

// ---------------------------------------------------------------------------------------------
// Niche descriptor
// ---------------------------------------------------------------------------------------------

export type RangeBucket = 'close' | 'mid' | 'far';
export type AggressionBucket = 'cautious' | 'balanced' | 'aggressive';
export type Niche = { family: WeaponFamily; range: RangeBucket; aggression: AggressionBucket };

/** Preferred range below this (px) is "close" (melee contact and a step back). */
export const RANGE_CLOSE = 120;
/** Preferred range above this (px) is "far" (longbow and staff territory). */
export const RANGE_FAR = 300;
/** Aggression beyond +-this is "aggressive" / "cautious". */
export const AGGRESSION_SPLIT = 0.25;
/** Distance a `flee` from an enemy is read as wanting (px). */
const FLEE_DISTANCE = 600;
export const NICHE_COUNT = 2 * 3 * 3;

/** Places that are (or sit next to) an enemy: the fighter refs of the brain registry and places built on them. */
const ENEMY_PLACES = new Set(['target', 'nearest_enemy', 'last_attacker', 'weakest', 'nearest_fight']);
function isEnemyPlace(p: string): boolean {
  return ENEMY_PLACES.has(p) || /^(behind|side|last_seen)\(/.test(p);
}
/** Places a fighter goes to get away from the fight. */
const REFUGES = new Set(['shrine', 'corner', 'dark_spot']);
function isRefuge(p: string): boolean {
  return REFUGES.has(p) || p.startsWith('cover_from(');
}

type Library = Readonly<Record<string, Behaviour>>;
/** Ticks spent in each behaviour (from match reports), keyed by behaviour name. */
export type Usage = Readonly<Record<string, number>>;

/**
 * Own behaviours plus imported starter behaviours (own wins on a name clash), each with its share
 * of the fighter's time: from `usage` when it recorded any of them, else equal shares. Without the
 * shares a rarely used fallback (a heal that seeks the shrine) would count as much as the
 * behaviour the fighter spends the match in.
 */
function weightedBehaviours(s: Strategy, library: Library, usage?: Usage): [Behaviour, number][] {
  const named: [string, Behaviour][] = Object.entries(s.behaviours);
  for (const name of s.imports ?? []) {
    const lib = library[name];
    if (lib && !(name in s.behaviours)) named.push([name, lib]);
  }
  const recorded = usage ? named.reduce((t, [n]) => t + (usage[n] ?? 0), 0) : 0;
  return named.map(([n, b]) => [b, recorded > 0 ? (usage![n] ?? 0) / recorded : 1 / named.length]);
}

/** Distance (px) a term tries to hold from an enemy place. */
function termDistance(t: MoveTerm, reach: number): number {
  if ('seek' in t) return t.weight >= 0 ? 0 : FLEE_DISTANCE;
  if ('flee' in t) return t.weight >= 0 ? FLEE_DISTANCE : 0;
  if ('keep_range' in t) return (t.keep_range[1] + t.keep_range[2]) / 2;
  return reach; // orbit circles at about weapon reach
}

/**
 * Distance (px) the strategy tries to keep from enemies: per behaviour, the weight-averaged
 * distance of its terms that refer to an enemy; then averaged over behaviours by time share.
 * Weapon reach when no behaviour says.
 */
export function preferredRange(s: Strategy, library: Library = {}, usage?: Usage): number {
  const reach = WEAPONS[s.build.weapon].range;
  let sum = 0;
  let share = 0;
  for (const [b, w] of weightedBehaviours(s, library, usage)) {
    let d = 0;
    let tw = 0;
    for (const t of b.move) {
      if (!isEnemyPlace(termArg(t))) continue;
      d += Math.abs(t.weight) * termDistance(t, reach);
      tw += Math.abs(t.weight);
    }
    if (tw > 0 && w > 0) {
      sum += (w * d) / tw;
      share += w;
    }
  }
  return share > 0 ? sum / share : reach;
}

/**
 * How much one term pulls toward the fight (> 0) or away from it (< 0), scaled by its weight.
 * Seeking an enemy closes in; fleeing one, heading for a refuge (shrine, cover), preferring shadow
 * or avoiding being seen backs off. Holding a band or circling counts half: it engages at a
 * distance (inside weapon reach) or kites (outside it).
 */
function termLean(t: MoveTerm, reach: number): number {
  const w = Math.abs(t.weight);
  const sign = t.weight >= 0 ? 1 : -1;
  const arg = termArg(t);
  const kind = termKind(t);
  if (isEnemyPlace(arg)) {
    if (kind === 'seek') return sign * w;
    if (kind === 'flee') return -sign * w;
    if ('keep_range' in t) return (t.keep_range[1] + t.keep_range[2]) / 2 <= reach ? w / 2 : -w / 2;
    if (kind === 'orbit') return w / 2;
    return 0;
  }
  if (isRefuge(arg) && (kind === 'seek' || kind === 'prefer')) return -w;
  if (kind === 'prefer' && arg === 'shadow') return -w;
  if (kind === 'avoid' && (arg.startsWith('seen_by(') || arg === 'lit' || arg === 'open')) return -w;
  return 0;
}

/**
 * -1 (only backs off) .. +1 (only closes in). Per behaviour: summed lean over summed term weight;
 * then averaged over behaviours by time share.
 */
export function aggression(s: Strategy, library: Library = {}, usage?: Usage): number {
  const reach = WEAPONS[s.build.weapon].range;
  let total = 0;
  for (const [b, w] of weightedBehaviours(s, library, usage)) {
    let lean = 0;
    let tw = 0;
    for (const t of b.move) {
      lean += termLean(t, reach);
      tw += Math.abs(t.weight);
    }
    if (tw > 0) total += (w * lean) / tw;
  }
  return total;
}

/** The strategy's niche; pass `usage` (behaviour ticks from its matches) when there is a record. */
export function nicheOf(s: Strategy, library: Library = {}, usage?: Usage): Niche {
  const range = preferredRange(s, library, usage);
  const aggr = aggression(s, library, usage);
  return {
    family: WEAPONS[s.build.weapon].family,
    range: range < RANGE_CLOSE ? 'close' : range > RANGE_FAR ? 'far' : 'mid',
    aggression: aggr > AGGRESSION_SPLIT ? 'aggressive' : aggr < -AGGRESSION_SPLIT ? 'cautious' : 'balanced',
  };
}

export function nicheKey(n: Niche): string {
  return `${n.family}/${n.range}/${n.aggression}`;
}

// ---------------------------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------------------------

/**
 * Copy imported starter behaviours into the strategy's own behaviours so mutation and crossover can
 * change them. Same fighter: own behaviours already win over imports of the same name.
 */
export function materializeImports(s: Strategy, library: Library): Strategy {
  if (!s.imports?.length) return s;
  const out = structuredClone(s);
  const kept: string[] = [];
  for (const name of s.imports) {
    if (name in out.behaviours) continue;
    const lib = library[name];
    if (lib) out.behaviours[name] = structuredClone(lib);
    else kept.push(name);
  }
  if (kept.length > 0) out.imports = kept;
  else delete out.imports;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------------------------

export type Bred = { strategy: Strategy; mutations: string[] };
export type MutateOptions = { termPool?: readonly MoveTerm[] };

/** Largest move-term weight a mutation produces (the language allows any finite weight; this keeps steering sane). */
export const MAX_WEIGHT = 3;
const MIN_WEIGHT = 0.05;
/** keep_range bands stay within [0, MAX_RANGE] px and at least MIN_BAND wide. */
const MAX_RANGE = 900;
const MIN_BAND = 10;
const ATTACK_KEYWORDS = new Set(['in_range', 'never', 'if_blocked']);

const round2 = (v: number) => Math.round(v * 100) / 100;
/** Up to 2 decimals, no trailing zeros ("0.4", "12"). */
const num = (v: number) => String(round2(v));

type TermRef = { behaviour: string; index: number; term: MoveTerm };
function termRefs(s: Strategy): TermRef[] {
  return Object.entries(s.behaviours).flatMap(([behaviour, b]) => b.move.map((term, index) => ({ behaviour, index, term })));
}

function mutateWeight(s: Strategy, rng: Rng): string | null {
  const refs = termRefs(s);
  if (refs.length === 0) return null;
  const { behaviour, term } = rng.pick(refs);
  const before = term.weight;
  const sign = before < 0 ? -1 : 1;
  let after = sign * round2(clamp(Math.abs(before) * Math.exp(rng.normal(0, 0.35)), MIN_WEIGHT, MAX_WEIGHT));
  if (after === before) after = sign * round2(clamp(Math.abs(before) + (Math.abs(before) >= MAX_WEIGHT ? -0.1 : 0.1), MIN_WEIGHT, MAX_WEIGHT));
  if (after === before) return null;
  term.weight = after;
  return `${behaviour}: ${termLabel(term)} weight ${num(before)} -> ${num(after)}`;
}

type ExprSlot = { label: string; get: () => string; set: (v: string) => void };
function exprSlots(s: Strategy): ExprSlot[] {
  const slots: ExprSlot[] = [{ label: 'target', get: () => s.target, set: (v) => (s.target = v) }];
  for (const [name, b] of Object.entries(s.behaviours)) {
    slots.push({ label: `${name}: score`, get: () => b.score, set: (v) => (b.score = v) });
    if (!ATTACK_KEYWORDS.has(b.attack.trim())) slots.push({ label: `${name}: attack`, get: () => b.attack, set: (v) => (b.attack = v) });
    if (b.skill !== undefined) slots.push({ label: `${name}: skill`, get: () => b.skill!, set: (v) => (b.skill = v) });
    for (const slot of Object.keys(b.set ?? {})) {
      slots.push({ label: `${name}: set ${slot}`, get: () => b.set![slot]!, set: (v) => (b.set![slot] = v) });
    }
  }
  return slots;
}

/** Numeric literals that are not part of a name, and not compared with `==`/`!=` (those are usually 0/1 flags). */
const LITERAL = /(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g;

function nudgeNumber(v: number, rng: Rng): number {
  if (v > 0 && v < 1) {
    let n = round2(clamp(v + rng.normal(0, 0.08), 0.01, 0.99));
    if (n === v) n = round2(clamp(v + (v < 0.5 ? 0.02 : -0.02), 0.01, 0.99));
    return n;
  }
  if (Number.isInteger(v)) {
    let n = Math.max(1, Math.round(v * Math.exp(rng.normal(0, 0.2))));
    if (n === v) n = v === 1 || rng.chance(0.5) ? v + 1 : v - 1;
    return n;
  }
  const n = round2(v * Math.exp(rng.normal(0, 0.2)));
  return n === v ? round2(v + 0.1) : n;
}

function mutateThreshold(s: Strategy, rng: Rng): string | null {
  const found: { slot: ExprSlot; index: number; text: string }[] = [];
  for (const slot of exprSlots(s)) {
    const expr = slot.get();
    for (const m of expr.matchAll(LITERAL)) {
      const before = expr.slice(0, m.index).trimEnd();
      if (before.endsWith('==') || before.endsWith('!=')) continue;
      if (Number(m[0]) === 0) continue;
      found.push({ slot, index: m.index!, text: m[0] });
    }
  }
  if (found.length === 0) return null;
  const { slot, index, text } = rng.pick(found);
  const before = Number(text);
  const after = nudgeNumber(before, rng);
  const expr = slot.get();
  slot.set(expr.slice(0, index) + num(after) + expr.slice(index + text.length));
  return `${slot.label} ${text} -> ${num(after)}`;
}

function mutateRange(s: Strategy, rng: Rng): string | null {
  const refs = termRefs(s).filter((r) => 'keep_range' in r.term);
  if (refs.length === 0) return null;
  const { behaviour, term } = rng.pick(refs);
  if (!('keep_range' in term)) return null;
  const [, min, max] = term.keep_range;
  const editMin = rng.chance(0.5);
  const v = editMin ? min : max;
  let next = v === 0 ? rng.int(5, 40) : Math.round(v * Math.exp(rng.normal(0, 0.2)));
  next = editMin ? clamp(next, 0, max - MIN_BAND) : clamp(next, min + MIN_BAND, MAX_RANGE);
  if (next === v) next = editMin ? clamp(v + 10, 0, max - MIN_BAND) : clamp(v - 10, min + MIN_BAND, MAX_RANGE);
  if (next === v) return null;
  if (editMin) term.keep_range[1] = next;
  else term.keep_range[2] = next;
  return `${behaviour}: keep_range ${editMin ? 'min' : 'max'} ${v} -> ${next}`;
}

function mutateAttributes(s: Strategy, rng: Rng): string | null {
  const a = s.build.attributes;
  const left = attributePointsLeft(a);
  const below = ATTRIBUTE_KEYS.filter((k) => a[k] < ATTRIBUTE_MAX);
  if (left > 0 && below.length > 0 && rng.chance(0.5)) {
    const k = rng.pick(below);
    const n = Math.min(left, ATTRIBUTE_MAX - a[k], rng.int(1, 6));
    a[k] += n;
    return `attributes: +${n} ${k} from unspent points`;
  }
  const from = ATTRIBUTE_KEYS.filter((k) => a[k] > ATTRIBUTE_MIN);
  if (from.length === 0) return null;
  const src: AttributeKey = rng.pick(from);
  const to = ATTRIBUTE_KEYS.filter((k) => k !== src && a[k] < ATTRIBUTE_MAX);
  if (to.length === 0) return null;
  const dst: AttributeKey = rng.pick(to);
  const n = Math.min(a[src] - ATTRIBUTE_MIN, ATTRIBUTE_MAX - a[dst], rng.int(1, 6));
  if (n <= 0) return null;
  a[src] -= n;
  a[dst] += n;
  return `attributes: ${n} ${n === 1 ? 'point' : 'points'} from ${src} to ${dst}`;
}

/** Same place, another way of moving relative to it. */
function reshapeTerm(t: MoveTerm, s: Strategy, rng: Rng): MoveTerm {
  const kind = termKind(t);
  const arg = termArg(t);
  const weight = t.weight;
  if (kind === 'avoid') return { prefer: arg, weight };
  if (kind === 'prefer') return { avoid: arg, weight };
  const next = rng.pick(PLACE_KINDS.filter((k) => k !== kind));
  const reach = WEAPONS[s.build.weapon].range;
  if (next === 'seek') return { seek: arg, weight };
  if (next === 'flee') return { flee: arg, weight };
  if (next === 'orbit') return { orbit: [arg, rng.chance(0.5) ? 'cw' : 'ccw'], weight };
  return { keep_range: [arg, Math.round(reach * 0.6), Math.max(Math.round(reach * 0.6) + MIN_BAND, Math.round(reach * 0.95))], weight };
}

function swapTerm(s: Strategy, rng: Rng, opts: MutateOptions): string | null {
  const refs = termRefs(s);
  if (refs.length === 0) return null;
  const { behaviour, index, term } = rng.pick(refs);
  const before = termLabel(term);
  const pool = (opts.termPool ?? []).filter((t) => termLabel(t) !== before);
  const next = pool.length > 0 && rng.chance(0.5) ? structuredClone(rng.pick(pool)) : reshapeTerm(term, s, rng);
  if (termLabel(next) === before) return null;
  s.behaviours[behaviour]!.move[index] = next;
  return `${behaviour}: ${before} -> ${termLabel(next)}`;
}

function mutateBuild(s: Strategy, rng: Rng): string | null {
  if (rng.chance(0.7)) {
    const before = s.build.weapon;
    s.build.weapon = rng.pick(WEAPON_IDS.filter((w) => w !== before));
    return `build: weapon ${before} -> ${s.build.weapon}`;
  }
  const before = s.build.skill;
  s.build.skill = rng.pick(SKILL_IDS.filter((k) => k !== before));
  return `build: skill ${before} -> ${s.build.skill}`;
}

type Operator = { weight: number; apply: (s: Strategy, rng: Rng, opts: MutateOptions) => string | null };
const OPERATORS: readonly Operator[] = [
  { weight: 3, apply: mutateWeight },
  { weight: 3, apply: mutateThreshold },
  { weight: 2, apply: mutateRange },
  { weight: 2, apply: mutateAttributes },
  { weight: 2, apply: swapTerm },
  // A new weapon is a big jump, but it is the only way into the other weapon family's niches.
  { weight: 1, apply: mutateBuild },
];

/**
 * One mutation, operator chosen by weight. An operator that cannot apply (no keep_range term, no
 * numbers to nudge) gives way to another. `mutations` is empty only if nothing could change.
 */
export function mutate(s: Strategy, rng: Rng, opts: MutateOptions = {}): Bred {
  const child = structuredClone(s);
  const ops = [...OPERATORS];
  while (ops.length > 0) {
    let r = rng.next() * ops.reduce((t, o) => t + o.weight, 0);
    let i = 0;
    while (i < ops.length - 1 && r >= ops[i]!.weight) r -= ops[i++]!.weight;
    const desc = ops[i]!.apply(child, rng, opts);
    if (desc) return { strategy: child, mutations: [desc] };
    ops.splice(i, 1);
  }
  return { strategy: child, mutations: [] };
}

// ---------------------------------------------------------------------------------------------
// Crossover
// ---------------------------------------------------------------------------------------------

function behaviourCount(s: Strategy): number {
  return new Set([...Object.keys(s.behaviours), ...(s.imports ?? [])]).size;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Child of `a` that takes one or two whole behaviours from `b`: a behaviour with the same name is
 * replaced, a new one is added while there is room, otherwise it replaces one of `a`'s. Memory slots
 * the incoming behaviours use come along. Build, target and the rest stay `a`'s.
 */
export function crossover(a: Strategy, b: Strategy, rng: Rng, donorName = b.name): Bred {
  const child = structuredClone(a);
  const names = Object.keys(b.behaviours);
  if (names.length === 0) return { strategy: child, mutations: [] };
  const taken = rng.shuffle([...names]).slice(0, rng.chance(0.5) ? 1 : 2);
  const mutations: string[] = [];
  for (const name of taken) {
    const incoming = structuredClone(b.behaviours[name]!);
    if (name in child.behaviours) {
      mutations.push(`${name}: swapped for ${donorName}'s`);
    } else if (behaviourCount(child) < MAX_BEHAVIOURS) {
      mutations.push(`${name}: added from ${donorName}`);
    } else {
      const replaceable = Object.keys(child.behaviours).filter((n) => !taken.includes(n));
      if (replaceable.length === 0) continue;
      const out = rng.pick(replaceable);
      delete child.behaviours[out];
      mutations.push(`${out}: replaced by ${donorName}'s ${name}`);
    }
    child.behaviours[name] = incoming;
    const text = JSON.stringify(incoming);
    for (const [slot, initial] of Object.entries(b.memory ?? {})) {
      if (child.memory && slot in child.memory) continue;
      if (!new RegExp(`(?<![\\w.])${escapeRegExp(slot)}(?![\\w])`).test(text)) continue;
      child.memory = { ...(child.memory ?? {}), [slot]: initial };
    }
  }
  return { strategy: child, mutations };
}
