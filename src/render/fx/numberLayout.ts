// Owned by: render-fx
/**
 * Damage numbers as pure layout (numbers.ts draws them). Small and short-lived, coloured by the
 * attacker, crits bigger, backstabs labelled. They sit beside the victim's body (right flank) and
 * stack downward, never upward into the HP bar and name tag above the body, so a flurry of hits
 * stays readable and the tag is never covered. Sizes are CSS px: constant on screen at any zoom.
 */

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

/** Text for a hit: whole damage, at least 1 (a hit always shows). */
export function damageText(amount: number): string {
  const n = Math.round(amount);
  return String(n < 1 ? 1 : n);
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
