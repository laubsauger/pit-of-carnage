import { describe, expect, it } from 'vitest';
import { BLOOD_FLOOR, BLOOD_RAMP, DRYING, LUMA, bloodAlbedo, bloodLit, dryFraction, srgbToLinear, wetAfter } from './palette';
import type { Rgb } from './palette';

const DENSITIES = [0.02, 0.1, 0.3, 0.6, 1, 2, 4, 8, 20, 60];
const SHARES = [0, 0.1, 0.3, 0.5, 0.8, 1];

function lum(c: Rgb): number {
  return c.r * LUMA.r + c.g * LUMA.g + c.b * LUMA.b;
}

/** How red a colour is: red over the larger of green and blue (grey = 1). */
function redness(c: Rgb): number {
  return c.r / Math.max(c.g, c.b, 1e-6);
}

describe('floor blood gradient', () => {
  const c: Rgb = { r: 0, g: 0, b: 0 };

  // The user's screenshots: stacked splats went grey-black. Blood is now data mapped through one
  // gradient, so however much piles up (any density, wetness, tone) the colour stays plainly red.
  it('never turns grey or black, however much blood overlaps', () => {
    for (const d of DENSITIES) {
      for (const wet of SHARES) {
        for (const tone of SHARES) {
          bloodAlbedo(c, d, wet, tone);
          expect(redness(c), `density ${d}, wet ${wet}, tone ${tone}`).toBeGreaterThan(4);
          // Darkness floor: never below the darkest stop of the gradient.
          expect(c.r).toBeGreaterThanOrEqual(BLOOD_RAMP.dry[2].r - 1e-9);
        }
      }
    }
  });

  it('keeps every stop of the gradient red, the darkest one included', () => {
    for (const s of [...BLOOD_RAMP.wet, ...BLOOD_RAMP.dry]) expect(redness(s)).toBeGreaterThan(4);
  });

  // Pools and trampled areas should read deeper than a single spray, not the same flat red.
  it('gets deeper with more blood', () => {
    for (const wet of [0, 1]) {
      let last = Infinity;
      for (const d of DENSITIES) {
        const l = lum(bloodAlbedo(c, d, wet, BLOOD_FLOOR.tone));
        expect(l).toBeLessThanOrEqual(last + 1e-12);
        last = l;
      }
      expect(lum(bloodAlbedo(c, 0.3, wet, BLOOD_FLOOR.tone))).toBeGreaterThan(lum(bloodAlbedo(c, 8, wet, BLOOD_FLOOR.tone)) * 1.5);
    }
  });

  it('paints a fresh thin spray bright arterial red', () => {
    bloodAlbedo(c, 0.4, 1, 1);
    expect(c.r).toBeGreaterThan(0.4);
    expect(redness(c)).toBeGreaterThan(10);
  });

  // Drying changes colour toward maroon (it used to change only an invisible sheen), but darkens
  // without losing its hue: never toward grey.
  it('dries toward maroon: darker, still red', () => {
    for (const d of [0.3, 1, 4]) {
      const wet = { ...bloodAlbedo(c, d, 1, BLOOD_FLOOR.tone) };
      const dry = { ...bloodAlbedo(c, d, 0, BLOOD_FLOOR.tone) };
      expect(lum(dry)).toBeLessThan(lum(wet));
      expect(redness(dry)).toBeGreaterThan(4);
      let last = Infinity;
      for (let w = 1; w >= 0; w -= 0.1) {
        const l = lum(bloodAlbedo(c, d, w, BLOOD_FLOOR.tone));
        expect(l).toBeLessThanOrEqual(last + 1e-12);
        last = l;
      }
    }
  });
});

