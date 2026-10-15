// Owned by: ui
// Pure model of the full-screen fighter overview (key I) and the strategy sheet: score history for
// the sparklines, the commit timer, sensors with their registry docs, memory slots, and the
// fighter's own event log. No React, so it is unit-tested directly.
import { TICK_HZ } from '../../core';
import type { Decision, FeedItem, MoveTerm, TimelineMark } from '../../core';
import { SENSORS } from '../../brain';
import { markForFeed } from '../hud';

/**
 * Rivals' strategies are visible to everyone for now (debugging and learning). Rooms will get a
 * setting for whether they are revealed after a match; this one flag keeps that decision cheap.
 */
export const REVEAL_RIVAL_STRATEGIES = true;

/**
 * Proposed core refinement (not in `Decision` yet): the target expression's score for every known
 * enemy this think, by fighter id. The overview shows a score column only when a brain provides it.
 */
export type DecisionWithTargets = Decision & { targetScores?: Record<string, number> };

// ---------------------------------------------------------------------------------------------
// Score history (sparklines) and the commit timer
// ---------------------------------------------------------------------------------------------

/** The sparklines show this much of the past: about ten seconds of thinking. */
export const HISTORY_TICKS = 10 * TICK_HZ;

export type ScorePoint = { tick: number; behaviour: string; scores: Record<string, number> };

/**
 * Add one think to the history. Time is the match's, not the wall clock's: a seek backwards (or a
 * jump forward past the window) starts a fresh history, because the old points belong to another
 * stretch of the match and a sparkline across the gap would invent a trend.
 */
export function pushHistory(hist: readonly ScorePoint[], p: ScorePoint, windowTicks = HISTORY_TICKS): ScorePoint[] {
  const last = hist[hist.length - 1];
  if (last && (p.tick < last.tick || p.tick - last.tick > windowTicks)) return [p];
  if (last && p.tick === last.tick) return hist as ScorePoint[];
  const out = hist.filter((h) => h.tick >= p.tick - windowTicks);
  out.push(p);
  return out;
}

