/**
 * Hazard telegraphs. Pure functions, no three.js.
 */

import type { HazardState } from '../core';

/** Fraction of the spike cycle before the thrust during which the holes glow (the warning). */
export const SPIKE_WARNING = 0.3;

/**
 * Where a spike trap is in its cycle, 0..1. `HazardState.phase` is read as the cycle fraction
 * (0..1); values above 1 are treated as ticks into a cycle of `period` ticks.
 */
export function spikeCycle(h: Pick<HazardState, 'phase' | 'period'>, defaultPeriod: number): number {
  const p = h.phase;
  if (p >= 0 && p <= 1) return p;
  const period = h.period ?? defaultPeriod;
  return (((p % period) + period) % period) / period;
}

/**
 * Warning glow 0..1: rises over the last SPIKE_WARNING of the cycle before `triggerAt`, so a viewer
 * (and a fighter's owner) can see the thrust coming; 0 after the thrust until the next warning.
 */
export function spikeWarning(cycle: number, triggerAt: number): number {
  const start = triggerAt - SPIKE_WARNING;
  if (cycle < start || cycle > triggerAt) return 0;
  return (cycle - start) / SPIKE_WARNING;
}
