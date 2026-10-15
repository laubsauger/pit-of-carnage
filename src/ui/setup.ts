// Owned by: ui
// Match setup model and the pure function that turns it into a MatchConfig.
import {
  DEFAULT_FIGHTERS,
  DEFAULT_MAP_ID,
  DEFAULT_TIME_LIMIT_TICKS,
  FIGHTER_COLORS,
  MAX_FIGHTERS,
  MIN_FIGHTERS,
  Rng,
  clamp,
  strategyKey,
} from '../core';
import type { Entrant, MatchConfig, MatchFormat, MatchReport, SavedStrategy, Strategy } from '../core';
import { MAPS } from '../sim';
import { roman, strategyLabel } from './format';

/**
 * Slot choice, kept as a string so it can live in a <select> and in localStorage:
 * `random` (a house stack drawn with the match seed), `house:<name>` or `saved:<id>`.
 */
export type SlotChoice = string;
export const RANDOM_SLOT: SlotChoice = 'random';

export type MatchSetup = {
  mapId: string;
  format: MatchFormat;
  /** Requested fighters; duels always use 2. */
  fighters: number;
  /** Fighters per squad in squads format. */
  squadSize: number;
  friendlyFire: boolean;
  /** One entry per slot; missing entries count as random. */
  slots: SlotChoice[];
  seed: number;
};

/** A strategy the setup screen can put in a slot. */
export type PoolEntry = { ref: SlotChoice; label: string; source: 'house' | 'saved'; strategy: Strategy };

export function houseRef(s: Strategy): SlotChoice {
  return `house:${s.name}`;
}

export function savedRef(id: string): SlotChoice {
  return `saved:${id}`;
}

/**
 * Everything that can fill a slot: house stacks in their given order, then saved strategies
 * newest version first within each name, names alphabetical. Saved versions are all listed, so a
 * slot can pin an older version for a rematch.
 */
export function buildPool(house: readonly Strategy[], saved: readonly SavedStrategy[]): PoolEntry[] {
  const mine = [...saved].sort((a, b) => a.name.localeCompare(b.name) || b.version - a.version);
  return [
    ...house.map((s) => ({ ref: houseRef(s), label: s.name, source: 'house' as const, strategy: s })),
    // The entry's version is the source of truth; stamp it on so reports key on the saved name@vN.
    ...mine.map((s) => ({ ref: savedRef(s.id), label: strategyLabel(s.name, s.version), source: 'saved' as const, strategy: { ...s.strategy, version: s.version } })),
  ];
}

/** One line per map for the setup screen. Maps without a line just show their name. */
export const MAP_BLURBS: Readonly<Record<string, string>> = {
  pit: 'Balanced. Lit centre, pillar ring, dark alcoves.',
  pillar_forest: 'Dense pillars, short sightlines. Ambush country.',
  catacombs: 'Dark rooms and torch pools. Ears matter.',
  meat_grinder: 'Narrow halls and moving saws. Melee heaven.',
};

export function defaultSetup(seed: number): MatchSetup {
  return {
    mapId: DEFAULT_MAP_ID,
    format: 'ffa',
    fighters: DEFAULT_FIGHTERS,
    squadSize: 2,
    friendlyFire: true,
    slots: Array.from({ length: MAX_FIGHTERS }, () => RANDOM_SLOT),
    seed,
  };
}

/** Effective fighter count: duels are always two, everything else 2..16. */
export function fighterCount(setup: Pick<MatchSetup, 'format' | 'fighters'>): number {
  if (setup.format === 'duel') return 2;
  return clamp(Math.round(setup.fighters), MIN_FIGHTERS, MAX_FIGHTERS);
}

/** Squad sizes that still leave at least two squads for this many fighters. */
export function squadSizeOptions(fighters: number): number[] {
  const out: number[] = [];
  for (let size = 2; size <= Math.floor(fighters / 2); size++) out.push(size);
  return out;
}

/** Squad size actually used: the requested size, shrunk until at least two squads exist. */
export function effectiveSquadSize(setup: Pick<MatchSetup, 'format' | 'fighters' | 'squadSize'>): number {
  const n = fighterCount(setup);
  return clamp(Math.round(setup.squadSize), 1, Math.max(1, Math.floor(n / 2)));
}

/** Squad of slot i. FFA and duels: everyone alone. Squads: consecutive slots fill a squad. */
export function squadOf(i: number, setup: Pick<MatchSetup, 'format' | 'fighters' | 'squadSize'>): number {
  return setup.format === 'squads' ? Math.floor(i / effectiveSquadSize(setup)) : i;
}

/**
 * Fighter names are strategy names; mirror matches add roman numerals ("Apologetic Gary II") so
 * the feed and reports never mention two different fighters by the same name.
 */
