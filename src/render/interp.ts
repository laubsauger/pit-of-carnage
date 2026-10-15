/**
 * Interpolation between two consecutive sim states. Pure functions, no three.js: the renderer draws
 * at display rate while the sim steps at TICK_HZ, so every visual position is a blend of the two
 * latest ticks. Teleports (shadowstep, respawns) snap instead of sliding across the arena.
 */

import { angleDiff, clamp } from '../core';
import type { FighterState } from '../core';

/** A move longer than this between two ticks is a teleport: snap to the new position. */
export const SNAP_DISTANCE = 40;

/** The previous-tick record of `curr`: same index when the roster order is stable, else found by id. */
export function prevFighter(prev: readonly FighterState[], curr: FighterState, index: number): FighterState {
  const same = prev[index];
  if (same !== undefined && same.id === curr.id) return same;
  for (let i = 0; i < prev.length; i++) {
    const f = prev[i]!;
    if (f.id === curr.id) return f;
  }
  return curr;
}

/** Interpolated scalar coordinate; `snap` tells whether this pair counts as a teleport. */
export function lerpPos(a: number, b: number, alpha: number, snap: boolean): number {
  return snap ? b : a + (b - a) * alpha;
}

/** True when the fighter moved farther than SNAP_DISTANCE between the two ticks. */
export function isTeleport(prev: FighterState, curr: FighterState): boolean {
  const dx = curr.pos.x - prev.pos.x;
  const dy = curr.pos.y - prev.pos.y;
  return dx * dx + dy * dy > SNAP_DISTANCE * SNAP_DISTANCE;
}

/** Shortest-way angle blend, safe across the ±π seam. */
export function lerpAngleShort(a: number, b: number, alpha: number): number {
  return a + angleDiff(a, b) * alpha;
}

/**
 * Ticks into the current animation phase at `alpha` between the two ticks. The sim advances `t`
 * by one per tick, so `curr.t - (1 - alpha)` equals the blend of prev and curr within a phase and
 * starts the new phase at 0 when the phase just changed (no backwards jump).
 */
export function animTicks(curr: FighterState, alpha: number): number {
  const a = curr.anim;
  return clamp(a.t - (1 - alpha), 0, Math.max(a.dur, 0));
}

/** Progress 0..1 through the current animation phase. */
export function animProgress(curr: FighterState, alpha: number): number {
  const dur = curr.anim.dur;
  if (dur <= 0) return 0;
  return clamp(animTicks(curr, alpha) / dur, 0, 1);
}
