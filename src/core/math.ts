/**
 * Allocation-free math for hot paths.
 *
 * Vec2 helpers write into an `out` parameter and return it, so per-tick code can reuse scratch
 * vectors (`const tmp = v2()` once at module scope, then `v2Sub(tmp, a, b)` every tick). `out` may
 * alias an input. Only `v2()` allocates.
 *
 * Angles follow the world convention in types.ts: radians from +x toward +y (`Math.atan2(dy, dx)`).
 */

import { STEER_DIRS } from './constants';
import type { Rect, Vec2 } from './types';

export const TAU = Math.PI * 2;
const EPS = 1e-9;

// ---------------------------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------------------------

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse of lerp: where v sits between a and b (unclamped). Returns 0 when a === b. */
export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

/** Hermite smoothstep of x between edges e0 and e1, clamped to [0, 1]. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01(invLerp(e0, e1, x));
  return t * t * (3 - 2 * t);
}

/** Move `current` toward `target` by at most `maxStep`. */
export function approach(current: number, target: number, maxStep: number): number {
  const d = target - current;
  return Math.abs(d) <= maxStep ? target : current + Math.sign(d) * maxStep;
}

// ---------------------------------------------------------------------------------------------
// Vec2
// ---------------------------------------------------------------------------------------------

/** Allocate a vector. Use at setup time, not per tick. */
export function v2(x = 0, y = 0): Vec2 {
  return { x, y };
}

export function v2Set(out: Vec2, x: number, y: number): Vec2 {
  out.x = x;
  out.y = y;
  return out;
}

export function v2Copy(out: Vec2, a: Vec2): Vec2 {
  out.x = a.x;
  out.y = a.y;
  return out;
}

export function v2Add(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  return out;
}

export function v2Sub(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  return out;
}

export function v2Scale(out: Vec2, a: Vec2, s: number): Vec2 {
  out.x = a.x * s;
  out.y = a.y * s;
  return out;
}

/** out = a + b * s */
export function v2AddScaled(out: Vec2, a: Vec2, b: Vec2, s: number): Vec2 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  return out;
}

export function v2Len(a: Vec2): number {
  return Math.sqrt(a.x * a.x + a.y * a.y);
}

export function v2LenSq(a: Vec2): number {
  return a.x * a.x + a.y * a.y;
}

export function v2Dist(a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function v2DistSq(a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dx * dx + dy * dy;
}

export function v2Dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** z component of the 3D cross product; > 0 when b is clockwise-on-screen (toward +y) from a. */
export function v2Cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

/** Unit vector in the direction of a. A zero vector stays zero (no NaN). */
export function v2Normalize(out: Vec2, a: Vec2): Vec2 {
  const len = Math.sqrt(a.x * a.x + a.y * a.y);
  if (len < EPS) return v2Set(out, 0, 0);
  return v2Set(out, a.x / len, a.y / len);
}

export function v2Lerp(out: Vec2, a: Vec2, b: Vec2, t: number): Vec2 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  return out;
}

/** Rotate a by `angle` radians (toward +y for positive angles). */
export function v2Rotate(out: Vec2, a: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const x = a.x * c - a.y * s;
  out.y = a.x * s + a.y * c;
  out.x = x;
  return out;
}

export function v2FromAngle(out: Vec2, angle: number, length = 1): Vec2 {
  out.x = Math.cos(angle) * length;
  out.y = Math.sin(angle) * length;
  return out;
}

/** Angle of a (radians, atan2 convention). */
export function v2Angle(a: Vec2): number {
  return Math.atan2(a.y, a.x);
}

/** Angle of the direction from `from` to `to`. */
export function angleTo(from: Vec2, to: Vec2): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/** Scale a down to at most `max` length (direction kept). */
export function v2ClampLen(out: Vec2, a: Vec2, max: number): Vec2 {
  const lenSq = a.x * a.x + a.y * a.y;
  if (lenSq <= max * max) return v2Copy(out, a);
  const k = max / Math.sqrt(lenSq);
  return v2Set(out, a.x * k, a.y * k);
}

// ---------------------------------------------------------------------------------------------
// Angles
// ---------------------------------------------------------------------------------------------

/** Wrap any angle into (-π, π]. */
export function wrapAngle(a: number): number {
  a = a % TAU;
  if (a <= -Math.PI) a += TAU;
  else if (a > Math.PI) a -= TAU;
  return a;
}

