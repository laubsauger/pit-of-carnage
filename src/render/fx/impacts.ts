// Owned by: render-fx
/**
 * The projectile colour code. Every projectile type has one colour that its trail, its impact and
 * its sparks share, and its own impact effect, so a hit reads at a glance and never as one shared
 * grey puff:
 *
 * - arrows: warm ash-wood amber; wood splinters and a small spray where they land,
 * - thrown axes: cold steel blue-white; metal sparks and a clang flash,
 * - staff orbs: the caster's spell colour (from the fighter colour, see `spellColor`); an arcane
 *   burst and a ring the size of the splash,
 * - kegs: fire orange; a fireball and a scorch mark.
 *
 * Pure, no three.js: the world renderer can use the same colours for the projectile bodies.
 */

import type { WeaponId } from '../../core';
import { hexToLinear, srgbToLinear } from './palette';
import type { Rgb } from './palette';

export type ImpactStyle = 'splinters' | 'sparks' | 'arcane' | 'fireball';

export type ProjectileWeapon = Extract<WeaponId, 'LONGBOW' | 'THROWING_AXES' | 'ARCANE_STAFF'>;

export type ProjectileFx = {
  impact: ImpactStyle;
  /** Trail, impact and spark colour (sRGB hex). Staff orbs use it only when the caster is unknown. */
  color: string;
};

export const PROJECTILE_FX: Readonly<Record<ProjectileWeapon, ProjectileFx>> = {
  LONGBOW: { impact: 'splinters', color: '#e8b45a' },
  THROWING_AXES: { impact: 'sparks', color: '#b8d4ff' },
  ARCANE_STAFF: { impact: 'arcane', color: '#a565ff' },
};

/** Keg blasts: an orange fireball and a scorch mark. */
export const KEG_FX: Readonly<ProjectileFx> = { impact: 'fireball', color: '#ff6a12' };

export function isProjectileWeapon(w: WeaponId | null | undefined): w is ProjectileWeapon {
  return w === 'LONGBOW' || w === 'THROWING_AXES' || w === 'ARCANE_STAFF';
}

/** Linear colour of a projectile type (staff orbs: pass the caster's colour for its spell colour). */
export function projectileColor(out: Rgb, weapon: ProjectileWeapon, casterHex: string | null): Rgb {
  if (weapon === 'ARCANE_STAFF' && casterHex) return spellColor(out, casterHex);
  return hexToLinear(out, PROJECTILE_FX[weapon].color);
}

/**
 * A caster's spell colour (linear): the fighter colour's hue at full saturation and a bright,
 * glowing lightness, so every staff wielder's orbs, trails and bursts are their own and read as
 * magic rather than paint. A colourless fighter colour falls back to the default arcane violet.
 */
export function spellColor(out: Rgb, fighterHex: string): Rgb {
  const s = fighterHex.charAt(0) === '#' ? fighterHex.slice(1) : fighterHex;
  const n = s.length === 6 ? parseInt(s, 16) : NaN;
  if (Number.isNaN(n)) return hexToLinear(out, PROJECTILE_FX.ARCANE_STAFF.color);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.12) return hexToLinear(out, PROJECTILE_FX.ARCANE_STAFF.color);
  let h: number;
  if (max === r) h = ((g - b) / (max - min) + 6) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  // Back to RGB at saturation 1, lightness SPELL_LIGHTNESS.
  out.r = srgbToLinear(hueChannel(h) * 255);
  out.g = srgbToLinear(hueChannel(h + 4) * 255);
  out.b = srgbToLinear(hueChannel(h + 2) * 255);
  return out;
}

const SPELL_LIGHTNESS = 0.62;

/**
 * One RGB channel of a fully saturated HSL colour. `h` is the hue in sixths (0 red, 2 green,
 * 4 blue); red reads it as is, green shifted by 4, blue by 2.
 */
function hueChannel(h: number): number {
  const k = h % 6;
  const t = Math.abs(k - 3) - 1;
  const chroma = 1 - Math.abs(2 * SPELL_LIGHTNESS - 1);
  return SPELL_LIGHTNESS + chroma * ((t < 0 ? 0 : t > 1 ? 1 : t) - 0.5);
}
