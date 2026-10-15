// Owned by: render-fx
/**
 * Damage numbers as pure layout (numbers.ts draws them). Small and short-lived, coloured by the
 * attacker, crits bigger, backstabs labelled; heals are green "+N". They sit beside the victim's
 * body (right flank) and stack downward, never upward into the HP bar and name tag above the body,
 * so a flurry of hits stays readable and the tag is never covered. Numbers of victims standing
 * close together never overlap: a number that would cover another takes its victim's left flank,
 * or steps down below what it covers (`placeNumber`). Sizes are CSS px: constant on screen at any
 * zoom.
 */

import { overlaps } from './barks';
import type { Box } from './barks';

export const DAMAGE_NUMBERS = {
  /** Seconds a number lives (game time). */
  life: 0.95,
  /** Glyph height (CSS px) of an ordinary number and of a crit. */
  size: 15,
  critSize: 20,
  /** Label ("BACKSTAB") height. */
  labelSize: 10,
  /** Gap between the body's edge and the number. */
  side: 5,
  /** Vertical step between stacked numbers (at least a glyph height, so they never overlap). */
  line: 20,
  /** How far a number drifts up over its life. */
  rise: 7,
  /** Numbers kept per victim (the oldest goes first). */
  perVictim: 3,
  /**
   * Hits from the same attacker on the same victim this soon after the newest number add up into
   * it instead of stacking (a whirlwind, a saw, a flurry of daggers read as one number).
   */
  mergeSeconds: 0.3,
};

/** Whether a new hit adds into the victim's newest number instead of starting its own. */
export function mergesInto(newest: { attackerId: string; t: number } | null, attackerId: string): boolean {
  return newest !== null && newest.attackerId === attackerId && newest.t < DAMAGE_NUMBERS.mergeSeconds;
}

/** Text for a hit: whole damage, at least 1 (a hit always shows). Heals read "+N". */
export function damageText(amount: number, heal = false): string {
  const n = Math.round(amount);
  return (heal ? '+' : '') + String(n < 1 ? 1 : n);
}

/** Scale and opacity at `t` seconds: a quick pop, a hold, then a fade. */
export function numberEnvelope(out: { scale: number; alpha: number; rise: number }, t: number, crit: boolean): { scale: number; alpha: number; rise: number } {
  const life = DAMAGE_NUMBERS.life;
  const k = t <= 0 ? 0 : t >= life ? 1 : t / life;
  const pop = Math.min(1, t / 0.08);
  out.scale = (crit ? 1.35 : 1.15) - (crit ? 0.35 : 0.15) * pop;
  out.alpha = k < 0.6 ? Math.min(1, t / 0.04) : Math.max(0, 1 - (k - 0.6) / 0.4);
  out.rise = Math.sqrt(k);
  return out;
}

/**
 * Vertical offset (CSS px, +down) of the centre of the number in stack `slot` (0 = newest) at
 * `rise` (0..1) from the victim's centre, for glyph height `h`. The newest sits level with the
 * upper body and drifts up a little; older ones stop drifting and step down a line each (`slot`
 * may be fractional while easing). The top of a number never rises above the body's top edge
 * (`radiusPx` above centre), so it never reaches the HP bar or tag.
 */
export function numberOffsetY(slot: number, rise: number, h: number, radiusPx: number): number {
  const d = DAMAGE_NUMBERS;
  const drift = slot >= 1 ? 0 : 1 - slot;
  const head = -radiusPx * 0.35 - rise * d.rise * drift;
  const top = -radiusPx + h / 2;
  return (head < top ? top : head) + slot * d.line;
}

/**
 * Move `box` straight down until it overlaps none of the first `count` obstacles (with `pad`
 * between). Each move puts it below an obstacle it can then never reach again, so this ends after
 * at most `count` moves. Returns the number of moves.
 */
export function dropClear(box: Box, obstacles: readonly Box[], count: number, pad: number): number {
  let moves = 0;
  for (let guard = 0; guard < count + 1; guard++) {
    let hit = -1;
    for (let i = 0; i < count; i++) {
      if (!overlaps(box, obstacles[i], pad)) continue;
      if (hit < 0 || obstacles[i].cy + obstacles[i].hh > obstacles[hit].cy + obstacles[hit].hh) hit = i;
    }
    if (hit < 0) return moves;
    const o = obstacles[hit];
    box.cy = o.cy + o.hh + pad + box.hh;
    moves++;
  }
  return moves;
}

/** Where `placeNumber` put a number. */
export const NUMBER_SPOT = { right: 0, left: 1, below: 2 } as const;

/**
 * Keep a number clear of the first `count` obstacles (numbers already placed, fighters' tags):
 * its spot on the victim's right flank (`box`, as given) if free, else the left flank (`leftCx`),
 * else straight down from the right flank below whatever it covers. Never up, so it never climbs
 * into its victim's HP bar or tag. Returns which spot it took (`NUMBER_SPOT`).
 */
export function placeNumber(box: Box, leftCx: number, obstacles: readonly Box[], count: number, pad: number): number {
  if (!hitsAny(box, obstacles, count, pad)) return NUMBER_SPOT.right;
  const rightCx = box.cx;
  box.cx = leftCx;
  if (!hitsAny(box, obstacles, count, pad)) return NUMBER_SPOT.left;
  box.cx = rightCx;
  dropClear(box, obstacles, count, pad);
  return NUMBER_SPOT.below;
}

function hitsAny(box: Box, obstacles: readonly Box[], count: number, pad: number): boolean {
  for (let i = 0; i < count; i++) if (overlaps(box, obstacles[i], pad)) return true;
  return false;
}