describe('lit floor blood', () => {
  const c: Rgb = { r: 0, g: 0, b: 0 };
  const out: Rgb = { r: 0, g: 0, b: 0 };
  /** The Catacombs' ambient light (lightfield.ts: AMBIENT_TINT x map ambient x AMBIENT_GAIN). */
  const catacombs: Rgb = { r: 0.55 * 0.06 * 1.5, g: 0.62 * 0.06 * 1.5, b: 0.85 * 0.06 * 1.5 };
  const torch: Rgb = { r: 1.4, g: 1.05, b: 0.7 };

  // Blood barely showed on the dark Catacombs floor, and the cool ambient pulled it toward blue-grey.
  it('stays red and visible in the darkest, coolest shadow', () => {
    for (const d of DENSITIES) {
      for (const wet of [0, 1]) {
        bloodLit(out, bloodAlbedo(c, d, wet, BLOOD_FLOOR.tone), catacombs, wet);
        expect(redness(out), `density ${d}, wet ${wet}`).toBeGreaterThan(4);
        // Never below the darkness floor, which is itself a visible dark red on screen.
        expect(out.r).toBeGreaterThanOrEqual(BLOOD_FLOOR.darkest.r);
      }
    }
    expect(BLOOD_FLOOR.darkest.r).toBeGreaterThan(srgbToLinear(40));
    expect(redness(BLOOD_FLOOR.darkest)).toBeGreaterThan(4);
  });

  // Old blood must still read darker than fresh blood in the same light, or drying is invisible.
  it('keeps fresh blood brighter than dried blood under the same light', () => {
    for (const light of [catacombs, torch]) {
      for (const d of [0.4, 1, 3]) {
        const fresh = lum(bloodLit(out, bloodAlbedo(c, d, 1, BLOOD_FLOOR.tone), light, 1));
        const dry = lum(bloodLit(out, bloodAlbedo(c, d, 0, BLOOD_FLOOR.tone), light, 0));
        expect(fresh, `density ${d}`).toBeGreaterThan(dry * 1.15);
      }
    }
  });

  it('is lit by the scene like the floor: torchlight is brighter than shadow', () => {
    bloodAlbedo(c, 1, 1, BLOOD_FLOOR.tone);
    const dark = lum(bloodLit(out, c, catacombs, 1));
    const lit = lum(bloodLit(out, c, torch, 1));
    expect(lit).toBeGreaterThan(dark * 3);
  });

  // "Reads from straight above": the wet highlight is a faint red gain, never a light film that
  // could grey dense blood out (the old sheen did exactly that).
  it('adds only a faint, red wet highlight', () => {
    bloodAlbedo(c, 4, 1, BLOOD_FLOOR.tone);
    const wet = { ...bloodLit(out, c, torch, 1) };
    const matte = { ...bloodLit(out, c, torch, 0) };
    expect(wet.r - matte.r).toBeLessThanOrEqual(lum(torch) * 0.06);
    expect(wet.g - matte.g).toBeLessThan((wet.r - matte.r) * 0.2);
    expect(redness(wet)).toBeGreaterThan(4);
  });
});

describe('drying blood', () => {
  it('halves the wet share every half-life, the same at any frame rate', () => {
    expect(dryFraction(0)).toBe(0);
    expect(dryFraction(DRYING.wetHalfLife)).toBeCloseTo(0.5, 9);
    expect(wetAfter(DRYING.wetHalfLife)).toBeCloseTo(0.5, 9);
    let wet = 1;
    for (let i = 0; i < DRYING.wetHalfLife / DRYING.interval; i++) wet *= 1 - dryFraction(DRYING.interval);
    expect(wet).toBeCloseTo(0.5, 6);
    // Blood spilled during a fight should visibly dry before the 90 s match is over.
    expect(DRYING.wetHalfLife).toBeLessThan(30);
  });

  // The decal target is half float (11 significant bits). A drying step smaller than half a unit
  // in the last place near "almost dry" rounds away, and drying would stall there; per-frame steps
  // did. One step at the configured interval must still register when 5% wetness is left.
  it('dries in steps big enough for the half-float target', () => {
    const halfUlpNearOne = 2 ** -12;
    expect(0.05 * dryFraction(DRYING.interval)).toBeGreaterThan(halfUlpNearOne);
  });
});
