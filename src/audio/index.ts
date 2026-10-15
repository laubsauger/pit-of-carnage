// Owned by: audio
/**
 * Sound for the Watch screen: procedural WebAudio, no asset files (see the AudioModule contract in
 * core/audio-api.ts).
 *
 * - `init()` from the first user gesture creates the AudioContext, renders the noise textures and
 *   starts the ambience (crowd bed, torches); the round's crowd babble renders offline in the
 *   background.
 * - `startRound(seed)` gives every round its own crowd (crowd.ts: density, pitch, pace, brightness,
 *   rowdiness, chant) and re-renders the babble from the seed; the old crowd fades into the new.
 * - `onEvents` maps live sim events to cues (cues.ts) and plays them through the mixer (engine.ts):
 *   voice limits per group, throttling, ducking, a compressor, a limiter and a soft clipper, so 16
 *   fighters never clip. The crowd director reads the same events and state: the bed swells with
 *   the action and falls nearly silent in lulls, with sparse gasps, whistles, boos and chants.
 * - `onSignal` plays the countdown, FIGHT and the final-kill sting (unbent by slow motion). The
 *   final sting plays once whether the kill event or the signal arrives first.
 * - `update(dt, timeScale)` bends pitch and tempo with slow motion and suspends the context when the
 *   game stays paused (timeScale 0 longer than a hit-stop), so sound pauses with the game. A hidden
 *   page suspends it too: rAF stops there, and the crowd should not murmur on in a background tab.
 */

import { DEFAULT_VIEW_SETTINGS } from '../core';
import type { AudioModule, GameEvent, MatchSignal, WorldState } from '../core';
import { SoundDriver } from './driver';
import { AudioEngine } from './engine';
import { PauseDetector } from './mix';

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const g = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/** Seconds a match signal keeps sound running, even if the game's time factor reads as paused. */
const SIGNAL_HOLD = 1.5;

export function createAudio(): AudioModule {
  let ctx: AudioContext | null = null;
  let driver: SoundDriver | null = null;
  let starting: Promise<void> | null = null;
  let disposed = false;
  let volume = DEFAULT_VIEW_SETTINGS.volume;
  const pause = new PauseDetector();
  let pageHidden = false;
  /** This module suspended the context (pause or hidden page), so it may resume it. */
  let suspended = false;
  /** The round's seed; kept from `startRound` even before sound starts. */
  let seed = 0;

  /** Keep the context running exactly while the game runs on a visible page. */
  function syncRunning(): void {
    const c = ctx;
    if (!c || c.state === 'closed') return;
    const want = !pause.paused && !pageHidden;
    if (want && suspended) {
      suspended = false;
      void c.resume().catch(() => undefined);
    } else if (!want && !suspended && c.state === 'running') {
      suspended = true;
      void c.suspend().catch(() => undefined);
    }
  }

  function onVisibility(): void {
    pageHidden = document.visibilityState === 'hidden';
    syncRunning();
  }

  /** The driver while sound is running (nothing plays into a suspended or closed context). */
  function live(): SoundDriver | null {
    return driver && ctx && ctx.state === 'running' ? driver : null;
  }

  function start(): Promise<void> {
    const Ctor = audioContextCtor();
    if (!Ctor) return Promise.resolve();
    // Everything up to resume() runs synchronously inside the user gesture.
    const c = new Ctor({ latencyHint: 'interactive' });
    ctx = c;
    const e = new AudioEngine(c);
    e.setVolume(volume);
    driver = new SoundDriver(e, seed);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    return c.resume().catch(() => undefined);
  }

  return {
    init() {
      if (disposed) return Promise.resolve();
      if (!starting) {
        starting = start();
        return starting;
      }
      // A context created without a real gesture stays suspended until the next one.
      if (ctx && ctx.state === 'suspended' && !suspended) return ctx.resume().catch(() => undefined);
      return starting;
    },

    startRound(roundSeed: number) {
      if (disposed) return;
      seed = Number.isFinite(roundSeed) ? roundSeed >>> 0 : 0;
      driver?.startRound(seed);
    },

    onSignal(signal: MatchSignal) {
      const d = driver;
      const c = ctx;
      if (!d || !c || c.state === 'closed' || pageHidden) return;
      // The countdown runs while the sim holds (time factor 0 may read as a pause): keep sound up
      // through the beat. A suspended context resumes before the cue's start time.
      pause.hold(SIGNAL_HOLD);
      syncRunning();
      d.onSignal(signal);
    },

    onEvents(events: GameEvent[], state: WorldState) {
      live()?.onEvents(events, state);
    },

    update(dt: number, timeScale: number) {
      const d = driver;
      const c = ctx;
      if (!d || !c || c.state === 'closed') return;
      const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
      // Hit-stops are short; a longer stretch of 0 is the pause button (or the Watch screen gone).
      pause.update(step, timeScale);
      d.frame(step, timeScale);
      syncRunning();
    },

    setVolume(v: number) {
      volume = Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
      driver?.engine.setVolume(volume);
    },

    dispose() {
      disposed = true;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      driver?.stop();
      driver = null;
      const c = ctx;
      ctx = null;
      if (c && c.state !== 'closed') void c.close().catch(() => undefined);
    },
  };
}
