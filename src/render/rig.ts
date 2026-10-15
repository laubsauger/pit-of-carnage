/**
 * Pose math for the fighter rig. Pure functions, no three.js.
 *
 * Angles are in the fighter's body frame: 0 = straight ahead (facing), positive = toward the right
 * hand (clockwise on screen, matching the world angle convention). Weapons are held in the right
 * hand, so an idle weapon rests at a small positive angle and a strike sweeps it across the front
 * toward negative angles. Readability rules encoded here:
 * - every attack telegraphs: the windup pulls the weapon back and the glow ramps up to full;
 * - the strike is fast and crosses the facing direction, so the victim is visibly in its path;
 * - phases join without jumps (end of windup = start of strike, end of recovery = idle).
 */

import { WEAPON_IDS, clamp01 } from '../core';
import type { AnimPhase, WeaponId } from '../core';

export type WeaponPose = {
  /** Weapon angle around its pivot in the body frame (radians, + = toward the right hand). */
  swing: number;
  /** Extra reach along the weapon direction (px at nominal body size). */
  reach: number;
  /** Bowstring draw / staff charge 0..1. */
  draw: number;
  /** Telegraph glow 0..1. */
  glow: number;
  /** Strike smear opacity 0..1 (melee only). */
  smear: number;
  /** Angle the smear trails from (the swing's start), body frame. */
  smearFrom: number;
  /** The weapon left the hand (thrown axe between strike and the end of recovery). */
  released: boolean;
};

export function newWeaponPose(): WeaponPose {
  return { swing: 0, reach: 0, draw: 0, glow: 0, smear: 0, smearFrom: 0, released: false };
}

/** Key angles of one weapon's swing (radians, body frame) and reach offsets (px). */
type SwingKeys = {
  idle: number;
  back: number;
  end: number;
  backReach: number;
  strikeReach: number;
  /** Strike draws a smear arc (sweeping weapons). */
  smear: boolean;
};

export const SWING_KEYS: Readonly<Record<WeaponId, SwingKeys>> = {
  // Big flat cleave: cocked far back over the right shoulder, sweeps through the whole 135° arc.
  GREATSWORD: { idle: 0.62, back: 1.95, end: -1.5, backReach: -4, strikeReach: 4, smear: true },
  // Overhead smash: raised high, slammed down just left of centre with extra reach.
  WARHAMMER: { idle: 0.8, back: 2.25, end: -0.2, backReach: -8, strikeReach: 10, smear: true },
  // Stabs: little angle change, the reach does the work.
  TWIN_DAGGERS: { idle: 0.38, back: 0.7, end: 0.04, backReach: -7, strikeReach: 15, smear: false },
  // Over-the-shoulder throw.
  THROWING_AXES: { idle: 0.72, back: 2.35, end: -0.45, backReach: -3, strikeReach: 6, smear: false },
  // The bow points straight ahead; the draw does the work.
  LONGBOW: { idle: 0, back: 0, end: 0, backReach: 0, strikeReach: 0, smear: false },
  // Staff thrust: the orb is raised forward and pushed out on release.
  ARCANE_STAFF: { idle: 0.48, back: 0.16, end: 0.1, backReach: 4, strikeReach: 14, smear: false },
};

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

function easeOutQuart(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u * u;
}

function easeInOutSine(t: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * t);
}

/**
 * Weapon pose for an animation phase at progress `p` (0..1 through the phase). `idleTime` is a
 * cosmetic clock (seconds) for the idle sway.
 */
