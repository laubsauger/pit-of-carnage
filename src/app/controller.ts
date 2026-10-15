// Owned by: integrator
/**
 * The real GameController: owns the Watch loop and wires sim + brains + renderer + UI + gym.
 *
 * Per animation frame: the time director gives a slow-motion factor, the fixed-step clock turns
 * real time x speed x slow-mo into whole 60 Hz ticks, the session steps the sim, the events go to
 * the renderer (which forwards them to fx), and the renderer draws prev -> curr at the clock's
 * alpha. React hears about it at about 10 Hz through `subscribe`, never per frame. Sound gets the
 * same event batches and the same time factor; it starts on the page's first pointer or key press
 * (browsers refuse audio before a gesture).
 *
 * The sim only advances while an arena renderer is attached: nobody watches a match without one.
 *
 * A round is framed (round.ts): nothing plays behind the splash; every match opens with "3, 2, 1,
 * FIGHT!" while the sim holds; the final kill gets ultra slow motion, the camera and the WINNER
 * stamp for about 3 s before the end card. The beats reach the renderer and audio as match signals.
 *
 * A room's match (`watchStream`) is drawn from its stream instead of a local sim: same renderer,
 * same audio, the snapshot built from the stream's view, and playback controls do nothing.
 */

import type {
  BackgroundJob, GameController, GameEvent, GameRenderer, LoadingStageId, MapObjectKind, MatchPhase, MatchSignal, RenderInitStage, UiSnapshot, ViewInsets, ViewSettings,
  WorldState,
} from '../core';
import { DEFAULT_MAP_ID, DEFAULT_TIME_LIMIT_TICKS, LOADING_STAGES, NO_VIEW_INSETS, clamp } from '../core';
import { createAudio } from '../audio';
import { createGymApi } from '../gym';
import type { GymService } from '../gym';
import type { MatchStream, StreamWatcher } from '../net/watch';
import { gatedBrainFactory } from '../strategy';
import { copyInto } from './copy';
import { objectInfo } from './objects';
import { FINAL_SECONDS, RoundFlow } from './round';
import { MatchSession, validatedConfig } from './session';
import { browserStorage, createStrategyStore } from './store';
import { FixedStep, MAX_SPEED, MIN_SPEED, TimeDirector } from './time';
import { loadView, sanitizeView, saveView } from './view';

/** UI notifications while the match runs (React re-renders at most this often). */
const NOTIFY_MS = 100;
/** Pointer travel (CSS px) that turns a press on the arena into a pan instead of a click. */
const DRAG_SLOP_PX = 4;
/** Wheel zoom per pixel of scroll: one 100 px notch zooms about 14%. */
const WHEEL_ZOOM_PER_PX = 0.0015;

