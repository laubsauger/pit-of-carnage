// Owned by: render-fx
/** Easing curves for popups. Pure functions of x in [0, 1]. */

import { BARK_RULES } from '../../core';

const C4 = (2 * Math.PI) / 3;

/** Elastic ease-out: shoots past 1, wobbles, settles exactly at 1. */
export function elasticOut(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * C4) + 1;
}

/** Back ease-out: a single overshoot of about 10%. */
export function backOut(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const t = x - 1;
  return 1 + c3 * t * t * t + c1 * t * t;
}

export function cubicOut(x: number): number {
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Kill stamp timing: a quick elastic pop, a short hold, then within about 0.6 s of the kill it
 * shrinks and floats up while fading, gone by about 1.2 s. Readable, then out of the way.
 */
export const STAMP_TIMING = { popIn: 0.26, hold: 0.34, out: 0.6 };

/** Scale a stamp shrinks to by the end of its out phase. */
const STAMP_END_SCALE = 0.55;

/**
 * Kill stamp envelope at `t` seconds: scale, opacity and rise (0..1, how far it has floated up).
 */
export function stampEnvelope(out: { scale: number; alpha: number; rise: number }, t: number): { scale: number; alpha: number; rise: number } {
  const { popIn, hold, out: outT } = STAMP_TIMING;
  const k = (t - popIn - hold) / outT;
  if (k <= 0) {
    out.scale = elasticOut(t / popIn);
    out.alpha = Math.min(1, Math.max(0, t / 0.05));
    out.rise = 0;
    return out;
  }
  const e = cubicOut(k);
  out.scale = 1 - (1 - STAMP_END_SCALE) * e;
  out.alpha = k >= 1 ? 0 : 1 - k * k;
  out.rise = e;
  return out;
}

export function stampDuration(): number {
  return STAMP_TIMING.popIn + STAMP_TIMING.hold + STAMP_TIMING.out;
}

/**
 * Move `current` toward `target` by an exponential ease at `rate` per second, the same at any frame
 * rate. Used so placed popups glide aside instead of jumping.
 */
export function easeToward(current: number, target: number, dt: number, rate: number): number {
  if (dt <= 0) return current;
  return target + (current - target) * Math.exp(-rate * dt);
}

/**
 * Lift of a placed popup that dodges something (>= 0, up). A new popup (`lift` < 0) takes the
 * `needed` lift at once; after that it only glides up when it must and otherwise stays put, so a
 * bubble or stamp never jumps or bobs as things move around it.
 */
export function glideUp(lift: number, needed: number, dt: number, rate: number): number {
  if (lift < 0) return needed;
  return needed > lift ? easeToward(lift, needed, dt, rate) : lift;
}

/**
 * Bark bubble envelope: quick back-out pop, hold, fade and shrink away; the whole bubble lasts
 * `BARK_RULES.visibleSeconds` (barks are small and brief, never a wall of speech).
 */
export const BARK_TIMING = { popIn: 0.14, hold: BARK_RULES.visibleSeconds - 0.14 - 0.3, popOut: 0.3 };

export function barkEnvelope(out: { scale: number; alpha: number; rise: number }, t: number): { scale: number; alpha: number; rise: number } {
  const { popIn, hold, popOut } = BARK_TIMING;
  const outT = (t - popIn - hold) / popOut;
  if (outT <= 0) {
    out.scale = backOut(t / popIn);
    out.alpha = Math.min(1, t / 0.08);
  } else {
    const k = Math.min(1, outT);
    out.scale = 1 - 0.25 * k;
    out.alpha = 1 - k;
  }
  out.rise = 0;
  return out;
}

export function barkDuration(): number {
  return BARK_TIMING.popIn + BARK_TIMING.hold + BARK_TIMING.popOut;
}
