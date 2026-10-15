// Owned by: ui
// Pure helpers for planning gym runs: who plays, and why a run cannot start yet.
import { MAX_FIGHTERS, MIN_FIGHTERS, clamp, strategyKey } from '../core';
import type { Strategy } from '../core';

/**
 * Candidates and field for a batch, de-duplicated by `name@vN`. Reports and ratings key on that,
 * so the same strategy listed twice would pour two entries' numbers into one row. A strategy
 * picked as both candidate and opponent stays a candidate (it is the thing being tested).
 */
export function batchLineup(candidates: readonly Strategy[], field: readonly Strategy[]): { candidates: Strategy[]; field: Strategy[] } {
  const seen = new Set<string>();
  const keep = (s: Strategy) => {
    const k = strategyKey(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  const c = candidates.filter(keep);
  return { candidates: c, field: field.filter(keep) };
}

export type BatchPlan = { candidates: number; field: number; maps: number; matches: number; fighters: number };

/** Why a batch cannot run, worded for the run bar, or null when it can. */
export function batchProblem(p: BatchPlan): string | null {
  if (p.candidates === 0) return 'Pick at least one strategy to test.';
  if (p.maps === 0) return 'Pick at least one map.';
  if (p.matches < 1) return 'Run at least one match.';
  if (p.fighters < MIN_FIGHTERS || p.fighters > MAX_FIGHTERS) return `Matches take ${MIN_FIGHTERS} to ${MAX_FIGHTERS} fighters.`;
  if (p.candidates > p.fighters) return `${p.candidates} strategies do not fit in ${p.fighters}-fighter matches.`;
  if (p.candidates < p.fighters && p.field === 0) return 'Pick opponents to fill the other slots.';
  return null;
}

export type EvolvePlan = { parentValid: boolean; field: number; maps: number; generations: number; population: number; matches: number; fighters: number };

/** Why an evolution run cannot start, or null. */
export function evolveProblem(p: EvolvePlan): string | null {
  if (!p.parentValid) return 'Fix the strategy in the editor first; evolution starts from it.';
  if (p.field === 0) return 'Pick opponents. Evolution needs a fixed field to measure against.';
  if (p.maps === 0) return 'Pick at least one map.';
  if (p.generations < 1 || p.population < 1 || p.matches < 1) return 'Generations, population and matches must be at least 1.';
  if (p.fighters < MIN_FIGHTERS || p.fighters > MAX_FIGHTERS) return `Matches take ${MIN_FIGHTERS} to ${MAX_FIGHTERS} fighters.`;
  return null;
}

/** Gym batch form, persisted per browser. Strategy picks are slot refs (see setup.ts) plus `draft`. */
export type BatchForm = { candidates: string[]; field: string[]; maps: string[]; matches: number; fighters: number; seed: number };
export type EvolveForm = { field: string[]; maps: string[]; generations: number; population: number; matches: number; fighters: number; seed: number };

/**
 * Read a stored form back field by field: a value is kept only when it has the same shape as the
 * default (finite number, or list of strings). A form saved by an older build, or edited by hand,
 * then loses only its broken fields instead of breaking the gym.
 */
export function sanitizeForm<T extends Record<string, number | string[]>>(value: unknown, fallback: T): T {
  if (typeof value !== 'object' || value === null) return fallback;
  const v = value as Record<string, unknown>;
  const out = { ...fallback } as Record<string, number | string[]>;
  for (const key of Object.keys(fallback)) {
    const want = fallback[key];
    const got = v[key];
    if (typeof want === 'number' && typeof got === 'number' && Number.isFinite(got)) out[key] = got;
    else if (Array.isArray(want) && Array.isArray(got) && got.every((x) => typeof x === 'string')) out[key] = got as string[];
  }
  return out as T;
}

/**
 * Whole number from a form field, clamped to [min, max]. Half-typed input ("", "-", "1e") falls
 * back instead of becoming NaN, which would otherwise travel into a batch request.
 */
export function readInt(text: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
}
