/**
 * Headless match runner: steps a sim match to the end at full speed and records it.
 *
 * The sim ends every match by itself: by elimination, or by a judges' decision at its hard cap
 * (`matchHardCapTicks`). A stalled sim must still not hang a batch: `SAFETY_MARGIN_TICKS` past that
 * cap the gym stops the match, places it by remaining HP and reports the ending as `capped`.
 */

import { TICK_HZ, matchHardCapTicks } from '../core';
import type { BrainFactory, Match, MatchConfig, MatchResult } from '../core';
import { createBrain } from '../brain';
import { requireValidStrategy } from '../strategy';
import type { MatchRunner } from './batch';
import { MatchRecorder, placementsByStanding } from './recorder';

/** Ticks past the sim's hard cap before the gym stops a match itself (10 s). */
export const SAFETY_MARGIN_TICKS = 10 * TICK_HZ;

/**
 * The production gate (as `gatedBrainFactory`) with the brain's inspector data switched off:
 * the same choices and guard trips, less work per think. Nobody inspects a gym match live.
 */
export const headlessBrainFactory: BrainFactory = (strategy) => createBrain(requireValidStrategy(strategy, 'config'), { inspect: false });

export type SimDeps = {
  createMatch: (config: MatchConfig, brainFactory: BrainFactory) => Match;
  brainFactory: BrainFactory;
  mapName?: (mapId: string) => string;
};

export function createSimRunner(deps: SimDeps): MatchRunner {
  return (config) => {
    const match = deps.createMatch(config, deps.brainFactory);
    const recorder = new MatchRecorder(config, match.state, { mapName: deps.mapName });
    const cap = matchHardCapTicks(config.timeLimitTicks) + SAFETY_MARGIN_TICKS;
    while (!match.isOver && match.state.tick < cap) recorder.observe(match.step(), match.state);
    if (match.isOver) return recorder.finish(match.result());

    const placements = placementsByStanding(match.state.fighters);
    const base = match.result();
    const result: MatchResult = {
      ...base,
      ticks: match.state.tick,
      placements,
      fighters: base.fighters.map((f) => ({ ...f, place: placements.indexOf(f.id) + 1 })),
    };
    return recorder.finish(result, { capped: true });
  };
}
