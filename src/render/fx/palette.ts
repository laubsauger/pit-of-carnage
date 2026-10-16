// Owned by: render-fx
/**
 * Colours for gore and debris, in linear working space (what node materials and the decal target
 * expect). Kept free of three.js so the pure fx logic stays testable in node.
 *
 * Floor blood is stored as data, not colour (see decals.ts): how much blood lies on a texel, how
 * much of it is still wet, and its tone. The floor maps that data through one blood gradient
 * (`bloodAlbedo`, mirrored in TSL by goreFloor.ts): deep arterial red where it is thin and fresh,
 * dark wet red where it pools, maroon-brown once it has dried (about 30 s). Every stop is clearly
 * red, the darkest one included, so overlaps can never turn grey or black, and fresh blood on old
 * stands out by hue as well as brightness.
 */

export type Rgb = { r: number; g: number; b: number };

export function srgbToLinear(c255: number): number {
  const c = c255 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Parse `#rrggbb` (or `rrggbb`) into linear rgb. Invalid input gives mid grey. */
export function hexToLinear(out: Rgb, hex: string): Rgb {
  const s = hex.charAt(0) === '#' ? hex.slice(1) : hex;
  const n = s.length === 6 ? parseInt(s, 16) : NaN;
  if (Number.isNaN(n)) {
    out.r = out.g = out.b = 0.2;
    return out;
  }
  out.r = srgbToLinear((n >> 16) & 255);
  out.g = srgbToLinear((n >> 8) & 255);
  out.b = srgbToLinear(n & 255);
  return out;
}

function stop(t: number, hex: number): { t: number; r: number; g: number; b: number } {
  return { t, r: srgbToLinear((hex >> 16) & 255), g: srgbToLinear((hex >> 8) & 255), b: srgbToLinear(hex & 255) };
}

/** Clotted near-black maroon -> dark maroon -> blood red -> deep arterial red (the floor's fresh red). */
const BLOOD_STOPS = [stop(0, 0x2a0407), stop(0.35, 0x5a080c), stop(0.7, 0x8c1016), stop(1, 0xbc1d1c)];

/**
 * Colour of blood in the air (drops, mist, gib sheen) along the maroon-to-arterial ramp. `t` = 0
 * is dark clotted blood, `t` = 1 fresh arterial spray. Floor blood uses `bloodAlbedo` instead.
 */
export function bloodColor(out: Rgb, t: number): Rgb {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  let i = 1;
  while (i < BLOOD_STOPS.length - 1 && BLOOD_STOPS[i].t < x) i++;
  const a = BLOOD_STOPS[i - 1];
  const b = BLOOD_STOPS[i];
  const k = (x - a.t) / (b.t - a.t);
  out.r = a.r + (b.r - a.r) * k;
  out.g = a.g + (b.g - a.g) * k;
  out.b = a.b + (b.b - a.b) * k;
  return out;
}

/**
 * Drying of floor gore. Blood never fades (it stays for the whole match); what dries is the wet
 * share the target keeps, which the floor turns into colour: wet blood is arterial to deep red with a
 * faint highlight, dried blood is maroon. Drying shifts the colour, never toward grey.
 */
export const DRYING = {
  /** Seconds (game time) for the wet share of floor blood to halve. */
  wetHalfLife: 10,
  /**
   * Seconds between drying passes. Not every frame: the target is half float, and a per-frame step
   * is smaller than its precision near "almost dry", so drying would stall there.
   */
  interval: 0.5,
};

/** Fraction of wetness a drying pass removes after `seconds` of game time. */
export function dryFraction(seconds: number): number {
  return seconds <= 0 ? 0 : 1 - Math.pow(0.5, seconds / DRYING.wetHalfLife);
}

/** Wetness left on blood that was spilled `seconds` ago (1 = fresh). */
export function wetAfter(seconds: number): number {
  return seconds <= 0 ? 1 : Math.pow(0.5, seconds / DRYING.wetHalfLife);
}

function lin(hex: number): Rgb {
  return { r: srgbToLinear((hex >> 16) & 255), g: srgbToLinear((hex >> 8) & 255), b: srgbToLinear(hex & 255) };
}

/**
 * The one blood gradient of the floor, by thickness (thin, mid, thick). Wet blood is a deep
 * arterial red (bright, never neon) running to a dark wet red; dried blood a maroon-brown running to
 * a dark brown-maroon. Dry and wet differ in hue as well as level, so fresh blood landing on old
 * reads at a glance. The darkest stop is the darkness floor: still plainly red (red channel several
 * times green and blue), never grey.
 */
export const BLOOD_RAMP: Readonly<{ wet: readonly Rgb[]; dry: readonly Rgb[] }> = {
  wet: [lin(0xb81f1b), lin(0x921218), lin(0x6e0c14)],
  dry: [lin(0x6a2318), lin(0x4c1912), lin(0x38130e)],
};

/** How floor blood data turns into colour and light (shared by `bloodAlbedo` and goreFloor.ts). */
export const BLOOD_FLOOR = {
  /** Coverage of the floor by blood of density D: 1 - exp(-cover x D). Thin edges let the floor through. */
  cover: 3,
  /** Position on the gradient: thickness = 1 - exp(-thick x D) (a spray ~0.4, a trampled pool ~0.9). */
  thick: 0.6,
  /** Tone a stamp has when nothing says otherwise (1 = arterial spray, 0.4 = pooled). */
  tone: 0.7,
  /** How far tone moves a stamp along the gradient (darker tone = thicker look). */
  toneShift: 0.45,
  /**
   * Blood is lit with at least this much light in every channel, so the cool ambient can never tint
   * it blue-grey and fresh and dried blood stay apart in the dark.
   */
  minLight: 0.2,
  /**
   * The darkness floor of lit blood (linear, sRGB #2c0809): however dark the spot, blood is never
   * darker than this, so it reads red on the Catacombs' near-black stone (it read black there).
   */
  darkest: { r: srgbToLinear(0x2c), g: srgbToLinear(0x08), b: srgbToLinear(0x09) } as Readonly<Rgb>,
  /** Wet highlight: share of the light added back as a faint red gloss on fresh blood. */
  gloss: 0.05,
  /** Fresh share of a texel: wet share s (wet density / density) becomes 1 - (1 - s)^layer of the colour. */
  layer: 2,
  /**
   * Fresh blood on old: wet density W covers 1 - exp(-freshCover x W) of the texel whatever lies
   * under it, so a new spray over a dried pool shows as fresh red instead of vanishing into it.
   */
  freshCover: 2.5,
};

function ramp3(out: Rgb, s: readonly Rgb[], t: number): Rgb {
  const a = t * 2 < 0 ? 0 : t * 2 > 1 ? 1 : t * 2;
  const b = t * 2 - 1 < 0 ? 0 : t * 2 - 1 > 1 ? 1 : t * 2 - 1;
  out.r = s[0].r + (s[1].r - s[0].r) * a + (s[2].r - s[1].r) * b;
  out.g = s[0].g + (s[1].g - s[0].g) * a + (s[2].g - s[1].g) * b;
  out.b = s[0].b + (s[1].b - s[0].b) * a + (s[2].b - s[1].b) * b;
  return out;
}

/**
 * How fresh floor blood looks, 0 (dried) .. 1 (just spilled), from its `density` and the wet part
 * of it (`wetDensity`, see decals.ts). The larger of two readings: the wet share of the blood there
 * (a single splat starts fully fresh and dries with it), and the coverage of the wet blood alone (a
 * new splat over an old pool is fresh where it lies, however much dried blood is under it).
 */
export function bloodFreshness(density: number, wetDensity: number): number {
  const F = BLOOD_FLOOR;
  const d = density > 1e-4 ? density : 1e-4;
  const w = wetDensity > 0 ? wetDensity : 0;
  const share = Math.min(1, w / d);
  const byShare = 1 - Math.pow(1 - share, F.layer);
  const byCover = 1 - Math.exp(-F.freshCover * w);
  return Math.max(byShare, byCover);
}

const dryTmp: Rgb = { r: 0, g: 0, b: 0 };

/**
 * Albedo (linear) of floor blood: `density` is how much blood lies there (0 none, ~1 a spray, 4+ a
 * trampled pool), `wetDensity` how much of it is still wet (0..density), `tone` its average tone
 * 0..1. The TSL floor composite computes exactly this.
 */
export function bloodAlbedo(out: Rgb, density: number, wetDensity: number, tone: number): Rgb {
  const F = BLOOD_FLOOR;
  const d = density > 0 ? density : 0;
  const th = 1 - Math.exp(-F.thick * d);
  const t = Math.min(1, Math.max(0, th + (F.tone - tone) * F.toneShift));
  const fresh = bloodFreshness(d, wetDensity);
  ramp3(dryTmp, BLOOD_RAMP.dry, t);
  ramp3(out, BLOOD_RAMP.wet, t);
  out.r = dryTmp.r + (out.r - dryTmp.r) * fresh;
  out.g = dryTmp.g + (out.g - dryTmp.g) * fresh;
  out.b = dryTmp.b + (out.b - dryTmp.b) * fresh;
  return out;
}

/** Wet density left after `seconds` of drying a texel that held `wetDensity` (the decal target's drying passes). */
export function wetDensityAfter(wetDensity: number, seconds: number): number {
  const wetCover = (1 - Math.exp(-Math.max(0, wetDensity))) * wetAfter(seconds);
  return -Math.log(1 - wetCover);
}

/** Luminance weights (linear Rec. 709). */
export const LUMA: Readonly<Rgb> = { r: 0.2126, g: 0.7152, b: 0.0722 };

/**
 * Lit floor blood (linear): `albedo` under `light` (linear rgb, light field x ambient occlusion),
 * every channel lit with at least `BLOOD_FLOOR.minLight`, plus the faint red gloss of fresh blood
 * (`wet` = `bloodFreshness`), and never darker than `BLOOD_FLOOR.darkest`. Mirrors goreFloor.ts.
 */
export function bloodLit(out: Rgb, albedo: Rgb, light: Rgb, wet: number): Rgb {
  const F = BLOOD_FLOOR;
  const lum = light.r * LUMA.r + light.g * LUMA.g + light.b * LUMA.b;
  const w = Math.min(1, Math.max(0, wet));
  const gloss = w * w * lum * F.gloss;
  out.r = Math.max(F.darkest.r, albedo.r * Math.max(light.r, F.minLight) + gloss);
  out.g = Math.max(F.darkest.g, albedo.g * Math.max(light.g, F.minLight) + gloss * 0.12);
  out.b = Math.max(F.darkest.b, albedo.b * Math.max(light.b, F.minLight) + gloss * 0.1);
  return out;
}

/**
 * Dust colours per floor type (linear). Particles are unlit while the floor is lit dimly, so these
 * sit at roughly the floor's average lit brightness instead of its albedo; brighter dust glows.
 */
export const DUST_COLORS: Readonly<Record<'sand' | 'stone' | 'flesh', Rgb>> = {
  sand: { r: srgbToLinear(0x8a), g: srgbToLinear(0x70), b: srgbToLinear(0x50) },
  stone: { r: srgbToLinear(0x62), g: srgbToLinear(0x5d), b: srgbToLinear(0x56) },
  flesh: { r: srgbToLinear(0x5a), g: srgbToLinear(0x34), b: srgbToLinear(0x30) },
};
