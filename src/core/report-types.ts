/**
 * Battle reports, ratings and evolution results. Built by `src/gym`, shown by `src/ui`, pasted into
 * an LLM via `reportToText()` (gym). Every number here is computed from recorded events, never
 * invented; `findings` are plain sentences generated in code from those numbers.
 */

import { TICK_HZ } from './constants';
import { PERCEPTION } from './rules';
import type {
  DamageSource,
  GuardTrip,
  HazardKind,
  JudgedFighter,
  KillCause,
  KillFlag,
  MatchEnding,
  MatchFormat,
  PickupKind,
  SkillId,
  Strategy,
  SuddenDeathReason,
  Vec2,
  WeaponId,
} from './types';

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
 * `provisional` = still settling (`sigma > RATING_PROVISIONAL_SIGMA`): the UI marks it "new"
 * instead of hinting with a bare "?". Build one with `makeRating`. Ratings must be updated from
 * every rated match's placements and persisted between batches; never assigned by hand.
 */
export type Rating = { mu: number; sigma: number; ordinal: number; provisional: boolean };

/** Display points per unit of mu or sigma (`displayRating`). */
export const RATING_DISPLAY_SCALE = 40;

/**
 * Above this sigma a rating is provisional. New strategies start at 25/3 (about 8.3); after a few
 * dozen rated matches sigma typically drops well below 5, so the mark sits on numbers that will
 * still move a lot.
 */
export const RATING_PROVISIONAL_SIGMA = 5;

/** The one way to build a `Rating` from openskill's mu and sigma (ordinal and provisional follow). */
export function makeRating(mu: number, sigma: number): Rating {
  return { mu, sigma, ordinal: mu - 3 * sigma, provisional: sigma > RATING_PROVISIONAL_SIGMA };
}

/**
 * Number shown to players: `round(1000 + ordinal x 40)`. A new strategy shows 1000.
 * Note the ordinal rises as sigma shrinks, so a few matches move the number even at average play.
 */
export function displayRating(r: Rating): number {
  return Math.round(1000 + r.ordinal * RATING_DISPLAY_SCALE);
}

/**
 * A rating as the UI shows it: "1240 ±85", the ± part muted, and a "new" marker in its own slot
 * when provisional ("Provisional: rated from 3 matches. Settles after about 10."). `value` is
 * `displayRating`; `plusMinus` is one sigma in display points (`round(sigma x 40)`), so it shrinks
 * as evidence piles up.
 */
export type RatingDisplay = { value: number; plusMinus: number; provisional: boolean };

export function ratingDisplay(r: Rating): RatingDisplay {
  return { value: displayRating(r), plusMinus: Math.round(r.sigma * RATING_DISPLAY_SCALE), provisional: r.provisional };
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

// ---------------------------------------------------------------------------------------------
// Per-fighter stats and heatmaps
// ---------------------------------------------------------------------------------------------

/**
 * How the per-fighter stats (`FighterStats`) are measured. These are measurement thresholds for
 * reports, not gameplay rules; the UI and `reportToText` may quote them ("near a wall: within 48 px").
 */
export const REPORT_STATS = {
  /**
   * Engaged: from a tick where the fighter started an attack, or dealt damage to or took damage
   * from an enemy, until this many ticks later (the same window as the `fighting` sensor).
   * Hazards, kegs nobody broke and the wall do not engage anyone.
   */
  engagedWindowTicks: PERCEPTION.fightingWindowTicks,
  /** Moving less than this many px in a tick counts as standing still (idle or stuck). */
  stillPxPerTick: 0.15,
  /** Standing still while its decision's throttle (`Decision.speed`) is at least this = stuck, below = idle. */
  stuckThrottle: 0.5,
  /** Near a wall: the fighter's centre within this many px of a map wall or pillar. */
  nearWallPx: 48,
  /** Assist: dealt damage to an enemy within this many ticks before its death without landing the kill. */
  assistWindowTicks: 5 * TICK_HZ,
} as const;

/** Edge of one heatmap cell in world px: 17 x 11 cells on a 1360 x 860 map. */
export const HEATMAP_CELL_PX = 80;

/**
 * Where a fighter spent its time (or a strategy, summed over its appearances on one map). Plain
 * JSON. `counts` is row-major with `rows x cols` entries: cell (col, row) covers world x in
 * [col x cell, (col + 1) x cell) and y in [row x cell, (row + 1) x cell), and counts the ticks the
 * fighter was alive with its centre inside it (positions off the map count in the nearest edge
 * cell). `total` is the sum of `counts`, so `counts[i] / total` is the share of time in cell i.
 * Build and fill them with `createHeatmap`, `addToHeatmap` and `mergeHeatmap`.
 */
export type Heatmap = { cell: number; cols: number; rows: number; counts: number[]; total: number };

/** An empty heatmap covering a `width` x `height` px map. */
export function createHeatmap(width: number, height: number, cell: number = HEATMAP_CELL_PX): Heatmap {
  const cols = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));
  return { cell, cols, rows, counts: new Array<number>(cols * rows).fill(0), total: 0 };
}

