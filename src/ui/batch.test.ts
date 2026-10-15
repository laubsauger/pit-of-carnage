import { describe, expect, it } from 'vitest';
import { strategyKey } from '../core';
import type { Strategy } from '../core';
import { batchLineup, batchProblem, evolveProblem, readInt, sanitizeForm } from './batch';
import type { BatchForm } from './batch';

function strat(name: string, version = 1): Strategy {
  return {
    schema: 'pit-strategy/2', name, version,
    build: { weapon: 'LONGBOW', skill: 'DASH', attributes: { vitality: 16, power: 16, agility: 16, perception: 16, armor: 16, haste: 16 } },
    target: '0', behaviours: {}, commit: 30,
  };
}

describe('batchLineup', () => {
  it('drops repeats by name@vN, because two copies would pour into one report row and skew it', () => {
    const r = batchLineup([strat('Mine', 2), strat('Mine', 2)], [strat('Gary'), strat('Gary'), strat('Doug')]);
    expect(r.candidates.map(strategyKey)).toEqual(['Mine@v2']);
    expect(r.field.map(strategyKey)).toEqual(['Gary@v1', 'Doug@v1']);
  });

  it('keeps a strategy picked on both sides as a candidate, since it is the one being tested', () => {
    const r = batchLineup([strat('Mine', 2)], [strat('Mine', 2), strat('Gary')]);
    expect(r.candidates.map(strategyKey)).toEqual(['Mine@v2']);
    expect(r.field.map(strategyKey)).toEqual(['Gary@v1']);
  });

  it('treats different versions as different strategies, so v2 can be tested against v1', () => {
    const r = batchLineup([strat('Mine', 2)], [strat('Mine', 1)]);
    expect(r.field.map(strategyKey)).toEqual(['Mine@v1']);
  });
});

describe('batchProblem', () => {
  const ok = { candidates: 1, field: 8, maps: 1, matches: 20, fighters: 8 };

  it('lets a normal batch run', () => {
    expect(batchProblem(ok)).toBeNull();
  });

  it('names what is missing instead of sending a request the gym would reject', () => {
    expect(batchProblem({ ...ok, candidates: 0 })).toMatch(/test/);
    expect(batchProblem({ ...ok, maps: 0 })).toMatch(/map/);
    expect(batchProblem({ ...ok, matches: 0 })).toMatch(/match/);
    expect(batchProblem({ ...ok, fighters: 17 })).toMatch(/2 to 16/);
  });

  it('refuses more candidates than slots, since every candidate is promised a seat in every match', () => {
    expect(batchProblem({ ...ok, candidates: 9 })).toMatch(/do not fit/);
    expect(batchProblem({ ...ok, candidates: 8, field: 0 })).toBeNull();
  });

  it('needs opponents only when there are empty seats to fill', () => {
    expect(batchProblem({ ...ok, field: 0 })).toMatch(/opponents/);
  });
});

describe('evolveProblem', () => {
  const ok = { parentValid: true, field: 8, maps: 1, generations: 5, population: 6, matches: 8, fighters: 8 };

  it('needs a valid parent and a fixed field, the two things evolution measures against', () => {
    expect(evolveProblem(ok)).toBeNull();
    expect(evolveProblem({ ...ok, parentValid: false })).toMatch(/editor/);
    expect(evolveProblem({ ...ok, field: 0 })).toMatch(/opponents/i);
    expect(evolveProblem({ ...ok, population: 0 })).toMatch(/at least 1/);
  });
});

describe('sanitizeForm', () => {
  const fallback: BatchForm = { candidates: ['draft'], field: ['house:Gary'], maps: ['pit'], matches: 20, fighters: 8, seed: 7 };

  it('keeps well-formed fields from storage', () => {
    const stored = { ...fallback, matches: 50, maps: ['pit', 'catacombs'] };
    expect(sanitizeForm(stored, fallback)).toEqual(stored);
  });

  it('replaces only the broken fields of an old or hand-edited form, so the gym still opens', () => {
    const s = sanitizeForm({ matches: 'lots', fighters: Number.NaN, maps: ['pit', 3], field: ['house:Doug'], extra: true }, fallback);
    expect(s).toEqual({ ...fallback, field: ['house:Doug'] });
  });

  it('ignores junk that is not an object', () => {
    expect(sanitizeForm('nope', fallback)).toBe(fallback);
    expect(sanitizeForm(null, fallback)).toBe(fallback);
  });
});

describe('readInt', () => {
  it('clamps to the allowed range', () => {
    expect(readInt('40', 2, 16, 8)).toBe(16);
    expect(readInt('1', 2, 16, 8)).toBe(2);
    expect(readInt('12', 2, 16, 8)).toBe(12);
  });

  it('falls back on half-typed input instead of passing NaN into a request', () => {
    expect(readInt('', 2, 16, 8)).toBe(8);
    expect(readInt('-', 2, 16, 8)).toBe(8);
  });
});
