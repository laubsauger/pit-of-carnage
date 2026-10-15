/**
 * Compare: two strategies, or two versions of one, side by side over the same seeds.
 *
 * A paired experiment, like evolution's: both play the same matches (same seeds, maps, field
 * lineups and seat), each in the other's place, so a gap comes from the strategies and not from
 * who drew the easier fights. Neither ever meets the other. Both batches use a run-local rating
 * book: a comparison is a measurement, it does not move the leaderboard.
 *
 * The result carries both sets of reports (index i of each is the same seed, so the UI can Watch
 * either side of any pairing), both aggregates (with the per-fighter stats averaged and the
 * heatmaps per map), the per-seed finishes, a table of rows for the side-by-side view and findings.
 */

import { TICK_HZ, strategyKey } from '../core';
import type { BatchRequest, MatchReport, Strategy, StrategyAggregate } from '../core';
import { aggregateReports } from './aggregate';
import { buildBatch, type MatchRunner } from './batch';
import type { FindingContext } from './findings';
import { clock, plural, round, versionedName } from './format';
import { RatingBook } from './ratings';

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

export type CompareOptions = {
  mapName?: FindingContext['mapName'];
  mapPickups?: FindingContext['mapPickups'];
  /** After each match, counted over both sides (total = 2 x matches). */
  onProgress?: (done: number, total: number) => void;
};

/** "Lurking Daggers v3" and "v2" when both are versions of one name, else both full names. */
function labels(a: Strategy, b: Strategy): [string, string] {
  const full = (s: Strategy) => versionedName(s.name, s.version ?? 1);
  return a.name === b.name ? [full(a), `v${b.version ?? 1}`] : [full(a), full(b)];
}

/** The two paired batches: the same requests with only the candidate swapped. */
export function compareBatches(req: CompareRequest): [BatchRequest, BatchRequest] {
  const keyA = strategyKey(req.a);
  const keyB = strategyKey(req.b);
  if (keyA === keyB) throw new Error(`Compare needs two different strategies or versions; both are ${keyA}.`);
  if (!Number.isInteger(req.matches) || req.matches < 1) throw new Error(`Compare needs at least one match, got ${req.matches}.`);
  const field = req.field.filter((s) => strategyKey(s) !== keyA && strategyKey(s) !== keyB);
  if (field.length === 0) throw new Error('Compare needs at least one field strategy besides the two being compared.');
  const base = { field, mapIds: [...req.mapIds], matches: req.matches, fighters: req.fighters, seed: req.seed };
  return [
    { ...base, candidates: [req.a] },
    { ...base, candidates: [req.b] },
  ];
}

function seatPlace(report: MatchReport, key: string): number {
  const e = report.roster.find((r) => r.strategyKey === key);
  const f = e && report.fighters.find((x) => x.fighterId === e.fighterId);
  if (!f) throw new Error(`Compare: the match on seed ${report.seed} has no fighter for ${key}.`);
  return f.place;
}

function row(label: string, unit: CompareRow['unit'], a: number | null, b: number | null, higherIsBetter: boolean | null): CompareRow {
  let better: CompareRow['better'] = null;
  if (higherIsBetter !== null && a !== null && b !== null && a !== b) better = a > b === higherIsBetter ? 'a' : 'b';
  return { label, unit, a, b, better };
}

/** The side-by-side table: results first, then how each one moved and fought. */
export function compareRows(a: StrategyAggregate, b: StrategyAggregate): CompareRow[] {
  const share = (ticks: number, alive: number) => (alive > 0 ? round(ticks / alive, 3) : 0);
  const both = <T>(f: (s: StrategyAggregate) => T): [T, T] => [f(a), f(b)];
  const sec = (ticks: number | null) => (ticks === null ? null : round(ticks / TICK_HZ, 1));
  const rows: [string, CompareRow['unit'], [number | null, number | null], boolean | null][] = [
    ['Win rate', 'share', both((s) => s.winRate), true],
    ['Average place', 'place', both((s) => s.avgPlace), false],
    ['Kills per match', 'number', both((s) => s.avgKills), true],
    ['Damage per match', 'number', both((s) => s.avgDamageDealt), true],
    ['Survival', 'seconds', both((s) => sec(s.avgSurvivalTicks)), true],
    ['Kill participation', 'share', both((s) => s.stats.killParticipation), true],
    ['Accuracy', 'share', both((s) => s.stats.accuracy), true],
    ['Damage dealt per engaged second', 'number', both((s) => s.stats.damageDealtPerSecondEngaged), true],
    ['Damage taken per engaged second', 'number', both((s) => s.stats.damageTakenPerSecondEngaged), false],
    ['First contact', 'seconds', both((s) => sec(s.stats.ticksToFirstContact)), null],
    ['Engaged', 'share', both((s) => share(s.stats.ticksEngaged, s.avgSurvivalTicks)), null],
    ['Idle', 'share', both((s) => share(s.stats.ticksIdle, s.avgSurvivalTicks)), null],
    ['Stuck', 'share', both((s) => share(s.stats.ticksStuck, s.avgSurvivalTicks)), false],
    ['Near walls', 'share', both((s) => share(s.stats.ticksNearWalls, s.avgSurvivalTicks)), null],
    ['Outside the zone', 'share', both((s) => share(s.stats.ticksOutsideZone, s.avgSurvivalTicks)), false],
    ['Distance moved', 'px', both((s) => s.stats.distanceTravelled), null],
  ];
  return rows.map(([label, unit, [x, y], dir]) => row(label, unit, x, y, dir));
}

