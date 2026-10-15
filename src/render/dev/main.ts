/**
 * Render harness (dev only): drives the renderer and fx with a fake animated world.
 * Open /render-dev.html on the Vite dev server.
 *
 * Keys: 1-4 map, C cones (off/selected/all), F fog, H hearing ripples, N names, B HP bars,
 * R steering ring, X shake (kills/off), click select, L follow selected, Space pause, S slow motion,
 * K kill someone, E explode a keg, D sudden death (Shift+D: start with the wall far in), +/- fighters.
 */

import { DEFAULT_VIEW_SETTINGS, TICK_DT } from '../../core';
import type { GameEvent, GameRenderer, ViewSettings } from '../../core';
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
    for (const e of events) {
      if (e.type === 'kill') slowmoLeft = 0.9;
      if (e.type === 'hit' && (e.crit || e.amount >= 28)) hitStopLeft = Math.max(hitStopLeft, 0.07);
    }
    renderer.onEvents(events, world.state);
  };

  const reload = () => {
    world = new FakeWorld(MAPS[mapIds[mapIndex]!]!, count);
    renderer.reset();
    renderer.setMap(world.map);
    selected = null;
    renderer.setSelected(null);
    renderer.setFollow(null);
  };

  canvas.addEventListener('pointermove', (e) => renderer.setHovered(renderer.pick(e.clientX, e.clientY)));
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
    const scale = paused || hitStopLeft > 0 ? 0 : (slow ? 0.3 : 1) * (slowmoLeft > 0 ? 0.3 : 1);
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
        ` · shake ${overlay.shake}${paused ? ' · paused' : ''}${slow ? ' · slow' : ''}${follow ? ' · follow' : ''}\n` +
        '1-4 map · C cones · F fog · H hearing · N names · B bars · R ring · X shake · click select · L follow · Space pause · S slow · K kill · E keg · D sudden death · +/- fighters';
    }
    schedule(loop);
  };
  schedule(loop);
}

void main();
