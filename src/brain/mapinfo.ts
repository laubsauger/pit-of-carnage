/**
 * Static facts about a map that places and zones need, computed once per map (or once per match
 * where the answer depends on the WorldQuery) and cached. Brains only read these arrays.
 */

import { HAZARD_RULES, PERCEPTION, segmentRectT } from '../core';
import type { MapDef, Rect, Vec2, WorldQuery } from '../core';
import { STEERING } from './tuning';

export type MapInfo = {
  map: MapDef;
  /** Walls and pillars. */
  blockers: readonly Rect[];
  centre: Vec2;
  /** Free spots with walls close on two perpendicular sides, tightest first per corner. */
  corners: readonly Vec2[];
  /** Free points on a coarse grid (candidates for dark spots). */
  grid: readonly Vec2[];
};

const infoCache = new WeakMap<MapDef, MapInfo>();
const darkCache = new WeakMap<WorldQuery, readonly Vec2[]>();

export function mapInfo(map: MapDef): MapInfo {
  let info = infoCache.get(map);
  if (!info) {
    const blockers = [...map.walls, ...map.pillars];
    info = { map, blockers, centre: { x: map.width / 2, y: map.height / 2 }, corners: [], grid: [] };
    info.grid = buildGrid(info, STEERING.spotGrid);
    info.corners = buildCorners(info);
    infoCache.set(map, info);
  }
  return info;
}

/** Grid points in shadow (light below PERCEPTION.shadowLight). Light is static per map, so this is cached per match. */
export function darkSpots(world: WorldQuery, info: MapInfo): readonly Vec2[] {
  let spots = darkCache.get(world);
  if (!spots) {
    spots = info.grid.filter((p) => world.lightAt(p) < PERCEPTION.shadowLight);
    darkCache.set(world, spots);
  }
  return spots;
}

/** Can a fighter stand at (x, y): inside the map, clear of walls, pillars, props and static hazards. */
function spotFree(info: MapInfo, x: number, y: number): boolean {
  const r = STEERING.spotFit;
  const m = info.map;
  if (x - r < 0 || y - r < 0 || x + r > m.width || y + r > m.height) return false;
  for (const b of info.blockers) {
    const qx = (x < b.x ? b.x : x > b.x + b.w ? b.x + b.w : x) - x;
    const qy = (y < b.y ? b.y : y > b.y + b.h ? b.y + b.h : y) - y;
    if (qx * qx + qy * qy < r * r) return false;
  }
  for (const p of m.props) if (Math.hypot(p.pos.x - x, p.pos.y - y) < p.radius + r) return false;
  for (const h of m.hazards) {
    const hr = h.radius || HAZARD_RULES[h.kind].radius;
    if (Math.hypot(h.pos.x - x, h.pos.y - y) < hr + r + STEERING.hazardFade) return false;
  }
  return true;
}

function buildGrid(info: MapInfo, step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let y = step / 2; y < info.map.height; y += step) {
    for (let x = step / 2; x < info.map.width; x += step) {
      if (spotFree(info, x, y)) out.push(Object.freeze({ x, y }));
    }
  }
  return out;
}

/** Distance from p along (dx, dy) to the first blocker within `reach`, or Infinity. */
function rayToBlocker(info: MapInfo, p: Vec2, dx: number, dy: number, reach: number): number {
  const end = { x: p.x + dx * reach, y: p.y + dy * reach };
  let best = Infinity;
  for (const b of info.blockers) {
    const t = segmentRectT(p, end, b);
    if (t >= 0 && t * reach < best) best = t * reach;
  }
  return best;
}

/**
 * A corner spot has a wall within `cornerReach` both along x and along y, so attackers can only
 * come from the open quarter. Candidates are scored by how tight they sit (sum of the two wall
 * distances) and thinned so each real corner keeps only its tightest spot.
 */
function buildCorners(info: MapInfo): Vec2[] {
  const reach = STEERING.cornerReach;
  const cands: { p: Vec2; tight: number }[] = [];
  const step = STEERING.cornerGrid;
  for (let y = step / 2; y < info.map.height; y += step) {
    for (let x = step / 2; x < info.map.width; x += step) {
      if (!spotFree(info, x, y)) continue;
      const p = { x, y };
      const ax = Math.min(rayToBlocker(info, p, 1, 0, reach), rayToBlocker(info, p, -1, 0, reach));
      const ay = Math.min(rayToBlocker(info, p, 0, 1, reach), rayToBlocker(info, p, 0, -1, reach));
      if (ax <= reach && ay <= reach) cands.push({ p, tight: ax + ay });
    }
  }
  cands.sort((a, b) => a.tight - b.tight || a.p.y - b.p.y || a.p.x - b.p.x);
  const out: Vec2[] = [];
  const sep = STEERING.cornerSeparation;
  for (const c of cands) {
    if (out.some((o) => Math.hypot(o.x - c.p.x, o.y - c.p.y) < sep)) continue;
    out.push(Object.freeze(c.p));
  }
  return out;
}