/** Signed shortest rotation from `from` to `to`, in (-π, π]. */
export function angleDiff(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Interpolate along the shortest arc; result wrapped into (-π, π]. */
export function lerpAngle(a: number, b: number, t: number): number {
  return wrapAngle(a + angleDiff(a, b) * t);
}

/** Turn `current` toward `target` by at most `maxStep` radians (turn-rate limiting). Result wrapped. */
export function stepAngle(current: number, target: number, maxStep: number): number {
  const d = angleDiff(current, target);
  if (Math.abs(d) <= maxStep) return wrapAngle(target);
  return wrapAngle(current + Math.sign(d) * maxStep);
}

/** Precomputed cos of each steering direction: index i is angle i * 2π / STEER_DIRS. */
export const STEER_COS: readonly number[] = Array.from({ length: STEER_DIRS }, (_, i) => Math.cos((i * TAU) / STEER_DIRS));
/** Precomputed sin of each steering direction. */
export const STEER_SIN: readonly number[] = Array.from({ length: STEER_DIRS }, (_, i) => Math.sin((i * TAU) / STEER_DIRS));

/** Angle of steering direction i. */
export function steerAngle(i: number): number {
  return (i * TAU) / STEER_DIRS;
}

/** Index of the steering direction closest to `angle`. */
export function steerIndex(angle: number): number {
  // The second modulo also normalises -0 to 0.
  return ((Math.round((angle / TAU) * STEER_DIRS) % STEER_DIRS) + STEER_DIRS) % STEER_DIRS;
}

// ---------------------------------------------------------------------------------------------
// Geometry (rects are closed: touching an edge counts as contact)
// ---------------------------------------------------------------------------------------------

export function pointInRect(p: Vec2, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** Closest point of rect r to p (p itself when inside). */
export function closestPointOnRect(out: Vec2, p: Vec2, r: Rect): Vec2 {
  return v2Set(out, clamp(p.x, r.x, r.x + r.w), clamp(p.y, r.y, r.y + r.h));
}

/**
 * Where segment a->b first touches rect r, as t in [0, 1] (point = a + (b - a) * t).
 * 0 when a starts inside, -1 when the segment misses. Slab method; use it for LOS and for
 * stopping projectiles at the wall surface.
 */
export function segmentRectT(a: Vec2, b: Vec2, r: Rect): number {
  let tMin = 0;
  let tMax = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  if (Math.abs(dx) < EPS) {
    if (a.x < r.x || a.x > r.x + r.w) return -1;
  } else {
    let t1 = (r.x - a.x) / dx;
    let t2 = (r.x + r.w - a.x) / dx;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }

  if (Math.abs(dy) < EPS) {
    if (a.y < r.y || a.y > r.y + r.h) return -1;
  } else {
    let t1 = (r.y - a.y) / dy;
    let t2 = (r.y + r.h - a.y) / dy;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }
  return tMin;
}

/** Does segment a-b touch rect r? */
export function segmentHitsRect(a: Vec2, b: Vec2, r: Rect): boolean {
  return segmentRectT(a, b, r) >= 0;
}

/**
 * Where segment a->b first touches the circle (c, radius), as t in [0, 1]. 0 when a starts inside,
 * -1 when it misses. Use it for projectile-vs-fighter and projectile-vs-prop hits.
 */
export function segmentCircleT(a: Vec2, b: Vec2, c: Vec2, radius: number): number {
  const fx = a.x - c.x;
  const fy = a.y - c.y;
  const cc = fx * fx + fy * fy - radius * radius;
  if (cc <= 0) return 0;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const aa = dx * dx + dy * dy;
  if (aa < EPS) return -1;
  const bb = 2 * (fx * dx + fy * dy);
  const disc = bb * bb - 4 * aa * cc;
  if (disc < 0) return -1;
  const t = (-bb - Math.sqrt(disc)) / (2 * aa);
  return t >= 0 && t <= 1 ? t : -1;
}

/** Squared distance from p to segment a-b. */
export function distPointSegmentSq(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq < EPS ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = clamp01(t);
  const qx = a.x + dx * t - p.x;
  const qy = a.y + dy * t - p.y;
  return qx * qx + qy * qy;
}

/** Does the circle (c, radius) overlap rect r? */
export function circleHitsRect(c: Vec2, radius: number, r: Rect): boolean {
  const qx = clamp(c.x, r.x, r.x + r.w) - c.x;
  const qy = clamp(c.y, r.y, r.y + r.h) - c.y;
  return qx * qx + qy * qy < radius * radius;
}

/**
 * Minimal translation that moves the circle (c, radius) out of rect r, written to `out`.
 * Returns false (and zeroes `out`) when they do not overlap. A centre inside the rect is pushed out
 * through the nearest edge, so fighters knocked into a pillar never tunnel through it.
 */
export function circleRectPush(out: Vec2, c: Vec2, radius: number, r: Rect): boolean {
  const right = r.x + r.w;
  const bottom = r.y + r.h;
  const inside = c.x > r.x && c.x < right && c.y > r.y && c.y < bottom;
  if (inside) {
    const left = c.x - r.x;
    const rightGap = right - c.x;
    const top = c.y - r.y;
    const bottomGap = bottom - c.y;
    const m = Math.min(left, rightGap, top, bottomGap);
    if (m === left) v2Set(out, -(left + radius), 0);
    else if (m === rightGap) v2Set(out, rightGap + radius, 0);
    else if (m === top) v2Set(out, 0, -(top + radius));
    else v2Set(out, 0, bottomGap + radius);
    return true;
  }
  const qx = c.x - clamp(c.x, r.x, right);
  const qy = c.y - clamp(c.y, r.y, bottom);
  const dSq = qx * qx + qy * qy;
  if (dSq >= radius * radius) {
    v2Set(out, 0, 0);
    return false;
  }
  const d = Math.sqrt(dSq);
  if (d < EPS) {
    // Centre exactly on the boundary: push straight out along the axis it touches.
    if (c.x <= r.x) v2Set(out, -radius, 0);
    else if (c.x >= right) v2Set(out, radius, 0);
    else if (c.y <= r.y) v2Set(out, 0, -radius);
    else v2Set(out, 0, radius);
    return true;
  }
  const k = (radius - d) / d;
  v2Set(out, qx * k, qy * k);
  return true;
}
