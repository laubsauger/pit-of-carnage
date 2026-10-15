/**
 * Vision fans for the cone and fog overlays. Pure functions, no three.js.
 *
 * A fan is `rays + 1` distances spread evenly across the field of view, each clipped at the first
 * wall or pillar, so a drawn cone never shows sight through a wall the sim would block.
 *
 * Fixed rays make a cone pop as pillar corners slip between them, so the drawn cone is an exact
 * visibility polygon instead (`castVisibility`): the even fan plus a ray just either side of every
 * blocker corner inside the cone. Its shadow edges sit exactly on the corners and move smoothly.
 *
 * During sudden death the closing wall blocks sight too, like the sim's `losBlocked`: rays stop at
 * the zone's edge, and a fighter caught outside the zone sees nothing.
 */

import { angleDiff, segmentRectT, wrapAngle } from '../core';
import type { Rect, Vec2 } from '../core';

const _a: Vec2 = { x: 0, y: 0 };
const _b: Vec2 = { x: 0, y: 0 };

/** Angle of ray `i` of a fan centred on `heading` with full width `fov`. */
export function fanAngle(heading: number, fov: number, rays: number, i: number): number {
  return heading - fov / 2 + (fov * i) / rays;
}

/**
 * How far a ray from (ox, oy) at angle `ang` travels before it leaves rect `r`; 0 when it starts
 * outside (the sim blocks every line of sight that crosses the closing wall).
 */
export function rayExit(ox: number, oy: number, ang: number, r: Rect): number {
  if (ox < r.x || ox > r.x + r.w || oy < r.y || oy > r.y + r.h) return 0;
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  let t = Infinity;
  if (dx > 1e-9) t = Math.min(t, (r.x + r.w - ox) / dx);
  else if (dx < -1e-9) t = Math.min(t, (r.x - ox) / dx);
  if (dy > 1e-9) t = Math.min(t, (r.y + r.h - oy) / dy);
  else if (dy < -1e-9) t = Math.min(t, (r.y - oy) / dy);
  return t;
}

/** Length of one ray from (ox, oy) at angle `ang`, clipped at the first blocker and at `bounds` (the zone) if given. */
export function castRay(ox: number, oy: number, ang: number, range: number, blockers: readonly Rect[], bounds: Rect | null = null): number {
  _a.x = ox;
  _a.y = oy;
  _b.x = ox + Math.cos(ang) * range;
  _b.y = oy + Math.sin(ang) * range;
  const minX = Math.min(ox, _b.x);
  const maxX = Math.max(ox, _b.x);
  const minY = Math.min(oy, _b.y);
  const maxY = Math.max(oy, _b.y);
  let best = 1;
  for (let k = 0; k < blockers.length; k++) {
    const r = blockers[k]!;
    if (r.x > maxX || r.x + r.w < minX || r.y > maxY || r.y + r.h < minY) continue;
    const t = segmentRectT(_a, _b, r);
    if (t >= 0 && t < best) best = t;
  }
  return bounds ? Math.min(best * range, rayExit(ox, oy, ang, bounds)) : best * range;
}

/** Fill `out[0..rays]` with clipped ray lengths from (ox, oy). */
export function castFan(
  ox: number, oy: number, heading: number, fov: number, range: number, blockers: readonly Rect[], rays: number, out: Float32Array,
  bounds: Rect | null = null,
): void {
  for (let i = 0; i <= rays; i++) out[i] = castRay(ox, oy, fanAngle(heading, fov, rays, i), range, blockers, bounds);
}

/** Angle offset of the rays cast either side of a blocker corner. */
const CORNER_EPS = 1e-4;
/** Corner angles of the visibility polygon in progress (relative to the heading), reused. */
let corners = new Float32Array(256);

/**
 * Exact visibility polygon of a cone: the even fan of `rays + 1` rays plus a ray just either side of
 * every blocker corner inside the cone, sorted by angle. Writes absolute angles into `outAng` and
 * clipped lengths into `outDist` (both sized for the worst case, extra corners are dropped) and
 * returns the number of rays. The first and last rays are always exactly the cone's edges.
 */
export function castVisibility(
  ox: number, oy: number, heading: number, fov: number, range: number, blockers: readonly Rect[], rays: number,
  outAng: Float32Array, outDist: Float32Array, bounds: Rect | null = null,
): number {
  const half = fov / 2;
  const cap = outAng.length;
  if (corners.length < cap) corners = new Float32Array(cap);
  let nc = 0;
  for (let k = 0; k < blockers.length; k++) {
    const r = blockers[k]!;
    // Skip blockers wholly out of range.
    const cx = Math.max(r.x, Math.min(ox, r.x + r.w));
    const cy = Math.max(r.y, Math.min(oy, r.y + r.h));
    if (Math.hypot(cx - ox, cy - oy) > range) continue;
    for (let c = 0; c < 4; c++) {
      const px = c & 1 ? r.x + r.w : r.x;
      const py = c & 2 ? r.y + r.h : r.y;
      const dx = px - ox;
      const dy = py - oy;
      if (dx * dx + dy * dy > range * range) continue;
      const rel = wrapAngle(Math.atan2(dy, dx) - heading);
      for (let e = -1; e <= 1; e += 2) {
        const a = rel + e * CORNER_EPS;
        if (a <= -half || a >= half || nc + rays + 1 >= cap) continue;
        // Insertion keeps the corner list sorted (a few dozen entries at most).
        let j = nc++;
        while (j > 0 && corners[j - 1]! > a) {
          corners[j] = corners[j - 1]!;
          j--;
        }
        corners[j] = a;
      }
    }
  }
  // Merge the even fan with the sorted corners.
  let n = 0;
  let ci = 0;
  for (let i = 0; i <= rays; i++) {
    const a = -half + (fov * i) / rays;
    while (ci < nc && corners[ci]! < a) {
      outAng[n] = heading + corners[ci]!;
      outDist[n] = castRay(ox, oy, outAng[n]!, range, blockers, bounds);
      n++;
      ci++;
    }
    outAng[n] = heading + a;
    outDist[n] = castRay(ox, oy, outAng[n]!, range, blockers, bounds);
    n++;
  }
  return n;
}

/**
 * Ease a displayed angle toward its target, the short way round, without overshoot. `rate` is per
 * second; the head angle from the sim changes in ticks, the drawn cone glides.
 */
export function easeAngle(current: number, target: number, dt: number, rate: number): number {
  const k = 1 - Math.exp(-Math.max(0, dt) * rate);
  return wrapAngle(current + angleDiff(current, target) * k);
}

/** Is (px, py) inside a fan previously cast with `castFan`? */
export function fanContains(ox: number, oy: number, heading: number, fov: number, rays: number, dists: Float32Array, px: number, py: number): boolean {
  const dx = px - ox;
  const dy = py - oy;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return true;
  const rel = wrapAngle(Math.atan2(dy, dx) - heading);
  if (Math.abs(rel) > fov / 2) return false;
  const f = ((rel + fov / 2) / fov) * rays;
  const i = Math.min(rays - 1, Math.max(0, Math.floor(f)));
  const t = f - i;
  const reach = dists[i]! * (1 - t) + dists[i + 1]! * t;
  return d <= reach;
}