/** One shared scale for every behaviour's sparkline (always including 0), so lines can be compared. */
export function scoreRange(hist: readonly ScorePoint[]): { lo: number; hi: number } {
  let lo = 0;
  let hi = 0;
  for (const p of hist) {
    for (const v of Object.values(p.scores)) {
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (hi - lo < 1e-6) hi = lo + 1;
  return { lo, hi };
}

/**
 * SVG polyline points for one behaviour's score over the window ending at `now`. Older points sit
 * left, `now` at the right edge; a behaviour missing from a think is skipped.
 */
export function sparkPoints(hist: readonly ScorePoint[], name: string, now: number, w: number, h: number, range: { lo: number; hi: number }, windowTicks = HISTORY_TICKS): string {
  const out: string[] = [];
  for (const p of hist) {
    const v = p.scores[name];
    if (v === undefined || !Number.isFinite(v)) continue;
    const x = w - ((now - p.tick) / windowTicks) * w;
    const y = h - ((v - range.lo) / (range.hi - range.lo)) * h;
    out.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return out.join(' ');
}

/**
 * Commit timer: ticks left of the commit bonus for the running behaviour, measured from the think
 * it took over. `exact` is false when the history does not reach back to that think (the overview
 * opened mid-run), so the number is an upper bound.
 */
export function commitLeft(hist: readonly ScorePoint[], commitTicks: number, now: number): { left: number; exact: boolean } | null {
  const last = hist[hist.length - 1];
  if (!last) return null;
  let i = hist.length - 1;
  while (i > 0 && hist[i - 1]!.behaviour === last.behaviour) i--;
  const since = now - hist[i]!.tick;
  return { left: Math.max(0, commitTicks - since), exact: i > 0 };
}

// ---------------------------------------------------------------------------------------------
// Sensors and memory
// ---------------------------------------------------------------------------------------------

export type SensorGroup = 'You' | 'Target' | 'Others' | 'Around' | 'Match';
export const SENSOR_GROUPS: readonly SensorGroup[] = ['You', 'Target', 'Others', 'Around', 'Match'];

export function sensorGroup(name: string): SensorGroup {
  if (name.startsWith('target.')) return 'Target';
  if (name.startsWith('enemies_') || name.startsWith('ally') || name === 'fights_nearby' || name === 'allies_alive') return 'Others';
  if (name.startsWith('pickup.') || name.startsWith('shrine.') || name === 'ammo.distance' || name === 'hazard.distance') return 'Around';
  if (name === 'time' || name === 'sudden_death' || name.startsWith('zone.')) return 'Match';
  return 'You';
}

export type SensorRow = { name: string; value: number; unit: string; range: string; doc: string; group: SensorGroup };

const REGISTRY = new Map(SENSORS.map((s, i) => [s.name, { def: s, order: i }]));

/**
 * The decision's sensor values with the registry's unit, range and doc, grouped and in registry
 * order; anything the registry does not know is a memory slot (the brain reports those alongside).
 */
export function sensorRows(sensors: Record<string, number>): { sensors: SensorRow[]; memory: { name: string; value: number }[] } {
  const rows: (SensorRow & { order: number })[] = [];
  const memory: { name: string; value: number }[] = [];
  for (const [name, value] of Object.entries(sensors)) {
    const reg = REGISTRY.get(name);
    if (!reg) {
      memory.push({ name, value });
      continue;
    }
    rows.push({ name, value, unit: reg.def.unit, range: reg.def.range, doc: reg.def.doc, group: sensorGroup(name), order: reg.order });
  }
  rows.sort((a, b) => SENSOR_GROUPS.indexOf(a.group) - SENSOR_GROUPS.indexOf(b.group) || a.order - b.order);
  memory.sort((a, b) => a.name.localeCompare(b.name));
  return { sensors: rows.map(({ order: _order, ...r }) => r), memory };
}

/** A sensor value with its unit, the way players read it ("0.42 of max", "312 px", "yes"). */
export function sensorValueText(value: number, unit: string): string {
  if (unit === '0/1') return value > 0 ? 'yes' : 'no';
  if (!Number.isFinite(value)) return String(value);
  // The brain's "nothing to measure" distance (far beyond any map).
  if (unit === 'px' && value >= 9999) return 'none';
  const v = Math.abs(value) >= 100 ? Math.round(value).toString() : Number.isInteger(value) ? value.toString() : value.toFixed(2);
  switch (unit) {
    case 'px':
    case 's':
    case 'hp':
      return `${v} ${unit}`;
    case 'ticks':
      return `${v} ticks`;
    default:
      return v;
  }
}

// ---------------------------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------------------------

export type LogEntry = { tick: number; text: string; kind: string; /** It caused it, it happened to it, or it is just mentioned. */ role: 'did' | 'took' | 'about' };

/**
 * The fighter's own story, newest first: every timeline mark it caused or suffered, plus feed lines
 * that name it and have no mark of their own (no line is listed twice).
 */
export function fighterLog(id: string, feed: readonly FeedItem[], marks: readonly TimelineMark[]): LogEntry[] {
  const out: LogEntry[] = [];
  for (const m of marks) {
    if (m.actorId !== id && m.targetId !== id) continue;
    out.push({ tick: m.tick, text: m.text, kind: m.kind, role: m.actorId === id ? 'did' : 'took' });
  }
  for (const item of feed) {
    if (!item.ids.includes(id) || markForFeed(item, marks)) continue;
    out.push({ tick: item.tick, text: item.text, kind: item.kind, role: 'about' });
  }
  return out.sort((a, b) => b.tick - a.tick);
}

// ---------------------------------------------------------------------------------------------
// Strategy, read-only
// ---------------------------------------------------------------------------------------------

/** A move term in one line, as the strategy writes it: "keep_range target 220-320 x1". */
export function termLabel(t: MoveTerm): string {
  const w = ` x${t.weight}`;
  if ('seek' in t) return `seek ${t.seek}${w}`;
  if ('flee' in t) return `flee ${t.flee}${w}`;
  if ('keep_range' in t) return `keep_range ${t.keep_range[0]} ${t.keep_range[1]}-${t.keep_range[2]}${w}`;
  if ('orbit' in t) return `orbit ${t.orbit[0]} ${t.orbit[1]}${w}`;
  if ('avoid' in t) return `avoid ${t.avoid}${w}`;
  return `prefer ${t.prefer}${w}`;
}
