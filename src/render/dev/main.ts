/**
 * Render harness (dev only): drives the renderer and fx with a fake animated world.
 * Open /render-dev.html on the Vite dev server.
 *
 * Keys: 1-4 map, C cones (off/selected/all), F fog, H hearing ripples, N names, B HP bars,
 * R steering ring, X shake (kills/off), click select, L follow selected, Space pause, S slow motion,
 * K kill someone, E explode a keg, D sudden death (Shift+D: start with the wall far in), +/- fighters,
 * I fake inspector panel (view insets), P playback speed 1x/2x/4x, A spill acid, U dunk fighters
 * in the acid, Y shrine heal, T countdown (3, 2, 1, FIGHT), W final kill (everyone but one dies).
 */

import { DEFAULT_VIEW_SETTINGS, NO_VIEW_INSETS, TICK_DT } from '../../core';
import type { GameEvent, GameRenderer, PickedObject, ViewInsets, ViewSettings } from '../../core';
import { MAPS } from '../../sim';
import { createRenderer } from '../index';
import { FakeWorld } from './fakeWorld';

const host = document.getElementById('arena')!;
const hud = document.getElementById('hud')!;
const canvas = document.createElement('canvas');
canvas.style.cssText = 'display:block;width:100%;height:100%';
host.appendChild(canvas);

const mapIds = Object.keys(MAPS);
let mapIndex = 0;
let count = 12;
let world = new FakeWorld(MAPS[mapIds[mapIndex]!]!, count);
let paused = false;
let slow = false;
let selected: string | null = null;
let follow = false;
const overlay: ViewSettings = { ...DEFAULT_VIEW_SETTINGS };
/** Kill slow-motion and hit-stop, like the app's time director. */
let slowmoLeft = 0;
let hitStopLeft = 0;
/** Playback speed (the app's 1x-4x presets). */
let speed = 1;
/** A fake inspector panel (and top bar and timeline) covering the canvas edges. */
const PANEL_INSETS: ViewInsets = { left: 0, right: 420, top: 48, bottom: 96 };
let insets: ViewInsets = { ...NO_VIEW_INSETS };
let hoveredObject: PickedObject | null = null;
const panel = document.createElement('div');
panel.style.cssText =
  'position:fixed;top:0;right:0;bottom:0;pointer-events:none;display:none;background:rgba(22,20,18,0.86);border-left:1px solid #3a352f;' +
  'font:500 12px/1.5 Inter,system-ui,sans-serif;color:#a39a8e;padding:60px 16px;box-sizing:border-box';
panel.textContent = 'Inspector (fake panel: view insets)';
document.body.appendChild(panel);

/**
 * rAF never fires in hidden tabs (automation tabs report hidden) and timers there are throttled to
 * once a second, so a hidden harness pumps frames from a MessageChannel at about 60 Hz instead.
 */
const pump = new MessageChannel();
let pumped: ((now: number) => void) | null = null;
let lastPump = 0;
pump.port1.onmessage = () => {
  const fn = pumped;
  if (!fn) return;
  const now = performance.now();
  if (now - lastPump < 16) {
    pump.port2.postMessage(0);
    return;
  }
  lastPump = now;
  pumped = null;
  fn(now);
};
function schedule(fn: (now: number) => void): void {
  if (!document.hidden) {
    requestAnimationFrame(fn);
    return;
  }
  pumped = fn;
  pump.port2.postMessage(0);
}

function fail(message: string): void {
  hud.textContent = message;
  hud.classList.add('error');
}

