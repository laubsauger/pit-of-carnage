import { describe, expect, it } from 'vitest';
import { GRAVITY, PK, bloodLanding } from './particleRules';
import { bloodColor, hexToLinear, srgbToLinear } from './palette';

describe('blood drop landing prediction', () => {
  // Footprints use the CPU prediction of where drops land; it must match where the GPU kernel
  // (semi-implicit Euler at the frame step) actually puts them.
  it('matches the GPU integration within a couple of pixels', () => {
    const out = { x: 0, y: 0 };
    const start = { x: 100, y: 50, z: 16, vx: 220, vy: -90, vz: 160 };
    bloodLanding(out, start.x, start.y, start.z, start.vx, start.vy, start.vz);
    let { x, y, z, vz } = start;
    const dt = 1 / 60;
    while (z >= 0) {
      vz -= GRAVITY[PK.blood] * dt;
      x += start.vx * dt;
      y += start.vy * dt;
      z += vz * dt;
    }
    expect(Math.hypot(out.x - x, out.y - y)).toBeLessThan(5);
  });

  it('lands a drop thrown straight up back where it started', () => {
    const out = { x: 0, y: 0 };
    const t = bloodLanding(out, 10, 20, 0, 0, 0, 300);
    expect(out).toEqual({ x: 10, y: 20 });
    expect(t).toBeCloseTo((2 * 300) / GRAVITY[PK.blood], 6);
  });
});

describe('blood palette', () => {
  const c = { r: 0, g: 0, b: 0 };
  // Blood in the air (drops, mist): fresh arterial blood must be redder and brighter than clotted
  // blood, and always far more red than green or blue (or it reads as mud).
  it('runs from dark maroon to bright arterial red', () => {
    const old = { ...bloodColor(c, 0) };
    const fresh = { ...bloodColor(c, 1) };
    expect(fresh.r).toBeGreaterThan(old.r * 4);
    expect(old.r).toBeLessThan(0.05);
    for (const t of [0, 0.3, 0.6, 1]) {
      bloodColor(c, t);
      expect(c.r).toBeGreaterThan(c.g * 5);
      expect(c.r).toBeGreaterThan(c.b * 5);
    }
  });

  it('clamps out-of-range ramp positions', () => {
    expect({ ...bloodColor(c, -1) }).toEqual({ ...bloodColor({ r: 0, g: 0, b: 0 }, 0) });
    expect({ ...bloodColor(c, 3) }).toEqual({ ...bloodColor({ r: 0, g: 0, b: 0 }, 1) });
  });

  it('converts fighter hex colours to linear', () => {
    hexToLinear(c, '#ffffff');
    expect(c).toEqual({ r: 1, g: 1, b: 1 });
    hexToLinear(c, '#F2A541');
    expect(c.r).toBeCloseTo(srgbToLinear(0xf2), 6);
    hexToLinear(c, 'nope');
    expect(c.r).toBeCloseTo(0.2, 6);
  });
});
