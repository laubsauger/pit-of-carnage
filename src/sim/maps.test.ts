import { describe, expect, it } from 'vitest';
import { HAZARD_RULES, MAX_FIGHTERS, MIN_FIGHTERS, PERCEPTION, distPointSegmentSq } from '../core';
import type { MapDef, Rect, Vec2 } from '../core';
import { circleBlocked, geoFor, sampleLight, staticLosBlocked } from './geometry';
import { createMatch } from './match';
import { MAPS } from './maps';
import { seekerBrain, testConfig } from './testkit';

/** Biggest body a legal build can have (vitality 40, armor 40 is over budget; this is a safe bound). */
const BODY = 26;

const rectKey = (r: Rect) => `${r.x},${r.y},${r.w},${r.h}`;
const ptKey = (p: Vec2, tag = '') => `${tag}${Math.round(p.x)},${Math.round(p.y)}`;

function mirrored(map: MapDef, mx: boolean, my: boolean) {
  const W = map.width;
  const H = map.height;
  const rect = (r: Rect) => ({ x: mx ? W - r.x - r.w : r.x, y: my ? H - r.y - r.h : r.y, w: r.w, h: r.h });
  const pt = (p: Vec2) => ({ x: mx ? W - p.x : p.x, y: my ? H - p.y : p.y });
  return {
    blockers: [...map.walls, ...map.pillars].map(rect).map(rectKey).sort(),
    spawns: map.spawns.map(pt).map((p) => ptKey(p)).sort(),
    props: map.props.map((p) => ptKey(pt(p.pos), p.kind)).sort(),
    hazards: map.hazards.map((h) => ptKey(pt(h.pos), h.kind)).sort(),
    pickups: map.pickups.map((p) => ptKey(pt(p.pos), p.kind)).sort(),
    lights: map.lights.map((l) => ptKey(pt(l.pos), `${l.radius}/${l.intensity}/`)).sort(),
    shrines: map.shrines.map((s) => ptKey(pt(s.pos))).sort(),
  };
}

/** Grid flood fill over cells a BODY-radius fighter fits in (walls, pillars, props block). */
function reachable(map: MapDef, from: Vec2): (p: Vec2) => boolean {
  const geo = geoFor(map);
  const cell = 10;
  const gw = Math.ceil(map.width / cell);
  const gh = Math.ceil(map.height / cell);
  const free = (gx: number, gy: number) => {
    const x = gx * cell + cell / 2;
    const y = gy * cell + cell / 2;
    if (circleBlocked(geo, x, y, BODY)) return false;
    return map.props.every((p) => Math.hypot(p.pos.x - x, p.pos.y - y) >= p.radius + BODY);
  };
  const seen = new Uint8Array(gw * gh);
  const start = [Math.floor(from.x / cell), Math.floor(from.y / cell)] as const;
  const queue: number[] = [start[0] + start[1] * gw];
  seen[queue[0]!] = 1;
  while (queue.length > 0) {
    const k = queue.pop()!;
    const gx = k % gw;
    const gy = (k - gx) / gw;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = gx + dx;
      const ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const nk = nx + ny * gw;
      if (seen[nk] || !free(nx, ny)) continue;
      seen[nk] = 1;
      queue.push(nk);
    }
  }
  return (p) => seen[Math.floor(p.x / cell) + Math.floor(p.y / cell) * gw] === 1;
}

describe.each(Object.values(MAPS))('map $id', (map) => {
  // Fairness: no side of the arena may be better than another, so every map mirrors on both axes.
  it('is mirrored on both axes', () => {
    const base = mirrored(map, false, false);
    expect(mirrored(map, true, false)).toEqual(base);
    expect(mirrored(map, false, true)).toEqual(base);
  });

  it(`has at least ${MAX_FIGHTERS} spawns, all clear of walls, props, hazards and pickups`, () => {
    const geo = geoFor(map);
    expect(map.spawns.length).toBeGreaterThanOrEqual(MAX_FIGHTERS);
    for (const s of map.spawns) {
      expect(circleBlocked(geo, s.x, s.y, BODY), `spawn ${ptKey(s)} in a wall`).toBe(false);
      for (const p of map.props) expect(Math.hypot(p.pos.x - s.x, p.pos.y - s.y), `spawn ${ptKey(s)} on ${p.id}`).toBeGreaterThan(p.radius + BODY);
      for (const h of map.hazards) {
        const r = (h.radius || HAZARD_RULES[h.kind].radius) + BODY + 10;
        const path = h.path ?? [h.pos];
        for (let i = 0; i < path.length; i++) {
          const a = path[i]!;
          const b = path[(i + 1) % path.length]!;
          expect(Math.sqrt(distPointSegmentSq(s, a, b)), `spawn ${ptKey(s)} in ${h.id}`).toBeGreaterThan(r);
        }
      }
      for (const p of [...map.pickups, ...map.shrines]) expect(Math.hypot(p.pos.x - s.x, p.pos.y - s.y)).toBeGreaterThan(60);
    }
  });

  // Nobody may start sealed in: every spawn connects to the shrine and every other spawn.
  it('connects every spawn to the shrine for the biggest body', () => {
    for (const s of map.spawns) {
      const can = reachable(map, s);
      for (const sh of map.shrines) expect(can(sh.pos), `spawn ${ptKey(s)} cannot reach the shrine`).toBe(true);
      for (const o of map.spawns) expect(can(o), `spawn ${ptKey(s)} cannot reach ${ptKey(o)}`).toBe(true);
    }
  });

  it('lights every fire pit, so the renderer and the sim agree on the light', () => {
    for (const h of map.hazards.filter((x) => x.kind === 'fire')) {
      expect(map.lights.some((l) => l.pos.x === h.pos.x && l.pos.y === h.pos.y)).toBe(true);
    }
    for (const l of map.lights) {
      expect(l.pos.x).toBeGreaterThanOrEqual(0);
      expect(l.pos.x).toBeLessThanOrEqual(map.width);
      expect(l.pos.y).toBeGreaterThanOrEqual(0);
      expect(l.pos.y).toBeLessThanOrEqual(map.height);
    }
  });

  // Any fighter count from 2 to 16 is spread evenly around the arena (no clumps of spawns).
  it('spreads any fighter count evenly over the spawn ring', () => {
    for (let n = MIN_FIGHTERS; n <= MAX_FIGHTERS; n++) {
      const m = createMatch(testConfig({ seed: 100 + n, mapId: map.id, fighters: n }), seekerBrain);
      const slots = m.state.fighters
        .map((f) => map.spawns.findIndex((s) => s.x === f.pos.x && s.y === f.pos.y))
        .sort((a, b) => a - b);
      expect(new Set(slots).size).toBe(n);
      const total = map.spawns.length;
      const gaps = slots.map((s, i) => (i + 1 < n ? slots[i + 1]! - s : slots[0]! + total - s));
      for (const g of gaps) {
        expect(g).toBeGreaterThanOrEqual(Math.floor(total / n));
        expect(g).toBeLessThanOrEqual(Math.ceil(total / n));
      }
    }
  });
});

