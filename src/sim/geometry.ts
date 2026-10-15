/**
 * Static, per-map geometry computed once and cached: line-of-sight blockers, the light grid and
 * cover anchors. Everything here depends only on the MapDef, so a gym worker running thousands of
 * matches on one map pays for it once.
 */

import { HAZARD_RULES, clamp01, segmentRectT, smoothstep } from '../core';
import type { MapDef, Rect, Vec2 } from '../core';

/** Light grid spacing (px). Must stay below the smallest fighter radius so a body never samples inside a pillar. */
export const LIGHT_CELL = 16;

/** Fire pits are light sources too. */
const FIRE_LIGHT_RADIUS = 175;
const FIRE_LIGHT_INTENSITY = 0.55;

/** Clearance of a cover anchor from the obstacle it hides behind (px). */
const COVER_OFFSET = 30;
/** Radius checked free around a cover anchor so a fighter fits there. */
const COVER_FIT = 22;

export type StaticGeo = {
  map: MapDef;
  /** Walls and pillars: block movement, projectiles and line of sight. */
  blockers: Rect[];
  /** Light at grid points (gw x gh), row-major; sample with `sampleLight`. */
  light: Float32Array;
  gw: number;
  gh: number;
  /** Walkable points beside obstacles, frozen (brains receive them directly from `coverFrom`). */
  coverAnchors: readonly Vec2[];
};

const cache = new WeakMap<MapDef, StaticGeo>();

export function geoFor(map: MapDef): StaticGeo {
  let geo = cache.get(map);
  if (!geo) {
    geo = buildGeo(map);
    cache.set(map, geo);
  }
  return geo;
}

/** True when segment a-b touches any wall or pillar. */
export function staticLosBlocked(geo: StaticGeo, a: Vec2, b: Vec2): boolean {
  const bs = geo.blockers;
  const minX = a.x < b.x ? a.x : b.x;
  const maxX = a.x < b.x ? b.x : a.x;
  const minY = a.y < b.y ? a.y : b.y;
  const maxY = a.y < b.y ? b.y : a.y;
  for (let i = 0; i < bs.length; i++) {
    const r = bs[i]!;
    // Bounding-box reject before the slab test.
    if (r.x > maxX || r.x + r.w < minX || r.y > maxY || r.y + r.h < minY) continue;
    if (segmentRectT(a, b, r) >= 0) return true;
  }
  return false;
}

/** First hit of segment a->b on a wall or pillar as t in [0, 1], or -1. */
export function staticSegmentT(geo: StaticGeo, a: Vec2, b: Vec2): number {
  const bs = geo.blockers;
  const minX = a.x < b.x ? a.x : b.x;
  const maxX = a.x < b.x ? b.x : a.x;
  const minY = a.y < b.y ? a.y : b.y;
  const maxY = a.y < b.y ? b.y : a.y;
  let best = -1;
  for (let i = 0; i < bs.length; i++) {
    const r = bs[i]!;
    if (r.x > maxX || r.x + r.w < minX || r.y > maxY || r.y + r.h < minY) continue;
    const t = segmentRectT(a, b, r);
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

/** Does a circle at (x, y) overlap a wall or pillar, or leave the map? */
export function circleBlocked(geo: StaticGeo, x: number, y: number, r: number): boolean {
  const m = geo.map;
  if (x - r < 0 || y - r < 0 || x + r > m.width || y + r > m.height) return true;
  const bs = geo.blockers;
  const rr = r * r;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i]!;
    const qx = (x < b.x ? b.x : x > b.x + b.w ? b.x + b.w : x) - x;
    const qy = (y < b.y ? b.y : y > b.y + b.h ? b.y + b.h : y) - y;
    if (qx * qx + qy * qy < rr) return true;
  }
  return false;
}

