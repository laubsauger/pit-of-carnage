/**
 * Gameplay rules: every tunable number, in one place, each with a `doc` string.
 *
 * The sim reads these tables, the brain reads them for `in_range` and readiness, the strategy module
 * turns them into the rulebook and LLM prompt, and the UI shows them in the editor. Change a number
 * here and every consumer (including the documentation players read) follows.
 *
 * Units: px, ticks (TICK_HZ per second), radians. Walking speeds, dash impulses and projectile speeds
 * are listed before `SPEED_SCALE`; use the derived functions below to get in-game values.
 */

import { ATTRIBUTE_BUDGET, ATTRIBUTE_MAX, ATTRIBUTE_MIN, DEFAULT_TIME_LIMIT_TICKS, SPEED_SCALE, TICK_HZ } from './constants';
import { clamp } from './math';
import type { Attributes, BarkKind, FighterState, HazardKind, HazardState, MapDef, PickupKind, PropKind, Rect, SkillId, Stance, SuddenDeathState, Vec2, WeaponFamily, WeaponId } from './types';

/** Doc table with exactly one entry per key of T, enforced by the compiler. */
export type DocsFor<T> = { readonly [K in keyof T]: string };

// ---------------------------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------------------------

export type AttributeKey = keyof Attributes;

export const ATTRIBUTE_KEYS: readonly AttributeKey[] = ['vitality', 'power', 'agility', 'perception', 'armor', 'haste'];

export const ATTRIBUTE_DOCS: DocsFor<Attributes> = {
  vitality: 'Max HP (+8.5 per point) and a slightly bigger body.',
  power: 'Weapon damage +2.4% per point. Whirlwind damage +0.55 per point.',
  agility: 'Move speed and turn rate. The difference between catching someone and watching them leave.',
  perception: 'Vision range (+9.5 px), field of view, hearing (+4.2 px) and auto-parry chance.',
  armor: 'Damage reduction 1.6% per point (cap 48%). Heavier: slower to move and turn, bigger body.',
  haste: 'Attack cooldown -1.4% per point. Skill cooldown -3.1 ticks per point.',
};

export function attributeTotal(a: Attributes): number {
  return a.vitality + a.power + a.agility + a.perception + a.armor + a.haste;
}

/** Points left to spend (negative = over budget). */
export function attributePointsLeft(a: Attributes): number {
  return ATTRIBUTE_BUDGET - attributeTotal(a);
}

/** True when every attribute is in [ATTRIBUTE_MIN, ATTRIBUTE_MAX] and the total is within budget. */
export function attributesLegal(a: Attributes): boolean {
  for (const k of ATTRIBUTE_KEYS) {
    const v = a[k];
    if (!Number.isFinite(v) || v < ATTRIBUTE_MIN || v > ATTRIBUTE_MAX) return false;
  }
  return attributeTotal(a) <= ATTRIBUTE_BUDGET;
}

// ---------------------------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------------------------

export type WeaponRule = {
  id: WeaponId;
  /** Display name. */
  name: string;
  family: WeaponFamily;
  doc: string;
  /**
   * Reach in px. Melee: from the attacker's centre to the near edge of the victim
   * (`distance - victim.radius <= range`). Ranged: maximum aimed distance, centre to centre.
   */
  range: number;
  /** Base damage before power, berserk, backstab, crit and armor. */
  damage: number;
  /**
   * Ticks from the strike until the next windup may begin (before haste, see `attackCooldown`).
   * The next windup also waits for recovery to finish, so the full cycle is
   * windup + max(attackCooldown, strike + recovery).
   */
  cooldown: number;
  /** Telegraph ticks: pose + glow before the blow lands. Damage resolves on the first strike tick. */
  windup: number;
  strike: number;
  recovery: number;
  /** Knockback impulse (px/tick, before COMBAT.knockbackScale). */
  knockback: number;
  /** Melee: full width of the hit arc (radians), centred on facing. 0 for ranged. */
  arc: number;
  /** Melee: hits everyone in the arc (true) or only the target / nearest in the arc (false). */
  cleave: boolean;
  /** Damage multiplier for hits from behind (see COMBAT.backstabArc). */
  backstabMult: number;
  /** Ticks the victim is stunned on hit (0 = none). */
  stunTicks: number;
  /** Ticks the victim is slowed on hit (0 = none); speed x COMBAT.slowMoveMul. */
  slowTicks: number;
  /** Projectile speed px/tick before SPEED_SCALE (0 = melee). */
  projectileSpeed: number;
  /** Max ammo or charges (0 = unlimited, melee). */
  ammo: number;
  /** Spent projectiles land on the floor and must be walked over to recover. */
  ammoPickup: boolean;
  /** Ticks to regenerate one charge or arrow, up to `ammo` (0 = no regeneration). */
  ammoRegenTicks: number;
  /** Splash radius around the impact point (0 = none). */
  splash: number;
  /** Fraction of damage dealt to others inside the splash radius. */
  splashMul: number;
  /** Carries a shield: in `guard` stance, blocks projectiles arriving within COMBAT.shieldArc of facing. */
  shield: boolean;
  /** Added to vision range (px). */
  visionBonus: number;
  /** Base field of view (radians) before perception. */
  fov: number;
  /**
   * Move speed multiplier (weapon weight). Melee weapons are lighter on the feet: the melee family
   * averages about 10% faster than the ranged family, and no ranged weapon outruns a melee one, so
   * closing in is possible and kiting has to be earned.
   */
  moveMul: number;
  /** Turn rate multiplier (weapon weight). */
  turnMul: number;
  /** Melee: px the attacker lunges forward during each strike (0 for ranged). */
  lunge: number;
  /**
   * Ranged: base damage of a blow with a hand weapon kept back (a hatchet), used instead of
   * throwing at an enemy within punch reach and instead of fists when out of ammo; it swings like a
   * punch (reach COMBAT.punchRange, punch phases) on the weapon's own cooldown. 0 = fists
   * (COMBAT.punchDamage every COMBAT.punchCooldown).
   */
  handDamage: number;
};

export const WEAPON_IDS: readonly WeaponId[] = ['GREATSWORD', 'WARHAMMER', 'TWIN_DAGGERS', 'THROWING_AXES', 'LONGBOW', 'ARCANE_STAFF'];

