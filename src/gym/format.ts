/**
 * Small formatting helpers shared by reports, findings and evolution summaries.
 * Everything a player or an LLM reads goes through these, so numbers look the same everywhere.
 */

import { TICK_HZ } from '../core';

/** Round to `digits` decimals (reports keep JSON short and stable). */
export function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Match clock: ticks as m:ss. */
export function clock(ticks: number): string {
  const s = Math.max(0, Math.round(ticks / TICK_HZ));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Whole-number percentage, "0%" when there is nothing to divide by. */
export function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%';
}

/** 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th, 21st. */
export function ordinalPlace(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const suffix = n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/** "Lurking Daggers v3": how a strategy is named in findings and summaries. */
export function versionedName(name: string, version: number): string {
  return `${name} v${version}`;
}

/** "a, b and c". */
export function listing(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** Count occurrences and return the most frequent value (ties: first in sort order), or null. */
export function mostFrequent<T extends string>(values: readonly T[]): { value: T; count: number } | null {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: { value: T; count: number } | null = null;
  for (const [value, count] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!best || count > best.count) best = { value, count };
  }
  return best;
}
