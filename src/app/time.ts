// Owned by: integrator
/**
 * Watch-screen time: a fixed-step accumulator that turns real frame time into whole simulation
 * ticks (the sim always steps at TICK_HZ, whatever the display refresh), and the director that
 * briefly slows time around kills, dismemberments and parries.
 */

import { TICK_HZ } from '../core';
import type { GameEvent } from '../core';

/** Slowest and fastest playback speed (the UI offers 0.25, 0.5, 1, 2, 4). */
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

/**
 * Longest frame the clock accepts. A hidden tab or a breakpoint can stall rAF for seconds; catching
 * all of that up at once would freeze the page (and skip every moment), so the excess is dropped.
 */
export const MAX_FRAME_SECONDS = 0.25;

/** Fixed-step accumulator: whole ticks per frame, with the leftover fraction as the interpolation alpha. */
export class FixedStep {
  private carry = 0;

  /** Ticks to simulate for a frame of `realDt` seconds at `rate` game seconds per real second. */
  advance(realDt: number, rate: number): number {
    const dt = Math.min(Math.max(realDt, 0), MAX_FRAME_SECONDS);
    this.carry += dt * Math.max(rate, 0) * TICK_HZ;
    // The epsilon keeps 1/60 s frames at 1x from losing a tick to rounding.
    const steps = Math.floor(this.carry + 1e-6);
    this.carry = Math.max(0, this.carry - steps);
    return steps;
  }

  /** Fraction of the way from the previous tick to the current one, 0..1. */
  get alpha(): number {
    return Math.min(this.carry, 1);
  }

  reset(): void {
    this.carry = 0;
  }
}

/** One director reaction: freeze for `stop` s, then run at `scale` for `hold` s, then ease back. */
type Moment = { stop: number; scale: number; hold: number };

/** A kill: a beat of hit-stop, then slow motion while the gore flies. */
export const KILL_MOMENT: Moment = { stop: 0.07, scale: 0.3, hold: 0.35 };
/** The kill that ends the match gets the longest look. */
export const FINAL_MOMENT: Moment = { stop: 0.1, scale: 0.2, hold: 1.1 };
export const DISMEMBER_MOMENT: Moment = { stop: 0, scale: 0.5, hold: 0.2 };
export const PARRY_MOMENT: Moment = { stop: 0.04, scale: 0.65, hold: 0.1 };
/** After the hold, the time scale climbs back to 1 at this rate per real second. */
export const RECOVER_PER_SECOND = 1.4;

/**
 * Slow motion around big moments, in real seconds (so it feels the same at every playback speed).
 * Overlapping moments never stack below the slowest one requested, and never extend past the
 * longest hold, so a multi-kill brawl cannot grind the match to a halt.
 */
export class TimeDirector {
  private stop = 0;
  private scale = 1;
  private hold = 0;

  onEvents(events: readonly GameEvent[]): void {
    for (const e of events) {
      if (e.type === 'kill') this.add(KILL_MOMENT);
      else if (e.type === 'match_end') this.add(FINAL_MOMENT);
      else if (e.type === 'dismember') this.add(DISMEMBER_MOMENT);
      else if (e.type === 'parry') this.add(PARRY_MOMENT);
    }
  }

  /** Advance by a real frame; returns the game-time factor for that frame (0 during hit-stop). */
  update(realDt: number): number {
    const dt = Math.max(0, realDt);
    if (this.stop > 0) {
      this.stop = Math.max(0, this.stop - dt);
      return 0;
    }
    if (this.hold > 0) this.hold = Math.max(0, this.hold - dt);
    else this.scale = Math.min(1, this.scale + dt * RECOVER_PER_SECOND);
    return this.scale;
  }

  reset(): void {
    this.stop = 0;
    this.scale = 1;
    this.hold = 0;
  }

  private add(m: Moment): void {
    this.stop = Math.max(this.stop, m.stop);
    this.scale = Math.min(this.scale, m.scale);
    this.hold = Math.max(this.hold, m.hold);
  }
}