/** Count `n` ticks (default 1) at world point (x, y). Non-finite points are ignored. */
export function addToHeatmap(h: Heatmap, x: number, y: number, n = 1): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const col = Math.min(h.cols - 1, Math.max(0, Math.floor(x / h.cell)));
  const row = Math.min(h.rows - 1, Math.max(0, Math.floor(y / h.cell)));
  h.counts[row * h.cols + col]! += n;
  h.total += n;
}

/** Add every count of `from` into `into` (same map, same cell size), e.g. to sum a strategy's matches. */
export function mergeHeatmap(into: Heatmap, from: Heatmap): void {
  if (into.cell !== from.cell || into.cols !== from.cols || into.rows !== from.rows) {
    throw new Error(`mergeHeatmap: shapes differ (${into.cols}x${into.rows} @${into.cell}px vs ${from.cols}x${from.rows} @${from.cell}px).`);
  }
  for (let i = 0; i < into.counts.length; i++) into.counts[i]! += from.counts[i]!;
  into.total += from.total;
}

/**
 * Movement and engagement numbers for one fighter in one match ("for humans and LLMs"). Ticks are
 * sim ticks (`TICK_HZ` per second) counted while the fighter was alive; thresholds in
 * `REPORT_STATS`. In a `StrategyAggregate` the same shape holds averages, see there.
 */
export type FighterStats = {
  /** px moved while alive (sum of per-tick movement; a Shadowstep teleport counts as no movement). */
  distanceTravelled: number;
  /** `hitsLanded / attacks`, 0..1; 0 when it never attacked. */
  accuracy: number;
  /** Skill uses that damaged or stunned at least one enemy (Whirlwind, Shockwave; buffs and moves never count). */
  skillHits: number;
  /** Ticks spent engaged (`REPORT_STATS.engagedWindowTicks`). */
  ticksEngaged: number;
  /** Damage dealt to enemies per second of engaged time; 0 when never engaged. */
  damageDealtPerSecondEngaged: number;
  /** Damage taken from enemies per second of engaged time; 0 when never engaged. */
  damageTakenPerSecondEngaged: number;
  /** Ticks from the match start to its first engaged tick; null when it never engaged anyone. */
  ticksToFirstContact: number | null;
  /** Ticks standing still without wanting to move (not attacking, not stunned, throttle below `stuckThrottle`). */
  ticksIdle: number;
  /** Ticks standing still while its decision asked to move (pressed into a wall, pillar, prop or crowd). */
  ticksStuck: number;
  /** Ticks with its centre within `REPORT_STATS.nearWallPx` of a map wall or pillar. */
  ticksNearWalls: number;
  /**
   * Ticks during sudden death outside `SuddenDeathState.warning`: beyond the wall or in the strip it
   * reaches within 3 s (the brains' `outside_zone`).
   */
  ticksOutsideZone: number;
  /** Enemy deaths it dealt damage to within `REPORT_STATS.assistWindowTicks` before, without the kill. */
  assists: number;
  /** `(kills + assists) / enemy deaths in the match`, 0..1; 0 when no enemy died. */
  killParticipation: number;
};

/**
 * All zero (`ticksToFirstContact` null): a fighter that never moved, attacked or engaged. Also the
 * starting value for sums and the fill for test fixtures.
 */
export function emptyFighterStats(): FighterStats {
  return {
    distanceTravelled: 0,
    accuracy: 0,
    skillHits: 0,
    ticksEngaged: 0,
    damageDealtPerSecondEngaged: 0,
    damageTakenPerSecondEngaged: 0,
    ticksToFirstContact: null,
    ticksIdle: 0,
    ticksStuck: 0,
    ticksNearWalls: 0,
    ticksOutsideZone: 0,
    assists: 0,
    killParticipation: 0,
  };
}

