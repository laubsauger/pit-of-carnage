import { describe, expect, it } from 'vitest';
import type { MapDef } from '../core';
import {
  LIGHT_HEIGHT, buildOcclusion, collectMapLights, flicker, lightBlockers, lightFalloff, newShadowLight, occlusionRow,
  pickShadowLights, projectShadow,
} from './lightmath';
import type { ShadowSource } from './lightmath';

const ANGLES = 360;

function map(partial: Partial<MapDef>): MapDef {
  return {
    id: 't', name: 't', width: 1000, height: 600, floor: 'sand', ambient: 0.1, walls: [], pillars: [], lights: [],
    hazards: [], props: [], shrines: [], pickups: [], spawns: [], ...partial,
  };
}

describe('occlusion table', () => {
  it('stops a ray at the pillar, so the floor behind it is drawn in shadow like the sim counts it', () => {
    const m = map({ pillars: [{ x: 200, y: -20, w: 40, h: 40 }] });
    const out = new Float32Array(ANGLES);
    occlusionRow({ x: 0, y: 0, radius: 400 }, lightBlockers(m), ANGLES, out, 0);
    // Angle 0 points east, straight into the pillar's west face (shrunk by 1 px like the sim).
    expect(out[0]).toBeCloseTo(201, 3);
    // Pointing west nothing is in the way: the full radius.
    expect(out[ANGLES / 2]).toBeCloseTo(400, 3);
  });

  it('leaves lights that do not cast shadows unblocked', () => {
    const m = map({
      pillars: [{ x: 50, y: -10, w: 20, h: 20 }],
      lights: [{ id: 'a', pos: { x: 0, y: 0 }, radius: 300, intensity: 1, color: '#fff', flicker: 0, castsShadow: false }],
    });
    const lights = collectMapLights(m);
    const out = new Float32Array(ANGLES);
    buildOcclusion(lights, lightBlockers(m), ANGLES, out);
    expect(out[0]).toBe(300);
  });

  it('takes fire light from map.lights only, because the sim already lists every fire pit light there', () => {
    const m = map({
      hazards: [{ id: 'f', kind: 'fire', pos: { x: 10, y: 20 }, radius: 40 }],
      lights: [{ id: 'f_light', pos: { x: 10, y: 20 }, radius: 175, intensity: 0.55, color: '#ff7a2e', flicker: 0.45, castsShadow: true }],
    });
    const lights = collectMapLights(m);
    // One light per fire pit: a second one from the hazard list would make it twice as bright as the sim's.
    expect(lights).toHaveLength(1);
    expect(lights[0]!.id).toBe('f_light');
    expect(lights[0]!.occluded).toBe(true);
  });
});

describe('falloff and flicker', () => {
  it('matches the sim falloff: full at the centre, zero at the radius, smooth between', () => {
    expect(lightFalloff(0, 100)).toBe(1);
    expect(lightFalloff(100, 100)).toBe(0);
    expect(lightFalloff(50, 100)).toBeCloseTo(0.5, 5);
  });

  it('keeps torch flicker bounded so lit zones never visibly drop into shadow', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < 20; t += 0.01) {
      const f = flicker(t, 1.3, 0.35);
      lo = Math.min(lo, f);
      hi = Math.max(hi, f);
    }
    expect(lo).toBeGreaterThanOrEqual(1 - 0.6 * 0.35 - 1e-9);
    expect(hi).toBeLessThanOrEqual(1 + 0.6 * 0.35 + 1e-9);
    expect(hi - lo).toBeGreaterThan(0.1);
    expect(flicker(3, 1, 0)).toBe(1);
  });
});

// User feedback: walls cast torch shadows but bodies did not, so fighters looked pasted on.
describe('body shadows', () => {
  const source = (x: number, y: number, gain: number, occRow = -1): ShadowSource => ({ x, y, radius: 400, height: LIGHT_HEIGHT, gain, occRow });
  const out = [newShadowLight(), newShadowLight(), newShadowLight()];

  it('falls straight away from the light and grows longer the further the body stands from it', () => {
    const p = { x: 0, y: 0 };
    const near = projectShadow(0, 0, LIGHT_HEIGHT, 100, 0, 26, 1000, p);
    expect(p.x).toBeGreaterThan(100);
    expect(p.y).toBeCloseTo(0, 6);
    const far = projectShadow(0, 0, LIGHT_HEIGHT, 0, 250, 26, 1000, p);
    expect(p.y).toBeGreaterThan(250);
    expect(p.x).toBeCloseTo(0, 6);
    expect(far).toBeGreaterThan(near * 2);
  });

  it('caps the shadow length, so a body beside a low fire never throws a shadow across the arena', () => {
    const p = { x: 0, y: 0 };
    expect(projectShadow(0, 0, 30, 300, 0, 26, 120, p)).toBe(120);
    expect(p.x).toBeCloseTo(420, 6);
  });

  it('lets the dominant light throw the darkest shadow and ignores lights that are out of range', () => {
    const lights = [source(-100, 0, 1), source(0, 200, 1), source(2000, 0, 5)];
    const n = pickShadowLights(lights, lights.length, 0.05, new Float32Array(0), 1, 0, 0, out, 3, 0.02);
    expect(n).toBe(2);
    expect(out[0]!.x).toBe(-100);
    expect(out[0]!.share).toBeGreaterThan(out[1]!.share);
    expect(out[0]!.share + out[1]!.share).toBeLessThan(1);
  });

  it('casts nothing from a light a wall blocks, matching the shadows the floor already shows', () => {
    const m = map({ pillars: [{ x: 40, y: -20, w: 20, h: 40 }] });
    const occ = new Float32Array(ANGLES);
    occlusionRow({ x: 0, y: 0, radius: 400 }, lightBlockers(m), ANGLES, occ, 0);
    const lights = [source(0, 0, 1, 0)];
    expect(pickShadowLights(lights, 1, 0.05, occ, ANGLES, 120, 0, out, 3, 0.02)).toBe(0);
    expect(pickShadowLights(lights, 1, 0.05, occ, ANGLES, -120, 0, out, 3, 0.02)).toBe(1);
  });

  it('casts only faint or no shadows where ambient light dominates (dark maps vs lit arenas)', () => {
    const lights = [source(-350, 0, 0.3)];
    expect(pickShadowLights(lights, 1, 2, new Float32Array(0), 1, 0, 0, out, 3, 0.08)).toBe(0);
  });
});
