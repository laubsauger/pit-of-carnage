import { describe, expect, it } from 'vitest';
import { Rng, hashString } from './rng';

function draw(r: Rng, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(r.nextU32());
  return out;
}

describe('Rng determinism (replays, gym batches and shared seeds depend on it)', () => {
  it('produces the same stream for the same seed', () => {
    expect(draw(new Rng(1234), 1000)).toEqual(draw(new Rng(1234), 1000));
  });

  it('produces different streams for different seeds, even adjacent ones', () => {
    const a = draw(new Rng(1), 64);
    const b = draw(new Rng(2), 64);
    expect(a).not.toEqual(b);
    // Adjacent seeds must not share early outputs (players pick seeds like 1, 2, 3).
    expect(a.filter((v, i) => v === b[i]).length).toBe(0);
  });

  it('keeps a pinned stream so saved seeds and reports stay reproducible across code changes', () => {
    // If this fails, the generator changed: every stored seed now replays a different match.
    // Only update these numbers deliberately, together with a note that old replays are invalid.
    expect(draw(new Rng(42), 4)).toEqual(PINNED_SEED_42);
  });

  it('restores the exact stream from a saved state', () => {
    const r = new Rng(99);
    draw(r, 37);
    const saved = r.state;
    const expected = draw(r, 50);
    expect(draw(Rng.fromState(saved), 50)).toEqual(expected);
  });

  it('exposes state as a copy, so callers cannot corrupt the generator', () => {
    const r = new Rng(5);
    const s = r.state;
    s[0] = 0;
    s[1] = 0;
    expect(r.state).not.toEqual(s);
  });
});

describe('Rng.fork independence (subsystems must not shift each other\'s results)', () => {
  it('does not advance the parent: forking leaves the parent sequence unchanged', () => {
    const plain = new Rng(7);
    const forked = new Rng(7);
    forked.fork('brain:f1');
    forked.fork('combat');
    expect(draw(forked, 100)).toEqual(draw(plain, 100));
  });

  it('gives sibling forks streams that do not depend on how much the other one drew', () => {
    const p1 = new Rng(11);
    const a1 = p1.fork('brain:a');
    const b1 = p1.fork('brain:b');
    draw(a1, 500); // brain A thinks a lot
    const p2 = new Rng(11);
    p2.fork('brain:a'); // brain A never draws
    const b2 = p2.fork('brain:b');
    expect(draw(b1, 100)).toEqual(draw(b2, 100));
  });

  it('gives different labels unrelated streams and the same label the same stream', () => {
    const p = new Rng(3);
    const a = draw(p.fork('alpha'), 32);
    const b = draw(p.fork('beta'), 32);
    expect(a).not.toEqual(b);
    expect(draw(p.fork('alpha'), 32)).toEqual(a);
  });

  it('gives a fork a stream different from its parent', () => {
    const p = new Rng(3);
    const child = draw(p.fork('x'), 32);
    expect(child).not.toEqual(draw(new Rng(3), 32));
  });

  it('depends on the parent state, so forks taken after draws differ from forks taken before', () => {
    const p = new Rng(8);
    const early = draw(p.fork('round'), 16);
    p.next();
    expect(draw(p.fork('round'), 16)).not.toEqual(early);
  });
});

describe('Rng helpers', () => {
  it('int(a, b) includes both ends and nothing outside them', () => {
    const r = new Rng(21);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = r.int(1, 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      expect(Number.isInteger(v)).toBe(true);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('next() stays in [0, 1) with a mean near 0.5', () => {
    const r = new Rng(77);
    let sum = 0;
    for (let i = 0; i < 20000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(Math.abs(sum / 20000 - 0.5)).toBeLessThan(0.01);
  });

  it('chance() honours its extremes (rules with 0% or 100% must never surprise)', () => {
    const r = new Rng(4);
    for (let i = 0; i < 500; i++) {
      expect(r.chance(0)).toBe(false);
      expect(r.chance(1)).toBe(true);
    }
  });

  it('normal() has roughly the requested mean and spread', () => {
    const r = new Rng(13);
    const n = 20000;
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < n; i++) {
      const v = r.normal(10, 2);
      expect(Number.isFinite(v)).toBe(true);
      sum += v;
      sq += v * v;
    }
    const mean = sum / n;
    const sd = Math.sqrt(sq / n - mean * mean);
    expect(Math.abs(mean - 10)).toBeLessThan(0.1);
    expect(Math.abs(sd - 2)).toBeLessThan(0.1);
  });

  it('pick() throws on an empty array instead of returning undefined', () => {
    expect(() => new Rng(1).pick([])).toThrow();
  });

  it('shuffle() is a deterministic permutation', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = new Rng(9).shuffle([...xs]);
    expect(new Rng(9).shuffle([...xs])).toEqual(a);
    expect([...a].sort((x, y) => x - y)).toEqual(xs);
  });

  it('hashString is stable and label-sensitive', () => {
    expect(hashString('')).toBe(0x811c9dc5);
    expect(hashString('brain:a')).toBe(hashString('brain:a'));
    expect(hashString('brain:a')).not.toBe(hashString('brain:b'));
  });
});

/** First four nextU32() outputs for seed 42 (sfc32 checked against the reference implementation). */
const PINNED_SEED_42: number[] = [1028872839, 2516511472, 400437680, 853279530];
