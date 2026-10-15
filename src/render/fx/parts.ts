// Owned by: render-fx
/**
 * The body parts and debris the fx module throws around: 10 gib types, severed limbs, helmets and
 * dropped weapons. Each part has one cell in the canvas-drawn part atlas (see atlas.ts) and a set of
 * physical properties for the piece simulation (see pieces.ts). Pure data, no three.js.
 */

import type { WeaponId } from '../../core';

/** The 10 gib types a death can throw. */
export type GibKind = 'skull' | 'jaw' | 'ribcage' | 'heart' | 'eyeball' | 'intestine' | 'leg' | 'boot' | 'weaponArm' | 'brain';
export const GIB_KINDS: readonly GibKind[] = ['skull', 'jaw', 'ribcage', 'heart', 'eyeball', 'intestine', 'leg', 'boot', 'weaponArm', 'brain'];

export type PartId = GibKind | 'limbArm' | 'limbLeg' | `helmet_${WeaponId}` | `weapon_${WeaponId}`;

export type PartMaterial = 'meat' | 'bone' | 'metal' | 'cloth' | 'wood';

export type PartDef = {
  /** World px across the part's square atlas cell (the drawn quad size). */
  span: number;
  /** Collision radius (px) against walls and pillars. */
  radius: number;
  material: PartMaterial;
  /** Starting wetness: how much blood it smears when it slides (0 = none). */
  wet: number;
  /** Width of its full-speed smear (px). */
  streakWidth: number;
  /** Rolls (helmets): curving path and a tumbling squash while it moves. */
  rolls: boolean;
  /** Tinted with the owner's colour where the atlas mask says so. */
  tinted: boolean;
  /**
   * Radius (px) of the pool it oozes once it comes to rest (0 = none). Guts bleed most: a landed
   * intestine leaves the biggest puddle.
   */
  ooze: number;
};

export type MaterialPhys = {
  /** Fraction of the vertical speed kept on a bounce. */
  restitution: number;
  /** Sliding deceleration (px/s^2). */
  friction: number;
  /** Impacts slower than this (px/s) do not bounce. */
  minBounce: number;
  /** Clinks (sparks) on hard impacts. */
  clinks: boolean;
};

export const MATERIALS: Readonly<Record<PartMaterial, MaterialPhys>> = {
  meat: { restitution: 0.18, friction: 430, minBounce: 95, clinks: false },
  bone: { restitution: 0.42, friction: 520, minBounce: 70, clinks: false },
  metal: { restitution: 0.36, friction: 360, minBounce: 70, clinks: true },
  cloth: { restitution: 0.12, friction: 650, minBounce: 110, clinks: false },
  wood: { restitution: 0.3, friction: 480, minBounce: 80, clinks: false },
};

function gib(span: number, radius: number, material: PartMaterial, wet: number, streakWidth: number, ooze: number, tinted = false): PartDef {
  return { span, radius, material, wet, streakWidth, rolls: false, tinted, ooze };
}
function helmet(material: PartMaterial, tinted: boolean): PartDef {
  return { span: 34, radius: 10, material, wet: 0, streakWidth: 0, rolls: true, tinted, ooze: 0 };
}
function weapon(span: number, radius: number, material: PartMaterial): PartDef {
  return { span, radius, material, wet: 0, streakWidth: 0, rolls: false, tinted: false, ooze: 0 };
}

export const PARTS: Readonly<Record<PartId, PartDef>> = {
  skull: gib(24, 8, 'bone', 0.6, 9, 11),
  jaw: gib(20, 6, 'bone', 0.5, 6, 7),
  ribcage: gib(30, 10, 'bone', 0.8, 12, 15),
  heart: gib(18, 6, 'meat', 1, 9, 17),
  eyeball: gib(12, 4, 'meat', 0.6, 5, 5),
  intestine: gib(40, 9, 'meat', 1, 13, 27),
  leg: gib(40, 9, 'meat', 0.9, 11, 16, true),
  boot: gib(22, 7, 'cloth', 0.4, 7, 0),
  weaponArm: gib(36, 9, 'meat', 1, 11, 16, true),
  brain: gib(20, 7, 'meat', 1, 10, 15),
  limbArm: gib(40, 9, 'meat', 1, 12, 17, true),
  limbLeg: gib(46, 10, 'meat', 1, 13, 19, true),
  helmet_GREATSWORD: helmet('metal', false),
  helmet_WARHAMMER: helmet('metal', false),
  helmet_TWIN_DAGGERS: helmet('cloth', true),
  helmet_THROWING_AXES: helmet('metal', false),
  helmet_LONGBOW: helmet('cloth', true),
  helmet_ARCANE_STAFF: helmet('cloth', true),
  weapon_GREATSWORD: weapon(92, 12, 'metal'),
  weapon_WARHAMMER: weapon(76, 12, 'metal'),
  weapon_TWIN_DAGGERS: weapon(40, 7, 'metal'),
  weapon_THROWING_AXES: weapon(36, 8, 'metal'),
  weapon_LONGBOW: weapon(80, 10, 'wood'),
  weapon_ARCANE_STAFF: weapon(84, 10, 'wood'),
};

/** Atlas order: cell i of the atlas holds PART_IDS[i]. */
export const PART_IDS: readonly PartId[] = Object.keys(PARTS) as PartId[];

const CELL_OF = new Map<PartId, number>(PART_IDS.map((id, i) => [id, i]));

export function partCell(id: PartId): number {
  return CELL_OF.get(id) ?? 0;
}

/** Atlas layout shared by the canvas painter and the shaders. */
export const ATLAS = {
  /** Texels per cell side. */
  cell: 128,
  cols: 8,
  /** Rows of colour cells; the tint mask sits below them in the same canvas. */
  rows: Math.ceil(PART_IDS.length / 8),
};

/**
 * The death throw: 8-10 gibs. Always the crowd-pleasers (skull, ribcage, heart, intestine and an
 * eyeball), then a shuffled pick of the rest. `weaponArm` only when the fighter still had one.
 */
const rest: GibKind[] = [];

export function deathGibs(out: GibKind[], count: number, hasWeaponArm: boolean, rand: () => number): GibKind[] {
  out.length = 0;
  out.push('skull', 'ribcage', 'heart', 'intestine', 'eyeball');
  rest.length = 0;
  rest.push('eyeball', 'jaw', 'leg', 'boot', 'brain');
  if (hasWeaponArm) rest.push('weaponArm');
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = rest[i];
    rest[i] = rest[j];
    rest[j] = t;
  }
  const n = Math.max(out.length, Math.min(count, out.length + rest.length));
  for (let i = 0; out.length < n; i++) out.push(rest[i]);
  return out;
}