describe('the pit', () => {
  const pit = MAPS.pit!;
  const geo = geoFor(pit);
  const cx = pit.width / 2;
  const cy = pit.height / 2;

  it('matches the spec: 1360 x 860, a lit centre with the shrine, a ring of 8 pillars', () => {
    expect([pit.width, pit.height]).toEqual([1360, 860]);
    expect(pit.shrines.map((s) => s.pos)).toEqual([{ x: cx, y: cy }]);
    expect(sampleLight(geo, cx, cy)).toBeGreaterThan(0.7);
    expect(pit.pillars).toHaveLength(8);
    const dists = pit.pillars.map((p) => Math.hypot((p.x + p.w / 2 - cx) / 250, (p.y + p.h / 2 - cy) / 168));
    for (const d of dists) expect(d).toBeCloseTo(1, 1);
  });

  it('has open lanes along the top and bottom for ranged fighters', () => {
    expect(staticLosBlocked(geo, 270, 196, 1090, 196)).toBe(false);
    expect(staticLosBlocked(geo, 270, pit.height - 196, 1090, pit.height - 196)).toBe(false);
  });

  it('has gate halls with a doorway on the left and right', () => {
    for (const x of [203, pit.width - 203]) {
      expect(circleBlocked(geo, x, cy, BODY)).toBe(false); // the gate
      expect(circleBlocked(geo, x, cy - 100, 4)).toBe(true); // wall above it
      expect(circleBlocked(geo, x, cy + 100, 4)).toBe(true); // wall below it
    }
  });

  it('has dark corner alcoves, each with a torch at its mouth', () => {
    for (const [x, y] of [[76, 76], [pit.width - 76, 76], [76, pit.height - 76], [pit.width - 76, pit.height - 76]] as const) {
      expect(sampleLight(geo, x, y)).toBeLessThan(PERCEPTION.shadowLight);
      expect(pit.lights.some((l) => Math.hypot(l.pos.x - x, l.pos.y - y) < 170 && l.radius <= 200)).toBe(true);
    }
  });

  // Power-ups must be worth a detour and a risk: berserk on the gate halls' spike traps, haste in
  // the light in the open lanes where archers shoot; none hidden in a dark corner.
  it('puts its power-ups in contested spots: berserk on spike traps, haste lit in the open lanes', () => {
    const berserk = pit.pickups.filter((p) => p.kind === 'berserk');
    const haste = pit.pickups.filter((p) => p.kind === 'haste');
    expect(berserk.length).toBeGreaterThan(0);
    expect(haste.length).toBeGreaterThan(0);
    for (const b of berserk) expect(pit.hazards.some((h) => h.kind === 'spike' && h.pos.x === b.pos.x && h.pos.y === b.pos.y)).toBe(true);
    for (const h of haste) {
      expect(sampleLight(geo, h.pos.x, h.pos.y)).toBeGreaterThan(PERCEPTION.shadowLight);
      expect(staticLosBlocked(geo, 270, h.pos.y, 1090, h.pos.y)).toBe(false);
    }
  });

  it('keeps its kegs near the pillar ring', () => {
    const kegs = pit.props.filter((p) => p.kind === 'keg');
    expect(kegs.length).toBeGreaterThan(0);
    for (const k of kegs) {
      const near = Math.min(...pit.pillars.map((p) => Math.hypot(p.x + p.w / 2 - k.pos.x, p.y + p.h / 2 - k.pos.y)));
      expect(near).toBeLessThan(110);
    }
  });
});