export function dedupeNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} ${roman(n)}`;
  });
}

/**
 * Strategies for each slot. Random slots draw house stacks without replacement (a shuffled bag
 * refilled when empty) using the match seed, so a default 8-fighter match shows eight different
 * house stacks when there are enough, and the same seed always draws the same line-up.
 */
export function resolveSlots(setup: MatchSetup, pool: readonly PoolEntry[]): Strategy[] {
  if (pool.length === 0) throw new Error('No strategies available to fill the match.');
  const byRef = new Map(pool.map((p) => [p.ref, p.strategy]));
  const house = pool.filter((p) => p.source === 'house');
  const bagSource = house.length > 0 ? house : pool;
  const rng = new Rng(setup.seed).fork('slots');
  let bag: Strategy[] = [];
  const draw = (): Strategy => {
    if (bag.length === 0) bag = rng.shuffle(bagSource.map((p) => p.strategy));
    return bag.pop() as Strategy;
  };
  const n = fighterCount(setup);
  const out: Strategy[] = [];
  for (let i = 0; i < n; i++) {
    const choice = setup.slots[i] ?? RANDOM_SLOT;
    out.push((choice !== RANDOM_SLOT ? byRef.get(choice) : undefined) ?? draw());
  }
  return out;
}

/**
 * Colour per slot. FFA: every fighter its own colour. Squads: the whole squad shares one colour,
 * because "who is on whose side" is the first thing a viewer needs to read in a team fight.
 */
export function slotColor(i: number, setup: Pick<MatchSetup, 'format' | 'fighters' | 'squadSize'>): string {
  const k = setup.format === 'squads' ? squadOf(i, setup) : i;
  return FIGHTER_COLORS[k % FIGHTER_COLORS.length];
}

export function buildMatchConfig(setup: MatchSetup, pool: readonly PoolEntry[]): MatchConfig {
  const strategies = resolveSlots(setup, pool);
  const names = dedupeNames(strategies.map((s) => s.name));
  const entrants: Entrant[] = strategies.map((strategy, i) => ({
    id: `e${i}`,
    strategy,
    squad: squadOf(i, setup),
    name: names[i],
    color: slotColor(i, setup),
  }));
  return {
    seed: setup.seed >>> 0,
    mapId: setup.mapId,
    format: setup.format,
    entrants,
    friendlyFire: setup.format === 'squads' ? setup.friendlyFire : true,
    timeLimitTicks: DEFAULT_TIME_LIMIT_TICKS,
    suddenDeath: true,
  };
}

/**
 * Rebuild the config of a gym match so it can be watched. Entrant ids, order, squads, names and
 * colours come from the report roster unchanged, and the rules (time limit, sudden death, friendly
 * fire) from the report: the sim forks randomness per entrant, so any difference would replay a
 * different fight. Returns null when a roster strategy is unknown.
 */
export function configFromReport(report: MatchReport, strategies: readonly Strategy[]): MatchConfig | null {
  const byKey = new Map(strategies.map((s) => [strategyKey(s), s]));
  const entrants: Entrant[] = [];
  for (const r of report.roster) {
    const strategy = byKey.get(r.strategyKey);
    if (!strategy) return null;
    entrants.push({ id: r.entrantId, strategy, squad: r.squad, name: r.name, color: r.color });
  }
  return {
    seed: report.seed,
    mapId: report.mapId,
    format: report.format,
    entrants,
    friendlyFire: report.friendlyFire,
    timeLimitTicks: report.timeLimitTicks,
    suddenDeath: report.suddenDeath,
  };
}

/** A fresh seed for "Next match" and the dice button. UI-side randomness is fine (not in the sim). */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

/** Read a stored setup back, keeping only valid fields so an old or hand-edited value cannot break setup. */
export function sanitizeSetup(value: unknown, fallback: MatchSetup): MatchSetup {
  if (typeof value !== 'object' || value === null) return fallback;
  const v = value as Partial<MatchSetup>;
  const format: MatchFormat = v.format === 'squads' || v.format === 'duel' || v.format === 'ffa' ? v.format : fallback.format;
  const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  const slots = Array.isArray(v.slots) ? v.slots.filter((s): s is string => typeof s === 'string') : fallback.slots;
  while (slots.length < MAX_FIGHTERS) slots.push(RANDOM_SLOT);
  return {
    // A map from an older build (renamed or removed) would make every Fight fail; fall back instead.
    mapId: typeof v.mapId === 'string' && Object.hasOwn(MAPS, v.mapId) ? v.mapId : fallback.mapId,
    format,
    fighters: clamp(Math.round(num(v.fighters, fallback.fighters)), MIN_FIGHTERS, MAX_FIGHTERS),
    squadSize: clamp(Math.round(num(v.squadSize, fallback.squadSize)), 2, MAX_FIGHTERS / 2),
    friendlyFire: typeof v.friendlyFire === 'boolean' ? v.friendlyFire : fallback.friendlyFire,
    slots: slots.slice(0, MAX_FIGHTERS),
    seed: num(v.seed, fallback.seed) >>> 0,
  };
}
