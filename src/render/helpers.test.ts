import { describe, expect, it } from 'vitest';
import type { FighterState } from '../core';
import { DOT, GHOST_HOLD, ghostHit, pickIndex, secondsDigits, stepGhost } from './hud';
import type { HpGhost } from './hud';
import { animProgress, isTeleport, lerpAngleShort, prevFighter } from './interp';
import { offsetPoly, rect, signedArea } from './poly';
import { castFan, castVisibility, easeAngle, fanContains, rayExit } from './vision';

function fighter(id: string, x: number, y: number, anim: FighterState['anim'] = { phase: 'idle', t: 0, dur: 0 }): FighterState {
  return { id, pos: { x, y }, anim } as FighterState;
}

describe('interpolation', () => {
  it('pairs fighters by id even when the roster order changes', () => {
    const prev = [fighter('a', 0, 0), fighter('b', 10, 0)];
    expect(prevFighter(prev, fighter('b', 11, 0), 0)).toBe(prev[1]);
    expect(prevFighter(prev, fighter('c', 0, 0), 0).id).toBe('c');
  });

  it('snaps teleports (shadowstep) instead of sliding a body across the arena', () => {
    expect(isTeleport(fighter('a', 0, 0), fighter('a', 3, 2))).toBe(false);
    expect(isTeleport(fighter('a', 0, 0), fighter('a', 120, 0))).toBe(true);
  });

  it('blends angles the short way across the ±π seam (no full spins)', () => {
    expect(lerpAngleShort(3.1, -3.1, 0.5)).toBeCloseTo(Math.PI, 2);
  });

  it('advances animation smoothly within a phase and restarts at 0 on a new phase', () => {
    const f = fighter('a', 0, 0, { phase: 'windup', t: 5, dur: 10 });
    expect(animProgress(f, 0)).toBeCloseTo(0.4, 5);
    expect(animProgress(f, 1)).toBeCloseTo(0.5, 5);
    const fresh = fighter('a', 0, 0, { phase: 'strike', t: 0, dur: 10 });
    expect(animProgress(fresh, 0.3)).toBe(0);
  });
});

describe('HP damage chip', () => {
  it('holds the lost HP visible after a hit, then drains to the new value', () => {
    const g: HpGhost = { value: 1, hold: 0 };
    ghostHit(g);
    stepGhost(g, 0.6, GHOST_HOLD / 2);
    expect(g.value).toBe(1);
    for (let i = 0; i < 120; i++) stepGhost(g, 0.6, 1 / 60);
    expect(g.value).toBeCloseTo(0.6, 5);
  });

  it('shows heals immediately (no chip above the bar)', () => {
    const g: HpGhost = { value: 0.4, hold: 0.3 };
    stepGhost(g, 0.8, 1 / 60);
    expect(g.value).toBe(0.8);
  });
});

describe('picking', () => {
  const xs = new Float32Array([100, 130, 400]);
  const ys = new Float32Array([100, 100, 400]);
  const rs = new Float32Array([18, 18, 18]);
  it('picks the body under the cursor, closest first', () => {
    expect(pickIndex(xs, ys, rs, new Uint8Array([1, 1, 1]), 3, 126, 100, 4)).toBe(1);
    expect(pickIndex(xs, ys, rs, new Uint8Array([1, 1, 1]), 3, 250, 250, 4)).toBe(-1);
  });

  it('prefers a living fighter over a corpse at the same spot', () => {
    const x2 = new Float32Array([100, 102]);
    const y2 = new Float32Array([100, 100]);
    expect(pickIndex(x2, y2, rs, new Uint8Array([0, 1]), 2, 100, 100, 4)).toBe(1);
  });
});

describe('vision fan', () => {
  it('clips rays at walls so a cone never shows sight the sim would block', () => {
    const rays = 8;
    const out = new Float32Array(rays + 1);
    castFan(0, 0, 0, 0.4, 300, [{ x: 100, y: -500, w: 20, h: 1000 }], rays, out);
    for (let i = 0; i <= rays; i++) expect(out[i]).toBeLessThan(110);
    expect(fanContains(0, 0, 0, 0.4, rays, out, 50, 0)).toBe(true);
    expect(fanContains(0, 0, 0, 0.4, rays, out, 150, 0)).toBe(false);
    expect(fanContains(0, 0, 0, 0.4, rays, out, 0, 50)).toBe(false);
  });
});

describe('outline offset', () => {
  it('grows a shape evenly on every side, whatever its winding', () => {
    const sq = rect(0, 0, 10, 10);
    const grown = offsetPoly(sq, 2);
    expect(Math.abs(signedArea(grown))).toBeCloseTo(14 * 14, 5);
    const reversed = rect(0, 10, 10, 0);
    expect(Math.abs(signedArea(offsetPoly(reversed, 2)))).toBeCloseTo(14 * 14, 5);
  });
});