/** Bilinear light level at (x, y), 0..1. */
export function sampleLight(geo: StaticGeo, x: number, y: number): number {
  const gx = clampGrid(x / LIGHT_CELL, geo.gw - 1);
  const gy = clampGrid(y / LIGHT_CELL, geo.gh - 1);
  const ix = Math.min(Math.floor(gx), geo.gw - 2);
  const iy = Math.min(Math.floor(gy), geo.gh - 2);
  const fx = gx - ix;
  const fy = gy - iy;
  const row = iy * geo.gw;
  const l = geo.light;
  const a = l[row + ix]!;
  const b = l[row + ix + 1]!;
  const c = l[row + geo.gw + ix]!;
  const d = l[row + geo.gw + ix + 1]!;
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

function clampGrid(v: number, max: number): number {
  return v < 0 ? 0 : v > max ? max : v;
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

function buildGeo(map: MapDef): StaticGeo {
  const blockers = [...map.walls, ...map.pillars];
  const gw = Math.ceil(map.width / LIGHT_CELL) + 1;
  const gh = Math.ceil(map.height / LIGHT_CELL) + 1;
  const geo: StaticGeo = { map, blockers, light: new Float32Array(gw * gh), gw, gh, coverAnchors: [] };
  bakeLight(geo);
  geo.coverAnchors = buildCoverAnchors(geo);
  return geo;
}

type Emitter = { x: number; y: number; radius: number; intensity: number; shadows: boolean };

function bakeLight(geo: StaticGeo): void {
  const map = geo.map;
  const emitters: Emitter[] = map.lights.map((l) => ({ x: l.pos.x, y: l.pos.y, radius: l.radius, intensity: l.intensity, shadows: l.castsShadow }));
  for (const hz of map.hazards) {
    if (hz.kind === 'fire') emitters.push({ x: hz.pos.x, y: hz.pos.y, radius: FIRE_LIGHT_RADIUS, intensity: FIRE_LIGHT_INTENSITY, shadows: true });
  }
  // Blockers shrunk by 1 px so points on a lit wall face are not shadowed by the wall itself.
  const shrunk = geo.blockers.map((r) => ({ x: r.x + 1, y: r.y + 1, w: Math.max(0, r.w - 2), h: Math.max(0, r.h - 2) }));
  const a: Vec2 = { x: 0, y: 0 };
  const b: Vec2 = { x: 0, y: 0 };
  for (let gy = 0; gy < geo.gh; gy++) {
    for (let gx = 0; gx < geo.gw; gx++) {
      b.x = gx * LIGHT_CELL;
      b.y = gy * LIGHT_CELL;
      let sum = map.ambient;
      for (const e of emitters) {
        const d = Math.hypot(b.x - e.x, b.y - e.y);
        if (d >= e.radius) continue;
        if (e.shadows) {
          a.x = e.x;
          a.y = e.y;
          let blocked = false;
          for (const r of shrunk) {
            if (segmentRectT(a, b, r) >= 0) {
              blocked = true;
              break;
            }
          }
          if (blocked) continue;
        }
        sum += e.intensity * smoothstep(0, 1, 1 - d / e.radius);
      }
      geo.light[gy * geo.gw + gx] = clamp01(sum);
    }
  }
}

/**
 * Candidate hiding spots: points just outside every pillar and interior wall face (sides sampled
 * every 60 px, plus the four diagonal corners), kept only where a fighter fits.
 */
function buildCoverAnchors(geo: StaticGeo): readonly Vec2[] {
  const map = geo.map;
  const out: Vec2[] = [];
  const add = (x: number, y: number) => {
    if (circleBlocked(geo, x, y, COVER_FIT)) return;
    for (const p of map.props) if (Math.hypot(p.pos.x - x, p.pos.y - y) < p.radius + COVER_FIT) return;
    for (const hz of map.hazards) if (hz.kind !== 'saw' && Math.hypot(hz.pos.x - x, hz.pos.y - y) < (hz.radius || HAZARD_RULES[hz.kind].radius) + COVER_FIT) return;
    out.push(Object.freeze({ x, y }));
  };
  const o = COVER_OFFSET;
  for (const r of geo.blockers) {
    // Outer walls (they touch the map border) hide nothing useful.
    if (r.x <= 0 || r.y <= 0 || r.x + r.w >= map.width || r.y + r.h >= map.height) continue;
    const nx = Math.max(1, Math.round(r.w / 60));
    const ny = Math.max(1, Math.round(r.h / 60));
    for (let i = 0; i < nx; i++) {
      const x = r.x + ((i + 0.5) * r.w) / nx;
      add(x, r.y - o);
      add(x, r.y + r.h + o);
    }
    for (let i = 0; i < ny; i++) {
      const y = r.y + ((i + 0.5) * r.h) / ny;
      add(r.x - o, y);
      add(r.x + r.w + o, y);
    }
    const d = o * 0.75;
    add(r.x - d, r.y - d);
    add(r.x + r.w + d, r.y - d);
    add(r.x - d, r.y + r.h + d);
    add(r.x + r.w + d, r.y + r.h + d);
  }
  return out;
}