/** Pair the two sides' reports seed by seed and build the comparison. Reports must come from `compareBatches`. */
export function compareReports(req: CompareRequest, reportsA: readonly MatchReport[], reportsB: readonly MatchReport[], opts: CompareOptions = {}): CompareResult {
  if (reportsA.length !== reportsB.length) throw new Error(`Compare: ${reportsA.length} matches for A but ${reportsB.length} for B.`);
  const keyA = strategyKey(req.a);
  const keyB = strategyKey(req.b);
  const ctx = { seed: req.seed, mapIds: req.mapIds, mapName: opts.mapName, mapPickups: opts.mapPickups };
  const a = aggregateReports(reportsA, { ...ctx, book: new RatingBook(), candidateKeys: [keyA] }).strategies.find((s) => s.key === keyA)!;
  const b = aggregateReports(reportsB, { ...ctx, book: new RatingBook(), candidateKeys: [keyB] }).strategies.find((s) => s.key === keyB)!;
  const matches: CompareMatch[] = reportsA.map((ra, i) => {
    const rb = reportsB[i]!;
    if (ra.seed !== rb.seed || ra.mapId !== rb.mapId) throw new Error(`Compare: match ${i} is not paired (seed ${ra.seed} on ${ra.mapId} vs seed ${rb.seed} on ${rb.mapId}).`);
    return { seed: ra.seed, mapId: ra.mapId, fighters: ra.roster.length, placeA: seatPlace(ra, keyA), placeB: seatPlace(rb, keyB) };
  });
  const aAhead = matches.filter((m) => m.placeA < m.placeB).length;
  const bAhead = matches.filter((m) => m.placeB < m.placeA).length;
  const level = matches.length - aAhead - bAhead;

  const [nameA, nameB] = labels(req.a, req.b);
  const findings: string[] = [];
  if (matches.length > 0) {
    findings.push(`${nameA} finished ahead of ${nameB} on ${aAhead} of ${matches.length} shared ${plural(matches.length, 'seed')} (${bAhead} behind, ${level} level).`);
    const winsA = Math.round(a.winRate * a.matches);
    const winsB = Math.round(b.winRate * b.matches);
    findings.push(`Average place ${round(a.avgPlace, 1)} vs ${round(b.avgPlace, 1)}; won ${winsA} vs ${winsB} of ${matches.length}.`);
    const ca = a.stats.ticksToFirstContact;
    const cb = b.stats.ticksToFirstContact;
    if (ca !== null && cb !== null && Math.abs(ca - cb) >= 5 * TICK_HZ) {
      findings.push(`${ca < cb ? nameA : nameB} gets into fights sooner: first contact at ${clock(Math.min(ca, cb))} vs ${clock(Math.max(ca, cb))} on average.`);
    }
    const da = a.stats.damageDealtPerSecondEngaged;
    const db = b.stats.damageDealtPerSecondEngaged;
    if (Math.min(da, db) > 0 && Math.max(da, db) / Math.min(da, db) >= 1.25) {
      findings.push(`${da > db ? nameA : nameB} hits harder once engaged: ${Math.max(da, db)} vs ${Math.min(da, db)} damage per second.`);
    }
  }
  return { reportsA: [...reportsA], reportsB: [...reportsB], a, b, matches, aAhead, bAhead, level, rows: compareRows(a, b), findings };
}

/** Play both sides of a comparison and compare them. */
export function runCompare(req: CompareRequest, runMatch: MatchRunner, opts: CompareOptions = {}): CompareResult {
  const [batchA, batchB] = compareBatches(req);
  const configsA = buildBatch(batchA);
  const configsB = buildBatch(batchB);
  const total = configsA.length + configsB.length;
  const reportsA: MatchReport[] = [];
  const reportsB: MatchReport[] = [];
  for (const c of configsA) {
    reportsA.push(runMatch(c));
    opts.onProgress?.(reportsA.length, total);
  }
  for (const c of configsB) {
    reportsB.push(runMatch(c));
    opts.onProgress?.(reportsA.length + reportsB.length, total);
  }
  return compareReports(req, reportsA, reportsB, opts);
}
