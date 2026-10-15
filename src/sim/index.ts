/**
 * Deterministic, headless simulation. Same MatchConfig + seed + brains = same match, tick for tick.
 *
 * - `createMatch(config, brainFactory)` builds a match; call `step()` once per tick (TICK_HZ).
 * - `stateHash(state)` fingerprints a state for replay checks.
 * - `MAPS` holds every map; `arenaBounds` gives the sudden-death playable rectangle for rendering.
 * - `killLine(event, state)` turns a kill event into a broadcast feed line; `announcements(events,
 *   state)` gives the lines for sudden death, escalation, the judges, power-ups coming back and
 *   shrine heals.
 */

export { createMatch, stateHash } from './match';
export { MAPS, MAP_IDS } from './maps';
export { arenaBounds } from './geometry';
export { announcements, killLine } from './copy';
