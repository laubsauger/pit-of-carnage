// Owned by: audio
/**
 * Sound for the Watch screen: procedural WebAudio, no asset files (see the AudioModule contract in
 * core/audio-api.ts).
 *
 * - `init()` from the first user gesture creates the AudioContext, renders the noise textures and
 *   starts the ambience (crowd murmur, torches); the crowd babble renders offline in the background.
 * - `onEvents` maps live sim events to cues (cues.ts) and plays them through the mixer (engine.ts):
 *   voice limits per group, throttling, ducking, a limiter and a soft clipper, so 16 fighters never clip.
 * - `update(dt, timeScale)` bends pitch and tempo with slow motion and suspends the context when the
 *   game stays paused (timeScale 0 longer than a hit-stop), so sound pauses with the game. A hidden
 *   page suspends it too: rAF stops there, and the crowd should not murmur on in a background tab.
 */

import { DEFAULT_VIEW_SETTINGS } from '../core';
import type { AudioModule, GameEvent, WorldState } from '../core';
import { createCueMemory, cuesForEvent, excitementBump, finalKillIndex, isLive } from './cues';
import type { Cue } from './cues';
import { AudioEngine } from './engine';
import { PauseDetector, approach, pitchForTimeScale } from './mix';
import { renderBabble } from './synth';

/** Seconds (time constant) for pitch to follow the time scale. */
const RATE_TAU = 0.07;

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const g = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

export function createAudio(): AudioModule {
  let ctx: AudioContext | null = null;
  let engine: AudioEngine | null = null;
  let starting: Promise<void> | null = null;
  let disposed = false;
  let volume = DEFAULT_VIEW_SETTINGS.volume;
  let rate = 1;
  const pause = new PauseDetector();
  let pageHidden = false;
  /** This module suspended the context (pause or hidden page), so it may resume it. */
  let suspended = false;
  const memory = createCueMemory();
  const cues: Cue[] = [];

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

  function start(): Promise<void> {
    const Ctor = audioContextCtor();
    if (!Ctor) return Promise.resolve();
    // Everything up to resume() runs synchronously inside the user gesture.
    const c = new Ctor({ latencyHint: 'interactive' });
    ctx = c;
    const e = new AudioEngine(c);
    engine = e;
    e.setVolume(volume);
    e.startAmbience();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    const resumed = c.resume().catch(() => undefined);
    renderBabble(c.sampleRate).then(
      (buf) => {
        if (!disposed && engine === e) e.setBabble(buf);
      },
      // Without OfflineAudioContext the murmur keeps its noise bed: still a crowd, just vaguer.
      () => undefined,
    );
    return resumed;
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

    onEvents(events: GameEvent[], state: WorldState) {
      const e = engine;
      if (!e || !ctx || ctx.state !== 'running') return;
      const finalIdx = finalKillIndex(events);
      for (let i = 0; i < events.length; i++) {
        const ev = events[i]!;
        cues.length = 0;
        cuesForEvent(ev, state, memory, i === finalIdx, cues);
        for (const cue of cues) e.play(cue);
        if (isLive(ev, state)) e.excite(excitementBump(ev));
      }
      const zone = state.suddenDeath;
      e.setWallMoving(zone.active && zone.closedAtTick < 0 && !state.finished);
    },

    update(dt: number, timeScale: number) {
      const e = engine;
      const c = ctx;
      if (!e || !c || c.state === 'closed') return;
      const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
      // Hit-stops are short; a longer stretch of 0 is the pause button (or the Watch screen gone).
      pause.update(step, timeScale);
      if (timeScale > 0) {
        rate = approach(rate, pitchForTimeScale(timeScale), step, RATE_TAU);
        e.setRate(rate, timeScale);
      }
      syncRunning();
      e.tick(step);
    },

    setVolume(v: number) {
      volume = Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
      engine?.setVolume(volume);
    },

    dispose() {
      disposed = true;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      engine?.stopAll();
      engine = null;
      const c = ctx;
      ctx = null;
      if (c && c.state !== 'closed') void c.close().catch(() => undefined);
    },
  };
}
