import { describe, expect, it } from 'vitest';
import { strategyKey } from '../core';
import type { BatchRequest } from '../core';
import { buildBatch, fighterNames, runBatch } from './batch';
import { RatingBook } from './ratings';
import { fakeRunner, makeStrategy } from './testkit';

const field = ['Gary', 'Brenda', 'Doug', 'Mabel', 'Otis', 'Pip', 'Rosa'].map((n) => makeStrategy(n));
const candidate = makeStrategy('Lurking Daggers', { weapon: 'TWIN_DAGGERS', version: 3 });

function request(over: Partial<BatchRequest> = {}): BatchRequest {
  return { candidates: [candidate], field, mapIds: ['pit', 'catacombs'], matches: 14, fighters: 7, seed: 99, ...over };
}

const keysOf = (c: ReturnType<typeof buildBatch>[number]) => c.entrants.map((e) => strategyKey(e.strategy));

describe('buildBatch', () => {
  // "Same request, same reports" is what makes a gym result reproducible and watchable later.
  it('is deterministic in the request', () => {
    expect(buildBatch(request())).toEqual(buildBatch(request()));
    const a = buildBatch(request()).map((c) => c.seed);
    const b = buildBatch(request({ seed: 100 })).map((c) => c.seed);
    expect(a).not.toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });

  // Growing a batch must not reshuffle the matches already played.
  it('keeps earlier matches identical when the batch gets longer', () => {
    expect(buildBatch(request({ matches: 20 })).slice(0, 14)).toEqual(buildBatch(request()));
  });

  // Every candidate plays every match; the field fills the rest evenly with no repeats in a lineup.
  it('seats every candidate once per match and draws the field evenly', () => {
    const configs = buildBatch(request());
    const counts = new Map<string, number>();
    for (const c of configs) {
      const keys = keysOf(c);
      expect(keys.filter((k) => k === strategyKey(candidate))).toHaveLength(1);
      expect(new Set(keys).size).toBe(keys.length);
      for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const fieldCounts = field.map((s) => counts.get(strategyKey(s)) ?? 0);
    expect(fieldCounts.reduce((a, b) => a + b, 0)).toBe(14 * 6);
    expect(Math.max(...fieldCounts) - Math.min(...fieldCounts)).toBeLessThanOrEqual(1);
  });

  // Spawn points follow seat order; a fixed seat would hand one strategy the same spawn every time.
  it('shuffles seats and rotates maps', () => {
    const configs = buildBatch(request());
    const seats = configs.map((c) => keysOf(c).indexOf(strategyKey(candidate)));
    expect(new Set(seats).size).toBeGreaterThan(3);
    expect(configs.map((c) => c.mapId).slice(0, 4)).toEqual(['pit', 'catacombs', 'pit', 'catacombs']);
    for (const c of configs) {
      expect(c.entrants.map((e) => e.id)).toEqual(c.entrants.map((_, i) => `e${i}`));
      expect(c).toMatchObject({ format: 'ffa', friendlyFire: true, suddenDeath: true });
    }
  });

  it('fills free seats with mirror copies when there is no field', () => {
    const configs = buildBatch(request({ field: [], fighters: 3, candidates: [candidate, makeStrategy('Gary')] }));
    for (const c of configs) expect(c.entrants).toHaveLength(3);
  });

  it('rejects requests it cannot honour instead of guessing', () => {
    expect(() => buildBatch(request({ fighters: 1 }))).toThrow(/fighters/);
    expect(() => buildBatch(request({ mapIds: [] }))).toThrow(/map/);
    expect(() => buildBatch(request({ candidates: [candidate, candidate] }))).toThrow(/Lurking Daggers@v3/);
    expect(() => buildBatch(request({ candidates: field, fighters: 4 }))).toThrow(/do not fit/);
  });
});

describe('fighterNames', () => {
  // Kill lines and findings name fighters; two "Gary"s in one match would make them ambiguous.
  it('tells versions and mirror copies apart', () => {
    const g1 = makeStrategy('Gary', { version: 1 });
    const g2 = makeStrategy('Gary', { version: 2 });
    expect(fighterNames([g1, g2, makeStrategy('Doug')])).toEqual(['Gary v1', 'Gary v2', 'Doug']);
    expect(fighterNames([g1, g1, g1])).toEqual(['Gary', 'Gary II', 'Gary III']);
  });
});

describe('runBatch', () => {
  // The whole pipeline: configs -> runner -> reports -> ratings and aggregates, with progress.
  it('plays every match, reports progress and rates the batch', () => {
    const progress: number[] = [];
    const book = new RatingBook();
    const strong = (s: { name: string }) => (s.name === 'Lurking Daggers' ? 3 : 0);
    const result = runBatch(request(), fakeRunner(strong, 0.5), { book, fieldLabel: 'the house stacks', onProgress: (d) => progress.push(d) });
    expect(result.reports).toHaveLength(14);
    expect(progress).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(result.aggregate.matches).toBe(14);
    expect(result.aggregate.strategies[0]!.key).toBe('Lurking Daggers@v3');
    expect(book.record('Lurking Daggers@v3')!.matches).toBe(14);
    expect(result.aggregate.findings[0]).toMatch(/^Lurking Daggers v3 beats the house stacks 1[0-4] of 14 across 2 maps\.$/);
  });
});