async function main(): Promise<void> {
  if (!('gpu' in navigator)) {
    fail('WebGPU required: this browser has no navigator.gpu. Use a current Chrome, Edge or Safari.');
    return;
  }
  let renderer: GameRenderer;
  try {
    renderer = await createRenderer(canvas);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
    return;
  }
  const resize = () => renderer.resize(host.clientWidth, host.clientHeight);
  new ResizeObserver(resize).observe(host);
  resize();
  renderer.setMap(world.map);
  renderer.setView(overlay);
  renderer.setDecisionProvider((id) => world.decision(id));
  renderer.setKnowledgeProvider((id) => world.knowledge(id));

  const forward = (events: GameEvent[]) => {
    if (events.length === 0) return;
    let final: Extract<GameEvent, { type: 'kill' }> | null = null;
    for (const e of events) {
      if (e.type === 'kill') slowmoLeft = 0.9;
      if (e.type === 'kill' && e.final) final = e;
      if (e.type === 'hit' && (e.crit || e.amount >= 28)) hitStopLeft = Math.max(hitStopLeft, 0.07);
    }
    renderer.onEvents(events, world.state);
    // Like the controller: the final kill's signal arrives in the frame its kill event is delivered.
    if (final) {
      slowmoLeft = 2.5;
      renderer.onSignal({ type: 'final_kill', killerId: final.killerId, victimId: final.victimId, pos: { ...final.pos } });
    }
  };

  const setInsets = (next: ViewInsets) => {
    insets = { ...next };
    renderer.setViewInsets(insets);
    panel.style.display = insets.right > 0 ? 'block' : 'none';
    panel.style.width = `${insets.right}px`;
  };

  /** 3, 2, 1, FIGHT on real time, about 2.5 s like the app's countdown. */
  const countdown = () => {
    [3, 2, 1].forEach((value, k) => setTimeout(() => renderer.onSignal({ type: 'countdown', value }), k * 700));
    setTimeout(() => renderer.onSignal({ type: 'fight' }), 2100);
  };

  const reload = () => {
    world = new FakeWorld(MAPS[mapIds[mapIndex]!]!, count);
    renderer.reset();
    renderer.setMap(world.map);
    selected = null;
    renderer.setSelected(null);
    renderer.setFollow(null);
  };

  canvas.addEventListener('pointermove', (e) => {
    const hit = renderer.pickObject(e.clientX, e.clientY);
    renderer.setHovered(hit?.kind === 'fighter' ? hit.id : null);
    hoveredObject = hit;
  });
  canvas.addEventListener('click', (e) => {
    selected = renderer.pick(e.clientX, e.clientY);
    renderer.setSelected(selected);
    renderer.setFollow(follow ? selected : null);
  });
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k >= '1' && k <= '4') {
      mapIndex = Math.min(mapIds.length - 1, Number(k) - 1);
      reload();
    } else if (k === 'c') {
      overlay.cones = overlay.cones === 'off' ? 'selected' : overlay.cones === 'selected' ? 'all' : 'off';
    } else if (k === 'f') overlay.fog = !overlay.fog;
    else if (k === 'h') overlay.hearing = !overlay.hearing;
    else if (k === 'n') overlay.nameTags = !overlay.nameTags;
    else if (k === 'b') overlay.hpBars = !overlay.hpBars;
    else if (k === 'x') overlay.shake = overlay.shake === 'kills' ? 'off' : 'kills';
    else if (k === 'r') overlay.rings = !overlay.rings;
    else if (k === 'l') {
      follow = !follow;
      renderer.setFollow(follow ? selected : null);
    } else if (k === ' ') {
      paused = !paused;
      e.preventDefault();
    } else if (k === 's') slow = !slow;
    else if (k === 'k') forward(world.killRandom());
    else if (k === 'e') forward(world.explodeKeg());
    else if (k === 'd') forward(world.toggleSuddenDeath(e.shiftKey));
    else if (k === '+' || k === '=') {
      count = Math.min(16, count + 2);
      reload();
    } else if (k === '-') {
      count = Math.max(2, count - 2);
      reload();
    } else if (k === 'i') setInsets(insets.right > 0 ? NO_VIEW_INSETS : PANEL_INSETS);
    else if (k === 'p') speed = speed === 1 ? 2 : speed === 2 ? 4 : 1;
    else if (k === 'a') forward(world.spillAcid());
    else if (k === 'u') world.dunk(3);
    else if (k === 'y') forward(world.shrineHeal());
    else if (k === 't') countdown();
    else if (k === 'w') {
      const living = world.state.fighters.filter((f) => f.alive);
      for (let n = 0; n < living.length - 1; n++) forward(world.killRandom());
    }
    renderer.setView(overlay);
  });

  // Debug handle for automated checks (dev harness only).
  (window as unknown as { pit: unknown }).pit = {
    select(id: string | null) {
      selected = id;
      renderer.setSelected(id);
      renderer.setFollow(follow ? id : null);
    },
    follow(on: boolean) {
      follow = on;
      renderer.setFollow(on ? selected : null);
    },
    overlay(o: Partial<ViewSettings>) {
      Object.assign(overlay, o);
      renderer.setView(overlay);
    },
    pause(p: boolean) {
      paused = p;
    },
    kill: () => forward(world.killRandom()),
    keg: () => forward(world.explodeKeg()),
    suddenDeath: (fast = false) => forward(world.toggleSuddenDeath(fast)),
    insets: (next: Partial<ViewInsets> | null) => setInsets(next ? { ...NO_VIEW_INSETS, ...next } : NO_VIEW_INSETS),
    speed: (s: number) => {
      speed = s;
    },
    acid: () => forward(world.spillAcid()),
    dunk: (n = 3) => world.dunk(n),
    heal: () => forward(world.shrineHeal()),
    countdown,
    pickObject: (x: number, y: number) => renderer.pickObject(x, y),
    /** Wheel-style zoom toward a client point (factor > 1 zooms in); `reset` gives the camera back. */
    zoomAt: (x: number, y: number, factor: number) => renderer.zoomAt(x, y, factor),
    resetCamera: () => renderer.resetCamera(),
    signal: (sig: Parameters<GameRenderer['onSignal']>[0]) => renderer.onSignal(sig),
    /** Run the fake world for `ticks` without drawing (e.g. to let the wall close). */
    advance(ticks: number) {
      for (let i = 0; i < ticks; i++) forward(world.step());
    },
    map(i: number) {
      mapIndex = i;
      reload();
    },
    world: () => world,
    /** CPU cost of `frames` sim steps + renders (ms per frame). GPU work is asynchronous and not included. */
    bench(frames: number, fighters = 16) {
      count = fighters;
      reload();
      for (let i = 0; i < 120; i++) world.step();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        forward(world.step());
        renderer.render(world.prev, world.state, 0.5, 1 / 60);
      }
      const total = performance.now() - t0;
      const t1 = performance.now();
      for (let i = 0; i < frames; i++) world.step();
      const simOnly = performance.now() - t1;
      return { msPerFrame: total / frames, fakeSimMsPerFrame: simOnly / frames, alive: world.state.fighters.filter((f) => f.alive).length };
    },
  };

  let last = performance.now();
  let acc = 0;
  let fpsTime = 0;
  let frames = 0;
  let fps = 0;
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    slowmoLeft = Math.max(0, slowmoLeft - dt);
    hitStopLeft = Math.max(0, hitStopLeft - dt);
    const scale = paused || hitStopLeft > 0 ? 0 : speed * (slow ? 0.3 : 1) * (slowmoLeft > 0 ? 0.3 : 1);
    renderer.setTimeScale(scale);
    acc += dt * scale;
    while (acc >= TICK_DT) {
      acc -= TICK_DT;
      forward(world.step());
    }
    renderer.render(world.prev, world.state, acc / TICK_DT, dt);
    frames++;
    fpsTime += dt;
    if (fpsTime >= 0.5) {
      fps = Math.round(frames / fpsTime);
      frames = 0;
      fpsTime = 0;
      const alive = world.state.fighters.filter((f) => f.alive).length;
      hud.textContent =
        `${world.map.name} · ${alive}/${count} alive · ${fps} fps · cones ${overlay.cones} · fog ${overlay.fog ? 'on' : 'off'}` +
        ` · shake ${overlay.shake} · ${speed}x${paused ? ' · paused' : ''}${slow ? ' · slow' : ''}${follow ? ' · follow' : ''}` +
        `${hoveredObject ? ` · hover ${hoveredObject.kind} ${hoveredObject.id}` : ''}\n` +
        '1-4 map · C cones · F fog · H hearing · N names · B bars · R ring · X shake · click select · L follow · Space pause · S slow · K kill · E keg · D sudden death · +/- fighters\n' +
        'I panel · P speed · A acid · U dunk · Y shrine heal · T countdown · W final kill';
    }
    schedule(loop);
  };
  schedule(loop);
}

void main();
