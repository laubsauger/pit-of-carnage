/**
 * Shape library for the fighters, projectiles and floor items: cartoon gladiators seen from
 * straight above, built like a wrestling-broadcast figurine. Sizes are world px for a body of
 * radius NOMINAL_RADIUS; the rig scales each fighter by radius / NOMINAL_RADIUS.
 *
 * Silhouette rules (readability at a glance, at any zoom):
 * - Torso and cape in team colour, so the colour reads first.
 * - The head has a nose and the eyes sit at the front: you can always tell which way someone faces.
 * - Each weapon class has its own headgear shape (crest, horns, cowl tails, beard, hood point,
 *   wizard brim), so you can tell a duel's matchup without reading names.
 * - Oversized weapons with a glow strip that lights up during the windup (the telegraph).
 */

import type * as THREE from 'three/webgpu';
import type { WeaponId } from '../core';
import { buildCutout, SLOT } from './cutout';
import type { ShapeSpec } from './cutout';
import { arcBand, circle, ellipse, mirrorV, rect, roundRect, star, taperedCurve, transformPoly } from './poly';
import type { Poly } from './poly';

export const NOMINAL_RADIUS = 18;

export const C = {
  leather: 0x4a3324,
  boot: 0x2b231e,
  metal: 0x9aa3ae,
  metalDark: 0x5d6570,
  iron: 0x5a6069,
  gold: 0xe0aa45,
  wood: 0x7d5434,
  woodLight: 0xc9a46a,
  steel: 0xdfe5ec,
  bone: 0xeee3cb,
  cloth: 0x27232f,
  clothLight: 0x3d3747,
  white: 0xf6f2ea,
  pupil: 0x15110f,
  stump: 0x9e1a16,
  marrow: 0xf1dccb,
  beard: 0xb9581f,
  hair: 0x3d2819,
  glowGold: 0xffc75a,
  glowGreen: 0x8dffc6,
  glowArcane: 0xc58cff,
  glowCyan: 0x7fe3ff,
  string: 0xeae3d0,
  purpleWood: 0x4b2d5e,
} as const;

/** Team colour at a brightness factor (vertex colour multiplies the instance team colour). */
function team(k: number): number {
  const v = Math.round(Math.min(1, k) * 255);
  return (v << 16) | (v << 8) | v;
}

const skin: Partial<ShapeSpec> = { slot: SLOT.skin, color: 0xffffff };

// ---------------------------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------------------------

export function bootGeometry(): THREE.BufferGeometry {
  return buildCutout([
    { poly: roundRect(0, 0, 11.5, 7.6, 3.2), color: C.boot, dome: true },
    { poly: roundRect(3.6, 0, 4, 6, 2), color: C.metalDark, outline: 0.7 },
  ]);
}

/** Cape hangs from the shoulder line at u = 0 and trails back (the rig wobbles it). */
export function capeGeometry(): THREE.BufferGeometry {
  const p: Poly = [0, -13.5, -9, -16, -18, -14.5, -22.5, -7.5, -20.5, 0, -23, 7.5, -18, 14.5, -9, 16, 0, 13.5];
  return buildCutout([
    { poly: p, color: team(0.55), slot: SLOT.team },
    { poly: [-2, -8, -14, -9.5, -15, 0, -14, 9.5, -2, 8], color: team(0.42), slot: SLOT.team, outline: 0 },
  ]);
}

export function torsoGeometry(): THREE.BufferGeometry {
  return buildCutout([
    { poly: ellipse(0, 0, 11.4, 16.4, 28), color: team(1), slot: SLOT.team, dome: true },
    { poly: transformPoly(rect(-1.6, -12, 1.6, 12), 0, 0, -0.42), color: C.leather, outline: 0 },
    { poly: roundRect(0, 0, 4, 4.2, 1), color: C.gold, outline: 0.8 },
  ]);
}

/** Unit-length bar along u (0..1) with a fixed width in px; outlined on the long sides only. */
export function barGeometry(width: number, color: number, slot: number = SLOT.fixed, outline = 1.4): THREE.BufferGeometry {
  const h = width / 2;
  const specs: ShapeSpec[] = [];
  if (outline > 0) specs.push({ poly: rect(0, -h - outline, 1, h + outline), color: 0x0b0908, slot: SLOT.ink, outline: 0 });
  specs.push({ poly: rect(0, -h, 1, h), color, slot, outline: 0 });
  return buildCutout(specs);
}

