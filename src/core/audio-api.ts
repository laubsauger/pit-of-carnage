/**
 * Contract between the app loop and the sound module (`src/audio`). Type-only: the sim and the gym
 * worker never load audio.
 *
 * - Browsers refuse to start audio before a user gesture. The app calls `init()` from its first
 *   pointer or key event; until then every other call is a cheap no-op (nothing queued).
 * - Sounds are driven by the same event batches the renderer gets (`onEvents`). Events more than
 *   `LIVE_EVENT_TICKS` older than the state they arrive with are catch-up from a seek: play nothing
 *   for them.
 * - Game time: `update(dt, timeScale)` gets real seconds since the last frame and the app loop's
 *   combined time factor (speed x slow motion, 0 while paused), so sounds can pitch down in slow
 *   motion and pause with the game.
 * - Volume comes from `ViewSettings.volume`; the controller calls `setVolume` whenever it changes.
 * - Cosmetic only: audio may use Math.random and never feeds anything back into the sim.
 */

import type { GameEvent, WorldState } from './types';

export interface AudioModule {
  /** Create or resume the AudioContext. Call from a user gesture; safe to call again. */
  init(): Promise<void>;
  onEvents(events: GameEvent[], state: WorldState): void;
  /** `dt` = real seconds since the last frame; `timeScale` = game-time factor (0 = paused). */
  update(dt: number, timeScale: number): void;
  /** Master volume 0..1 (0 = silent). */
  setVolume(v: number): void;
  /** Stop every sound and release the AudioContext. */
  dispose(): void;
}
