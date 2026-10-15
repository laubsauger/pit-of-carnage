import { describe, expect, it } from 'vitest';
import { BLOOD_AMOUNT, SPLATTER, deathSplatter } from './splatter';
import type { SplatterStamp } from './splatter';

/** Deterministic random source for repeatable shapes. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function angleDiff(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

describe('blood amount setting', () => {
  // The View setting must actually change how much gore there is, in order.
  it('scales count and size from light to carnage', () => {
    expect(BLOOD_AMOUNT.light.count).toBeLessThan(BLOOD_AMOUNT.normal.count);
    expect(BLOOD_AMOUNT.normal.count).toBeLessThan(BLOOD_AMOUNT.carnage.count);
    expect(BLOOD_AMOUNT.light.size).toBeLessThan(BLOOD_AMOUNT.normal.size);
    expect(BLOOD_AMOUNT.normal.size).toBeLessThan(BLOOD_AMOUNT.carnage.size);
    expect(BLOOD_AMOUNT.normal).toEqual({ count: 1, size: 1 });
  });
});

describe('death splatter', () => {
  const out: SplatterStamp[] = [];

  // A death is an explosion painted far across the floor, not a puddle.
  it('reaches far across the floor', () => {
    for (let seed = 1; seed < 20; seed++) {
      const n = deathSplatter(out, 0, BLOOD_AMOUNT.normal, seeded(seed));
      let reach = 0;
      for (let i = 0; i < n; i++) reach = Math.max(reach, out[i].dist + (out[i].arm ? out[i].halfLen : 0));
      expect(reach).toBeGreaterThan(160);
    }
  });

  it('sprays in every direction, with no big gap in the ring', () => {
    for (let seed = 1; seed < 20; seed++) {
      const n = deathSplatter(out, 1.3, BLOOD_AMOUNT.light, seeded(seed));
      const arms = out.slice(0, n).filter((s) => s.arm).map((s) => ((s.angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
      arms.sort((a, b) => a - b);
      let gap = 2 * Math.PI - arms[arms.length - 1] + arms[0];
      for (let i = 1; i < arms.length; i++) gap = Math.max(gap, arms[i] - arms[i - 1]);
      expect(arms.length).toBeGreaterThanOrEqual(6);
      expect(gap).toBeLessThan((2 * Math.PI) / 4);
    }
  });

  // The killing blow throws the body's contents forward: arms along it are longer than against it.
  it('throws more blood further along the killing blow', () => {
    const dir = 0.7;
    let along = 0;
    let against = 0;
    for (let seed = 1; seed < 40; seed++) {
      const n = deathSplatter(out, dir, BLOOD_AMOUNT.normal, seeded(seed));
      for (let i = 0; i < n; i++) {
        if (!out[i].arm) continue;
        const d = angleDiff(out[i].angle, dir);
        if (d < Math.PI / 4) along += out[i].halfLen;
        else if (d > (3 * Math.PI) / 4) against += out[i].halfLen;
      }
    }
    expect(along).toBeGreaterThan(against * 1.5);
  });

  it('paints more with more blood', () => {
    const light = deathSplatter(out, 0, BLOOD_AMOUNT.light, seeded(3));
    const normal = deathSplatter(out, 0, BLOOD_AMOUNT.normal, seeded(3));
    const carnage = deathSplatter(out, 0, BLOOD_AMOUNT.carnage, seeded(3));
    expect(light).toBeLessThan(normal);
    expect(normal).toBeLessThan(carnage);
    expect(normal).toBeGreaterThanOrEqual(SPLATTER.arms + SPLATTER.flecks);
  });

  it('reuses its output array instead of allocating per death', () => {
    const buf: SplatterStamp[] = [];
    deathSplatter(buf, 0, BLOOD_AMOUNT.carnage, seeded(1));
    const first = buf[0];
    const len = buf.length;
    deathSplatter(buf, 0, BLOOD_AMOUNT.normal, seeded(2));
    expect(buf[0]).toBe(first);
    expect(buf.length).toBe(len);
  });
});
