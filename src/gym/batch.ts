/**
 * Batch builder and runner. A `BatchRequest` becomes a list of seeded `MatchConfig`s:
 *
 * - Every candidate gets one seat in every match; the remaining seats come from the field.
 * - The field is drawn from a shuffle bag, so over a batch every field strategy plays about equally
 *   often, and one lineup repeats a field strategy only when the field is smaller than the seats.
 * - Seats are shuffled per match (spawn points follow seat order, so nobody keeps the best spawn).
 * - Matches rotate through `mapIds`. Every seed derives from `req.seed`, so the same request always
 *   produces the same configs (and, with a deterministic sim, the same reports).
 *
 * Gym matches use the watch defaults (FFA, friendly fire, default time limit, sudden death), so the
 * UI can rebuild any reported match from its roster and replay it.
 */

import { DEFAULT_TIME_LIMIT_TICKS, FIGHTER_COLORS, MAX_FIGHTERS, MIN_FIGHTERS, Rng, strategyKey } from '../core';
import type { BatchRequest, BatchResult, Entrant, MatchConfig, MatchReport, Strategy } from '../core';
import { aggregateReports } from './aggregate';
import type { FindingContext } from './findings';
import type { RatingBook } from './ratings';

/** Plays one match to the end and reports it. The real one wraps the sim; tests inject fakes. */
export type MatchRunner = (config: MatchConfig) => MatchReport;

/**
 * Draws strategies so each appears equally often over many draws: a shuffled copy of the pool is
 * consumed, then refilled. Within one draw it skips strategies already in the lineup while the pool
 * still has others, so repeats (mirror matches) only happen when the pool is too small.
 */
export class ShuffleBag {
  private queue: Strategy[] = [];

  constructor(
    private readonly pool: readonly Strategy[],
    private readonly rng: Rng,
  ) {
    if (pool.length === 0) throw new Error('ShuffleBag: the pool is empty.');
  }

  draw(count: number, exclude: ReadonlySet<string> = new Set()): Strategy[] {
    const out: Strategy[] = [];
    const used = new Set(exclude);
    for (let n = 0; n < count; n++) {
      let i = this.queue.findIndex((s) => !used.has(strategyKey(s)));
      if (i < 0) {
        this.queue.push(...this.rng.shuffle([...this.pool]));
        i = this.queue.findIndex((s) => !used.has(strategyKey(s)));
        if (i < 0) i = 0;
      }
      const s = this.queue.splice(i, 1)[0]!;
      out.push(s);
      used.add(strategyKey(s));
    }
    return out;
  }
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI'];

/**
 * Fighter names for one lineup: the strategy name; with the version when two versions of one
 * strategy meet ("Gary v2", "Gary v3"); with a numeral in a mirror match ("Gary", "Gary II").
 */
export function fighterNames(lineup: readonly Strategy[]): string[] {
  const keysByName = new Map<string, Set<string>>();
  for (const s of lineup) {
    const set = keysByName.get(s.name) ?? new Set<string>();
    set.add(strategyKey(s));
    keysByName.set(s.name, set);
  }
  const base = lineup.map((s) => (keysByName.get(s.name)!.size > 1 ? `${s.name} v${s.version ?? 1}` : s.name));
  const seen = new Map<string, number>();
  return base.map((name) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} ${ROMAN[n] ?? n}`;
  });
}

/** One FFA config with the gym's standard rules. Seat i is entrant `e{i}`, squad i, colour i. */
export function gymConfig(seed: number, mapId: string, lineup: readonly Strategy[]): MatchConfig {
  const names = fighterNames(lineup);
  const entrants: Entrant[] = lineup.map((strategy, i) => ({
    id: `e${i}`,
    strategy,
    squad: i,
    name: names[i]!,
    color: FIGHTER_COLORS[i % FIGHTER_COLORS.length]!,
  }));
  return {
    seed: seed >>> 0,
    mapId,
    format: 'ffa',
    entrants,
    friendlyFire: true,
    timeLimitTicks: DEFAULT_TIME_LIMIT_TICKS,
    suddenDeath: true,
  };
}

/** Strategies with distinct keys, first occurrence kept. */
export function uniqueByKey(strategies: readonly Strategy[]): Strategy[] {
  const seen = new Set<string>();
  return strategies.filter((s) => {
    const k = strategyKey(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function checkRequest(req: BatchRequest): void {
  if (!Number.isInteger(req.fighters) || req.fighters < MIN_FIGHTERS || req.fighters > MAX_FIGHTERS) {
    throw new Error(`A batch needs ${MIN_FIGHTERS}-${MAX_FIGHTERS} fighters per match, got ${req.fighters}.`);
  }
  if (!Number.isInteger(req.matches) || req.matches < 0) throw new Error(`Match count must be a whole number, got ${req.matches}.`);
  if (req.mapIds.length === 0) throw new Error('A batch needs at least one map.');
  if (req.candidates.length > req.fighters) {
    throw new Error(`${req.candidates.length} candidates do not fit in ${req.fighters}-fighter matches.`);
  }
  if (req.candidates.length + req.field.length === 0) throw new Error('A batch needs at least one strategy.');
  const keys = req.candidates.map(strategyKey);
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) throw new Error(`Two candidates are both ${dup}; give them different names or versions.`);
}

/** The batch's match configs, in play order. Pure and deterministic in the request. */
export function buildBatch(req: BatchRequest): MatchConfig[] {
  checkRequest(req);
  const rng = new Rng(req.seed);
  const candidateKeys = new Set(req.candidates.map(strategyKey));
  // A field entry with a candidate's key would merge with it in every table; the candidate seat covers it.
  const field = uniqueByKey(req.field).filter((s) => !candidateKeys.has(strategyKey(s)));
  // With no field, the free seats go to mirror copies of the candidates.
  const bag = new ShuffleBag(field.length > 0 ? field : req.candidates, rng.fork('field'));
  const exclude = field.length > 0 ? candidateKeys : new Set<string>();

  const configs: MatchConfig[] = [];
  for (let i = 0; i < req.matches; i++) {
    const mrng = rng.fork(`match:${i}`);
    const seed = mrng.nextU32();
    const lineup = [...req.candidates, ...bag.draw(req.fighters - req.candidates.length, exclude)];
    mrng.shuffle(lineup);
    configs.push(gymConfig(seed, req.mapIds[i % req.mapIds.length]!, lineup));
  }
  return configs;
}

export type RunBatchOptions = {
  /** Persistent ratings; every report is rated into it, in play order. */
  book: RatingBook;
  /** Epoch ms stamped on rating records (leaderboard "last played"). */
  playedAt?: number;
  /** How findings call the non-candidates, e.g. "the house stacks". */
  fieldLabel?: string;
  mapName?: FindingContext['mapName'];
  mapPickups?: FindingContext['mapPickups'];
  onProgress?: (done: number, total: number) => void;
};

export function runBatch(req: BatchRequest, runMatch: MatchRunner, opts: RunBatchOptions): BatchResult {
  const configs = buildBatch(req);
  const reports: MatchReport[] = [];
  for (const config of configs) {
    reports.push(runMatch(config));
    opts.onProgress?.(reports.length, configs.length);
  }
  const aggregate = aggregateReports(reports, {
    seed: req.seed,
    mapIds: req.mapIds,
    book: opts.book,
    playedAt: opts.playedAt,
    candidateKeys: req.candidates.map(strategyKey),
    fieldLabel: opts.fieldLabel,
    mapName: opts.mapName,
    mapPickups: opts.mapPickups,
  });
  return { reports, aggregate };
}
