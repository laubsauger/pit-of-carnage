// Owned by: net
/**
 * How the arena shows a room's match: the controller draws a `MatchStream` with the normal
 * renderer instead of stepping its own sim. `StreamPlayer` is the implementation.
 *
 * Contract requested from the integrator (src/app, src/core): `GameController.watchStream(stream:
 * MatchStream | null)`. While a stream is watched the controller, per animation frame, calls
 * `advance(performance.now())`; when it returns output: on `reset` it calls `renderer.setMap(map)`
 * and `renderer.reset()`, then `onEvents(events, curr)` for renderer and audio, `onSignal` for
 * each signal, `setTimeScale(timeScale)`, `audio.update(dt, timeScale)` and `render(prev, curr,
 * alpha, dt)`. The UI snapshot comes from `view()`. On attach (and when a renderer is created
 * while watching) it calls `requestReset()`. `null` returns to local matches; so does `startMatch`.
 */

import type { FighterState, MapDef } from '../core';
import type { StreamOutput, StreamView } from './player';

export interface MatchStream {
  /** Map of the streamed match (our own copy, checked against the host's fingerprint). */
  readonly map: MapDef | null;
  /** What to draw at `nowMs` (monotonic ms), or null before the first frame. Takes the due events. */
  advance(nowMs: number): StreamOutput | null;
  /** The arena (re)attached: the next `advance` resets it and repaints the match so far. */
  requestReset(): void;
  /** HUD data for the match as last shown, or null before the first frame. */
  view(): StreamView | null;
  /** Live state of one fighter as last shown (the inspector). */
  fighter(id: string): FighterState | null;
}

export type StreamWatcher = { watchStream(stream: MatchStream | null): void };

/** True once the controller can show streams (the integrator's part of the rooms prototype). */
export function canWatchStreams(controller: object): controller is StreamWatcher {
  return typeof (controller as Partial<StreamWatcher>).watchStream === 'function';
}