export const WEAPONS: Readonly<Record<WeaponId, WeaponRule>> = {
  GREATSWORD: {
    id: 'GREATSWORD', name: 'Greatsword', family: 'melee',
    doc: 'Wide 135° cleave that hits everyone in the arc. Slow to wind up, rude to stand next to. Shield in guard stance.',
    range: 82, damage: 35, cooldown: 36, windup: 14, strike: 11, recovery: 12, knockback: 10,
    arc: 2.35, cleave: true, backstabMult: 1.45, stunTicks: 0, slowTicks: 0,
    projectileSpeed: 0, ammo: 0, ammoPickup: false, ammoRegenTicks: 0, splash: 0, splashMul: 0, shield: true,
    visionBonus: 0, fov: 1.95, moveMul: 1.06, turnMul: 0.84, lunge: 30, handDamage: 0,
  },
  WARHAMMER: {
    id: 'WARHAMMER', name: 'Warhammer', family: 'melee',
    doc: 'Single-target smash with the longest melee reach. Stuns for 16 ticks and sends the victim across the room. Shield in guard stance.',
    range: 76, damage: 30, cooldown: 38, windup: 15, strike: 12, recovery: 13, knockback: 16,
    arc: 1.65, cleave: false, backstabMult: 1.45, stunTicks: 16, slowTicks: 0,
    projectileSpeed: 0, ammo: 0, ammoPickup: false, ammoRegenTicks: 0, splash: 0, splashMul: 0, shield: true,
    visionBonus: -15, fov: 1.8, moveMul: 1.0, turnMul: 0.78, lunge: 24, handDamage: 0,
  },
  TWIN_DAGGERS: {
    id: 'TWIN_DAGGERS', name: 'Twin daggers', family: 'melee',
    doc: 'Short, quick stabs. Backstabs deal x2.2. Light enough to turn on a coin, but no shield and the shortest reach.',
    range: 58, damage: 22, cooldown: 27, windup: 6, strike: 8, recovery: 6, knockback: 3,
    arc: 1.35, cleave: false, backstabMult: 2.2, stunTicks: 0, slowTicks: 0,
    projectileSpeed: 0, ammo: 0, ammoPickup: false, ammoRegenTicks: 0, splash: 0, splashMul: 0, shield: false,
    visionBonus: 35, fov: 2.25, moveMul: 1.08, turnMul: 1.38, lunge: 22, handDamage: 0,
  },
  THROWING_AXES: {
    id: 'THROWING_AXES', name: 'Throwing axes', family: 'ranged',
    doc: 'Five axes, thrown hard; they stick in whatever they hit and have to be pulled back out. Keeps a hatchet back for anyone who gets close (28 damage), and for when the axes are gone.',
    range: 265, damage: 21, cooldown: 42, windup: 8, strike: 9, recovery: 7, knockback: 6,
    arc: 0, cleave: false, backstabMult: 1.45, stunTicks: 0, slowTicks: 0,
    projectileSpeed: 10.6, ammo: 5, ammoPickup: true, ammoRegenTicks: 0, splash: 0, splashMul: 0, shield: false,
    visionBonus: 45, fov: 2.05, moveMul: 1.0, turnMul: 1.12, lunge: 0, handDamage: 28,
  },
  LONGBOW: {
    id: 'LONGBOW', name: 'Longbow', family: 'ranged',
    doc: 'Longest reach in the pit. Arrows slow the victim for 105 ticks. Twelve arrows that stick where they hit (pull them back out), and the quiver finds one more every 4 s.',
    range: 430, damage: 20, cooldown: 37, windup: 11, strike: 8, recovery: 8, knockback: 4,
    arc: 0, cleave: false, backstabMult: 1.45, stunTicks: 0, slowTicks: 105,
    projectileSpeed: 12.2, ammo: 12, ammoPickup: true, ammoRegenTicks: 240, splash: 0, splashMul: 0, shield: false,
    visionBonus: 130, fov: 1.65, moveMul: 0.96, turnMul: 1.15, lunge: 0, handDamage: 0,
  },
  ARCANE_STAFF: {
    id: 'ARCANE_STAFF', name: 'Arcane staff', family: 'ranged',
    doc: 'Slow orbs that burst on impact, splashing 60% damage within 72 px. Four charges, one back every 65 ticks. Whacks anyone who gets close with the staff itself (16 damage).',
    range: 375, damage: 26, cooldown: 38, windup: 12, strike: 10, recovery: 10, knockback: 4,
    arc: 0, cleave: false, backstabMult: 1.45, stunTicks: 0, slowTicks: 0,
    projectileSpeed: 9.6, ammo: 4, ammoPickup: false, ammoRegenTicks: 65, splash: 72, splashMul: 0.6, shield: false,
    visionBonus: 95, fov: 1.9, moveMul: 0.95, turnMul: 1.02, lunge: 0, handDamage: 16,
  },
};

// ---------------------------------------------------------------------------------------------
// Muzzles: where projectiles leave the weapon (shared by the sim and the renderer's rig)
// ---------------------------------------------------------------------------------------------

/**
 * Body radius (px) the fighter rig is drawn at. The renderer scales each fighter's rig by
 * `radius / RIG_NOMINAL_RADIUS`, and `MUZZLES` are measured at this size.
 */
export const RIG_NOMINAL_RADIUS = 18;

/** A point in a fighter's body frame: `u` px ahead along its facing, `v` px toward its right hand. */
export type BodyOffset = { u: number; v: number };

/**
 * Where each weapon lets go of its projectile, in the shooter's body frame at `RIG_NOMINAL_RADIUS`
 * (scaled by `radius / RIG_NOMINAL_RADIUS`, like the drawn rig): the staff's orb tip at the end of
 * the windup (about 70 px ahead, so an enemy inside the staff's reach is still hit), the bow string
 * at rest, and the throwing hand as the axe leaves it (a left-hand throw mirrors `v`, see
 * `muzzleSide`). Melee weapons have none (0, 0). Read off the renderer's rig at release (render
 * fighters.ts with SWING_KEYS in rig.ts): change the rig and these together.
 */
export const MUZZLES: Readonly<Record<WeaponId, BodyOffset>> = {
  GREATSWORD: { u: 0, v: 0 },
  WARHAMMER: { u: 0, v: 0 },
  TWIN_DAGGERS: { u: 0, v: 0 },
  THROWING_AXES: { u: 16, v: 15 },
  LONGBOW: { u: 13, v: -3 },
  ARCANE_STAFF: { u: 69.5, v: 20 },
};

/**
 * Which hand a shot leaves from: 1 = right, -1 = left. Throwing axes alternate hands while both arms
 * are there: an odd ammo count (before the throw) throws from the right (the hand that holds a lone
 * axe), an even count from the left. Everything else shoots from the right.
 */
export function muzzleSide(weapon: WeaponId, ammo: number, hasLeftArm: boolean): 1 | -1 {
  return weapon === 'THROWING_AXES' && hasLeftArm && ammo % 2 === 0 ? -1 : 1;
}