export function armGeometry(): THREE.BufferGeometry {
  return barGeometry(6.2, 0xffffff, SLOT.skin, 1.5);
}

export function handGeometry(): THREE.BufferGeometry {
  return buildCutout([{ poly: circle(0, 0, 3.9, 16), ...skin, dome: true }]);
}

export function pauldronGeometry(): THREE.BufferGeometry {
  return buildCutout([
    { poly: ellipse(0, 0, 6.6, 5.6, 18), color: C.metal, dome: true },
    { poly: arcBand(0, 0, 3.4, 5.0, 0.4, Math.PI - 0.4, 8), color: C.metalDark, outline: 0 },
    { poly: circle(0.6, 1.2, 1.2, 8), color: C.gold, outline: 0.6 },
  ]);
}

export function headGeometry(): THREE.BufferGeometry {
  return buildCutout([
    { poly: circle(9.6, 0, 2.4, 10), ...skin },
    { poly: circle(0, 0, 10.2, 24), ...skin, dome: true },
  ]);
}

/** Hair on the back of a bare head (helmet knocked off). */
export function hairGeometry(): THREE.BufferGeometry {
  const back = ellipse(0, 0, 10.6, 10.6, 14, Math.PI * 0.58, Math.PI * 1.42);
  back.push(1.5, 0);
  return buildCutout([{ poly: back, color: C.hair }]);
}

// ---------------------------------------------------------------------------------------------
// Eyes
// ---------------------------------------------------------------------------------------------

const EYE_U = 5.9;
const EYE_V = 3.8;

function eyePair(make: (side: number) => ShapeSpec[]): ShapeSpec[] {
  return [...make(-1), ...make(1)];
}

export function eyesGeometry(kind: 'normal' | 'angry' | 'dizzy' | 'sly'): THREE.BufferGeometry {
  if (kind === 'sly') {
    return buildCutout(eyePair((s) => [
      { poly: ellipse(EYE_U + 0.4, s * EYE_V, 1.1, 2.7, 12), color: C.white, outline: 0.8 },
      { poly: circle(EYE_U + 0.9, s * EYE_V, 0.8, 8), color: C.pupil, outline: 0 },
    ]));
  }
  if (kind === 'dizzy') {
    return buildCutout(eyePair((s) => [
      { poly: circle(EYE_U, s * EYE_V, 2.7, 14), color: C.white, outline: 0.8 },
      { poly: arcBand(EYE_U, s * EYE_V, 0.9, 1.6, 0, Math.PI * 1.6, 10), color: C.pupil, outline: 0 },
    ]));
  }
  const specs = eyePair((s) => [
    { poly: ellipse(EYE_U, s * EYE_V, 2.7, 2.4, 14), color: C.white, outline: 0.8 },
    { poly: circle(EYE_U + 1.1, s * EYE_V, kind === 'angry' ? 1.1 : 1.35, 10), color: kind === 'angry' ? 0x7a0d0a : C.pupil, outline: 0 },
  ]);
  if (kind === 'angry') {
    for (const s of [-1, 1]) {
      specs.push({ poly: taperedCurve([EYE_U - 0.4, s * 1.2], [EYE_U - 2, s * 3.6], [EYE_U - 3.4, s * 6.4], 2.2, 1.2, 6), color: 0x1a1210, outline: 0 });
    }
  }
  return buildCutout(specs);
}

/** Three stars circling a stunned head. */
export function starsGeometry(): THREE.BufferGeometry {
  const specs: ShapeSpec[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    specs.push({ poly: star(Math.cos(a) * 14, Math.sin(a) * 14, 3.6, 1.5, 5, a), color: 0xffd84a, slot: SLOT.glow, outline: 0.8 });
  }
  return buildCutout(specs);
}

// ---------------------------------------------------------------------------------------------
// Headgear, one silhouette per weapon class
// ---------------------------------------------------------------------------------------------

export type Headgear = 'knight' | 'horned' | 'cowl' | 'viking' | 'hood' | 'wizard';

export const HEADGEAR: Readonly<Record<WeaponId, Headgear>> = {
  GREATSWORD: 'knight',
  WARHAMMER: 'horned',
  TWIN_DAGGERS: 'cowl',
  THROWING_AXES: 'viking',
  LONGBOW: 'hood',
  ARCANE_STAFF: 'wizard',
};

