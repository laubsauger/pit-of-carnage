// Owned by: ui
// Pure helpers for showing battle reports, ratings and evolution runs.
import type { KillCause, KillRecord, MatchReport, Rating, StrategyAggregate, WinRecord } from '../core';

export const CAUSE_LABEL: Record<KillCause, string> = {
  weapon: 'Weapons',
  skill: 'Skills',
  hazard: 'Hazards',
  keg: 'Kegs',
  friendly: 'Friendly fire',
  sudden_death: 'Sudden death',
};

/**
 * Where each tested strategy finished in one gym match, best first. A batch match has many
 * fighters, and the row in the match list only needs to answer "how did mine do".
 */
export function candidatePlaces(report: MatchReport, candidateKeys: ReadonlySet<string>): { name: string; place: number }[] {
  const out: { name: string; place: number }[] = [];
  for (const r of report.roster) {
    if (!candidateKeys.has(r.strategyKey)) continue;
    const place = report.placements.indexOf(r.fighterId) + 1;
    if (place > 0) out.push({ name: r.name, place });
  }
  return out.sort((a, b) => a.place - b.place);
}

/** "The Pit" reads as "the Pit" mid-sentence. */
export function inSentence(mapName: string): string {
  return mapName.replace(/^The /, 'the ');
}

/** One line on how a fighter went out, for the placings list. Empty when the report has no kill. */
export function howOut(victimId: string, kills: readonly KillRecord[], nameOf: (id: string) => string): string {
  const k = kills.find((x) => x.victimId === victimId);
  if (!k) return '';
  const killer = k.killerId ? nameOf(k.killerId) : null;
  switch (k.cause) {
    case 'hazard':
      return 'the arena got them';
    case 'keg':
      return killer ? `${killer}'s keg` : 'a keg';
    case 'sudden_death':
      return 'the closing wall';
    case 'friendly':
      return killer ? `friendly fire from ${killer}` : 'friendly fire';
    default:
      if (!killer) return 'killed';
      if (k.flags.includes('backstab')) return `${killer}, from behind`;
      if (k.cause === 'skill') return `${killer}'s skill`;
      return `by ${killer}`;
  }
}

/**
 * Above this sigma a rating is still settling. New strategies start at 25/3 (about 8.3); after a
 * few dozen rated matches sigma typically drops well below 5, so the label marks numbers that
 * will still move a lot.
 */
export const PROVISIONAL_SIGMA = 5;

export function isProvisional(r: Rating): boolean {
  return r.sigma > PROVISIONAL_SIGMA;
}

export type WinRow = { key: string; matches: number; wins: number; rate: number };

/** Win records as rows, worst first: the matchups to fix come first. Ties: more matches first. */
export function winRows(records: Record<string, WinRecord>): WinRow[] {
  return Object.entries(records)
    .map(([key, r]) => ({ key, matches: r.matches, wins: r.wins, rate: r.matches > 0 ? r.wins / r.matches : 0 }))
    .sort((a, b) => a.rate - b.rate || b.matches - a.matches || a.key.localeCompare(b.key));
}

/** Histogram bars normalised to the tallest column (0..1). */
export function histogramHeights(hist: readonly number[]): number[] {
  const top = Math.max(0, ...hist);
  return hist.map((v) => (top > 0 ? v / top : 0));
}

/**
 * Comparison of a candidate with the champion on the same seeds. Lower average place is better,
 * so `placeGain` is positive when the candidate finished higher on average.
 */
export function versusChampion(candidate: StrategyAggregate, champion: StrategyAggregate): { placeGain: number; winRateGain: number } {
  return { placeGain: champion.avgPlace - candidate.avgPlace, winRateGain: candidate.winRate - champion.winRate };
}

/** "+0.4" / "-1.2" / "0.0" for signed comparisons. */
export function formatSigned(v: number, digits = 1): string {
  const s = v.toFixed(digits);
  if (Number(s) === 0) return (0).toFixed(digits);
  return v > 0 ? `+${s}` : s;
}