/** How a fighter died: its kill as recorded (see KillRecord), plus the hazard kind and the stamp. */
export type DeathRecord = {
  tick: number;
  cause: KillCause;
  /** Who got the kill (the victim itself for an own goal), or null (hazard, wall, nobody's keg). */
  killerId: string | null;
  weapon: WeaponId | null;
  hazard: HazardKind | null;
  flags: KillFlag[];
  /** The kill stamp shown ("SPLIT", "SAWED", "CRUSHED"). */
  title: string;
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
  /** Movement and engagement numbers (distance, accuracy, damage per engaged second, idle, walls, ...). */
  stats: FighterStats;
  /** How it died, or null when it survived. */
  death: DeathRecord | null;
  /** Where it spent its time alive on this match's map. */
  heatmap: Heatmap;
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
  /**
   * The judges' scorecards (survivors in judged order, 1st first, with the numbers they used) when
   * the match ended `judges`; null otherwise.
   */
  judges: JudgedFighter[] | null;
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

/** How often a set of matches reached sudden death, and why. */
export type SuddenDeathShare = {
  /** Matches where sudden death started. */
  matches: number;
  /** `matches` / matches counted, 0..1. */
  share: number;
  byReason: Partial<Record<SuddenDeathReason, number>>;
  /** Mean tick sudden death started at over those matches; null when none reached it. */
  avgStartTick: number | null;
};

/** One match the judges decided, for batch reports ("The judges gave it to Gary on the Pit, seed 42"). */
export type JudgedMatch = {
  seed: number;
  mapId: string;
  /** Survivors in judged order (1st first) with their scorecards and strategy keys. */
  survivors: (JudgedFighter & { strategyKey: string })[];
};

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
  /**
   * `FighterStats` averaged per appearance, except: `accuracy` pools all landed attacks over all
   * attacks; the per-second rates are weighted by engaged time; `ticksToFirstContact` averages only
   * the appearances that engaged (null when none did).
   */
  stats: FighterStats;
  /** Where it spent its time, summed over its appearances, by map id (compare strategies per map). */
  heatmaps: Record<string, Heatmap>;
  /** Of its matches: how many reached sudden death, and why. */
  suddenDeath: SuddenDeathShare;
  /** Of its matches: how many the judges decided (`share` of its matches), and how many of those it won. */
  judges: { matches: number; share: number; wins: number };
  /** Plain sentences computed from the numbers above. */
  findings: string[];
  /** Rating after this batch (continues from the stored rating when one exists). */
  rating: Rating;
};

export type AggregateReport = {
  matches: number;
  seed: number;
  mapIds: string[];
  /** How the batch's matches ended, by ending. */
  endings: Partial<Record<MatchEnding, number>>;
  /** How many of the batch's matches reached sudden death, and why. */
  suddenDeath: SuddenDeathShare;
  /** Matches the judges decided (`share` of the batch), each with its scorecards. */
  judges: { matches: number; share: number; decisions: JudgedMatch[] };
  /** Sorted by rating ordinal, best first. */
  strategies: StrategyAggregate[];
  /** Batch-level findings, e.g. "Lurking Daggers v3 beats the house stacks 7 of 10 on the Pit." */
  findings: string[];
};

// ---------------------------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------------------------

/**
 * Compare two strategies, or two versions of one, side by side over the same seeds (`GymApi.compare`).
 * A paired experiment: both play the same matches (same seeds, maps, field lineups and seat), each
 * in the other's place, so a gap comes from the strategies and not from who drew the easier fights.
 * Neither ever meets the other. Not rated: a comparison is a measurement and never moves the
 * leaderboard.
 */
export type CompareRequest = {
  a: Strategy;
  b: Strategy;
  /** Opponents for both (any entry with A's or B's key is left out, so the two never meet). */
  field: Strategy[];
  mapIds: string[];
  matches: number;
  fighters: number;
  seed: number;
};

/** One shared seed: both finishes (1 = won). */
export type CompareMatch = { seed: number; mapId: string; fighters: number; placeA: number; placeB: number };

/**
 * One line of the side-by-side table. `a` and `b` are in `unit` (a share is 0..1, `seconds` are
 * seconds); null when there is no value (never engaged). `better` names the side that did better
 * when "better" has a direction (more wins, less damage taken), null when level or a matter of
 * style (idle time, distance, time near walls).
 */
export type CompareRow = { label: string; unit: 'share' | 'number' | 'seconds' | 'px' | 'place'; a: number | null; b: number | null; better: 'a' | 'b' | null };

/**
 * Both sets of reports (index i of each is the same seed, so the UI can Watch either side of any
 * pairing), both aggregates (per-fighter stats averaged, heatmaps per map), the per-seed finishes,
 * the side-by-side rows and findings.
 */
export type CompareResult = {
  /** A's matches; `reportsB[i]` is the same seed, map and lineup with B in A's seat. */
  reportsA: MatchReport[];
  reportsB: MatchReport[];
  a: StrategyAggregate;
  b: StrategyAggregate;
  matches: CompareMatch[];
  /** Shared seeds where A finished ahead of B, behind it, or level. */
  aAhead: number;
  bAhead: number;
  level: number;
  rows: CompareRow[];
  /** Plain sentences from the numbers, e.g. "Lurking Daggers v3 finished ahead of v2 on 7 of 10 shared seeds (2 behind, 1 level)." */
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
