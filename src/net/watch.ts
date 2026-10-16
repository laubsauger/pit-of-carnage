// Owned by: net
/**
 * How the arena shows a room's match: the controller draws a `MatchStream` with the normal
 * renderer instead of stepping its own sim (`GameController.watchStream`, documented in
 * src/core/controller.ts). `StreamPlayer` is the implementation.
 */

export type { MatchStream, StreamWatcher } from '../core';
import type { StreamWatcher } from '../core';

/**
 * True when the controller can show streams. Every `GameController` can now (the contract has
 * `watchStream`); kept for callers that hold a plain object.
 */
export function canWatchStreams(controller: object): controller is StreamWatcher {
  return typeof (controller as Partial<StreamWatcher>).watchStream === 'function';
}