export function weaponPose(weapon: WeaponId, phase: AnimPhase, p: number, idleTime: number, out: WeaponPose): WeaponPose {
  const k = SWING_KEYS[weapon];
  const t = clamp01(p);
  out.draw = 0;
  out.smear = 0;
  out.smearFrom = k.back;
  out.released = false;
  switch (phase) {
    case 'windup': {
      const e = easeOutCubic(t);
      out.swing = k.idle + (k.back - k.idle) * e;
      out.reach = k.backReach * e;
      out.glow = Math.pow(t, 1.4);
      out.draw = e;
      break;
    }
    case 'strike': {
      const e = easeOutQuart(t);
      out.swing = k.back + (k.end - k.back) * e;
      out.reach = k.backReach + (k.strikeReach - k.backReach) * Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5);
      out.glow = 1 - t;
      out.draw = 0;
      if (k.smear) out.smear = t < 0.75 ? 1 - t / 0.75 : 0;
      out.released = weapon === 'THROWING_AXES' && t > 0.25;
      break;
    }
    case 'recovery': {
      const e = easeInOutSine(t);
      out.swing = k.end + (k.idle - k.end) * e;
      out.reach = k.strikeReach * (1 - e);
      out.glow = 0;
      out.released = weapon === 'THROWING_AXES';
      break;
    }
    default: {
      out.swing = k.idle + Math.sin(idleTime * 2.1) * 0.05;
      out.reach = 0;
      out.glow = 0;
    }
  }
  return out;
}

/** Boot stride offset along the facing (px at nominal size) for a walk phase and movement 0..1. */
export function stride(walkPhase: number, move: number): number {
  return Math.sin(walkPhase) * 6.5 * clamp01(move);
}

/** Movement 0..1 from speed in px/tick (a brisk walk is about 2 px/tick). */
export function moveAmount(speed: number): number {
  return clamp01(speed / 2);
}

/** Eye scale: eyes pop out while `eyePop` ticks remain, easing back as the countdown ends. */
export function eyeScale(eyePop: number): number {
  if (eyePop <= 0) return 1;
  return 1 + 0.85 * clamp01(eyePop / 18);
}

/** White hit flash 0..1 from the remaining flash ticks (full for the first frames, then fades). */
export function flashAmount(hitFlash: number): number {
  return clamp01(hitFlash / 4);
}

// ---------------------------------------------------------------------------------------------
// Local hit weight: ordinary hits land on the two bodies involved, never on the camera
// ---------------------------------------------------------------------------------------------

/**
 * Strike progress (0..1) at which a melee blow visibly lands: where a sweep crosses the facing, or
 * where a stab reaches furthest. Hit-stop freezes the attacker on this pose, because the sim
 * resolves the hit on the strike's first tick, while the weapon is still cocked back.
 */
export const IMPACT_PROGRESS: Readonly<Record<WeaponId, number>> = computeImpacts();

/** Punches land at the peak of the jab (see the punch pose in the fighter rig). */
export const PUNCH_IMPACT = 1 / 2.8;

function computeImpacts(): Record<WeaponId, number> {
  const out = {} as Record<WeaponId, number>;
  const p = newWeaponPose();
  for (const w of WEAPON_IDS) {
    const k = SWING_KEYS[w];
    const sweep = k.back > 0 && k.end < 0;
    let best = 0;
    let bestScore = Infinity;
    for (let i = 0; i <= 200; i++) {
      const t = i / 200;
      weaponPose(w, 'strike', t, 0, p);
      const score = sweep ? Math.abs(p.swing) : -p.reach;
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    out[w] = best;
  }
  return out;
}

/** Longest local hit-stop (6 frames). Kills get the global freeze from the app's time director instead. */
export const HIT_STOP_MAX = 6 / 60;

/** Severity 0..1 of a blow: scratches near 0, a big or critical hit 1. */
export function hitSeverity(amount: number, crit: boolean): number {
  return Math.min(1, clamp01((amount - 6) / 30) + (crit ? 0.35 : 0));
}

/** Local hit-stop in game seconds: 3 frames for a scratch up to 6 for a big or critical blow. */
export function hitStopSeconds(severity: number): number {
  return (3 + 3 * clamp01(severity)) / 60;
}

/** Peak squash of a struck body (fraction its body flattens along the blow). */
export function squashPeak(severity: number): number {
  return 0.12 + 0.16 * clamp01(severity);
}

/** Seconds a struck body takes to spring back after its hit-stop. */
export const SQUASH_SECONDS = 0.35;

/**
 * Squash of a struck body: positive flattens it along the blow, negative stretches it. Held at the
 * peak while the hit-stop lasts (`age` < 0), then springs back with one visible overshoot.
 */
export function squashAmount(age: number, peak: number): number {
  if (age < 0) return peak;
  if (age >= SQUASH_SECONDS) return 0;
  return peak * Math.exp(-age * 10) * Math.cos(age * 28);
}
