import { describe, expect, it } from 'vitest';
import { STEER_DIRS } from './constants';
import {
  STEER_COS,
  STEER_SIN,
  angleDiff,
  circleHitsRect,
  circleRectPush,
  distPointSegmentSq,
  lerpAngle,
  segmentCircleT,
  segmentHitsRect,
  segmentRectT,
  stepAngle,
  steerAngle,
  steerIndex,
  v2,
  v2Add,
  v2Normalize,
  v2Rotate,
  wrapAngle,
} from './math';
import type { Rect } from './types';

const pillar: Rect = { x: 100, y: 100, w: 40, h: 40 };

describe('angles (facing and turn-rate limiting must never spin the long way round)', () => {
  it('wraps any angle into (-π, π]', () => {
    for (const a of [-10, -Math.PI, -1, 0, 1, Math.PI, 3 * Math.PI, 10, 100]) {
      const w = wrapAngle(a);
      expect(w).toBeGreaterThan(-Math.PI - 1e-12);
      expect(w).toBeLessThanOrEqual(Math.PI + 1e-12);
      expect(Math.cos(w)).toBeCloseTo(Math.cos(a), 9);
      expect(Math.sin(w)).toBeCloseTo(Math.sin(a), 9);
    }
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI, 12);
  });

  it('angleDiff takes the short way across the ±π seam', () => {
    expect(angleDiff(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2, 9);
    expect(angleDiff(-Math.PI + 0.1, Math.PI - 0.1)).toBeCloseTo(-0.2, 9);
  });

  it('stepAngle turns at most maxStep and lands exactly on target when close', () => {
    expect(stepAngle(0, 1, 0.25)).toBeCloseTo(0.25, 12);
    expect(stepAngle(0, 0.1, 0.25)).toBeCloseTo(0.1, 12);
    // Across the seam it must turn through π, not back through 0.
    const s = stepAngle(Math.PI - 0.05, -Math.PI + 0.05, 0.05);
    expect(Math.abs(angleDiff(s, Math.PI))).toBeLessThan(1e-9);
  });

  it('lerpAngle interpolates along the shortest arc', () => {
    expect(Math.abs(lerpAngle(Math.PI - 0.2, -Math.PI + 0.2, 0.5))).toBeCloseTo(Math.PI, 9);
  });

  it('steering directions and steerIndex agree, including near 2π', () => {
    for (let i = 0; i < STEER_DIRS; i++) {
      expect(STEER_COS[i]).toBeCloseTo(Math.cos(steerAngle(i)), 12);
      expect(STEER_SIN[i]).toBeCloseTo(Math.sin(steerAngle(i)), 12);
      expect(steerIndex(steerAngle(i))).toBe(i);
    }
    expect(steerIndex(-0.01)).toBe(0);
    expect(steerIndex(2 * Math.PI - 0.01)).toBe(0);
    expect(steerIndex(-Math.PI / 2)).toBe(STEER_DIRS * 0.75);
  });
});

describe('Vec2 out-params (hot paths reuse scratch vectors, often aliased)', () => {
  it('allows out to alias an input', () => {
    const a = v2(1, 0);
    v2Rotate(a, a, Math.PI / 2);
    expect(a.x).toBeCloseTo(0, 12);
    expect(a.y).toBeCloseTo(1, 12);
    v2Add(a, a, a);
    expect(a.y).toBeCloseTo(2, 12);
  });

  it('normalizing a zero vector yields zero, not NaN (a NaN position would poison the sim)', () => {
    const out = v2Normalize(v2(), v2(0, 0));
    expect(out).toEqual({ x: 0, y: 0 });
  });
});

