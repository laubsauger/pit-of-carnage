// Owned by: gym
// Placeholder stub from the architect: returns empty results. Replace wholesale.
import type { AggregateReport, GymApi, MatchReport } from '../core';

export function createGymApi(): GymApi {
  return {
    async runBatch(req) {
      return { reports: [], aggregate: { matches: 0, seed: req.seed, mapIds: req.mapIds, strategies: [], findings: [] } };
    },
    async evolve(req) {
      return { champion: req.parent, improved: false, generations: [], summary: 'Evolution is not built yet.' };
    },
    leaderboard: () => [],
    cancel() {},
  };
}

/** Compact plain-text summary for pasting into an LLM, followed by JSON. */
export function reportToText(report: MatchReport | AggregateReport): string {
  return JSON.stringify(report, null, 2);
}
