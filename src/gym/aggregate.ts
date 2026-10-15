/**
 * Aggregation: many match reports become one `StrategyAggregate` per strategy key, plus batch
 * findings. Every number is counted from the reports; ratings come from the `RatingBook`, which is
 * updated from every report's placements first.
 *
 * Units: placement, kills, damage and survival are per appearance (one seat in one match). Wins,
 * `matches`, `byMap` and `byOpponent` are per match, so a mirror match (one strategy in two seats)
 * counts once there. The batch builder avoids mirrors unless the field is too small.
 */

import type { AggregateReport, GuardTrip, KillCause, MatchReport, PickupKind, Rating, StrategyAggregate, WinRecord } from '../core';
import { batchFindings, strategyFindings, type Appearance, type FindingContext, type StrategyFindingContext } from './findings';
import { round, versionedName } from './format';
import type { RatingBook } from './ratings';

export type AggregateOptions = {
  seed: number;
  mapIds: readonly string[];
  /** Rated with every report (in order) before the aggregates read it. Mutated in place. */
  book: RatingBook;
  playedAt?: number;
  /** Strategies under test; batch findings compare each with the rest of the field. */
  candidateKeys?: readonly string[];
  fieldLabel?: string;
  mapName?: FindingContext['mapName'];
  mapPickups?: FindingContext['mapPickups'];
};

/** Every appearance of every strategy key, in report order. */
export function appearancesByKey(reports: readonly MatchReport[]): Map<string, Appearance[]> {
  const out = new Map<string, Appearance[]>();
  for (const report of reports) {
    const fighters = new Map(report.fighters.map((f) => [f.fighterId, f]));
    for (const entry of report.roster) {
      const fighter = fighters.get(entry.fighterId);
      if (!fighter) throw new Error(`Report for seed ${report.seed} has no fighter record for ${entry.fighterId}.`);
      const list = out.get(entry.strategyKey) ?? [];
      list.push({ report, entry, fighter });
      out.set(entry.strategyKey, list);
    }
  }
  return out;
}

/** "Lurking Daggers v3" for every key that appears in the reports. */
export function keyNames(reports: readonly MatchReport[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const r of reports) for (const e of r.roster) names.set(e.strategyKey, versionedName(e.strategyName, e.strategyVersion));
  return names;
}

/** Per-kind totals over every appearance. */
function sumKinds(tables: readonly Partial<Record<PickupKind, number>>[]): Partial<Record<PickupKind, number>> {
  const out: Partial<Record<PickupKind, number>> = {};
  for (const t of tables) for (const [k, v] of Object.entries(t) as [PickupKind, number][]) out[k] = (out[k] ?? 0) + v;
  return out;
}

/** Guard trips summed per path and kind, most first (ties by path, then kind). */
function sumGuardTrips(lists: readonly (readonly GuardTrip[])[]): GuardTrip[] {
  const byKey = new Map<string, GuardTrip>();
  for (const list of lists) {
    for (const g of list) {
      const key = `${g.path}\u0000${g.kind}`;
      const t = byKey.get(key);
      if (t) t.count += g.count;
      else byKey.set(key, { ...g });
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : 1));
}

function winRecord(matches: number, wins: number): WinRecord {
  return { matches, wins, winRate: matches > 0 ? round(wins / matches, 3) : 0 };
}

/** Did this strategy win the match? FFA: one of its fighters placed 1st. Squads: its squad did. */
function wonMatch(report: MatchReport, mine: readonly Appearance[]): boolean {
  const winner = report.roster.find((r) => r.fighterId === report.placements[0]);
  if (!winner) return false;
  return mine.some((a) => (report.format === 'squads' ? a.entry.squad === winner.squad : a.entry.fighterId === winner.fighterId));
}