/** The real controller; it can also show a room's stream (`watchStream`, see src/net/watch.ts). */
export function createController(): GameController & StreamWatcher {
  const listeners = new Set<() => void>();
  const clock = new FixedStep();
  const director = new TimeDirector();
  const round = new RoundFlow();
  const pending: GameEvent[] = [];

  let session: MatchSession | null = null;
  /** Copy of the state before the latest tick (the renderer interpolates prev -> curr). */
  let prev: WorldState | null = null;
  let renderer: GameRenderer | null = null;
  let arenaError: string | null = null;
  let paused = false;
  let speed = 1;
  let selectedId: string | null = null;
  let hoveredId: string | null = null;
  let followId: string | null = null;
  let cameraManual = false;
  let hoveredObject: { kind: MapObjectKind; id: string } | null = null;
  let viewInsets: ViewInsets = { ...NO_VIEW_INSETS };
  /** A room's match shown instead of the local one (null: the local match). */
  let stream: MatchStream | null = null;
  /** The stream's state last drawn (map-object cards read it). */
  let streamState: WorldState | null = null;
  /** The stream's match last drawn, and the end of its final moment (performance.now ms). */
  let streamMatchId = -1;
  let streamFinalUntil = 0;
  let streamAdmiredId = -1;
  /** Gym jobs for the top-bar chip (the gym publishes them through `onJobsChange`). */
  let jobs: BackgroundJob[] = [];
  /** Renderer init stages reached so far (`createRenderer`'s onProgress). */
  const renderStages = new Set<RenderInitStage>();
  const storage = browserStorage();
  let view: ViewSettings = loadView(storage);

  const audio = createAudio();
  audio.setVolume(view.volume);
  // init() must run synchronously inside the gesture, or the browser keeps the AudioContext muted.
  if (typeof window !== 'undefined') {
    const startAudio = () => void audio.init();
    window.addEventListener('pointerdown', startAudio, { once: true, capture: true });
    window.addEventListener('keydown', startAudio, { once: true, capture: true });
  }

  const gym: GymService = createGymApi({
    onJobsChange: () => {
      jobs = gym.jobs();
      notify();
    },
  });

  let snapshot = buildSnapshot();
  let dirty = false;
  let lastNotify = 0;
  let lastFrame = 0;
  let raf = 0;

  function stageDone(id: LoadingStageId): boolean {
    switch (id) {
      case 'bundle':
      case 'audio':
        return true; // this code runs, and the sound module exists (its context starts on "Enter the pit")
      case 'webgpu':
      case 'renderer':
        return renderStages.has('renderer');
      case 'shaders':
        return renderStages.has('shaders');
      case 'match':
        return session !== null || stream !== null;
    }
  }

  function loadingNow() {
    return LOADING_STAGES.map((st) => ({ id: st.id, label: st.label, done: stageDone(st.id) }));
  }

  /** The stream's phase: its own countdown, then live, then our final moment and the end card. */
  function streamPhase(ready: boolean): MatchPhase {
    if (!ready) return 'loading';
    if (!round.entered) return 'splash';
    const v = stream?.view() ?? null;
    if (!v) return 'live';
    if (v.countdown !== null && v.countdown > 0) return 'countdown';
    if (v.finished) return performance.now() < streamFinalUntil ? 'final' : 'ended';
    return 'live';
  }

  function phaseNow(ready: boolean): MatchPhase {
    return stream ? streamPhase(ready) : round.phase(ready, session?.state.finished ?? false);
  }

  function countdownNow(): number | null {
    return stream ? stream.view()?.countdown ?? null : round.countdown();
  }

  function buildSnapshot(): UiSnapshot {
    const loading = loadingNow();
    const phase = phaseNow(loading.every((st) => st.done));
    if (stream) return streamSnapshot(stream, phase, loading);
    const s = session;
    const state = s?.state ?? null;
    return {
      phase,
      countdown: round.countdown(),
      loading,
      jobs,
      tick: state?.tick ?? 0,
      speed,
      paused,
      mapId: s?.config.mapId ?? DEFAULT_MAP_ID,
      format: s?.config.format ?? 'ffa',
      seed: s?.config.seed ?? 0,
      timeLimitTicks: s?.config.timeLimitTicks ?? DEFAULT_TIME_LIMIT_TICKS,
      suddenDeath: state?.suddenDeath.active ?? false,
      maxTick: s?.maxTick ?? 0,
      fighters: (state?.fighters ?? []).map((f) => ({
        id: f.id, name: f.name, color: f.color, hp: f.hp, maxHp: f.maxHp, alive: f.alive, kills: f.kills,
        weapon: f.weapon, skill: f.skill, behaviour: f.behaviour, place: f.place, squad: f.squad,
      })),
      feed: s ? s.feed.slice() : [],
      marks: s ? s.marks.slice() : [],
      selectedId,
      hoveredId,
      hoveredObject,
      followId,
      cameraManual,
      view,
      finished: state?.finished ?? false,
      placements: state ? state.placements.slice() : [],
      ending: state?.ending ?? null,
      source: 'local',
      arenaError,
    };
  }

  /** The HUD for a room's match: what the stream last showed. Playback controls do nothing here. */
  function streamSnapshot(st: MatchStream, phase: MatchPhase, loading: UiSnapshot['loading']): UiSnapshot {
    const v = st.view();
    return {
      phase,
      countdown: v?.countdown ?? null,
      loading,
      jobs,
      tick: v?.tick ?? 0,
      speed: 1,
      paused: false,
      mapId: v?.mapId ?? DEFAULT_MAP_ID,
      format: v?.format ?? 'ffa',
      seed: v?.seed ?? 0,
      timeLimitTicks: v?.timeLimitTicks ?? DEFAULT_TIME_LIMIT_TICKS,
      suddenDeath: v?.suddenDeath ?? false,
      maxTick: v?.tick ?? 0,
      fighters: v ? v.fighters.slice() : [],
      feed: v ? v.feed.slice() : [],
      marks: v ? v.marks.slice() : [],
      selectedId,
      hoveredId,
      hoveredObject,
      followId,
      cameraManual,
      view,
      finished: v?.finished ?? false,
      placements: v ? v.placements.slice() : [],
      ending: v?.finished ? streamState?.ending ?? 'elimination' : null,
      source: 'room',
      arenaError,
    };
  }

  function notify(): void {
    snapshot = buildSnapshot();
    dirty = false;
    lastNotify = performance.now();
    for (const fn of listeners) fn();
  }

  /**
   * One live tick: keep the previous state for interpolation, collect events for the renderer.
   * `directed`: big moments may slow time (not when the player steps tick by tick).
   */
  function stepLive(s: MatchSession, directed: boolean): void {
    prev = copyInto(prev, s.state);
    const events = s.step();
    for (const e of events) {
      pending.push(e);
      // The final-kill moment starts in the frame its kill is delivered (the sim reuses its objects).
      if (e.type === 'kill' && e.final) round.signal({ type: 'final_kill', killerId: e.killerId, victimId: e.victimId, pos: { x: e.pos.x, y: e.pos.y } });
    }
    if (directed) director.onEvents(events);
    // Decided live: the final moment, once per match.
    if (s.over) round.decided();
  }

  function flushEvents(s: MatchSession): void {
    if (renderer && pending.length > 0) {
      renderer.onEvents(pending, s.state);
      audio.onEvents(pending, s.state);
    }
    pending.length = 0;
  }

  /** This frame's match signals, after its events (a signal never reaches a renderer that was not drawing). */
  function sendSignals(signals: readonly MatchSignal[]): void {
    if (!renderer) return;
    for (const sig of signals) {
      renderer.onSignal(sig);
      audio.onSignal(sig);
    }
  }

  /** Beats change what the UI shows (3, 2, 1, FIGHT!, the end card): tell it now, not at the next 10 Hz tick. */
  function notifyBeats(now: number): void {
    // Past loading stays past loading; only while loading do the stages need a fresh look.
    const ready = snapshot.phase !== 'loading' || loadingNow().every((st) => st.done);
    if (phaseNow(ready) !== snapshot.phase || countdownNow() !== snapshot.countdown) notify();
    else if (dirty && now - lastNotify >= NOTIFY_MS) notify();
  }

  function frame(now: number): void {
    raf = requestAnimationFrame(frame);
    const realDt = lastFrame ? (now - lastFrame) / 1000 : 0;
    lastFrame = now;
    if (stream) {
      frameStream(stream, realDt);
      return;
    }
    const s = session;
    if (!s || !renderer || !prev) {
      // Off the Watch screen: a time factor of 0 lets audio suspend instead of murmuring on.
      audio.update(realDt, 0);
      return;
    }

    // The countdown waits out a pause (leaving the Watch screen pauses); the final moment runs in real time.
    round.update(realDt, paused);
    // Slow motion runs on while the match is over (fx finish the last kill) but waits out a pause.
    const slow = director.update(paused ? 0 : realDt);
    // Nothing simulates behind the splash or during the countdown.
    const held = round.holds;
    const steps = paused || held || s.over ? 0 : clock.advance(realDt, speed * slow);
    for (let i = 0; i < steps && !s.over; i++) stepLive(s, true);
    if (steps > 0) {
      flushEvents(s);
      dirty = true;
    }
    sendSignals(round.takeSignals());

    // Behind the splash nothing animates or sounds; during the countdown the arena breathes at speed.
    const scale = !round.entered || paused ? 0 : held ? speed : speed * slow;
    renderer.setTimeScale(scale);
    audio.update(realDt, scale);
    renderer.render(prev, s.state, s.over ? 1 : clock.alpha, realDt);
    if (round.beating) dirty = true;
    notifyBeats(now);
  }

  /** One frame of a room's match: the stream says what to draw; we only route it. */
  function frameStream(st: MatchStream, realDt: number): void {
    const r = renderer;
    if (!r || !round.entered) {
      audio.update(realDt, 0);
      return;
    }
    const now = performance.now();
    const out = st.advance(now);
    if (out) {
      const v = st.view();
      if (out.reset && st.map) {
        r.setMap(st.map);
        r.reset();
        audio.startRound(v?.seed ?? 0);
      }
      if (v && v.matchId !== streamMatchId) {
        // A new match in the room: fighter ids repeat, so the old selection would pick a stranger.
        streamMatchId = v.matchId;
        selectedId = null;
        hoveredId = null;
        followId = null;
        r.setSelected(null);
        r.setHovered(null);
        r.setFollow(null);
      }
      if (out.events.length > 0) {
        r.onEvents(out.events, out.curr);
        audio.onEvents(out.events, out.curr);
      }
      sendSignals(out.signals);
      if (v?.finished && v.matchId !== streamAdmiredId) {
        streamAdmiredId = v.matchId;
        streamFinalUntil = now + FINAL_SECONDS * 1000;
      }
      r.setTimeScale(out.timeScale);
      audio.update(realDt, out.timeScale);
      r.render(out.prev, out.curr, out.alpha, realDt);
      streamState = out.curr;
      dirty = true;
    } else audio.update(realDt, 1);
    notifyBeats(now);
  }

  function ensureLoop(): void {
    if (raf === 0) raf = requestAnimationFrame(frame);
  }

  /** Point a renderer at the current match from scratch (new match, seek back, fresh renderer). */
  function showMatch(r: GameRenderer, s: MatchSession): void {
    r.setMap(s.match.map);
    r.reset();
  }

  /** Jump to `tick`. `fresh`: the renderer drew nothing of this match yet, so repaint from tick 0. */
  function seekTo(tick: number, fresh = false): void {
    const s = session;
    if (!s) return;
    const { events, rebuilt } = fresh ? { events: s.rebuildTo(tick), rebuilt: true } : s.seek(tick);
    prev = copyInto(prev, s.state);
    pending.length = 0;
    clock.reset();
    director.reset();
    // A jump skips the beats it lands past: no countdown, no FIGHT!, no final moment replayed.
    if (!fresh) round.jumped(s.state.finished);
    if (renderer) {
      if (rebuilt) showMatch(renderer, s);
      // Old events only repaint the floor gore; fx and the camera skip their transient effects.
      if (events.length > 0) renderer.onEvents(events, s.state);
      // Audio plays nothing for old events, but takes the wall state from the new tick.
      audio.onEvents(events, s.state);
    }
    notify();
  }

  function attachRenderer(r: GameRenderer, el: HTMLElement): void {
    renderer = r;
    r.resize(el.clientWidth, el.clientHeight);
    r.setView(view);
    r.setSelected(selectedId);
    r.setHovered(hoveredId);
    r.setFollow(followId);
    r.setDecisionProvider((id) => (stream ? null : session?.match.lastDecision(id) ?? null));
    r.setKnowledgeProvider((id) => (stream ? [] : session?.match.knowledge(id) ?? []));
    r.setViewInsets(viewInsets);
    if (stream) stream.requestReset();
    else if (session) seekTo(session.tick, true);
    ensureLoop();
  }

  /** Forget the selection, hover and follow (the fighters on screen are about to be others). */
  function clearFocus(): void {
    selectedId = null;
    hoveredId = null;
    hoveredObject = null;
    followId = null;
    cameraManual = false;
    if (renderer) {
      renderer.setSelected(null);
      renderer.setHovered(null);
      renderer.setFollow(null);
      renderer.resetCamera();
    }
  }

  const controller: GameController & StreamWatcher = {
    getSnapshot: () => snapshot,

    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    enter() {
      // Inside the user's gesture, so the browser lets sound start.
      void audio.init();
      // The loaded match starts its countdown (signals go out with the next frame).
      if (round.enter()) notify();
    },

    skip() {
      if (stream) streamFinalUntil = 0;
      else round.skip();
      notify();
    },

    startMatch(config) {
      const s = new MatchSession(validatedConfig(config), gatedBrainFactory);
      stream = null;
      streamState = null;
      session = s;
      audio.startRound(s.config.seed);
      prev = copyInto(prev, s.state);
      pending.length = 0;
      clock.reset();
      director.reset();
      round.begin();
      clearFocus();
      if (renderer) showMatch(renderer, s);
      ensureLoop();
      notify();
    },

    restart() {
      if (session && !stream) controller.startMatch(session.config);
    },

    setPaused(p) {
      if (paused === p || stream) return;
      paused = p;
      notify();
    },

    stepTicks(n) {
      const s = session;
      if (!s || stream || !round.entered) return;
      // Stepping during the countdown starts the match without the FIGHT! beat.
      if (round.holds) round.jumped(false);
      for (let i = 0; i < n && !s.over; i++) stepLive(s, false);
      flushEvents(s);
      sendSignals(round.takeSignals());
      // Paused on the new tick: show it exactly, not interpolated from the tick before.
      prev = copyInto(prev, s.state);
      clock.reset();
      notify();
    },

    setSpeed(sp) {
      if (stream) return;
      speed = clamp(sp, MIN_SPEED, MAX_SPEED);
      notify();
    },

    seek(tick) {
      if (!stream) seekTo(tick);
    },

    select(id) {
      selectedId = id;
      renderer?.setSelected(id);
      notify();
    },

    hover(id) {
      if (hoveredId === id) return;
      hoveredId = id;
      renderer?.setHovered(id);
      notify();
    },

    follow(id) {
      followId = id;
      renderer?.setFollow(id);
      notify();
    },

    resetCamera() {
      cameraManual = false;
      followId = null;
      renderer?.resetCamera();
      renderer?.setFollow(null);
      notify();
    },

    getView: () => view,

    setView(v) {
      const before = view.volume;
      view = sanitizeView({ ...view, ...v });
      saveView(storage, view);
      renderer?.setView(view);
      if (view.volume !== before) audio.setVolume(view.volume);
      notify();
    },

    decision: (id) => (stream ? null : session?.match.lastDecision(id) ?? null),

    knowledge: (id) => (stream ? [] : session?.match.knowledge(id) ?? []),

    fighter: (id) => (stream ? stream.fighter(id) : session?.state.fighters.find((f) => f.id === id) ?? null),

    objectInfo(kind, id) {
      const state = stream ? streamState : session?.state ?? null;
      return state ? objectInfo(state, kind, id) : null;
    },

    watchStream(next) {
      if (stream === next) return;
      stream = next;
      streamState = null;
      streamMatchId = -1;
      streamFinalUntil = 0;
      pending.length = 0;
      clock.reset();
      director.reset();
      clearFocus();
      if (next) next.requestReset();
      else if (session && renderer) {
        // Back to the local match: repaint it as it was.
        audio.startRound(session.config.seed);
        seekTo(session.tick, true);
      }
      ensureLoop();
      notify();
    },

    setViewInsets(insets) {
      viewInsets = { left: Math.max(0, insets.left), right: Math.max(0, insets.right), top: Math.max(0, insets.top), bottom: Math.max(0, insets.bottom) };
      renderer?.setViewInsets(viewInsets);
    },

    lastReport: () => (!stream && session?.state.finished ? session.report : null),

    mountCanvas(el) {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
      el.appendChild(canvas);
      let mine: GameRenderer | null = null;
      let gone = false;

      const pick = (e: MouseEvent) => (mine ? mine.pick(e.clientX, e.clientY) : null);
      const takeCamera = () => {
        if (cameraManual) return;
        cameraManual = true;
        notify();
      };
      // A press that travels pans the view; only a press that stays put is a click (select).
      let drag: { id: number; x: number; y: number; moved: boolean } | null = null;
      let dragged = false;
      const onDown = (e: PointerEvent) => {
        dragged = false;
        if (e.button === 0) drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      };
      const onMove = (e: PointerEvent) => {
        if (drag && drag.id === e.pointerId && (e.buttons & 1) !== 0) {
          const dx = e.clientX - drag.x;
          const dy = e.clientY - drag.y;
          if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
          if (!drag.moved) {
            drag.moved = true;
            canvas.setPointerCapture(e.pointerId);
          }
          drag.x = e.clientX;
          drag.y = e.clientY;
          if (mine) {
            mine.panBy(dx, dy);
            takeCamera();
          }
          return;
        }
        const hit = mine ? mine.pickObject(e.clientX, e.clientY) : null;
        controller.hover(hit?.kind === 'fighter' ? hit.id : null);
        const obj = hit && hit.kind !== 'fighter' ? { kind: hit.kind, id: hit.id } : null;
        if (obj?.kind !== hoveredObject?.kind || obj?.id !== hoveredObject?.id) {
          hoveredObject = obj;
          notify();
        }
      };
      const onUp = (e: PointerEvent) => {
        if (drag?.id !== e.pointerId) return;
        dragged = drag.moved;
        drag = null;
      };
      const onLeave = () => {
        controller.hover(null);
        if (hoveredObject) {
          hoveredObject = null;
          notify();
        }
      };
      const onClick = (e: MouseEvent) => {
        if (dragged) dragged = false;
        else controller.select(pick(e));
      };
      const onDouble = (e: MouseEvent) => controller.follow(pick(e));
      const onWheel = (e: WheelEvent) => {
        if (!mine) return;
        e.preventDefault(); // the arena zooms; the page never scrolls under it
        const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        mine.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * px * WHEEL_ZOOM_PER_PX));
        takeCamera();
      };
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointercancel', onUp);
      canvas.addEventListener('pointerleave', onLeave);
      canvas.addEventListener('click', onClick);
      canvas.addEventListener('dblclick', onDouble);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      const resize = new ResizeObserver(() => mine?.resize(el.clientWidth, el.clientHeight));
      resize.observe(el);

      const onProgress = (stage: RenderInitStage) => {
        if (gone || renderStages.has(stage)) return;
        renderStages.add(stage);
        notify();
      };
      // three.js and the renderer load as their own chunk: the splash paints and the gym works before they arrive.
      Promise.all([import('../render'), import('../render/fx')])
        .then(([render, fx]) => render.createRenderer(canvas, fx.createFx(), { onProgress }))
        .then(
        (r) => {
          if (gone) {
            r.dispose();
            return;
          }
          mine = r;
          arenaError = null;
          attachRenderer(r, el);
        },
        (err: unknown) => {
          if (gone) return;
          console.error('The arena renderer failed to start.', err);
          arenaError = err instanceof Error ? err.message : String(err);
          notify();
        },
      );

      return () => {
        gone = true;
        resize.disconnect();
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
        canvas.removeEventListener('pointerleave', onLeave);
        canvas.removeEventListener('click', onClick);
        canvas.removeEventListener('dblclick', onDouble);
        canvas.removeEventListener('wheel', onWheel);
        if (mine && renderer === mine) renderer = null;
        mine?.dispose();
        mine = null;
        canvas.remove();
      };
    },

    strategies: createStrategyStore(storage),
    gym,
  };

  return controller;
}
