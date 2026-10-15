/**
 * Battle reports, ratings and evolution results. Built by `src/gym`, shown by `src/ui`, pasted into
 * an LLM via `reportToText()` (gym). Every number here is computed from recorded events, never
 * invented; `findings` are plain sentences generated in code from those numbers.
 */

import type { DamageSource, GuardTrip, KillCause, KillFlag, MatchEnding, MatchFormat, PickupKind, SkillId, Strategy, SuddenDeathReason, Vec2, WeaponId } from './types';

/**
 * Identity of a strategy across matches: `name@vN` (version defaults to 1).
 * Ratings, aggregates and the leaderboard key on this.
 */
export function strategyKey(s: Pick<Strategy, 'name' | 'version'>): string {
  return `${s.name}@v${s.version ?? 1}`;
}

// ---------------------------------------------------------------------------------------------
// Ratings (openskill, Plackett-Luce over FFA placements)
// ---------------------------------------------------------------------------------------------

/**
 * openskill rating. `mu` is the skill estimate, `sigma` the uncertainty, `ordinal = mu - 3 x sigma`
 * a conservative score used for sorting. New strategies start at mu 25, sigma 25/3 (ordinal 0).
 * Ratings must be updated from every rated match's placements and persisted between batches;
 * never assigned by hand.
 */
export type Rating = { mu: number; sigma: number; ordinal: number };

/**
 * Number shown to players: `round(1000 + ordinal x 40)`. A new strategy shows 1000.
 * Note the ordinal rises as sigma shrinks, so a few matches move the number even at average play.
 */
export function displayRating(r: Rating): number {
  return Math.round(1000 + r.ordinal * 40);
}

// ---------------------------------------------------------------------------------------------
// Match report
// ---------------------------------------------------------------------------------------------

export type ReportRosterEntry = {
  fighterId: string;
  entrantId: string;
  /** Fighter display name (strategy name, de-duplicated in mirror matches). */
  name: string;
  strategyName: string;
  strategyVersion: number;
  /** `strategyKey` of the strategy this fighter ran. */
  strategyKey: string;
  weapon: WeaponId;
  skill: SkillId;
  squad: number;
  color: string;
};

export type KillRecord = {
  tick: number;
  killerId: string | null;
  victimId: string;
  weapon: WeaponId | null;
  cause: KillCause;
  pos: Vec2;
  flags: KillFlag[];
  killerBehaviour: string | null;
  victimBehaviour: string;
};

export type FighterReport = {
  fighterId: string;
  place: number;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  diedAtTick: number | null;
  /** Ticks spent in each behaviour. */
  behaviourTicks: Record<string, number>;
  /** Behaviours defined by the strategy that never won a think. Usually a scoring bug. */
  neverWon: string[];
  exposure: {
    ticksAlive: number;
    /** Ticks at least one enemy could see this fighter. */
    ticksSeen: number;
    ticksInShadow: number;
  };
  damageDealtBySource: Partial<Record<DamageSource, number>>;
  damageTakenBySource: Partial<Record<DamageSource, number>>;
  /** Swings and shots started. */
  attacks: number;
  /** Attacks that damaged at least one enemy. */
  hitsLanded: number;
  skillUses: number;
  parries: number;
  /** Power-ups taken from pedestals, by kind (spent ammo off the floor does not count). */
  pickupsTaken: Partial<Record<PickupKind, number>>;
  /**
   * What the power-ups bought: kills landed while a power-up of that kind taken from a pedestal was
   * still running (`PICKUP_RULES[kind].durationTicks` from the pickup). Buffs from skills (Bloodrage,
   * Dash) do not count. "Took berserk 4 times, 3 kills while berserk."
   */
  killsWhileBuffed: Partial<Record<PickupKind, number>>;
  /** Runtime guard trips of this fighter's brain over the match (from `MatchResult`), most first. */
  guardTrips: GuardTrip[];
};

export type MatchReport = {
  seed: number;
  mapId: string;
  format: MatchFormat;
  /** Rules of the match, so a report can be replayed exactly (see MatchConfig). */
  timeLimitTicks: number;
  suddenDeath: boolean;
  friendlyFire: boolean;
  /** Match length in ticks. */
  ticks: number;
  /** How it ended. `judges` and `capped` are always also explained in `findings`. */
  ending: MatchEnding;
  /** When and why sudden death started, or null if it never did. */
  suddenDeathStart: { tick: number; reason: SuddenDeathReason } | null;
  roster: ReportRosterEntry[];
  /** Fighter ids, 1st place first. */
  placements: string[];
  kills: KillRecord[];
  fighters: FighterReport[];
  /** Plain sentences about this match, e.g. "Gary was never seen and still came 1st." */
  findings: string[];
};

