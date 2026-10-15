/**
 * Small pure helpers for on-arena readouts: the HP bar's damage chip, fighter and map-object
 * picking and the digits of the "lost sight N s ago" labels. No three.js.
 */

import { HAZARD_RULES, PICKUP_RULES } from '../core';
import type { PickedObject, WorldState } from '../core';

/** Seconds the damage chip holds before draining. */
export const GHOST_HOLD = 0.4;
/** Chip drain speed, fraction of max HP per second. */
export const GHOST_DRAIN = 1.1;

export type HpGhost = { value: number; hold: number };

/**
 * Damage chip ("ghost" bar): after a hit the lost HP stays visible for a moment, then drains to the
 * new value, so a viewer can read how big the blow was. Heals show at once. Values are fractions
 * of max HP; `dt` in seconds of game time (a paused match keeps the chip).
 */
export function stepGhost(g: HpGhost, hp: number, dt: number): void {
  if (hp >= g.value) {
    g.value = hp;
    g.hold = 0;
    return;
  }
  if (g.hold > 0) {
    g.hold = Math.max(0, g.hold - dt);
    return;
  }
  g.value = Math.max(hp, g.value - GHOST_DRAIN * dt);
}

/** Call when a hit lands: restarts the hold so a combo keeps the whole chip visible. */
export function ghostHit(g: HpGhost): void {
  g.hold = GHOST_HOLD;
}

/**
 * Index of the living fighter under world point (wx, wy), or -1. A click within `slack` px of a
 * body counts (small fighters at low zoom are still clickable); the closest body wins. Corpses are
 * never picked: hovering one shows nothing (dead fighters stay inspectable from the scoreboard, the
 * feed and the end card).
 */
export function pickIndex(xs: Float32Array, ys: Float32Array, rs: Float32Array, alive: Uint8Array, count: number, wx: number, wy: number, slack: number): number {
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < count; i++) {
    if (!alive[i]) continue;
    const d = Math.hypot(xs[i]! - wx, ys[i]! - wy) - rs[i]!;
    if (d > slack) continue;
    if (d < bestScore) {
      bestScore = d;
      best = i;
    }
  }
  return best;
}

/** Pick radius of a power-up pedestal (its octagon), world px. */
export const PEDESTAL_PICK_RADIUS = 26;

/**
 * The map object under world point (wx, wy) for hover cards, or null: shrines, power-up pedestals
 * (whether or not the power-up is there), hazards (spilled acid included, saws where the blade is
 * now) and unbroken props. Within `slack` px of an object's edge counts. Where objects overlap (a
 * pedestal on a spike trap) the smallest one the pointer is inside wins: the one drawn on top.
 * Otherwise the nearest edge within the slack wins. Fighters are picked first, by the caller.
 */
export function pickMapObject(state: Pick<WorldState, 'shrines' | 'pickups' | 'hazards' | 'props'>, wx: number, wy: number, slack: number): PickedObject | null {
  let best: PickedObject | null = null;
  let bestScore = Infinity;
  const consider = (kind: PickedObject['kind'], id: string, x: number, y: number, r: number): void => {
    const d = Math.hypot(x - wx, y - wy);
    if (d > r + slack) return;
    const score = d <= r ? r : 1e6 + d - r;
    if (score < bestScore) {
      bestScore = score;
      best = { kind, id };
    }
  };
  for (const s of state.shrines) consider('shrine', s.id, s.pos.x, s.pos.y, PICKUP_RULES.shrine.radius);
  for (const p of state.pickups) consider('pickup', p.id, p.pos.x, p.pos.y, PEDESTAL_PICK_RADIUS);
  for (const h of state.hazards) consider('hazard', h.id, h.pos.x, h.pos.y, h.radius || HAZARD_RULES[h.kind].radius);
  for (const p of state.props) if (p.alive) consider('prop', p.id, p.pos.x, p.pos.y, p.radius);
  return best;
}

/** Glyph index of the decimal point in `secondsDigits` output (0-9 are the digits). */
export const DOT = 10;

/**
 * Digits of a "lost sight N s ago" count, without building a string every frame: one decimal below
 * 10 s ("2.3"), whole seconds from 10 ("12"), capped at 99. Writes glyph indices (0-9, DOT) into
 * `out` and returns how many.
 */
export function secondsDigits(seconds: number, out: Int8Array): number {
  const s = Math.max(0, seconds);
  if (s < 9.95) {
    const tenths = Math.round(s * 10);
    out[0] = Math.floor(tenths / 10);
    out[1] = DOT;
    out[2] = tenths % 10;
    return 3;
  }
  const whole = Math.min(99, Math.round(s));
  out[0] = Math.floor(whole / 10);
  out[1] = whole % 10;
  return 2;
}