describe('segment vs AABB (line of sight and projectile stops)', () => {
  it('a sightline through a pillar is blocked, one beside it is not', () => {
    expect(segmentHitsRect(v2(50, 120), v2(200, 120), pillar)).toBe(true);
    expect(segmentHitsRect(v2(50, 90), v2(200, 90), pillar)).toBe(false);
  });

  it('returns the entry point so projectiles stop at the wall surface', () => {
    const t = segmentRectT(v2(0, 120), v2(200, 120), pillar);
    expect(t).toBeCloseTo(0.5, 12); // x = 100 is the pillar's left face
  });

  it('handles axis-parallel segments and segments that end before the rect', () => {
    expect(segmentHitsRect(v2(120, 0), v2(120, 300), pillar)).toBe(true);
    expect(segmentHitsRect(v2(150, 0), v2(150, 300), pillar)).toBe(false);
    expect(segmentHitsRect(v2(0, 120), v2(99, 120), pillar)).toBe(false);
  });

  it('reports t = 0 when the segment starts inside', () => {
    expect(segmentRectT(v2(110, 110), v2(300, 300), pillar)).toBe(0);
  });

  it('catches a diagonal that clips a corner', () => {
    expect(segmentHitsRect(v2(90, 125), v2(110, 145), pillar)).toBe(true);
    expect(segmentHitsRect(v2(80, 130), v2(95, 150), pillar)).toBe(false);
  });
});

describe('segment vs circle (projectile hits on fighters)', () => {
  it('finds the first contact along the path', () => {
    const t = segmentCircleT(v2(0, 0), v2(100, 0), v2(50, 0), 10);
    expect(t).toBeCloseTo(0.4, 12);
  });

  it('misses a fighter beside the path and one beyond its end', () => {
    expect(segmentCircleT(v2(0, 0), v2(100, 0), v2(50, 20), 10)).toBe(-1);
    expect(segmentCircleT(v2(0, 0), v2(30, 0), v2(50, 0), 10)).toBe(-1);
  });

  it('reports 0 when the projectile starts inside the circle', () => {
    expect(segmentCircleT(v2(48, 0), v2(100, 0), v2(50, 0), 10)).toBe(0);
  });

  it('distPointSegmentSq clamps to the segment ends', () => {
    expect(distPointSegmentSq(v2(5, 3), v2(0, 0), v2(10, 0))).toBeCloseTo(9, 12);
    expect(distPointSegmentSq(v2(-4, 3), v2(0, 0), v2(10, 0))).toBeCloseTo(25, 12);
  });
});

describe('circle vs AABB (fighter collision with walls and pillars)', () => {
  it('detects overlap and separation', () => {
    expect(circleHitsRect(v2(95, 120), 10, pillar)).toBe(true);
    expect(circleHitsRect(v2(85, 120), 10, pillar)).toBe(false);
    // Near a corner, distance is to the corner, not the edges' extensions.
    expect(circleHitsRect(v2(93, 93), 9, pillar)).toBe(false);
    expect(circleHitsRect(v2(95, 95), 9, pillar)).toBe(true);
  });

  it('push resolves the overlap exactly: after applying it the circle just touches', () => {
    const c = v2(95, 120);
    const push = v2();
    expect(circleRectPush(push, c, 10, pillar)).toBe(true);
    v2Add(c, c, push);
    expect(c.x).toBeCloseTo(90, 9);
    expect(c.y).toBeCloseTo(120, 9);
    expect(circleHitsRect(c, 10, pillar)).toBe(false);
  });

  it('pushes a centre that ended up inside out through the nearest face (no tunnelling)', () => {
    const c = v2(135, 120); // 5 px from the right face
    const push = v2();
    expect(circleRectPush(push, c, 10, pillar)).toBe(true);
    v2Add(c, c, push);
    expect(c.x).toBeCloseTo(150, 9);
    expect(circleHitsRect(c, 10, pillar)).toBe(false);
  });

  it('pushes diagonally away from a corner', () => {
    const c = v2(95, 95);
    const push = v2();
    expect(circleRectPush(push, c, 9, pillar)).toBe(true);
    expect(push.x).toBeLessThan(0);
    expect(push.y).toBeLessThan(0);
    v2Add(c, c, push);
    expect(Math.hypot(c.x - 100, c.y - 100)).toBeCloseTo(9, 9);
  });

  it('returns false and a zero push when apart', () => {
    const push = v2(5, 5);
    expect(circleRectPush(push, v2(10, 10), 5, pillar)).toBe(false);
    expect(push).toEqual({ x: 0, y: 0 });
  });
});