/** World position of `f`'s muzzle (see `MUZZLES`, `muzzleSide`), written into `out`. */
export function muzzlePoint(f: Pick<FighterState, 'pos' | 'facing' | 'radius' | 'weapon' | 'ammo' | 'limbs'>, out: Vec2): Vec2 {
  const m = MUZZLES[f.weapon];
  const side = muzzleSide(f.weapon, f.ammo, f.limbs.armL);
  const s = f.radius / RIG_NOMINAL_RADIUS;
  const u = m.u * s;
  const v = m.v * side * s;
  const c = Math.cos(f.facing);
  const n = Math.sin(f.facing);
  out.x = f.pos.x + u * c - v * n;
  out.y = f.pos.y + u * n + v * c;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------------------------

/** One shape for every skill; fields a skill does not use are 0. */
export type SkillRule = {
  id: SkillId;
  name: string;
  doc: string;
  /** Effect radius in px (WHIRLWIND, SHOCKWAVE). */
  radius: number;
  /** Full width of the effect cone (radians), centred on facing; 0 = all around. */
  arc: number;
  /** Base damage. Skill damage = damage + power x powerScale, then armor (no other multipliers). */
  damage: number;
  powerScale: number;
  knockback: number;
  /** Stun applied to each victim. */
  stunTicks: number;
  /** Parry window granted to the user. */
  parryTicks: number;
  /** SHADOWSTEP: how far behind the target the user lands (px). HOOK: the gap (px) left between the bodies when the pull ends. */
  distance: number;
  /** DASH: impulse along the current steering heading, px/tick before SPEED_SCALE. */
  impulse: number;
  hasteTicks: number;
  berserkTicks: number;
  /** Ticks the skill's animation lasts (cosmetic; effects resolve on use). */
  activeTicks: number;
  /** Needs a known target within `maxRange` px to be usable. */
  needsTarget: boolean;
  maxRange: number;
  /** SECOND_WIND: share of max HP healed in all, in equal gulps every `healEvery` ticks over `healTicks`. */
  heal: number;
  healTicks: number;
  healEvery: number;
  /** The user cannot start an attack for this many ticks after the skill (SHADOWSTEP: stepping out of the shadows takes a moment). */
  lockTicks: number;
};

export const SKILL_IDS: readonly SkillId[] = ['WHIRLWIND', 'SHADOWSTEP', 'DASH', 'SHOCKWAVE', 'BLOODRAGE', 'HOOK', 'SECOND_WIND'];

const NO_SKILL_FIELDS = {
  radius: 0, arc: 0, damage: 0, powerScale: 0, knockback: 0, stunTicks: 0, parryTicks: 0,
  distance: 0, impulse: 0, hasteTicks: 0, berserkTicks: 0, activeTicks: 0, needsTarget: false, maxRange: 0,
  heal: 0, healTicks: 0, healEvery: 0, lockTicks: 0,
};

export const SKILLS: Readonly<Record<SkillId, SkillRule>> = {
  WHIRLWIND: {
    ...NO_SKILL_FIELDS, id: 'WHIRLWIND', name: 'Whirlwind',
    doc: 'Spin attack: 25 + power x 0.55 damage to everyone within 92 px, with knockback.',
    radius: 92, damage: 25, powerScale: 0.55, knockback: 12, activeTicks: 28,
  },
  SHADOWSTEP: {
    ...NO_SKILL_FIELDS, id: 'SHADOWSTEP', name: 'Shadowstep',
    doc: 'Teleport 36 px behind the target (within 320 px), facing its back. Stepping out of the shadows takes a moment: no attack for 30 ticks after. Pairs well with daggers.',
    distance: 36, needsTarget: true, maxRange: 320, activeTicks: 10, lockTicks: 30,
  },
  DASH: {
    ...NO_SKILL_FIELDS, id: 'DASH', name: 'Dash',
    doc: 'Burst along the current steering heading (impulse 14) plus haste for 65 ticks. Works for chasing and for leaving.',
    impulse: 14, hasteTicks: 65, activeTicks: 12,
  },
  SHOCKWAVE: {
    ...NO_SKILL_FIELDS, id: 'SHOCKWAVE', name: 'Shockwave',
    doc: 'Shield slam: parry window of 36 ticks, plus 19 damage and a 24-tick stun to everyone in a 96 px cone ahead.',
    radius: 96, arc: 2.2, damage: 19, knockback: 16, stunTicks: 24, parryTicks: 36, activeTicks: 16,
  },
  BLOODRAGE: {
    ...NO_SKILL_FIELDS, id: 'BLOODRAGE', name: 'Bloodrage',
    doc: 'Berserk (+35% damage) and haste (x1.45 speed) for 145 ticks.',
    hasteTicks: 145, berserkTicks: 145, activeTicks: 20,
  },
  HOOK: {
    ...NO_SKILL_FIELDS, id: 'HOOK', name: 'Hook',
    doc: 'Chain hook at the target (in sight, clear line, within 260 px): 8 damage, yanked to 20 px in front of you and stunned 24 ticks. Pull an archer off its perch, or a rival across the saw.',
    damage: 8, stunTicks: 24, distance: 20, needsTarget: true, maxRange: 260, activeTicks: 14,
  },
  SECOND_WIND: {
    ...NO_SKILL_FIELDS, id: 'SECOND_WIND', name: 'Second wind',
    doc: 'Catch your breath: heal 24% of max HP over 3 s, a gulp every half second. Any damage taken ends it. Needs you hurt.',
    heal: 0.24, healTicks: 180, healEvery: 30, activeTicks: 20,
  },
};

// ---------------------------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------------------------

export const COMBAT = {
  armorPerPoint: 0.016,
  armorCap: 0.48,
  powerPerPoint: 0.024,
  berserkBonus: 0.35,
  minDamage: 3,
  backstabArc: 1.05,
  critMinDamage: 28,
  critChance: 0.25,
  critMult: 1.35,
  parryTicks: 30,
  parryCooldown: 135,
  parryReflect: 0.65,
  parryStunTicks: 40,
  parryBaseChance: 0.35,
  parryFacingArc: 0.9,
  shieldArc: 1.6,
  knockbackScale: 0.55,
  hasteAttackPerPoint: 0.014,
  minAttackCooldown: 10,
  skillCooldownBase: 205,
  skillCooldownPerHaste: 3.1,
  minSkillCooldown: 60,
  skillStartCooldown: 40,
  hasteMoveMul: 1.45,
  slowMoveMul: 0.6,
  dismemberMinDamage: 24,
  dismemberBelowHp: 0.5,
  dismemberChance: 0.3,
  punchDamage: 6,
  punchRange: 34,
  punchCooldown: 30,
  leglessMoveMul: 0.55,
  helmetKnockChance: 0.5,
  projectileRangeMul: 1.15,
  backpedalMoveMul: 0.55,
  rangedPlantMoveMul: 0.3,
  releaseFacingTolerance: 0.15,
  spreadBase: 0.025,
  spreadPerSpeed: 0.06,
  spreadPerPx: 0.00012,
  spreadMax: 0.3,
  aimLead: 0.75,
  pointBlankRange: 80,
  pointBlankMul: 0.5,
  interruptStaggerTicks: 18,
} as const;

export const COMBAT_DOCS: DocsFor<typeof COMBAT> = {
  armorPerPoint: 'Damage reduction per armor point.',
  armorCap: 'Maximum damage reduction from armor.',
  powerPerPoint: 'Weapon damage bonus per power point.',
  berserkBonus: 'Extra weapon damage while berserk (Bloodrage, berserk pickup).',
  minDamage: 'No hit deals less than this after armor.',
  backstabArc: 'A hit counts as a backstab when it arrives within this angle (radians) of the victim\'s back.',
  critMinDamage: 'Only hits of at least this much damage before armor can crit.',
  critChance: 'Chance that an eligible hit crits. A backstab cannot also crit.',
  critMult: 'Damage multiplier of a crit.',
  parryTicks: 'Length of a parry window.',
  parryCooldown: 'Ticks after a parry before the next one can start.',
  parryReflect: 'Fraction of a parried blow reflected back at the attacker.',
  parryStunTicks: 'Stun on an attacker whose blow was parried.',
  parryBaseChance: 'Auto-parry chance at 40 perception (scales linearly with perception), rolled once per enemy windup aimed at you while you face the attacker.',
  parryFacingArc: 'To parry you must face the attacker within this angle (radians).',
  shieldArc: 'Shield users in guard stance block projectiles arriving within this full arc (radians) of facing. A blocked staff orb still bursts on the shield; its splash spares the bearer.',
  knockbackScale: 'Knockback impulse multiplier applied to the victim\'s velocity.',
  hasteAttackPerPoint: 'Attack cooldown reduction per haste point.',
  minAttackCooldown: 'Attack cooldown never drops below this many ticks.',
  skillCooldownBase: 'Skill cooldown at 0 haste (ticks).',
  skillCooldownPerHaste: 'Skill cooldown reduction per haste point (ticks).',
  minSkillCooldown: 'Skill cooldown never drops below this many ticks.',
  skillStartCooldown: 'Skill cooldown at spawn, so nobody opens with a skill on tick one.',
  hasteMoveMul: 'Move speed multiplier while hasted.',
  slowMoveMul: 'Move speed multiplier while slowed (longbow arrows, acid).',
  dismemberMinDamage: 'Smallest hit that can sever a limb.',
  dismemberBelowHp: 'Limbs can only come off when the victim is below this fraction of max HP.',
  dismemberChance: 'Chance that an eligible hit severs a limb.',
  punchDamage: 'Damage of a punch when the weapon arm is gone.',
  punchRange: 'Reach of a punch (px).',
  punchCooldown: 'Ticks between punches.',
  leglessMoveMul: 'Move speed multiplier after losing a leg (the fighter hops).',
  helmetKnockChance: 'Chance that a crit knocks the victim\'s helmet off (cosmetic).',
  projectileRangeMul: 'Projectiles fly up to range x this before dropping to the floor.',
  backpedalMoveMul: 'Move speed multiplier walking straight backwards (away from where you face); sideways is halfway, forwards is full speed. Kiting costs.',
  rangedPlantMoveMul: 'Ranged attackers plant to shoot: move speed multiplier during windup and recovery.',
  releaseFacingTolerance: 'A shot only releases when the shooter faces its target within this angle (radians); until then the windup holds.',
  spreadBase: 'Aim error of a standing shooter at point-blank range (radians, half-angle).',
  spreadPerSpeed: 'Extra aim error per px/tick the shooter is moving (radians).',
  spreadPerPx: 'Extra aim error per px of distance to the target (radians).',
  spreadMax: 'Aim error never exceeds this (radians, half-angle).',
  aimLead: 'Shooters lead a moving target by this fraction of its seen velocity (1 = perfect prediction).',
  pointBlankRange: 'Ranged hits on a target closer than this (px, centre to centre, at release) deal reduced damage.',
  pointBlankMul: 'Damage multiplier of a point-blank ranged hit.',
  interruptStaggerTicks: 'A melee hit on a ranged attacker in windup cancels the shot (no ammo spent) and staggers them for this many ticks.',
};

// ---------------------------------------------------------------------------------------------
// Perception
// ---------------------------------------------------------------------------------------------

export const PERCEPTION = {
  visionBase: 255,
  visionPerPerception: 9.5,
  fovPerPerception: 0.012,
  fovMin: 1.35,
  fovMax: 2.55,
  hearingBase: 115,
  hearingPerPerception: 4.2,
  hearingFastMul: 1.15,
  hearingQuietMul: 0.72,
  hearingFastSpeed: 1.0,
  shadowLight: 0.35,
  shadowVisionMul: 0.45,
  enemiesNearRadius: 200,
  fightingWindowTicks: 90,
  memoryTicks: 360,
  hearingWallMul: 0.5,
  hearingErrorBase: 24,
  hearingErrorPerPx: 0.2,
  hearingRefreshTicks: 30,
  searchStareTicks: 45,
  searchScanArc: 2.4,
  searchScanTicks: 120,
} as const;

export const PERCEPTION_DOCS: DocsFor<typeof PERCEPTION> = {
  visionBase: 'Vision range at 0 perception (px), before the weapon bonus.',
  visionPerPerception: 'Vision range per perception point (px).',
  fovPerPerception: 'Field of view per perception point (radians), added to the weapon base.',
  fovMin: 'Narrowest field of view (radians).',
  fovMax: 'Widest field of view (radians).',
  hearingBase: 'Hearing radius at 0 perception (px). Hearing works in every direction; through a wall or pillar only within hearingWallMul of the radius. It gives a rough position, never an exact one.',
  hearingPerPerception: 'Hearing radius per perception point (px).',
  hearingFastMul: 'Hearing radius multiplier against a target moving faster than hearingFastSpeed.',
  hearingQuietMul: 'Hearing radius multiplier against a target that is slow, still or creeping.',
  hearingFastSpeed: 'Speed (px/tick) above which a non-creeping fighter counts as noisy.',
  shadowLight: 'Light level below which a spot counts as shadow.',
  shadowVisionMul: 'A target in shadow is only seen within this fraction of normal vision range.',
  enemiesNearRadius: 'Radius (px) of the enemies_near sensor.',
  fightingWindowTicks: 'A fighter counts as fighting for this many ticks after attacking or being hit.',
  memoryTicks: 'An enemy not seen or heard for this long is forgotten. Until then it is remembered where it was last seen or heard.',
  hearingWallMul: 'Hearing radius multiplier when a wall or pillar stands between listener and source.',
  hearingErrorBase: 'A heard-only position is off by up to this many px (plus hearingErrorPerPx x distance), and always by at least half of that total.',
  hearingErrorPerPx: 'Extra hearing error per px of distance to the source.',
  hearingRefreshTicks: 'A heard-only estimate moves to a new rough guess this often (ticks); in between it stays put.',
  searchStareTicks: 'After losing sight of its target, a fighter keeps looking at the last seen spot this long (ticks), then sweeps.',
  searchScanArc: 'Full width (radians) of the head sweep while searching, centred on the last seen spot.',
  searchScanTicks: 'Ticks for one full sweep left and back while searching.',
};

// ---------------------------------------------------------------------------------------------
// Stances
// ---------------------------------------------------------------------------------------------

export type StanceRule = { moveMul: number; quiet: boolean; shield: boolean; doc: string };

export const STANCES: Readonly<Record<Stance, StanceRule>> = {
  normal: { moveMul: 1, quiet: false, shield: false, doc: 'Full speed. Heard normally.' },
  creep: { moveMul: 0.55, quiet: true, shield: false, doc: 'Slow and quiet: always counts as quiet for hearing.' },
  guard: { moveMul: 0.7, quiet: false, shield: true, doc: 'Slow, shield up: greatsword and warhammer users block projectiles from the front.' },
};

// ---------------------------------------------------------------------------------------------
// Hazards, pickups, props
// ---------------------------------------------------------------------------------------------

export type HazardRule = {
  kind: HazardKind;
  name: string;
  doc: string;
  damage: number;
  /** Ticks between damage ticks for fighters standing in it (0 = see `period`/`triggerAt`). */
  intervalTicks: number;
  /** Default radius in px when the map does not override it. */
  radius: number;
  /** Cycle length in ticks (spikes). */
  period: number;
  /** Fraction of the period at which spikes thrust and deal damage (once per cycle). */
  triggerAt: number;
  /** Travel speed along `path`, px/tick before SPEED_SCALE (saws). */
  speed: number;
  /** Lifetime in ticks when spawned during a match (acid spills); map hazards are permanent. */
  durationTicks: number;
  knockback: number;
  /**
   * Ticks of slow (COMBAT.slowMoveMul) each damage tick leaves on its victim (0 = none). Longer than
   * the damage interval, so the slow holds while you stand in it and lingers a moment after.
   */
  slowTicks: number;
  /**
   * How far it reaches into a body: it touches a fighter whose centre is within its radius + this
   * share of the fighter's body radius (see `hazardReach`). A pool needs you standing in it, a saw
   * only has to graze you. The sim's damage and the renderer's "standing in acid" look use the same.
   */
  bodyShare: number;
};

const NO_HAZARD_FIELDS = { intervalTicks: 0, period: 0, triggerAt: 0, speed: 0, durationTicks: 0, knockback: 0, slowTicks: 0 };

export const HAZARD_RULES: Readonly<Record<HazardKind, HazardRule>> = {
  spike: {
    ...NO_HAZARD_FIELDS, kind: 'spike', name: 'Spike trap',
    doc: 'Thrusts at 88% of its 165-tick cycle for 36 damage. Watch the rhythm, then walk.',
    damage: 36, radius: 42, period: 165, triggerAt: 0.88, knockback: 6, bodyShare: 0.5,
  },
  saw: {
    ...NO_HAZARD_FIELDS, kind: 'saw', name: 'Saw blade',
    doc: 'Rolls along its track and deals 22 damage every 12 ticks to anyone it touches. Faster in sudden death.',
    damage: 22, intervalTicks: 12, radius: 26, speed: 1.6, knockback: 8, bodyShare: 1,
  },
  acid: {
    ...NO_HAZARD_FIELDS, kind: 'acid', name: 'Acid pool',
    doc: '11 damage every 24 ticks and a slow (x0.6 speed) while you stand in it, so wading out takes a while. Spilled pools dry up after 400 ticks.',
    damage: 11, intervalTicks: 24, radius: 62, durationTicks: 400, slowTicks: 40, bodyShare: 0.3,
  },
  fire: {
    ...NO_HAZARD_FIELDS, kind: 'fire', name: 'Fire pit',
    doc: '9 damage every 20 ticks while you stand in it. Also a light source.',
    damage: 9, intervalTicks: 20, radius: 40, bodyShare: 0.3,
  },
};

/**
 * Distance (px) from a hazard's centre within which a fighter's centre is touched by it: the
 * hazard's radius (the map's, else the rule's) + `bodyShare` x the fighter's body radius.
 */
export function hazardReach(h: Pick<HazardState, 'kind' | 'radius'>, bodyRadius: number): number {
  const rule = HAZARD_RULES[h.kind];
  return (h.radius || rule.radius) + bodyRadius * rule.bodyShare;
}

export type PickupRule = {
  name: string;
  doc: string;
  /** Touch radius in px. */
  radius: number;
  /** Effect length in ticks (0 = instant). */
  durationTicks: number;
  /** Ticks until it can be used again after a use (power-ups: until it respawns on its pedestal). */
  cooldownTicks: number;
  /** Ticks after the match starts before it first appears (0 = there from the start). Never above cooldownTicks. */
  firstSpawnTicks: number;
  /** Effect size: heal fraction of max HP (shrine), speed multiplier (haste), damage bonus (berserk). */
  amount: number;
};

export const PICKUP_RULES: Readonly<Record<'shrine' | PickupKind, PickupRule>> = {
  shrine: {
    name: 'Shrine', doc: 'Heals 42% of max HP on touch, then needs 900 ticks (15 s) to recharge.',
    radius: 34, durationTicks: 0, cooldownTicks: 900, firstSpawnTicks: 0, amount: 0.42,
  },
  haste: {
    name: 'Haste charm', doc: 'Move speed x1.45 for 200 ticks. First appears after 480 ticks, respawns 600 ticks after it is taken.',
    radius: 30, durationTicks: 200, cooldownTicks: 600, firstSpawnTicks: 480, amount: 1.45,
  },
  berserk: {
    name: 'Berserk draught', doc: '+35% weapon damage for 200 ticks. First appears after 480 ticks, respawns 600 ticks after it is taken.',
    radius: 30, durationTicks: 200, cooldownTicks: 600, firstSpawnTicks: 480, amount: 0.35,
  },
};

export type PropRule = {
  kind: PropKind;
  name: string;
  doc: string;
  /** Damage it takes before breaking (any hit or projectile). */
  hp: number;
  /** Blast damage on break (0 = none), before armor, to everyone within blastRadius. */
  blastDamage: number;
  blastRadius: number;
  knockback: number;
  /** Hazard left behind when it breaks. */
  spills: HazardKind | null;
};

export const PROP_RULES: Readonly<Record<PropKind, PropRule>> = {
  keg: {
    kind: 'keg', name: 'Powder keg',
    doc: 'Explodes when broken: 38 damage and heavy knockback within 106 px. Kills credit whoever broke it.',
    hp: 32, blastDamage: 38, blastRadius: 106, knockback: 20, spills: null,
  },
  amphora: {
    kind: 'amphora', name: 'Acid amphora',
    doc: 'Shatters into an acid pool that lasts 400 ticks.',
    hp: 18, blastDamage: 0, blastRadius: 0, knockback: 0, spills: 'acid',
  },
  crate: {
    kind: 'crate', name: 'Crate',
    doc: 'Blocks movement and projectiles until someone breaks it.',
    hp: 45, blastDamage: 0, blastRadius: 0, knockback: 0, spills: null,
  },
};

// ---------------------------------------------------------------------------------------------
// Stuck arrows and axes
// ---------------------------------------------------------------------------------------------

/**
 * Arrows and thrown axes stick where they hit (`StuckAmmo` in `WorldState.stuck`): in a wall,
 * pillar or prop at the impact point and angle, or in a body until it dies. They stay retrievable
 * (walk up to `pickupPos`); ammo in a living body is out of play, and drops to the floor around the
 * corpse when that body dies. Misses that run out of flight over open floor skid and lie there as
 * plain floor items (or stick point-first with `floorStickChance`). Placeholder values: the balance
 * pass tunes them against the bow's ammo economy.
 */
export const STUCK_AMMO = {
  wallStickChance: 1,
  propStickChance: 1,
  bodyStickChance: 1,
  floorStickChance: 0,
  pickupOffset: 14,
  pickupSlack: 14,
  maxPerBody: 8,
  maxStuck: 96,
  bodyDropScatter: 22,
} as const;

export const STUCK_AMMO_DOCS: DocsFor<typeof STUCK_AMMO> = {
  wallStickChance: 'Chance that an arrow or axe hitting a wall or pillar sticks in it; otherwise it drops to the floor in front of it.',
  propStickChance: 'Chance that an arrow or axe hitting a crate, keg or amphora sticks in it. It drops to the floor when the prop breaks.',
  bodyStickChance: 'Chance that an arrow or axe that hits a fighter sticks in the body. Out of play until that fighter dies, then it drops to the floor.',
  floorStickChance: 'Chance that a shot running out of flight over open floor sticks point-first instead of skidding flat. Either way it can be picked up.',
  pickupOffset: 'A stuck arrow or axe is taken back from this many px in front of the surface it hit.',
  pickupSlack: 'A fighter takes back stuck ammo when its pickup point is within its body radius + this many px.',
  maxPerBody: 'At most this many arrows and axes stick in one body; a hit beyond that drops its ammo at the victim\'s feet.',
  maxStuck: 'At most this many stuck arrows and axes in the arena; the oldest drops to the floor when another sticks.',
  bodyDropScatter: 'When a body full of arrows dies, they land on the floor up to this many px from the corpse.',
};

// ---------------------------------------------------------------------------------------------
// Bleed (candidate rule, off)
// ---------------------------------------------------------------------------------------------

/**
 * Bleeding (`FighterState.bleed`), a candidate rule: disabled, every amount zero, until the balance
 * harness shows it adds variety without dominating. Sketch: a lost limb always bleeds; dagger
 * backstabs open a wound; damage over time per bleed tick; a shrine heal cures it; bleeding
 * fighters leave a drip trail hunters can follow out of sight. While `enabled` is false the sim sets
 * no bleed, no sensor ever reads true and the rulebook leaves it out.
 */
export const BLEED_RULES = {
  enabled: false,
  intervalTicks: 30,
  limbLossTicks: 0,
  limbLossDamage: 0,
  backstabTicks: 0,
  backstabDamage: 0,
  maxTicks: 0,
  shrineCures: true,
  dripEveryTicks: 0,
} as const;

export const BLEED_RULES_DOCS: DocsFor<typeof BLEED_RULES> = {
  enabled: 'Bleeding is in the game. While false nobody bleeds and these numbers do nothing.',
  intervalTicks: 'A bleeding fighter takes its bleed damage every this many ticks.',
  limbLossTicks: 'Losing a limb opens a wound that bleeds this many ticks.',
  limbLossDamage: 'Damage per bleed tick of a lost limb.',
  backstabTicks: 'A twin-dagger backstab opens a wound that bleeds this many ticks.',
  backstabDamage: 'Damage per bleed tick of a backstab wound.',
  maxTicks: 'Bleeding never lasts longer than this many ticks, however many wounds stack.',
  shrineCures: 'A shrine heal stops the bleeding.',
  dripEveryTicks: 'A bleeding fighter leaves a drop of blood on the floor this often (ticks): a trail hunters can follow.',
};

// ---------------------------------------------------------------------------------------------
// Match flow
// ---------------------------------------------------------------------------------------------

/**
 * Match flow. Sudden death starts at the time limit, or earlier on a stalemate; the wall closes to
 * `final`; then damage ramps up every second, outside the zone first and soon everywhere, so every
 * match ends in deaths. The hard cap (time limit + hardCapExtraTicks) is the last resort: a judges'
 * decision, announced and reported, never silent. With `MatchConfig.suddenDeath` off none of this
 * runs and the bell at the time limit ends the match (placed by standing).
 */
export const MATCH_RULES = {
  timeLimitTicks: DEFAULT_TIME_LIMIT_TICKS,
  stalemateTicks: 15 * TICK_HZ,
  suddenDeathInsetPerTick: 0.25,
  suddenDeathMinHalfSize: 90,
  suddenDeathDamage: 4,
  suddenDeathIntervalTicks: 10,
  wallContactDamage: 4,
  wallPushKnockback: 10,
  wallCrushDamage: 45,
  suddenDeathSawSpeedMul: 1.6,
  warningTicks: 3 * TICK_HZ,
  escalationStepTicks: TICK_HZ,
  escalationDamage: 2,
  escalationEverywhereTicks: 5 * TICK_HZ,
  hardCapExtraTicks: 60 * TICK_HZ,
  multiKillWindowTicks: 180,
} as const;

export const MATCH_RULES_DOCS: DocsFor<typeof MATCH_RULES> = {
  timeLimitTicks: 'Default ticks before sudden death (90 s).',
  stalemateTicks: 'Sudden death starts early when no fighter has damaged another fighter for this long (15 s; weapons, skills and kegs count, hazards and the wall do not). Hiding cannot stall a match.',
  suddenDeathInsetPerTick: 'In sudden death the arena wall moves inward this many px per tick on every side.',
  suddenDeathMinHalfSize: 'The wall stops when the remaining arena is this many px from its centre to an edge.',
  suddenDeathDamage: 'Wall damage every interval to a fighter outside the playable area (a backstop: the solid wall keeps everyone inside) and, once escalation reaches everywhere, to everyone.',
  suddenDeathIntervalTicks: 'Ticks between sudden-death wall damage.',
  wallContactDamage: 'The closing wall is solid and spiked: damage every tick a fighter touches it, walking into it or standing still.',
  wallPushKnockback: 'Knockback impulse (before knockbackScale) that shoves a fighter touching the wall straight back into the arena, every tick of contact.',
  wallCrushDamage: 'Extra damage every tick the wall pins a fighter against a wall, pillar or prop (CRUSHED).',
  suddenDeathSawSpeedMul: 'Saw speed multiplier during sudden death.',
  warningTicks: 'The floor warns where the wall will be this many ticks ahead (3 s).',
  escalationStepTicks: 'After the wall stops, the escalation level rises by one every this many ticks (every second).',
  escalationDamage: 'Extra wall damage per escalation level, every interval. Outside the zone from the first level; inside it too from escalationEverywhereTicks.',
  escalationEverywhereTicks: 'This long after the wall stops, the escalated damage hits everyone, inside the zone too.',
  hardCapExtraTicks: 'If anyone is still standing at time limit + this (60 s), the judges decide (see JUDGES_ORDER).',
  multiKillWindowTicks: 'Kills by the same fighter within this window count as a multi-kill.',
};

/** What the judges compare when the hard cap ends a match with fighters standing. */
export type JudgeCriterion = 'hp_fraction' | 'damage_dealt' | 'kills';

/** Judges' decision: survivors ranked by these, in order, higher first; full ties keep roster order. */
export const JUDGES_ORDER: readonly JudgeCriterion[] = ['hp_fraction', 'damage_dealt', 'kills'];
export const JUDGES_DOC = "Judges' decision at the hard cap: survivors ranked by HP fraction left, then damage dealt, then kills.";

/** Chance to bark when the trigger happens (if the strategy has lines for it). `low_hp` fires once, below 30% HP. */
const BARK_CHANCE: Readonly<Record<BarkKind, number>> = { spawn: 0.5, kill: 0.8, hit: 0.15, low_hp: 0.6, death: 0.7, skill: 0.5, taunt: 0.05 };

/** Bark kinds shown in the default "key moments" view (`ViewSettings.barks === 'key'`). */
const KEY_BARK_KINDS: readonly BarkKind[] = ['spawn', 'kill', 'low_hp', 'skill', 'death'];

/**
 * Barks are rare and small. The sim enforces the per-fighter cooldown (every kind, kill and death
 * included) and emits `bark` events with their kind; fx enforce what is visible (mode, key kinds,
 * at most `maxVisible` bubbles, `maxWords`, `visibleSeconds`).
 */
export const BARK_RULES = {
  /** Ticks a fighter waits after barking before it may bark again (8 s). */
  cooldownTicks: 8 * TICK_HZ,
  /** Longest bark text shown (characters); the validator rejects longer lines. */
  maxLength: 48,
  /** HP fraction below which the `low_hp` bark may fire (once per fighter). */
  lowHp: 0.3,
  chance: BARK_CHANCE,
  /** Kinds shown in "key moments" mode. */
  keyKinds: KEY_BARK_KINDS,
  /** Most bark bubbles on screen at once. */
  maxVisible: 2,
  /** Bubbles show at most this many words (longer lines end in an ellipsis). */
  maxWords: 5,
  /** Seconds a bubble stays up, fade included. */
  visibleSeconds: 1.5,
} as const;

/** Tick at which a match still running ends by judges' decision (only with sudden death on). */
export function matchHardCapTicks(timeLimitTicks: number): number {
  return timeLimitTicks + MATCH_RULES.hardCapExtraTicks;
}

/**
 * The zone before sudden death: the whole map is playable, nothing moves, and `final` (where the
 * wall will stop) is worked out from the map. The sim starts every match from this; tests and mocks
 * use it too.
 */
export function initialSuddenDeathState(map: Pick<MapDef, 'width' | 'height'>): SuddenDeathState {
  const fx = Math.max(0, map.width / 2 - MATCH_RULES.suddenDeathMinHalfSize);
  const fy = Math.max(0, map.height / 2 - MATCH_RULES.suddenDeathMinHalfSize);
  return {
    active: false,
    reason: null,
    startedAtTick: -1,
    inset: 0,
    bounds: { x: 0, y: 0, w: map.width, h: map.height },
    warning: { x: 0, y: 0, w: map.width, h: map.height },
    final: { x: fx, y: fy, w: map.width - 2 * fx, h: map.height - 2 * fy },
    closedAtTick: -1,
    escalation: 0,
    everywhere: false,
  };
}

/**
 * Where the playable rectangle will be `ticks` from now, written into `out` (which may be
 * `z.bounds` itself). The wall moves `suddenDeathInsetPerTick` per side per tick and stops at
 * `final`; before sudden death and once closed the answer is `bounds`. The sim fills
 * `SuddenDeathState.warning` with `zoneBoundsAfter(z, MATCH_RULES.warningTicks, ...)`.
 */
export function zoneBoundsAfter(z: Readonly<SuddenDeathState>, ticks: number, out: Rect): Rect {
  const b = z.bounds;
  let x0 = b.x;
  let y0 = b.y;
  let x1 = b.x + b.w;
  let y1 = b.y + b.h;
  if (z.active && z.closedAtTick < 0 && ticks > 0) {
    const d = ticks * MATCH_RULES.suddenDeathInsetPerTick;
    const f = z.final;
    x0 = Math.min(f.x, x0 + d);
    y0 = Math.min(f.y, y0 + d);
    x1 = Math.max(f.x + f.w, x1 - d);
    y1 = Math.max(f.y + f.h, y1 - d);
  }
  out.x = x0;
  out.y = y0;
  out.w = x1 - x0;
  out.h = y1 - y0;
  return out;
}

/**
 * Ticks until the closing wall reaches p: 0 when p is already outside the zone, Infinity when the
 * wall will never reach it (sudden death not running, the wall already stopped, or p inside `final`).
 * Sensors in seconds divide by TICK_HZ and must map Infinity to their documented maximum.
 */
export function zoneTicksToReach(z: Readonly<SuddenDeathState>, p: Vec2): number {
  if (!z.active) return Infinity;
  const b = z.bounds;
  if (p.x < b.x || p.x > b.x + b.w || p.y < b.y || p.y > b.y + b.h) return 0;
  if (z.closedAtTick >= 0) return Infinity;
  const v = MATCH_RULES.suddenDeathInsetPerTick;
  const f = z.final;
  let t = Infinity;
  if (p.x < f.x) t = Math.min(t, (p.x - b.x) / v);
  if (p.x > f.x + f.w) t = Math.min(t, (b.x + b.w - p.x) / v);
  if (p.y < f.y) t = Math.min(t, (p.y - b.y) / v);
  if (p.y > f.y + f.h) t = Math.min(t, (b.y + b.h - p.y) / v);
  return t;
}

/** Signed distance (px) from p to the edge of the playable rectangle: positive inside, negative outside. */
export function zoneEdgeDistance(z: Readonly<SuddenDeathState>, p: Vec2): number {
  const b = z.bounds;
  const left = p.x - b.x;
  const right = b.x + b.w - p.x;
  const top = p.y - b.y;
  const bottom = b.y + b.h - p.y;
  if (left >= 0 && right >= 0 && top >= 0 && bottom >= 0) return Math.min(left, right, top, bottom);
  const ox = Math.max(0, -left, -right);
  const oy = Math.max(0, -top, -bottom);
  return -Math.sqrt(ox * ox + oy * oy);
}

// ---------------------------------------------------------------------------------------------
// Derived stats
// ---------------------------------------------------------------------------------------------

export function maxHp(a: Attributes): number {
  return Math.round(150 + a.vitality * 8.5);
}

export function fighterRadius(a: Attributes): number {
  return 15.5 + a.vitality * 0.18 + a.armor * 0.14;
}

/** Walking speed in px/tick, including weapon weight and SPEED_SCALE (before stance, buffs, limbs). */
export function moveSpeed(a: Attributes, weapon: WeaponId): number {
  const raw = 2.2 + a.agility * 0.068 - a.armor * 0.015;
  return Math.max(0.5, raw) * WEAPONS[weapon].moveMul * SPEED_SCALE;
}

/**
 * Move-speed multiplier for walking toward `moveDir` while facing `facing` (radians): 1 straight
 * ahead, COMBAT.backpedalMoveMul straight backwards, blended by the cosine in between (sideways is
 * halfway). Applied on top of moveSpeed, stance and buffs.
 */
export function facingMoveMul(moveDir: number, facing: number): number {
  const ahead = (1 + Math.cos(moveDir - facing)) / 2;
  return COMBAT.backpedalMoveMul + (1 - COMBAT.backpedalMoveMul) * ahead;
}

/**
 * Half-angle (radians) of a shot's aim error: the release direction is the (imperfectly led) aim
 * line turned by a uniform random angle in [-spread, spread]. Grows with the shooter's speed
 * (px/tick) and the distance to the target (px).
 */
export function shotSpread(shooterSpeed: number, distance: number): number {
  return Math.min(COMBAT.spreadMax, COMBAT.spreadBase + COMBAT.spreadPerSpeed * Math.max(0, shooterSpeed) + COMBAT.spreadPerPx * Math.max(0, distance));
}

/** Turn rate in rad/s, including weapon weight, clamped to [1.6, 7.4]. */
export function turnRate(a: Attributes, weapon: WeaponId): number {
  const raw = (2.4 + a.agility * 0.145 - a.armor * 0.032) * WEAPONS[weapon].turnMul;
  return clamp(raw, 1.6, 7.4);
}

/** Turn rate in rad/tick. */
export function turnPerTick(a: Attributes, weapon: WeaponId): number {
  return turnRate(a, weapon) / TICK_HZ;
}

/** Fraction of incoming damage removed by armor. */
export function armorMitigation(a: Attributes): number {
  return Math.min(a.armor * COMBAT.armorPerPoint, COMBAT.armorCap);
}

/** Weapon damage multiplier from power and berserk. */
export function damageMultiplier(a: Attributes, berserk: boolean): number {
  return 1 + a.power * COMBAT.powerPerPoint + (berserk ? COMBAT.berserkBonus : 0);
}

/**
 * Final damage of one hit: `base x mult`, reduced by the victim's armor, rounded, at least
 * COMBAT.minDamage. `mult` combines damageMultiplier, backstab and crit as applicable.
 */
export function resolveDamage(base: number, mult: number, victim: Attributes): number {
  return Math.max(COMBAT.minDamage, Math.round(base * mult * (1 - armorMitigation(victim))));
}

/** Ticks from a strike until the next windup may begin. */
export function attackCooldown(a: Attributes, weapon: WeaponId): number {
  return Math.max(COMBAT.minAttackCooldown, Math.round(WEAPONS[weapon].cooldown * (1 - a.haste * COMBAT.hasteAttackPerPoint)));
}

/** Ticks between skill uses. */
export function skillCooldown(a: Attributes): number {
  return Math.max(COMBAT.minSkillCooldown, Math.round(COMBAT.skillCooldownBase - a.haste * COMBAT.skillCooldownPerHaste));
}

/** Skill damage before armor (no power multiplier or berserk on top). */
export function skillDamage(skill: SkillId, a: Attributes): number {
  const s = SKILLS[skill];
  return s.damage + a.power * s.powerScale;
}

export function visionRange(a: Attributes, weapon: WeaponId): number {
  return PERCEPTION.visionBase + a.perception * PERCEPTION.visionPerPerception + WEAPONS[weapon].visionBonus;
}

/** Full field-of-view width in radians. */
export function visionFov(a: Attributes, weapon: WeaponId): number {
  return clamp(WEAPONS[weapon].fov + a.perception * PERCEPTION.fovPerPerception, PERCEPTION.fovMin, PERCEPTION.fovMax);
}

/** Base hearing radius in px (before the target's noise multiplier). */
export function hearingRadius(a: Attributes): number {
  return PERCEPTION.hearingBase + a.perception * PERCEPTION.hearingPerPerception;
}

/** Hearing multiplier against a target with this speed (px/tick) and stance. */
export function noiseMultiplier(speed: number, stance: Stance): number {
  if (STANCES[stance].quiet || speed <= PERCEPTION.hearingFastSpeed) return PERCEPTION.hearingQuietMul;
  return PERCEPTION.hearingFastMul;
}

/** Auto-parry chance per enemy windup (see COMBAT_DOCS.parryBaseChance). */
export function parryChance(a: Attributes): number {
  return clamp((COMBAT.parryBaseChance * a.perception) / 40, 0, 1);
}

/** Projectile speed in px/tick including SPEED_SCALE (0 for melee). */
export function projectileSpeed(weapon: WeaponId): number {
  return WEAPONS[weapon].projectileSpeed * SPEED_SCALE;
}

/** Ticks a projectile flies before dropping (0 for melee). */
export function projectileTtl(weapon: WeaponId): number {
  const speed = projectileSpeed(weapon);
  return speed > 0 ? Math.ceil((WEAPONS[weapon].range * COMBAT.projectileRangeMul) / speed) : 0;
}

/** Everything the editor and inspector show about a build. */
export type DerivedStats = {
  maxHp: number;
  radius: number;
  moveSpeed: number;
  turnRate: number;
  armorMitigation: number;
  damageMultiplier: number;
  attackCooldown: number;
  skillCooldown: number;
  visionRange: number;
  visionFov: number;
  hearingRadius: number;
  parryChance: number;
};

export function deriveStats(a: Attributes, weapon: WeaponId): DerivedStats {
  return {
    maxHp: maxHp(a),
    radius: fighterRadius(a),
    moveSpeed: moveSpeed(a, weapon),
    turnRate: turnRate(a, weapon),
    armorMitigation: armorMitigation(a),
    damageMultiplier: damageMultiplier(a, false),
    attackCooldown: attackCooldown(a, weapon),
    skillCooldown: skillCooldown(a),
    visionRange: visionRange(a, weapon),
    visionFov: visionFov(a, weapon),
    hearingRadius: hearingRadius(a),
    parryChance: parryChance(a),
  };
}

/** Label, unit and formula text for each derived stat (rulebook, editor tooltips). */
export const STAT_DOCS: Readonly<Record<keyof DerivedStats, { label: string; unit: string; doc: string }>> = {
  maxHp: { label: 'Max HP', unit: 'hp', doc: '150 + vitality x 8.5, rounded.' },
  radius: { label: 'Body radius', unit: 'px', doc: '15.5 + vitality x 0.18 + armor x 0.14.' },
  moveSpeed: { label: 'Move speed', unit: 'px/tick', doc: `(2.2 + agility x 0.068 - armor x 0.015) x weapon weight x ${SPEED_SCALE}. Walking backwards is slower (x${COMBAT.backpedalMoveMul} straight back).` },
  turnRate: { label: 'Turn rate', unit: 'rad/s', doc: '(2.4 + agility x 0.145 - armor x 0.032) x weapon weight, clamped 1.6-7.4.' },
  armorMitigation: { label: 'Damage reduction', unit: 'fraction', doc: 'armor x 1.6%, at most 48%.' },
  damageMultiplier: { label: 'Damage multiplier', unit: 'x', doc: '1 + power x 2.4% (+35% while berserk).' },
  attackCooldown: { label: 'Attack cooldown', unit: 'ticks', doc: 'weapon cooldown x (1 - haste x 1.4%), at least 10.' },
  skillCooldown: { label: 'Skill cooldown', unit: 'ticks', doc: '205 - haste x 3.1, at least 60.' },
  visionRange: { label: 'Vision range', unit: 'px', doc: '255 + perception x 9.5 + weapon bonus. 45% of that against targets in shadow.' },
  visionFov: { label: 'Field of view', unit: 'rad', doc: 'weapon base + perception x 0.012, clamped 1.35-2.55.' },
  hearingRadius: { label: 'Hearing', unit: 'px', doc: '115 + perception x 4.2; x1.15 against noisy targets, x0.72 against quiet ones.' },
  parryChance: { label: 'Parry chance', unit: 'fraction', doc: '0.35 x perception / 40 per enemy windup you face.' },
};
