// Owned by: ui
// Pure helpers for showing battle reports, ratings and evolution runs.
import { RATING_PROVISIONAL_SIGMA, REPORT_STATS, TICK_HZ, ratingDisplay } from '../core';
import type { FighterStats, Heatmap, KillCause, KillRecord, MatchReport, Rating, StrategyAggregate, WinRecord } from '../core';
import { heatmapPhrase } from '../gym';
import { formatPercent } from './format';

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
 * Above this sigma a rating is still settling (the core's `RATING_PROVISIONAL_SIGMA`). New
 * strategies start at 25/3 (about 8.3); after a few dozen rated matches sigma typically drops well
 * below 5, so the mark sits on numbers that will still move a lot.
 */
export const PROVISIONAL_SIGMA = RATING_PROVISIONAL_SIGMA;

/** Ratings stored before `Rating.provisional` existed lack the flag; their sigma still says it. */
export function isProvisional(r: Rating): boolean {
  return typeof r.provisional === 'boolean' ? r.provisional : r.sigma > PROVISIONAL_SIGMA;
}

/** Rated matches after which a new rating has usually settled (the "new" card's promise). */
export const RATING_SETTLES_AFTER = 10;

/**
 * A rating as every table shows it: "1240 ±85", the ± part muted, and a "new" mark in its own slot
 * with a card that explains it. `matches` (rated matches so far) makes the card concrete.
 */
export type RatingView = { value: string; plusMinus: string; provisional: boolean; card: string; label: string };

export function ratingView(r: Rating, matches?: number): RatingView {
  const d = ratingDisplay(r);
  const provisional = isProvisional(r);
  const rated = matches === undefined ? 'rated from only a few matches' : `rated from ${matches} ${matches === 1 ? 'match' : 'matches'}`;
  const card = provisional
    ? matches !== undefined && matches >= RATING_SETTLES_AFTER
      ? `Provisional: ${rated} and still moving a lot. The ± shows how far it may be off.`
      : `Provisional: ${rated}. Settles after about ${RATING_SETTLES_AFTER}.`
    : `Settled. The ± is one standard deviation: the true strength is likely within it.`;
  const value = String(d.value);
  const plusMinus = `±${d.plusMinus}`;
  return { value, plusMinus, provisional, card, label: `${provisional ? 'New, ' : ''}rating ${value} plus or minus ${d.plusMinus}` };
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

// ---------------------------------------------------------------------------------------------
// Watching gym matches
// ---------------------------------------------------------------------------------------------

/** Opening a match at a death starts this far before it, so you see the fight that led there. */
export const DEATH_LEAD_IN_TICKS = 4 * TICK_HZ;

/** Tick to open a match at so a death (or kill) plays with its lead-in. */
export function leadInTick(deathTick: number): number {
  return Math.max(0, deathTick - DEATH_LEAD_IN_TICKS);
}

/** Of the matches both strategies played, how often each finished ahead of the other. */
export function headToHead(reports: readonly MatchReport[], keyA: string, keyB: string): { shared: number; aAhead: number; bAhead: number } {
  let shared = 0;
  let aAhead = 0;
  let bAhead = 0;
  for (const r of reports) {
    const best = (key: string) => {
      const places = r.roster.filter((x) => x.strategyKey === key).map((x) => r.placements.indexOf(x.fighterId) + 1).filter((p) => p > 0);
      return places.length ? Math.min(...places) : 0;
    };
    const a = best(keyA);
    const b = best(keyB);
    if (!a || !b) continue;
    shared++;
    if (a < b) aAhead++;
    else if (b < a) bAhead++;
  }
  return { shared, aAhead, bAhead };
}

// ---------------------------------------------------------------------------------------------
// Per-fighter stats and comparisons
// ---------------------------------------------------------------------------------------------

/** Ticks as seconds with one decimal ("7.2 s"); averages are fractional, so never a clock. */
export function secondsText(ticks: number): string {
  return `${(Math.max(0, ticks) / TICK_HZ).toFixed(1)} s`;
}

const px = (v: number) => `${Math.round(v).toLocaleString('en-US')} px`;
const perSecond = (v: number) => `${v.toFixed(1)}/s`;
const count = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

/** One movement or engagement number as players read it, with what it measures. */
type Metric = { label: string; hint: string; value: (s: FighterStats) => number | null; format: (v: number) => string };

const STAT_METRICS: readonly Metric[] = [
  { label: 'Distance travelled', hint: 'px moved while alive', value: (s) => s.distanceTravelled, format: px },
  { label: 'Accuracy', hint: 'attacks that damaged an enemy', value: (s) => s.accuracy, format: (v) => formatPercent(v) },
  { label: 'Damage dealt while engaged', hint: 'per second of fighting', value: (s) => s.damageDealtPerSecondEngaged, format: perSecond },
  { label: 'Damage taken while engaged', hint: 'per second of fighting', value: (s) => s.damageTakenPerSecondEngaged, format: perSecond },
  { label: 'Time engaged', hint: 'fighting someone', value: (s) => s.ticksEngaged, format: secondsText },
  { label: 'First contact after', hint: 'from the start to its first fight', value: (s) => s.ticksToFirstContact, format: secondsText },
  { label: 'Idle', hint: 'standing still by choice', value: (s) => s.ticksIdle, format: secondsText },
  { label: 'Stuck', hint: 'wanted to move, did not', value: (s) => s.ticksStuck, format: secondsText },
  { label: 'Near walls', hint: `within ${REPORT_STATS.nearWallPx} px of a wall or pillar`, value: (s) => s.ticksNearWalls, format: secondsText },
  { label: 'Outside the zone', hint: 'in sudden death, where the wall is or will be in 3 s', value: (s) => s.ticksOutsideZone, format: secondsText },
  { label: 'Skill hits', hint: 'skill uses that hurt or stunned an enemy', value: (s) => s.skillHits, format: count },
  { label: 'Assists', hint: `damaged an enemy within ${REPORT_STATS.assistWindowTicks / TICK_HZ} s of its death, no kill`, value: (s) => s.assists, format: count },
  { label: 'Kill participation', hint: 'kills and assists over enemy deaths', value: (s) => s.killParticipation, format: (v) => formatPercent(v) },
];

export type StatLine = { label: string; value: string; hint: string };

/** The movement and engagement numbers as labelled lines ("First contact after: never"). */
export function statLines(s: FighterStats): StatLine[] {
  return STAT_METRICS.map((m) => {
    const v = m.value(s);
    return { label: m.label, value: v === null ? 'never' : m.format(v), hint: m.hint };
  });
}

/**
 * One cell of the gym's side-by-side table (`compareRows` in src/gym), in the units players read:
 * shares as percentages, places with two decimals, seconds and px with their unit, "never" for a
 * missing value (it never engaged anyone).
 */
export function compareCell(value: number | null, unit: 'share' | 'number' | 'seconds' | 'px' | 'place'): string {
  if (value === null || !Number.isFinite(value)) return 'never';
  switch (unit) {
    case 'share':
      return formatPercent(value);
    case 'place':
      return value.toFixed(2);
    case 'seconds':
      return `${value.toFixed(1)} s`;
    case 'px':
      return px(value);
    default:
      return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
}

// ---------------------------------------------------------------------------------------------
// Heatmaps
// ---------------------------------------------------------------------------------------------

/** Each cell's time relative to the busiest cell (0..1), for shading. All zero when nothing was recorded. */
export function heatShades(h: Heatmap): number[] {
  const top = Math.max(0, ...h.counts);
  return h.counts.map((c) => (top > 0 ? c / top : 0));
}

/**
 * Where it spent its time, in words. The gym's own phrase, so the caption, the findings and the
 * LLM paste never describe the same heatmap differently: "Corners 62%, sides 30%, centre 8%;
 * busiest spot: the north-west corner, 45% of its time in one 240 px square; visited 23% of the map."
 */
export function heatSummary(h: Heatmap): string {
  if (h.total <= 0) return 'No time on this map.';
  const phrase = heatmapPhrase(h);
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}.`;
}
