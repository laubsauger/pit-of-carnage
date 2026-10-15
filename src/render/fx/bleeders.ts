// Owned by: render-fx
/**
 * Timed blood emitters: stump spurts after a dismemberment (pulsing like a heartbeat that loses
 * pressure for several seconds), the trail of a severed limb in flight, the blood fountain of a
 * death, and pools that keep spreading under a body or a landed gib for a second or two. Pure
 * timing logic; the caller turns pulses into droplets and stamps.
 */

import type { Limb } from '../../core';
import type { Pooled } from './pool';

export const SPURT = {
  /** Seconds a stump keeps spurting (then it only drips, wherever the fighter walks). */
  duration: 4.6,
  /** Seconds between the first heartbeats; the beat slows as pressure drops. */
  interval: 0.22,
  /** How much longer the last beat interval is than the first (x (1 + slowdown)). */
  slowdown: 1.7,
  /** Strength of the last pulse relative to the first. */
  minStrength: 0.12,
};

export type Spurt = Pooled & { fighterId: string; limb: Limb; t: number; next: number };

export function startSpurt(s: Spurt, fighterId: string, limb: Limb): void {
  s.fighterId = fighterId;
  s.limb = limb;
  s.t = 0;
  s.next = 0;
}

/**
 * Advance a spurt by `dt` seconds, calling `pulse(strength)` for every heartbeat inside the step
 * (strength 1 = first pulse, falling to `minStrength`, fastest at first). Returns false once the
 * stump is done.
 */
export function spurtStep(s: Spurt, dt: number, pulse: (strength: number) => void): boolean {
  s.t += dt;
  while (s.next <= s.t && s.next < SPURT.duration) {
    const k = 1 - s.next / SPURT.duration;
    pulse(SPURT.minStrength + (1 - SPURT.minStrength) * k * Math.sqrt(k));
    s.next += SPURT.interval * (1 + SPURT.slowdown * (1 - k));
  }
  return s.t < SPURT.duration;
}

/**
 * A severed limb flying off trails blood from its cut end: drops shed at a rate that starts high and
 * weakens, until the limb has bled out (then its slide streaks take over).
 */
export const LIMB_TRAIL = {
  /** Seconds a flying limb keeps shedding drops. */
  duration: 1.3,
  /** Drops per second when it leaves the body, and at the end. */
  rate: 46,
  minRate: 8,
};

export type Trail = { t: number; carry: number; on: boolean };

export function createTrail(): Trail {
  return { t: 0, carry: 0, on: false };
}

export function startTrail(tr: Trail): void {
  tr.t = 0;
  tr.carry = 0;
  tr.on = true;
}

/**
 * Advance a limb's blood trail by `dt` seconds, calling `drop(strength)` once per drop shed in the
 * step (strength 1 at the cut, weakening). Drop count depends only on time, never on frame rate.
 * Returns false once the limb has stopped bleeding.
 */
export function trailStep(tr: Trail, dt: number, drop: (strength: number) => void): boolean {
  if (!tr.on) return false;
  const L = LIMB_TRAIL;
  const t0 = tr.t;
  const t1 = Math.min(L.duration, t0 + (dt > 0 ? dt : 0));
  tr.t = t0 + (dt > 0 ? dt : 0);
  // Integral of the linearly falling rate over [t0, t1].
  const rateAt = (t: number) => L.rate + (L.minRate - L.rate) * (t / L.duration);
  tr.carry += t1 > t0 ? ((rateAt(t0) + rateAt(t1)) / 2) * (t1 - t0) : 0;
  while (tr.carry >= 1) {
    tr.carry -= 1;
    drop(1 - t1 / L.duration * 0.75);
  }
  if (tr.t >= L.duration) tr.on = false;
  return tr.on;
}

/**
 * A death is a comic explosion: the body erupts in a fountain that throws blood high up in every
 * direction, fast at first and dying down, so it rains back over a wide circle.
 */
export const FOUNTAIN = {
  /** Seconds the fountain keeps erupting. */
  duration: 0.95,
  /** Seconds between eruptions. */
  interval: 0.075,
  /** Strength of the last eruption relative to the first. */
  minStrength: 0.2,
};

export type Fountain = Pooled & { x: number; y: number; power: number; t: number; next: number };

export function startFountain(f: Fountain, x: number, y: number, power: number): void {
  f.x = x;
  f.y = y;
  f.power = power;
  f.t = 0;
  f.next = 0;
}

/**
 * Advance a fountain by `dt` seconds, calling `pulse(strength)` for every eruption inside the step
 * (strength 1 first, easing down to `minStrength`). Returns false once it is done.
 */
export function fountainStep(f: Fountain, dt: number, pulse: (strength: number) => void): boolean {
  f.t += dt;
  while (f.next <= f.t && f.next < FOUNTAIN.duration) {
    const k = 1 - f.next / FOUNTAIN.duration;
    pulse(FOUNTAIN.minStrength + (1 - FOUNTAIN.minStrength) * k * k);
    f.next += FOUNTAIN.interval;
  }
  return f.t < FOUNTAIN.duration;
}

export const POOL = {
  /** Seconds a death pool keeps spreading (a gib's ooze passes its own, shorter duration). */
  duration: 2.6,
  /** Seconds between stamps while it spreads. */
  interval: 0.13,
  /** Opacity of each stamp; overlapping stamps darken the thick middle. */
  alpha: 0.2,
};

export type GrowingPool = Pooled & {
  x: number;
  y: number;
  radius: number;
  angle: number;
  seed: number;
  /** Seconds it keeps spreading. */
  duration: number;
  t: number;
  next: number;
};

export function startPool(p: GrowingPool, x: number, y: number, radius: number, angle: number, seed: number, duration: number = POOL.duration): void {
  p.x = x;
  p.y = y;
  p.radius = radius;
  p.angle = angle;
  p.seed = seed;
  p.duration = duration;
  p.t = 0;
  p.next = 0;
}

/** Radius of a spreading pool `t` seconds after it started: fast at first, then creeping. */
export function poolRadius(p: GrowingPool, t: number): number {
  const x = Math.min(1, Math.max(0, t / p.duration));
  return p.radius * (0.25 + 0.75 * (1 - Math.pow(1 - x, 2.2)));
}

/** Advance a pool, calling `stamp(radius)` for each spread step inside `dt`. Returns false when done. */
export function poolStep(p: GrowingPool, dt: number, stamp: (radius: number) => void): boolean {
  p.t += dt;
  while (p.next <= p.t && p.next <= p.duration) {
    stamp(poolRadius(p, p.next));
    p.next += POOL.interval;
  }
  return p.t < p.duration;
}