export function headgearGeometry(kind: Headgear): THREE.BufferGeometry {
  switch (kind) {
    case 'knight':
      return buildCutout([
        { poly: circle(0, 0, 10.9, 24), color: C.metal, dome: true },
        { poly: rect(6.2, -6.6, 8.6, 6.6), color: 0x15171b, outline: 0 },
        { poly: roundRect(-2, 0, 17, 3.4, 1.6), color: C.metalDark, outline: 0.8 },
        { poly: ellipse(-8.5, 0, 9.6, 3.5, 16), color: team(1), slot: SLOT.team, dome: true },
      ]);
    case 'horned': {
      const horn = taperedCurve([-1, 8.2], [-3.5, 19], [8, 22.5], 6.6, 1.0, 12);
      return buildCutout([
        { poly: horn, color: C.bone },
        { poly: mirrorV(horn), color: C.bone },
        { poly: circle(0, 0, 10.8, 24), color: C.iron, dome: true },
        { poly: arcBand(0, 0, 8.6, 10.2, Math.PI * 0.6, Math.PI * 1.4, 10), color: C.gold, outline: 0 },
        { poly: circle(-5, 0, 1.4, 8), color: C.gold, outline: 0.6 },
      ]);
    }
    case 'cowl':
      return buildCutout([
        { poly: circle(0, 0, 11, 24), color: C.cloth, dome: true },
        { poly: arcBand(0, 0, 6.8, 10.8, -1.05, 1.05, 10), color: C.clothLight, outline: 0 },
        { poly: circle(-10.4, 0, 2.8, 10), color: team(1), slot: SLOT.team },
      ]);
    case 'viking':
      return buildCutout([
        { poly: ellipse(9.5, 0, 7.2, 8.8, 18), color: C.beard, dome: true },
        { poly: circle(15.2, -3.6, 2.2, 8), color: C.beard },
        { poly: circle(15.2, 3.6, 2.2, 8), color: C.beard },
        { poly: circle(0, 0, 10.5, 24), color: C.metal, dome: true },
        { poly: rect(-10, -1.3, 10, 1.3), color: C.gold, outline: 0 },
        { poly: rect(-1.3, -10, 1.3, 10), color: C.gold, outline: 0 },
        { poly: roundRect(11.5, 0, 6.5, 2.8, 1.2), color: C.metal, outline: 0.8 },
      ]);
    case 'hood': {
      const hood = ellipse(0, 0, 11.3, 11.3, 18, -2.5, 2.5);
      hood.push(-19, 0);
      return buildCutout([
        { poly: hood, color: team(0.62), slot: SLOT.team, dome: true },
        { poly: ellipse(5.2, 0, 4.6, 7.4, 14), ...skin, outline: 0 },
        { poly: taperedCurve([-4, 6.5], [-11, 13], [-19, 12], 3, 0.6, 10), color: 0xe8c547, outline: 0.8 },
      ]);
    }
    case 'wizard':
      return buildCutout([
        { poly: circle(0, 0, 15.8, 28), color: team(0.5), slot: SLOT.team, dome: true },
        { poly: arcBand(-1, 0, 8.6, 10.2, 0, Math.PI * 2, 24), color: C.gold, outline: 0 },
        { poly: circle(-1, 0, 8.6, 22), color: team(1), slot: SLOT.team, dome: true },
        { poly: star(-1, 0, 4.2, 1.8, 5, -Math.PI / 2), color: C.gold, slot: SLOT.glow, outline: 0.7 },
      ]);
  }
}

/** Cowl headband tails (wobble like the cape). */
export function tailsGeometry(): THREE.BufferGeometry {
  const tail = taperedCurve([0, -1.4], [-8, -2.6], [-18, -6.5], 3.4, 1.2, 10);
  return buildCutout([
    { poly: tail, color: team(1), slot: SLOT.team },
    { poly: mirrorV(tail), color: team(1), slot: SLOT.team },
  ]);
}

