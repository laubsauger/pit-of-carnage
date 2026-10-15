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
 * Kill stamp envelope at `t` seconds: slams in with an elastic overshoot, holds, then fades.
 * Returns scale and opacity through `out`.
 */
export const STAMP_TIMING = { popIn: 0.55, hold: 1.25, fadeOut: 0.35 };

export function stampEnvelope(out: { scale: number; alpha: number; rise: number }, t: number): { scale: number; alpha: number; rise: number } {
  const { popIn, hold, fadeOut } = STAMP_TIMING;
  out.scale = elasticOut(t / popIn);
  const fadeT = (t - popIn - hold) / fadeOut;
  out.alpha = fadeT <= 0 ? Math.min(1, t / 0.06) : Math.max(0, 1 - fadeT);
  out.rise = fadeT <= 0 ? 0 : cubicOut(fadeT);
  return out;
}

export function stampDuration(): number {
  return STAMP_TIMING.popIn + STAMP_TIMING.hold + STAMP_TIMING.fadeOut;
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