/** One strategy's aggregate over its appearances. */
export function strategyAggregate(key: string, apps: readonly Appearance[], rating: Rating, ctx: StrategyFindingContext): StrategyAggregate {
  if (apps.length === 0) throw new Error(`No appearances of ${key} to aggregate.`);
  const first = apps[0]!.entry;

  const byReport = new Map<MatchReport, Appearance[]>();
  for (const a of apps) byReport.set(a.report, [...(byReport.get(a.report) ?? []), a]);

  const size = Math.max(...apps.map((a) => a.report.roster.length));
  const placementHistogram = new Array<number>(size).fill(0);
  for (const a of apps) placementHistogram[a.fighter.place - 1] = (placementHistogram[a.fighter.place - 1] ?? 0) + 1;

  let wins = 0;
  const maps = new Map<string, { matches: number; wins: number }>();
  const opponents = new Map<string, { matches: number; wins: number }>();
  for (const [report, mine] of byReport) {
    const won = wonMatch(report, mine);
    if (won) wins++;
    const m = maps.get(report.mapId) ?? { matches: 0, wins: 0 };
    m.matches++;
    if (won) m.wins++;
    maps.set(report.mapId, m);

    // Head to head: best seat against best seat; in squads, teammates are not opponents.
    const mySquads = new Set(mine.map((a) => a.entry.squad));
    const myBest = Math.min(...mine.map((a) => a.fighter.place));
    const theirBest = new Map<string, number>();
    const placeOf = new Map(report.fighters.map((f) => [f.fighterId, f.place]));
    for (const e of report.roster) {
      if (e.strategyKey === key) continue;
      if (report.format === 'squads' && mySquads.has(e.squad)) continue;
      const place = placeOf.get(e.fighterId) ?? Infinity;
      theirBest.set(e.strategyKey, Math.min(theirBest.get(e.strategyKey) ?? Infinity, place));
    }
    for (const [opp, place] of theirBest) {
      const o = opponents.get(opp) ?? { matches: 0, wins: 0 };
      o.matches++;
      if (myBest < place) o.wins++;
      opponents.set(opp, o);
    }
  }

  // Deaths: cause, and which strategy landed the kill.
  const deathsByCause: Partial<Record<KillCause, number>> = {};
  const killers = new Map<string, number>();
  for (const a of apps) {
    const kill = a.report.kills.find((k) => k.victimId === a.entry.fighterId);
    if (!kill) continue;
    deathsByCause[kill.cause] = (deathsByCause[kill.cause] ?? 0) + 1;
    if (!kill.killerId || kill.killerId === kill.victimId) continue;
    const killerKey = a.report.roster.find((r) => r.fighterId === kill.killerId)?.strategyKey;
    if (killerKey) killers.set(killerKey, (killers.get(killerKey) ?? 0) + 1);
  }
  let killedMostBy: StrategyAggregate['killedMostBy'] = null;
  for (const [k, count] of [...killers].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!killedMostBy || count > killedMostBy.count) killedMostBy = { key: k, count };
  }

  const n = apps.length;
  const total = (f: (a: Appearance) => number) => apps.reduce((s, a) => s + f(a), 0);
  const agg: StrategyAggregate = {
    key,
    name: first.strategyName,
    version: first.strategyVersion,
    matches: byReport.size,
    placementHistogram,
    avgPlace: round(total((a) => a.fighter.place) / n, 2),
    winRate: round(wins / byReport.size, 3),
    byMap: Object.fromEntries([...maps].map(([id, m]) => [id, winRecord(m.matches, m.wins)])),
    byOpponent: Object.fromEntries([...opponents].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, o]) => [k, winRecord(o.matches, o.wins)])),
    killedMostBy,
    avgKills: round(total((a) => a.fighter.kills) / n, 2),
    avgDamageDealt: round(total((a) => a.fighter.damageDealt) / n, 1),
    avgSurvivalTicks: Math.round(total((a) => a.fighter.diedAtTick ?? a.report.ticks) / n),
    deathsByCause,
    pickupsTaken: sumKinds(apps.map((a) => a.fighter.pickupsTaken)),
    killsWhileBuffed: sumKinds(apps.map((a) => a.fighter.killsWhileBuffed)),
    guardTrips: sumGuardTrips(apps.map((a) => a.fighter.guardTrips)),
    findings: [],
    rating: { ...rating },
  };
  agg.findings = strategyFindings(agg, apps, ctx);
  return agg;
}

/**
 * Rate every report into `opts.book`, then aggregate per strategy (best rating first) and compute
 * batch findings.
 */
export function aggregateReports(reports: readonly MatchReport[], opts: AggregateOptions): AggregateReport {
  for (const r of reports) opts.book.rate(r, opts.playedAt ?? 0);
  const names = keyNames(reports);
  const ctx: StrategyFindingContext = { mapName: opts.mapName, mapPickups: opts.mapPickups, nameOfKey: (k) => names.get(k) ?? k };
  const strategies = [...appearancesByKey(reports)]
    .map(([key, apps]) => strategyAggregate(key, apps, opts.book.get(key), ctx))
    .sort((a, b) => b.rating.ordinal - a.rating.ordinal || a.avgPlace - b.avgPlace || (a.key < b.key ? -1 : 1));
  return {
    matches: reports.length,
    seed: opts.seed,
    mapIds: [...opts.mapIds],
    strategies,
    findings: batchFindings(strategies, reports, {
      ...ctx,
      mapIds: opts.mapIds,
      candidateKeys: opts.candidateKeys,
      fieldLabel: opts.fieldLabel,
    }),
  };
}