/** Quiver on the back of archers. */
export function quiverGeometry(): THREE.BufferGeometry {
  const fletch = (cv: number): ShapeSpec => ({ poly: [-17, cv - 1.6, -21.5, cv, -17, cv + 1.6, -15.5, cv], color: team(1), slot: SLOT.team, outline: 0.7 });
  return buildCutout([
    { poly: roundRect(-10, 7.5, 14, 6.4, 2.6), color: C.leather, dome: true },
    fletch(5.6),
    fletch(7.6),
    fletch(9.6),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Weapons: grip at the origin, the weapon along +u
// ---------------------------------------------------------------------------------------------

export function weaponGeometry(kind: 'greatsword' | 'warhammer' | 'dagger' | 'axe' | 'bow' | 'staff'): THREE.BufferGeometry {
  switch (kind) {
    case 'greatsword':
      return buildCutout([
        { poly: rect(-5, -1.9, 4, 1.9), color: C.leather },
        { poly: circle(-6, 0, 2.8, 10), color: C.gold },
        { poly: [7, -4.7, 54, -3.7, 64.5, 0, 54, 3.7, 7, 4.7], color: C.steel },
        { poly: [9, -1.15, 51, -0.8, 51, 0.8, 9, 1.15], color: C.glowGold, slot: SLOT.glow, outline: 0 },
        { poly: roundRect(5, 0, 3.8, 19.5, 1.5), color: C.gold },
      ]);
    case 'warhammer':
      return buildCutout([
        { poly: rect(-8, -2.3, 44, 2.3), color: C.wood },
        { poly: rect(-6, -2.7, -1.5, 2.7), color: C.leather, outline: 0.6 },
        { poly: [51, -4.2, 61.5, 0, 51, 4.2], color: C.steel },
        { poly: roundRect(44, 0, 14.5, 31, 3), color: C.iron, dome: true },
        { poly: rect(39.5, -15.6, 48.5, -11.4), color: team(1), slot: SLOT.team, outline: 0.7 },
        { poly: rect(39.5, 11.4, 48.5, 15.6), color: team(1), slot: SLOT.team, outline: 0.7 },
        { poly: rect(49.6, -11, 51.2, 11), color: C.glowGold, slot: SLOT.glow, outline: 0 },
      ]);
    case 'dagger':
      return buildCutout([
        { poly: rect(-4, -1.6, 3, 1.6), color: C.cloth },
        { poly: taperedCurve([4.5, 0], [15, 2.8], [27.5, 0.4], 6.2, 0.5, 12), color: 0xd6efe4 },
        { poly: taperedCurve([7, 0.7], [15, 2.9], [24, 0.8], 1.5, 0.4, 10), color: C.glowGreen, slot: SLOT.glow, outline: 0 },
        { poly: roundRect(3.6, 0, 2.4, 9.4, 1), color: C.gold },
      ]);
    case 'axe':
      return buildCutout([
        { poly: rect(-4, -1.9, 21, 1.9), color: C.wood },
        { poly: [15, -1.2, 20.5, -1.2, 17.8, -5.4], color: C.metalDark },
        { poly: [14, 1.2, 21, 1.2, 24.8, 5, 24.2, 11.2, 19, 12.4, 16.5, 7], color: C.steel },
        { poly: taperedCurve([24.5, 4.8], [26, 8.4], [22.4, 12], 1.8, 1.0, 8), color: C.glowGold, slot: SLOT.glow, outline: 0 },
      ]);
    case 'bow': {
      const limb = taperedCurve([0, 0], [7, -12.5], [-2, -25.5], 4.4, 1.6, 12);
      return buildCutout([
        { poly: limb, color: C.wood },
        { poly: mirrorV(limb), color: C.wood },
        { poly: roundRect(0.6, 0, 5, 6.4, 1.5), color: C.leather, outline: 0.8 },
      ]);
    }
    case 'staff':
      return buildCutout([
        { poly: rect(-16, -2.3, 44, 2.3), color: C.purpleWood },
        { poly: rect(-6, -2.9, -3.5, 2.9), color: C.gold, outline: 0.6 },
        { poly: rect(30, -2.9, 32.5, 2.9), color: C.gold, outline: 0.6 },
        { poly: [42, -6.5, 48.5, -3.6, 46, 0, 48.5, 3.6, 42, 6.5, 44, 0], color: C.gold },
        { poly: circle(50.5, 0, 6, 18), color: C.glowArcane, slot: SLOT.glow },
      ]);
  }
}

/** Bow tips in the bow's frame (string anchors). */
export const BOW_TIP_U = -2;
export const BOW_TIP_V = 25.5;

/** Arrow on the string: nock at the origin, head toward +u. */
export function nockedArrowGeometry(): THREE.BufferGeometry {
  return buildCutout([
    { poly: [-4, -3.3, 2, -0.9, 2, 0.9, -4, 3.3, -2, 0], color: team(1), slot: SLOT.team, outline: 0.8 },
    { poly: rect(-2, -0.9, 24, 0.9), color: C.woodLight, outline: 1 },
    { poly: [23.5, -2.8, 30, 0, 23.5, 2.8], color: C.steel },
  ]);
}

export function shieldGeometry(): THREE.BufferGeometry {
  return buildCutout([
    { poly: roundRect(0, 0, 6.8, 27.5, 3), color: C.metal },
    { poly: roundRect(0, 0, 4.2, 22.5, 2), color: team(0.85), slot: SLOT.team, outline: 0 },
    { poly: circle(0.4, 0, 2.3, 10), color: C.gold, outline: 0.7 },
  ]);
}

export function stumpGeometry(): THREE.BufferGeometry {
  return buildCutout([
    { poly: circle(0, 0, 3.6, 12), color: C.stump, dome: true },
    { poly: circle(0.3, 0, 1.6, 8), color: C.marrow, outline: 0 },
  ]);
}

/** Parry barrier: a bright arc in front of the body (emissive, it blooms). */
export function parryArcGeometry(): THREE.BufferGeometry {
  return buildCutout([{ poly: arcBand(0, 0, 21, 24.5, -1.15, 1.15, 20), color: C.glowCyan, slot: SLOT.glow, outline: 1 }]);
}

/** Guard stance: the shield arc that blocks arrows from the front. */
export function guardArcGeometry(): THREE.BufferGeometry {
  return buildCutout([{ poly: arcBand(0, 0, 20, 21.6, -0.8, 0.8, 16), color: 0xd8c08a, outline: 0.8 }]);
}

// ---------------------------------------------------------------------------------------------
// Projectiles and floor items
// ---------------------------------------------------------------------------------------------

/** Flying arrow, head toward +u (bigger than the nocked one so it reads in flight). */
export function arrowGeometry(): THREE.BufferGeometry {
  return buildCutout([
    { poly: [-16, -3.8, -9, -1, -9, 1, -16, 3.8, -13, 0], color: team(1), slot: SLOT.team, outline: 0.9 },
    { poly: rect(-14, -1.1, 10, 1.1), color: C.woodLight, outline: 1.1 },
    { poly: [9, -3.4, 17, 0, 9, 3.4], color: C.steel },
  ]);
}

/** Spinning thrown axe (centred on its balance point). */
export function flyingAxeGeometry(): THREE.BufferGeometry {
  return buildCutout([
    { poly: rect(-12, -1.9, 10, 1.9), color: C.wood },
    { poly: [3, 1.2, 10, 1.2, 13.8, 5, 13.2, 11.2, 8, 12.4, 5.5, 7], color: C.steel },
    { poly: [4, -1.2, 9.5, -1.2, 6.8, -5.4], color: C.metalDark },
  ]);
}

/** Orb core (the glow sprite does the halo). */
export function orbGeometry(): THREE.BufferGeometry {
  return buildCutout([
    // White-hot core; the caster's spell colour comes from the halo, trail and light around it.
    { poly: circle(0, 0, 7, 18), color: 0xf2ecff, slot: SLOT.glow, outline: 1.2 },
    { poly: circle(1.5, -1.5, 2.6, 10), color: 0xffffff, slot: SLOT.glow, outline: 0 },
  ]);
}

export function floorItemGeometry(kind: 'arrow' | 'axe' | 'weapon' | 'helmet'): THREE.BufferGeometry {
  switch (kind) {
    case 'arrow':
      return buildCutout([
        { poly: [-14, -3, -8, -0.8, -8, 0.8, -14, 3, -11.5, 0], color: 0x8a8070, outline: 0.8 },
        { poly: rect(-12, -0.9, 8, 0.9), color: C.woodLight, outline: 0.9 },
        { poly: [7.5, -2.8, 14, 0, 7.5, 2.8], color: C.steel },
      ]);
    case 'axe':
      return buildCutout([
        { poly: rect(-10, -1.8, 9, 1.8), color: C.wood },
        { poly: [4, 1.2, 10, 1.2, 13.5, 5, 13, 10.6, 8, 11.6, 5.5, 6.6], color: C.steel },
      ]);
    case 'weapon':
      return buildCutout([
        { poly: rect(-12, -1.8, -4, 1.8), color: C.leather },
        { poly: [-1, -3.8, 26, -3, 32, 0, 26, 3, -1, 3.8], color: C.steel },
        { poly: roundRect(-2.5, 0, 3, 14, 1.2), color: C.gold },
      ]);
    case 'helmet':
      return buildCutout([
        { poly: circle(0, 0, 9.5, 20), color: C.metal, dome: true },
        { poly: rect(4.6, -5.6, 6.6, 5.6), color: 0x15171b, outline: 0 },
      ]);
  }
}