// ---------------------------------------------------------------------------------------------
// Aggregate report
// ---------------------------------------------------------------------------------------------

export type WinRecord = { matches: number; wins: number; winRate: number };

/**
 * One strategy's results across a batch. Units: `placementHistogram`, `avgPlace`, `avgKills`,
 * `avgDamageDealt` and `avgSurvivalTicks` count per appearance (one seat); `matches`, `winRate`,
 * `byMap` and `byOpponent` count per match (a mirror match with two seats counts once).
 */
export type StrategyAggregate = {
  key: string;
  name: string;
  version: number;
  matches: number;
  /** Index 0 = times placed 1st, index 1 = 2nd, ... */
  placementHistogram: number[];
  avgPlace: number;
  /** Fraction of matches won (placed 1st). */
  winRate: number;
  byMap: Record<string, WinRecord>;
  /**
   * Head-to-head by opponent strategy key: `wins` counts matches where this strategy placed above
   * that opponent (in FFA, "beat" means finished ahead of it).
   */
  byOpponent: Record<string, WinRecord>;
  /** Opponent strategy key that killed this strategy most often, with the count. */
  killedMostBy: { key: string; count: number } | null;
  avgKills: number;
  avgDamageDealt: number;
  avgSurvivalTicks: number;
  deathsByCause: Partial<Record<KillCause, number>>;
  /** Power-ups taken across the batch (totals over every appearance), by kind. */
  pickupsTaken: Partial<Record<PickupKind, number>>;
  /** Kills while a pedestal power-up was running, across the batch (totals), by kind. */
  killsWhileBuffed: Partial<Record<PickupKind, number>>;
  /** Guard-trip totals across the batch, summed per path and kind, most first. */
  guardTrips: GuardTrip[];
  /** Plain sentences computed from the numbers above. */
  findings: string[];
  /** Rating after this batch (continues from the stored rating when one exists). */
  rating: Rating;
};

export type AggregateReport = {
  matches: number;
  seed: number;
  mapIds: string[];
  /** Sorted by rating ordinal, best first. */
  strategies: StrategyAggregate[];
  /** Batch-level findings, e.g. "Lurking Daggers v3 beats the house stacks 7 of 10 on the Pit." */
  findings: string[];
};

// ---------------------------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------------------------

export type LeaderboardEntry = {
  key: string;
  name: string;
  version: number;
  rating: Rating;
  matches: number;
  wins: number;
  avgPlace: number;
  lastPlayedAt: number;
};

// ---------------------------------------------------------------------------------------------
// Evolution
// ---------------------------------------------------------------------------------------------

/**
 * Evolve a strategy against a fixed field (MAP-Elites). The run keeps an archive of elites, one per
 * niche (weapon family x preferred range x aggression). Each generation breeds `population` children
 * from the whole archive (mutation and crossover), plays them with the elites and the champion on
 * the SAME seeds against the same field (paired comparison), and lets a child take a niche when it
 * beats that niche's elite. A title challenger must beat the champion on the shared seeds and then
 * again on 2 x `matchesPerCandidate` fresh seeds. Fewer, honest promotions beat a new "champion"
 * every generation.
 */
export type EvolveRequest = {
  parent: Strategy;
  /** Opponents (house stacks, saved strategies). Fixed for the whole run so ratings mean something. */
  field: Strategy[];
  mapIds: string[];
  generations: number;
  /** Children bred per generation. */
  population: number;
  /** Shared seeds per generation (every child, elite and the champion play each one). */
  matchesPerCandidate: number;
  fighters: number;
  seed: number;
};

export type EvolveCandidate = {
  strategy: Strategy;
  /** What changed versus its parent, in plain words, e.g. "kite: keep_range max 300 -> 340". */
  mutations: string[];
  aggregate: StrategyAggregate;
};

export type EvolveGeneration = {
  generation: number;
  /** The champion's results on this generation's seeds. */
  champion: StrategyAggregate;
  /** Every child played this generation. */
  candidates: EvolveCandidate[];
  /** The strategy that took the title (a child or an older elite), or null when none beat the champion. */
  promoted: EvolveCandidate | null;
  /** e.g. "New contender: Lurking Daggers v3 beats v2 on 7 of 10 shared seeds." */
  summary: string;
};

export type EvolveResult = {
  /** Best strategy found (the parent itself if nothing beat it). Versioned above the parent. */
  champion: Strategy;
  improved: boolean;
  generations: EvolveGeneration[];
  summary: string;
};
