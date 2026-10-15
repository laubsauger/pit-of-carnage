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
import type { Attributes, BarkKind, HazardKind, PickupKind, PropKind, SkillId, Stance, WeaponFamily, WeaponId } from './types';

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
  /** Ticks to regenerate one charge (0 = no regeneration). */
  ammoRegenTicks: number;
  /** Splash radius around the impact point (0 = none). */
  splash: number;
  /** Fraction of damage dealt to others inside the splash radius. */
  splashMul: number;
  /** Carries a shield: in `guard` stance, blocks arrows and axes arriving within COMBAT.shieldArc of facing. */
  shield: boolean;
  /** Added to vision range (px). */
  visionBonus: number;
  /** Base field of view (radians) before perception. */
  fov: number;
  /** Move speed multiplier (weapon weight). */
  moveMul: number;
  /** Turn rate multiplier (weapon weight). */
  turnMul: number;
};

export const WEAPON_IDS: readonly WeaponId[] = ['GREATSWORD', 'WARHAMMER', 'TWIN_DAGGERS', 'THROWING_AXES', 'LONGBOW', 'ARCANE_STAFF'];

export const WEAPONS: Readonly<Record<WeaponId, WeaponRule>> = {
  GREATSWORD: {
    id: 'GREATSWORD', name: 'Greatsword', family: 'melee',
    doc: 'Wide 135° cleave that hits everyone in the arc. Slow to wind up, rude to stand next to. Shield in guard stance.',
    range: 82, damage: 30, cooldown: 42, windup: 14, strike: 11, recovery: 12, knockback: 10,
    arc: 2.35, cleave: true, backstabMult: 1.45, stunTicks: 0, slowTicks: 0,
    projectileSpeed: 0, ammo: 0, ammoPickup: false, ammoRegenTicks: 0, splash: 0, splashMul: 0, shield: true,
    visionBonus: 0, fov: 1.95, moveMul: 0.96, turnMul: 0.84,
  },
  WARHAMMER: {
    id: 'WARHAMMER', name: 'Warhammer', family: 'melee',
    doc: 'Single-target smash. Stuns for 34 ticks and sends the victim across the room. Shield in guard stance.',
    range: 70, damage: 26, cooldown: 44, windup: 15, strike: 12, recovery: 13, knockback: 16,
    arc: 1.65, cleave: false, backstabMult: 1.45, stunTicks: 34, slowTicks: 0,
    projectileSpeed: 0, ammo: 0, ammoPickup: false, ammoRegenTicks: 0, splash: 0, splashMul: 0, shield: true,
    visionBonus: -15, fov: 1.8, moveMul: 0.91, turnMul: 0.78,
  },
  TWIN_DAGGERS: {
    id: 'TWIN_DAGGERS', name: 'Twin daggers', family: 'melee',
    doc: 'Short, fast stabs. Backstabs deal x2.35. Light enough to turn on a coin.',
    range: 56, damage: 16, cooldown: 18, windup: 6, strike: 8, recovery: 6, knockback: 3,
    arc: 1.35, cleave: false, backstabMult: 2.35, stunTicks: 0, slowTicks: 0,
    projectileSpeed: 0, ammo: 0, ammoPickup: false, ammoRegenTicks: 0, splash: 0, splashMul: 0, shield: false,
    visionBonus: 35, fov: 2.25, moveMul: 1.18, turnMul: 1.38,
  },
  THROWING_AXES: {
    id: 'THROWING_AXES', name: 'Throwing axes', family: 'ranged',
    doc: 'Four axes, thrown hard. Each one lands on the floor and has to be picked up again.',
    range: 265, damage: 21, cooldown: 26, windup: 8, strike: 9, recovery: 7, knockback: 6,
    arc: 0, cleave: false, backstabMult: 1.45, stunTicks: 0, slowTicks: 0,
    projectileSpeed: 10.6, ammo: 4, ammoPickup: true, ammoRegenTicks: 0, splash: 0, splashMul: 0, shield: false,
    visionBonus: 45, fov: 2.05, moveMul: 1.06, turnMul: 1.12,
  },
  LONGBOW: {
    id: 'LONGBOW', name: 'Longbow', family: 'ranged',
    doc: 'Longest reach in the pit. Arrows slow the victim for 75 ticks. Ten arrows; spent ones must be picked up.',
    range: 430, damage: 20, cooldown: 33, windup: 11, strike: 8, recovery: 8, knockback: 4,
    arc: 0, cleave: false, backstabMult: 1.45, stunTicks: 0, slowTicks: 75,
    projectileSpeed: 12.2, ammo: 10, ammoPickup: true, ammoRegenTicks: 0, splash: 0, splashMul: 0, shield: false,
    visionBonus: 130, fov: 1.65, moveMul: 1.07, turnMul: 1.15,
  },
  ARCANE_STAFF: {
    id: 'ARCANE_STAFF', name: 'Arcane staff', family: 'ranged',
    doc: 'Slow orbs that burst on impact, splashing 60% damage within 72 px. Recharges instead of using ammo.',
    range: 375, damage: 25, cooldown: 43, windup: 12, strike: 10, recovery: 10, knockback: 8,
    arc: 0, cleave: false, backstabMult: 1.45, stunTicks: 0, slowTicks: 0,
    projectileSpeed: 9.6, ammo: 4, ammoPickup: false, ammoRegenTicks: 90, splash: 72, splashMul: 0.6, shield: false,
    visionBonus: 95, fov: 1.9, moveMul: 0.99, turnMul: 1.02,
  },
};

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
  /** SHADOWSTEP: how far behind the target the user lands (px). */
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
};

