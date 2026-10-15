import { describe, expect, it } from 'vitest';
import { STREAK, createStreak, streakLength, streakStep } from './streaks';
import type { StreakStamp } from './streaks';

const half = () => 0.5;

type Copy = Omit<StreakStamp, never>;

/** Slide a piece along +x from 0 to `dist` in `steps` equal segments at a fixed speed. */
function slide(dist: number, steps: number, speed: number, width = 8, wet = 1): Copy[] {
  const s = createStreak(width, wet);
  const out: Copy[] = [];
  const seg = dist / steps;
  for (let i = 0; i < steps; i++) streakStep(s, i * seg, 0, (i + 1) * seg, 0, speed, half, (st) => out.push({ ...st }));
  return out;
}

describe('limb and gib streaks', () => {
  // The trail must not depend on frame rate or slow motion: the same slide split into many tiny
  // frames leaves the same stamps as one big frame.
  it('stamps by distance travelled, not by frame count', () => {
    const coarse = slide(300, 1, 200);
    const fine = slide(300, 120, 200);
    expect(fine.length).toBe(coarse.length);
    for (let i = 0; i < coarse.length; i++) expect(fine[i].x).toBeCloseTo(coarse[i].x, 6);
  });

  // A fast slide reads as one continuous smear: each stamp overlaps the next.
  it('overlaps stamps into a continuous smear at speed', () => {
    const stamps = slide(200, 10, 260);
    expect(stamps.length).toBeGreaterThan(5);
    for (let i = 1; i < stamps.length; i++) {
      const gap = stamps[i].x - stamps[i - 1].x;
      expect(gap).toBeLessThan(stamps[i - 1].length);
      expect(stamps[i].fleck).toBe(false);
    }
  });

  it('spaces and sizes the smear by speed: faster is wider and longer', () => {
    const fast = slide(100, 1, 300)[0];
    const slow = slide(100, 1, 110)[0];
    expect(fast.width).toBeGreaterThan(slow.width);
    expect(fast.length).toBeGreaterThan(slow.length);
    const s = createStreak(8);
    expect(streakLength(s, 300)).toBeGreaterThan(streakLength(s, 110));
  });

  // As the piece slows the smear thins, then breaks into small separated flecks.
  it('breaks into flecks with gaps once the piece is slow', () => {
    const flecks = slide(200, 20, STREAK.fleckSpeed - 20);
    expect(flecks.length).toBeGreaterThan(3);
    expect(flecks.every((f) => f.fleck)).toBe(true);
    const continuous = slide(200, 20, 220)[0];
    for (let i = 1; i < flecks.length; i++) {
      expect(flecks[i].x - flecks[i - 1].x).toBeGreaterThan(flecks[i - 1].length);
      expect(flecks[i].width).toBeLessThan(continuous.width);
    }
  });

  it('runs out of blood: wetness drops per stamp and the trail ends', () => {
    const s = createStreak(8, 0.3);
    let n = 0;
    let lastWet = 1;
    for (let i = 0; i < 400; i++) {
      streakStep(s, i * 5, 0, (i + 1) * 5, 0, 200, half, (st) => {
        expect(st.wet).toBeLessThanOrEqual(lastWet);
        lastWet = st.wet;
        n++;
      });
    }
    expect(s.wet).toBe(0);
    expect(n).toBeGreaterThan(5);
    expect(streakStep(s, 0, 0, 100, 0, 200, half, () => n++)).toBe(0);
  });

  it('stamps nothing when the piece is nearly still or was never bloody', () => {
    expect(slide(100, 5, STREAK.stopSpeed - 1).length).toBe(0);
    expect(slide(100, 5, 200, 8, 0).length).toBe(0);
  });

  it('points each stamp along the direction of travel', () => {
    const s = createStreak(8);
    const angles: number[] = [];
    streakStep(s, 0, 0, 0, 120, 250, half, (st) => angles.push(st.angle));
    expect(angles.length).toBeGreaterThan(0);
    for (const a of angles) expect(a).toBeCloseTo(Math.PI / 2, 6);
  });
});
