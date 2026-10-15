/**
 * CPU side of the arena light field. Pure functions, no three.js.
 *
 * The sim decides who stands in shadow with a 2D light model (`lightAt`): every light whose
 * `castsShadow` is set is blocked by walls and pillars along the straight line to the point, and
 * contributes `intensity x smoothstep(0, 1, 1 - d / radius)`. The renderer draws exactly that
 * model, so the shadows players see are the shadows fighters hide in. Occlusion is precomputed per
 * light as a polar distance table (distance to the first blocker per angle), which the GPU light
 * pass reads every frame.
 */

import { TAU, segmentRectT } from '../core';
import type { MapDef, Rect, Vec2 } from '../core';

export type LightSource = {
  id: string;
  x: number;
  y: number;
  radius: number;
  /** Gameplay intensity (same number the sim adds up). */
  intensity: number;
  color: string;
  flicker: number;
  /** Walls and pillars block it. */
  occluded: boolean;
  /** Cosmetic flicker seed. */
  seed: number;
};

/**
 * Every light the sim counts for `lightAt`. The sim lists fire pits' lights in `map.lights` too, so
 * the map's list is the whole story (adding fire pits here again would light them twice).
 */
export function collectMapLights(map: MapDef): LightSource[] {
  return map.lights.map((l, i) => ({
    id: l.id, x: l.pos.x, y: l.pos.y, radius: l.radius, intensity: l.intensity, color: l.color,
    flicker: l.flicker, occluded: l.castsShadow, seed: i * 1.731 + 0.37,
  }));
}

/** Walls and pillars shrunk by 1 px, exactly like the sim's light bake (lit wall faces stay lit). */
export function lightBlockers(map: MapDef): Rect[] {
  return [...map.walls, ...map.pillars].map((r) => ({ x: r.x + 1, y: r.y + 1, w: Math.max(0, r.w - 2), h: Math.max(0, r.h - 2) }));
}

const _a: Vec2 = { x: 0, y: 0 };
const _b: Vec2 = { x: 0, y: 0 };

/**
 * Polar occlusion table for one light: `out[offset + k]` = distance from the light to the first
 * blocker along angle `k * TAU / angles`, or the light radius when nothing blocks the ray.
 */
export function occlusionRow(light: { x: number; y: number; radius: number }, blockers: readonly Rect[], angles: number, out: Float32Array, offset: number): void {
  _a.x = light.x;
  _a.y = light.y;
  const r = light.radius;
  for (let k = 0; k < angles; k++) {
    const ang = (k / angles) * TAU;
    _b.x = light.x + Math.cos(ang) * r;
    _b.y = light.y + Math.sin(ang) * r;
    const minX = Math.min(_a.x, _b.x);
    const maxX = Math.max(_a.x, _b.x);
    const minY = Math.min(_a.y, _b.y);
    const maxY = Math.max(_a.y, _b.y);
    let best = 1;
    for (let i = 0; i < blockers.length; i++) {
      const rc = blockers[i]!;
      if (rc.x > maxX || rc.x + rc.w < minX || rc.y > maxY || rc.y + rc.h < minY) continue;
      const t = segmentRectT(_a, _b, rc);
      if (t >= 0 && t < best) best = t;
    }
    out[offset + k] = best * r;
  }
}

/** Fill `out` with occlusion rows for every light (row i = light i); unoccluded lights get their radius. */
export function buildOcclusion(lights: readonly LightSource[], blockers: readonly Rect[], angles: number, out: Float32Array): void {
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i]!;
    if (l.occluded) occlusionRow(l, blockers, angles, out, i * angles);
    else out.fill(l.radius, i * angles, (i + 1) * angles);
  }
}

/**
 * Cosmetic flicker multiplier around 1. Bounded by `1 ± 0.6 x amount` and smooth over time, so a
 * torch breathes instead of strobing. `t` in seconds.
 */
export function flicker(t: number, seed: number, amount: number): number {
  if (amount <= 0) return 1;
  const w = 0.5 * Math.sin(t * 7.3 + seed) + 0.3 * Math.sin(t * 13.9 + seed * 2.7) + 0.2 * Math.sin(t * 23.1 + seed * 4.1);
  return 1 + 0.6 * amount * w;
}

/** The sim's falloff for one light at distance d (shared by tests and the GPU pass). */
export function lightFalloff(d: number, radius: number): number {
  if (d >= radius) return 0;
  const x = 1 - d / radius;
  return x * x * (3 - 2 * x);
}