export const SKILL_IDS: readonly SkillId[] = ['WHIRLWIND', 'SHADOWSTEP', 'DASH', 'SHOCKWAVE', 'BLOODRAGE'];

const NO_SKILL_FIELDS = {
  radius: 0, arc: 0, damage: 0, powerScale: 0, knockback: 0, stunTicks: 0, parryTicks: 0,
  distance: 0, impulse: 0, hasteTicks: 0, berserkTicks: 0, activeTicks: 0, needsTarget: false, maxRange: 0,
};

export const SKILLS: Readonly<Record<SkillId, SkillRule>> = {
  WHIRLWIND: {
    ...NO_SKILL_FIELDS, id: 'WHIRLWIND', name: 'Whirlwind',
    doc: 'Spin attack: 25 + power x 0.55 damage to everyone within 92 px, with knockback.',
    radius: 92, damage: 25, powerScale: 0.55, knockback: 12, activeTicks: 28,
  },
  SHADOWSTEP: {
    ...NO_SKILL_FIELDS, id: 'SHADOWSTEP', name: 'Shadowstep',
    doc: 'Teleport 36 px behind the target (within 320 px), facing its back. Pairs well with daggers.',
    distance: 36, needsTarget: true, maxRange: 320, activeTicks: 10,
  },
  DASH: {
    ...NO_SKILL_FIELDS, id: 'DASH', name: 'Dash',
    doc: 'Burst along the current steering heading (impulse 14) plus haste for 65 ticks. Works for chasing and for leaving.',
    impulse: 14, hasteTicks: 65, activeTicks: 12,
  },
  SHOCKWAVE: {
    ...NO_SKILL_FIELDS, id: 'SHOCKWAVE', name: 'Shockwave',
    doc: 'Shield slam: parry window of 48 ticks, plus 19 damage and a 36-tick stun to everyone in a 96 px cone ahead.',
    radius: 96, arc: 2.2, damage: 19, knockback: 16, stunTicks: 36, parryTicks: 48, activeTicks: 16,
  },
  BLOODRAGE: {
    ...NO_SKILL_FIELDS, id: 'BLOODRAGE', name: 'Bloodrage',
    doc: 'Berserk (+35% damage) and haste (x1.45 speed) for 145 ticks.',
    hasteTicks: 145, berserkTicks: 145, activeTicks: 20,
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
  shieldArc: 'Shield users in guard stance block arrows and axes arriving within this full arc (radians) of facing.',
  knockbackScale: 'Knockback impulse multiplier applied to the victim\'s velocity.',
  hasteAttackPerPoint: 'Attack cooldown reduction per haste point.',
  minAttackCooldown: 'Attack cooldown never drops below this many ticks.',
  skillCooldownBase: 'Skill cooldown at 0 haste (ticks).',
  skillCooldownPerHaste: 'Skill cooldown reduction per haste point (ticks).',
  minSkillCooldown: 'Skill cooldown never drops below this many ticks.',
  skillStartCooldown: 'Skill cooldown at spawn, so nobody opens with a skill on tick one.',
  hasteMoveMul: 'Move speed multiplier while hasted.',
  slowMoveMul: 'Move speed multiplier while slowed (longbow arrows).',
  dismemberMinDamage: 'Smallest hit that can sever a limb.',
  dismemberBelowHp: 'Limbs can only come off when the victim is below this fraction of max HP.',
  dismemberChance: 'Chance that an eligible hit severs a limb.',
  punchDamage: 'Damage of a punch when the weapon arm is gone.',
  punchRange: 'Reach of a punch (px).',
  punchCooldown: 'Ticks between punches.',
  leglessMoveMul: 'Move speed multiplier after losing a leg (the fighter hops).',
  helmetKnockChance: 'Chance that a crit knocks the victim\'s helmet off (cosmetic).',
  projectileRangeMul: 'Projectiles fly up to range x this before dropping to the floor.',
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
} as const;

export const PERCEPTION_DOCS: DocsFor<typeof PERCEPTION> = {
  visionBase: 'Vision range at 0 perception (px), before the weapon bonus.',
  visionPerPerception: 'Vision range per perception point (px).',
  fovPerPerception: 'Field of view per perception point (radians), added to the weapon base.',
  fovMin: 'Narrowest field of view (radians).',
  fovMax: 'Widest field of view (radians).',
  hearingBase: 'Hearing radius at 0 perception (px). Hearing works in every direction and through walls.',
  hearingPerPerception: 'Hearing radius per perception point (px).',
  hearingFastMul: 'Hearing radius multiplier against a target moving faster than hearingFastSpeed.',
  hearingQuietMul: 'Hearing radius multiplier against a target that is slow, still or creeping.',
  hearingFastSpeed: 'Speed (px/tick) above which a non-creeping fighter counts as noisy.',
  shadowLight: 'Light level below which a spot counts as shadow.',
  shadowVisionMul: 'A target in shadow is only seen within this fraction of normal vision range.',
  enemiesNearRadius: 'Radius (px) of the enemies_near sensor.',
  fightingWindowTicks: 'A fighter counts as fighting for this many ticks after attacking or being hit.',
  memoryTicks: 'An enemy not seen or heard for this long is forgotten.',
};

// ---------------------------------------------------------------------------------------------
// Stances
// ---------------------------------------------------------------------------------------------

export type StanceRule = { moveMul: number; quiet: boolean; shield: boolean; doc: string };

export const STANCES: Readonly<Record<Stance, StanceRule>> = {
  normal: { moveMul: 1, quiet: false, shield: false, doc: 'Full speed. Heard normally.' },
  creep: { moveMul: 0.55, quiet: true, shield: false, doc: 'Slow and quiet: always counts as quiet for hearing.' },
  guard: { moveMul: 0.7, quiet: false, shield: true, doc: 'Slow, shield up: greatsword and warhammer users block arrows and axes from the front.' },
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
};

const NO_HAZARD_FIELDS = { intervalTicks: 0, period: 0, triggerAt: 0, speed: 0, durationTicks: 0, knockback: 0 };

export const HAZARD_RULES: Readonly<Record<HazardKind, HazardRule>> = {
  spike: {
    ...NO_HAZARD_FIELDS, kind: 'spike', name: 'Spike trap',
    doc: 'Thrusts at 88% of its 165-tick cycle for 36 damage. Watch the rhythm, then walk.',
    damage: 36, radius: 42, period: 165, triggerAt: 0.88, knockback: 6,
  },
  saw: {
    ...NO_HAZARD_FIELDS, kind: 'saw', name: 'Saw blade',
    doc: 'Rolls along its track and deals 22 damage every 12 ticks to anyone it touches. Faster in sudden death.',
    damage: 22, intervalTicks: 12, radius: 26, speed: 1.6, knockback: 8,
  },
  acid: {
    ...NO_HAZARD_FIELDS, kind: 'acid', name: 'Acid pool',
    doc: '11 damage every 24 ticks while you stand in it. Spilled pools dry up after 400 ticks.',
    damage: 11, intervalTicks: 24, radius: 62, durationTicks: 400,
  },
  fire: {
    ...NO_HAZARD_FIELDS, kind: 'fire', name: 'Fire pit',
    doc: '9 damage every 20 ticks while you stand in it. Also a light source.',
    damage: 9, intervalTicks: 20, radius: 40,
  },
};

export type PickupRule = {
  name: string;
  doc: string;
  /** Touch radius in px. */
  radius: number;
  /** Effect length in ticks (0 = instant). */
  durationTicks: number;
  /** Ticks until it can be used again after a use. */
  cooldownTicks: number;
  /** Effect size: heal fraction of max HP (shrine), speed multiplier (haste), damage bonus (berserk). */
  amount: number;
};

export const PICKUP_RULES: Readonly<Record<'shrine' | PickupKind, PickupRule>> = {
  shrine: {
    name: 'Shrine', doc: 'Heals 42% of max HP on touch, then needs 320 ticks to recharge.',
    radius: 34, durationTicks: 0, cooldownTicks: 320, amount: 0.42,
  },
  haste: {
    name: 'Haste charm', doc: 'Move speed x1.45 for 200 ticks. Respawns after 600 ticks.',
    radius: 30, durationTicks: 200, cooldownTicks: 600, amount: 1.45,
  },
  berserk: {
    name: 'Berserk draught', doc: '+35% weapon damage for 200 ticks. Respawns after 600 ticks.',
    radius: 30, durationTicks: 200, cooldownTicks: 600, amount: 0.35,
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
// Match flow
// ---------------------------------------------------------------------------------------------

export const MATCH_RULES = {
  timeLimitTicks: DEFAULT_TIME_LIMIT_TICKS,
  suddenDeathInsetPerTick: 0.25,
  suddenDeathMinHalfSize: 90,
  suddenDeathDamage: 4,
  suddenDeathIntervalTicks: 10,
  suddenDeathSawSpeedMul: 1.6,
  multiKillWindowTicks: 180,
} as const;

export const MATCH_RULES_DOCS: DocsFor<typeof MATCH_RULES> = {
  timeLimitTicks: 'Default ticks before sudden death (90 s).',
  suddenDeathInsetPerTick: 'In sudden death the arena wall moves inward this many px per tick on every side.',
  suddenDeathMinHalfSize: 'The wall stops when the remaining arena is this many px from its centre to an edge.',
  suddenDeathDamage: 'Damage to a fighter caught outside the sudden-death wall, every interval.',
  suddenDeathIntervalTicks: 'Ticks between sudden-death wall damage.',
  suddenDeathSawSpeedMul: 'Saw speed multiplier during sudden death.',
  multiKillWindowTicks: 'Kills by the same fighter within this window count as a multi-kill.',
};

/** Chance to bark when the trigger happens (if the strategy has lines for it). `low_hp` fires once, below 30% HP. */
const BARK_CHANCE: Readonly<Record<BarkKind, number>> = { spawn: 0.5, kill: 0.8, hit: 0.15, low_hp: 0.6, death: 0.7, skill: 0.5, taunt: 0.05 };

export const BARK_RULES = {
  /** Ticks a fighter waits after barking before it may bark again. */
  cooldownTicks: 150,
  /** Longest bark text shown (characters); the validator rejects longer lines. */
  maxLength: 48,
  /** HP fraction below which the `low_hp` bark may fire (once per fighter). */
  lowHp: 0.3,
  chance: BARK_CHANCE,
} as const;

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
  moveSpeed: { label: 'Move speed', unit: 'px/tick', doc: `(2.2 + agility x 0.068 - armor x 0.015) x weapon weight x ${SPEED_SCALE}.` },
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
