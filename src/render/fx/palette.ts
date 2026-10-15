// Owned by: render-fx
/**
 * Colours for gore and debris, in linear working space (what node materials and the decal target
 * expect). Kept free of three.js so the pure fx logic stays testable in node.
 *
 * The floor decal target stores a *multiply* colour over the floor albedo (white = clean floor), so
 * blood colours here are "how much of the floor's light survives" through one layer of blood:
 * bright arterial red keeps most of the red channel and kills green/blue, clotted blood keeps almost
 * nothing. Thinner or thicker layers raise this to a power (see `decalShade`).
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

/** Clotted near-black maroon -> dark maroon -> blood red -> bright arterial red. */
const BLOOD_STOPS = [stop(0, 0x2a0407), stop(0.35, 0x5a080c), stop(0.7, 0x931016), stop(1, 0xd0201e)];

/**
 * Blood colour along the maroon-to-arterial ramp. `t` = 0 is old, thick, nearly black blood;
 * `t` = 1 is fresh arterial spray.
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
 * The darkest the floor's gore multiply colour may get (linear): a deep maroon. Overlapping stamps
 * keep absorbing, and without a floor trampled pools went to pure black; the floor's wet sheen on a
 * black floor read as grey, patchy blotches. Every decal pass clamps the target up to this colour,
 * so old blood ends near-black maroon and stays red in hue.
 */
export const GORE_FLOOR: Readonly<Rgb> = { r: 0.085, g: 0.0075, b: 0.007 };

/**
 * Drying of floor gore. Colour never fades (blood stays for the whole match); what dries is the
 * wetness the target keeps in alpha, which the floor turns into a sheen. Fresh blood glistens, old
 * blood is matte.
 */
export const DRYING = {
  /** Seconds (game time) for the wet sheen to halve. */
  wetHalfLife: 9,
  /** Seconds between drying passes when nothing new was painted. */
  interval: 0.25,
};

/** Fraction of wetness a drying pass removes after `seconds` of game time. */
export function dryFraction(seconds: number): number {
  return seconds <= 0 ? 0 : 1 - Math.pow(0.5, seconds / DRYING.wetHalfLife);
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