// ---------------------------------------------------------------------------------------------
// Body shadows (cosmetic: the sim's light model has no shadows from fighters)
// ---------------------------------------------------------------------------------------------

/** Height (px) of map lights above the floor when projecting body shadows (torches on walls). */
export const LIGHT_HEIGHT = 70;

/**
 * A light as body shadows see it. `gain` is its visual brightness right now (luminance x flicker,
 * already faded for transient flashes); `occRow` is its row in the occlusion table, -1 if walls do
 * not block it.
 */
export type ShadowSource = { x: number; y: number; radius: number; height: number; gain: number; occRow: number };

/** One light that throws a visible shadow of a caster; `share` is its part of the light falling there. */
export type ShadowLight = { x: number; y: number; height: number; share: number };

export function newShadowLight(): ShadowLight {
  return { x: 0, y: 0, height: LIGHT_HEIGHT, share: 0 };
}

/** Does the occlusion table say light row `row` at (lx, ly) reaches the floor point (x, y)? */
export function litFrom(occ: Float32Array, row: number, angles: number, lx: number, ly: number, x: number, y: number): boolean {
  if (row < 0) return true;
  const dx = x - lx;
  const dy = y - ly;
  const a = (((Math.atan2(dy, dx) / TAU) % 1) + 1) % 1;
  const k = Math.round(a * angles) % angles;
  return Math.hypot(dx, dy) <= occ[row * angles + k]! + 1;
}

/**
 * The lights that would throw a visible shadow of something standing at (x, y), strongest first,
 * written into `out` (preallocated); returns how many. A light counts when it reaches the point
 * (in range, not behind a wall) and supplies at least `minShare` of the light there, so a body under
 * a torch casts a dark shadow away from it, while a body lit mostly by ambient light casts almost
 * none. The colour falloff (smoothstep squared) matches what the floor shows.
 */
export function pickShadowLights(
  sources: readonly ShadowSource[], count: number, ambient: number, occ: Float32Array, angles: number,
  x: number, y: number, out: ShadowLight[], max: number, minShare: number,
): number {
  let total = ambient;
  let n = 0;
  for (let i = 0; i < count; i++) {
    const s = sources[i]!;
    const d = Math.hypot(x - s.x, y - s.y);
    if (d >= s.radius || s.gain <= 0) continue;
    if (!litFrom(occ, s.occRow, angles, s.x, s.y, x, y)) continue;
    const f = lightFalloff(d, s.radius);
    const c = s.gain * f * f;
    total += c;
    // Keep the `max` strongest in `out` (insertion into a short sorted list; share holds c for now).
    let j = n < max ? n : max - 1;
    if (n >= max && c <= out[j]!.share) continue;
    while (j > 0 && out[j - 1]!.share < c) {
      const prev = out[j - 1]!;
      const cur = out[j]!;
      cur.x = prev.x;
      cur.y = prev.y;
      cur.height = prev.height;
      cur.share = prev.share;
      j--;
    }
    const slot = out[j]!;
    slot.x = s.x;
    slot.y = s.y;
    slot.height = s.height;
    slot.share = c;
    if (n < max) n++;
  }
  if (total <= 0) return 0;
  let kept = 0;
  for (let i = 0; i < n; i++) {
    const share = out[i]!.share / total;
    if (share < minShare) break;
    out[i]!.share = share;
    kept++;
  }
  return kept;
}

/**
 * Where a point at height `h` above floor point (x, y) casts its shadow, lit by a light at (lx, ly)
 * and height `lh`: pushed straight away from the light by (p - l) x h / (lh - h), so shadows grow
 * longer the further a body stands from a torch. The push is capped at `maxOffset` px (a body next
 * to a low fire pit would otherwise throw a shadow across the arena). Writes into `out`; returns
 * the push length.
 */
export function projectShadow(lx: number, ly: number, lh: number, x: number, y: number, h: number, maxOffset: number, out: Vec2): number {
  const dx = x - lx;
  const dy = y - ly;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) {
    out.x = x;
    out.y = y;
    return 0;
  }
  const k = h / Math.max(lh - h, 1);
  const len = Math.min(d * k, maxOffset);
  out.x = x + (dx / d) * len;
  out.y = y + (dy / d) * len;
  return len;
}
