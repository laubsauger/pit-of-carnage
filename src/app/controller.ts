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
 */

import type { GameController, GameEvent, GameRenderer, UiSnapshot, ViewSettings, WorldState } from '../core';
import { DEFAULT_MAP_ID, DEFAULT_TIME_LIMIT_TICKS, clamp } from '../core';
import { createAudio } from '../audio';
import { createGymApi } from '../gym';
import { createRenderer } from '../render';
import { createFx } from '../render/fx';
import { gatedBrainFactory } from '../strategy';
import { copyInto } from './copy';
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

export function createController(): GameController {
  const listeners = new Set<() => void>();
  const clock = new FixedStep();
  const director = new TimeDirector();
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

  let snapshot = buildSnapshot();
  let dirty = false;
  let lastNotify = 0;
  let lastFrame = 0;
  let raf = 0;

  function buildSnapshot(): UiSnapshot {
    const s = session;
    const state = s?.state ?? null;
    return {
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
      followId,
      cameraManual,
      view,
      finished: state?.finished ?? false,
      placements: state ? state.placements.slice() : [],
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
    for (const e of events) pending.push(e);
    if (directed) director.onEvents(events);
  }

  function flushEvents(s: MatchSession): void {
    if (renderer && pending.length > 0) {
      renderer.onEvents(pending, s.state);
      audio.onEvents(pending, s.state);
    }
    pending.length = 0;
  }

  function frame(now: number): void {
    raf = requestAnimationFrame(frame);
    const realDt = lastFrame ? (now - lastFrame) / 1000 : 0;
    lastFrame = now;
    const s = session;
    if (!s || !renderer || !prev) {
      // Off the Watch screen: a time factor of 0 lets audio suspend instead of murmuring on.
      audio.update(realDt, 0);
      return;
    }

    // Slow motion runs on while the match is over (fx finish the last kill) but waits out a pause.
    const slow = director.update(paused ? 0 : realDt);
    const steps = paused || s.over ? 0 : clock.advance(realDt, speed * slow);
    for (let i = 0; i < steps && !s.over; i++) stepLive(s, true);
    if (steps > 0) {
      flushEvents(s);
      dirty = true;
      if (s.over) notify();
    }

    renderer.setTimeScale(paused ? 0 : speed * slow);
    audio.update(realDt, paused ? 0 : speed * slow);
    renderer.render(prev, s.state, s.over ? 1 : clock.alpha, realDt);
    if (dirty && now - lastNotify >= NOTIFY_MS) notify();
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
    r.setDecisionProvider((id) => session?.match.lastDecision(id) ?? null);
    r.setKnowledgeProvider((id) => session?.match.knowledge(id) ?? []);
    if (session) seekTo(session.tick, true);
    ensureLoop();
  }

  const controller: GameController = {
    getSnapshot: () => snapshot,

    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    startMatch(config) {
      const s = new MatchSession(validatedConfig(config), gatedBrainFactory);
      session = s;
      prev = copyInto(prev, s.state);
      pending.length = 0;
      clock.reset();
      director.reset();
      selectedId = null;
      hoveredId = null;
      followId = null;
      cameraManual = false;
      if (renderer) {
        renderer.setSelected(null);
        renderer.setHovered(null);
        renderer.setFollow(null);
        renderer.resetCamera();
        showMatch(renderer, s);
      }
      ensureLoop();
      notify();
    },

    restart() {
      if (session) controller.startMatch(session.config);
    },

    setPaused(p) {
      if (paused === p) return;
      paused = p;
      notify();
    },

    stepTicks(n) {
      const s = session;
      if (!s) return;
      for (let i = 0; i < n && !s.over; i++) stepLive(s, false);
      flushEvents(s);
      // Paused on the new tick: show it exactly, not interpolated from the tick before.
      prev = copyInto(prev, s.state);
      clock.reset();
      notify();
    },

    setSpeed(sp) {
      speed = clamp(sp, MIN_SPEED, MAX_SPEED);
      notify();
    },

    seek(tick) {
      seekTo(tick);
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

    decision: (id) => session?.match.lastDecision(id) ?? null,

    knowledge: (id) => session?.match.knowledge(id) ?? [],

    fighter: (id) => session?.state.fighters.find((f) => f.id === id) ?? null,

    lastReport: () => (session?.state.finished ? session.report : null),

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
        controller.hover(pick(e));
      };
      const onUp = (e: PointerEvent) => {
        if (drag?.id !== e.pointerId) return;
        dragged = drag.moved;
        drag = null;
      };
      const onLeave = () => controller.hover(null);
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

      createRenderer(canvas, createFx()).then(
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
    gym: createGymApi(),
  };

  return controller;
}