// User feedback: cones jittered because fixed rays popped on and off pillar corners.
describe('visibility polygon', () => {
  const pillar = [{ x: 150, y: 20, w: 40, h: 40 }];
  const ang = new Float32Array(128);
  const dist = new Float32Array(128);

  function area(n: number): number {
    let a = 0;
    for (let i = 0; i + 1 < n; i++) a += 0.5 * dist[i]! * dist[i + 1]! * Math.sin(ang[i + 1]! - ang[i]!);
    return a;
  }

  it('puts the shadow edge exactly on a pillar corner inside the cone', () => {
    const n = castVisibility(0, 0, 0.2, 1.2, 400, pillar, 8, ang, dist);
    for (let i = 1; i < n; i++) expect(ang[i]!).toBeGreaterThanOrEqual(ang[i - 1]!);
    expect(ang[0]).toBeCloseTo(0.2 - 0.6, 6);
    expect(ang[n - 1]).toBeCloseTo(0.2 + 0.6, 6);
    // The pillar's bottom-left corner (150, 60): one ray just short of it stops on the pillar,
    // the next one just past it runs on to the full range.
    const corner = Math.atan2(60, 150);
    let k = -1;
    for (let i = 0; i + 1 < n; i++) if (ang[i]! < corner && ang[i + 1]! > corner && ang[i + 1]! - ang[i]! < 1e-3) k = i;
    expect(k).toBeGreaterThanOrEqual(0);
    expect(dist[k]!).toBeCloseTo(Math.hypot(150, 60), 0);
    expect(dist[k + 1]!).toBeCloseTo(400, 3);
  });

  it('changes smoothly as the head turns past a corner (no popping), unlike a fixed fan', () => {
    let worst = 0;
    let prev = -1;
    for (let h = 0; h < 0.5; h += 0.002) {
      const a = area(castVisibility(0, 0, h, 1.2, 400, pillar, 8, ang, dist));
      if (prev >= 0) worst = Math.max(worst, Math.abs(a - prev));
      prev = a;
    }
    // A turn of 0.002 rad sweeps about 0.002 * 400^2 / 2 = 160 px^2 at most; a popping ray is thousands.
    expect(worst).toBeLessThan(400);
  });
});

// The sim blocks every line of sight across the closing wall, so the drawn cone must stop there too.
describe('vision during sudden death', () => {
  const zone = { x: 0, y: 0, w: 200, h: 100 };
  it('stops rays at the zone edge', () => {
    expect(rayExit(50, 50, 0, zone)).toBeCloseTo(150, 6);
    expect(rayExit(50, 50, -Math.PI / 2, zone)).toBeCloseTo(50, 6);
    const ang = new Float32Array(32);
    const dist = new Float32Array(32);
    const n = castVisibility(50, 50, 0, 1, 400, [], 8, ang, dist, zone);
    for (let i = 0; i < n; i++) {
      const ex = 50 + Math.cos(ang[i]!) * dist[i]!;
      const ey = 50 + Math.sin(ang[i]!) * dist[i]!;
      expect(ex).toBeLessThanOrEqual(200 + 1e-3);
      expect(Math.abs(ey - 50)).toBeLessThanOrEqual(50 + 1e-3);
    }
    expect(Math.max(...Array.from(dist.subarray(0, n)))).toBeGreaterThan(140);
  });

  it('shows no sight at all for a fighter caught outside the zone', () => {
    expect(rayExit(250, 50, Math.PI, zone)).toBe(0);
    const out = new Float32Array(9);
    castFan(250, 50, Math.PI, 1, 400, [], 8, out, zone);
    expect(Math.max(...Array.from(out))).toBe(0);
  });
});

describe('cone heading easing', () => {
  it('glides toward the head angle the short way round and never overshoots', () => {
    let a = 3.0;
    let last = Infinity;
    for (let i = 0; i < 60; i++) {
      a = easeAngle(a, -3.0, 1 / 60, 14);
      const d = Math.abs(Math.atan2(Math.sin(-3.0 - a), Math.cos(-3.0 - a)));
      expect(d).toBeLessThanOrEqual(last + 1e-12);
      last = d;
    }
    expect(last).toBeLessThan(0.01);
    expect(easeAngle(1, 2, 0, 14)).toBeCloseTo(1, 9);
  });
});

describe('lost-sight label digits', () => {
  const out = new Int8Array(4);
  it('shows tenths under ten seconds and whole seconds after, capped at 99', () => {
    expect(Array.from(out.subarray(0, secondsDigits(2.34, out)))).toEqual([2, DOT, 3]);
    expect(Array.from(out.subarray(0, secondsDigits(0, out)))).toEqual([0, DOT, 0]);
    expect(Array.from(out.subarray(0, secondsDigits(12.6, out)))).toEqual([1, 3]);
    expect(Array.from(out.subarray(0, secondsDigits(9.97, out)))).toEqual([1, 0]);
    expect(Array.from(out.subarray(0, secondsDigits(500, out)))).toEqual([9, 9]);
  });
});
