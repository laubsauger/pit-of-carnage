/**
 * The world renderer: WebGPU + three.js node materials, orthographic top-down camera.
 *
 * `createRenderer` is async because WebGPU needs `await renderer.init()` before the first frame.
 * WebGPU only: the app checks `navigator.gpu` before calling this; if the browser still cannot
 * create a WebGPU device the promise rejects with a clear error (no WebGL path exists).
 *
 * Hosts the fx module: it receives a RenderContext on the first `setMap`, every event batch and a
 * scaled-time update each frame.
 *
 * Weight without rumble: only kills shake the camera (and only with the viewer's shake setting on);
 * ordinary hits land locally on the two fighters (hit-stop, flash, squash) and never move the camera.
 */

import * as THREE from 'three/webgpu';
import { DEFAULT_VIEW_SETTINGS, LAYER_HEIGHT, LIVE_EVENT_TICKS, MAX_FIGHTERS, WEAPONS, clamp } from '../core';
import type {
  Decision, FxModule, GameEvent, GameRenderer, KnownFighter, MapDef, RenderContext, SkillId, ViewSettings, WorldState,
} from '../core';
import { affine, setFrame } from './affine';
import { ArenaLayer } from './arena';
import { CameraDirector, eventMoment, eventTrauma } from './camera';
import type { FrameInput } from './camera';
import { createCutoutMaterial } from './cutout';
import { FighterLayer } from './fighters';
import { Floor } from './floor';
import { createFx } from './fx';
import { pickIndex } from './hud';
import { LightField } from './lightfield';
import { OverlayLayer } from './overlays';
import { Post } from './post';
import { ProjectileLayer } from './projectiles';
import { IMPACT_PROGRESS, PUNCH_IMPACT, hitSeverity } from './rig';
import { ShadowLayer } from './shadows';
import { QuadBatch, acidMaterial, fireMaterial, glowMaterial, groundDecalMaterial } from './sprites';
import { TagLayer } from './tags';
import { Walls } from './walls';
import { ZoneLayer } from './zone';

/** Gore decal texels per world px. */
const DECAL_SCALE = 1.5;
const DECAL_MAX = 4096;
const CLEAR_COLOR = 0x090807;
/**
 * Render resolution cap. Retina laptops render at 1.5x (with FXAA) instead of 2x: the HDR colour +
 * emissive targets at full 2x cost a lot of fill rate and bandwidth for little visible gain.
 */
const MAX_PIXEL_RATIO = 1.5;

const SKILL_FLASH: Readonly<Record<SkillId, number>> = {
  WHIRLWIND: 0xffd27a,
  SHADOWSTEP: 0x9c7bff,
  DASH: 0x8fe6ff,
  SHOCKWAVE: 0xfff1c4,
  BLOODRAGE: 0xff3a24,
};

export async function createRenderer(canvas: HTMLCanvasElement, fx: FxModule = createFx()): Promise<GameRenderer> {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  await renderer.init();
  if ((renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend !== true) {
    renderer.dispose();
    throw new Error('WebGPU is required: this browser could not create a WebGPU device.');
  }
  const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  renderer.setPixelRatio(pixelRatio);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(CLEAR_COLOR, 1);

  const scene = new THREE.Scene();
  scene.name = 'pit';
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1200);
  camera.up.set(0, 0, -1);
  camera.position.set(0, 600, 0);
  camera.lookAt(0, 0, 0);

  const light = new LightField(renderer);
  const decalTarget = new THREE.RenderTarget(4, 4, { depthBuffer: false, type: THREE.HalfFloatType });
  decalTarget.texture.name = 'floor-decals';
  const cutout = createCutoutMaterial(light);
  const glow = new QuadBatch('glows', glowMaterial(), 256);
  glow.mesh.renderOrder = 5;
  const fire = new QuadBatch('fires', fireMaterial(), 96);
  fire.mesh.renderOrder = 6;
  const acid = new QuadBatch('acid', acidMaterial(), 48);
  acid.mesh.renderOrder = 0;
  const floor = new Floor(renderer, light, decalTarget.texture);
  const walls = new Walls(light);
  const arena = new ArenaLayer(cutout, acid);
  const shadows = new ShadowLayer(light);
  const zone = new ZoneLayer(light);
  const glowFrame = affine();
  const fighters = new FighterLayer(cutout, groundDecalMaterial(), (x, y, size, r, g, b) => {
    const k = glow.push(setFrame(glowFrame, x, y, 0, size), LAYER_HEIGHT.fighters + 4);
    if (k < 0) return;
    glow.data[k] = r;
    glow.data[k + 1] = g;
    glow.data[k + 2] = b;
    glow.data[k + 4] = 0.2;
  }, shadows);
  const projectiles = new ProjectileLayer(cutout);
  const overlays = new OverlayLayer();
  const tags = new TagLayer();
  scene.add(
    light.group, floor.mesh, shadows.mesh, zone.group, walls.mesh, arena.group, acid.mesh, fighters.group, projectiles.group, glow.mesh,
    fire.mesh, overlays.group, tags.group,
  );

  const msaa = pixelRatio <= 1.25;
  const post = new Post(renderer, scene, camera, msaa);
  const director = new CameraDirector();

  let map: MapDef | null = null;
  let ctx: RenderContext | null = null;
  let viewW = Math.max(1, canvas.clientWidth || canvas.width);
  let viewH = Math.max(1, canvas.clientHeight || canvas.height);
  let timeScale = 1;
  let time = 0;
  let selectedId: string | null = null;
  let hoveredId: string | null = null;
  let followId: string | null = null;
  let view: ViewSettings = { ...DEFAULT_VIEW_SETTINGS };
  let decisionOf: (id: string) => Decision | null = () => null;
  let knowledgeOf: (id: string) => readonly KnownFighter[] = () => [];
  let needsSnap = true;
  let disposed = false;
  const points = new Float32Array(MAX_FIGHTERS * 2);
  const frame: FrameInput = { viewW, viewH, mapW: 1, mapH: 1, points, count: 0, followX: null, followY: null };
  const savedClear = new THREE.Color();

  renderer.setSize(viewW, viewH, false);
  post.setAspect(viewW / viewH);

  function clearDecals(): void {
    const prev = renderer.getRenderTarget();
    renderer.getClearColor(savedClear);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(decalTarget);
    renderer.setClearColor(0xffffff, 0);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(prev);
    renderer.setClearColor(savedClear, prevAlpha);
  }

  function fillFrame(): void {
    frame.viewW = viewW;
    frame.viewH = viewH;
    let n = 0;
    for (let i = 0; i < fighters.count; i++) {
      if (!fighters.alive[i]) continue;
      points[n * 2] = fighters.xs[i]!;
      points[n * 2 + 1] = fighters.ys[i]!;
      n++;
    }
    frame.count = n;
    const f = fighters.indexOf(followId);
    if (f >= 0 && fighters.alive[f]) {
      frame.followX = fighters.xs[f]!;
      frame.followY = fighters.ys[f]!;
    } else {
      frame.followX = null;
      frame.followY = null;
    }
  }

  function applyCamera(): void {
    const halfW = viewW / (2 * director.zoom);
    const halfH = viewH / (2 * director.zoom);
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.updateProjectionMatrix();
    const x = director.x + director.shakeX;
    const y = director.y + director.shakeY;
    camera.position.set(x, 600, y);
    camera.lookAt(x, 0, y);
  }

  /** Local weight of a blow: hit-stop on both bodies (attacker on its impact pose), squash on the victim. */
  function onHit(e: Extract<GameEvent, { type: 'hit' }>): void {
    // The wall's damage ticks are a slow squeeze, not blows.
    if (e.source === 'sudden_death' || e.amount <= 0) return;
    const severity = hitSeverity(e.amount, e.crit);
    if (e.source === 'hazard') {
      fighters.nudge(e.victimId, e.dir, severity);
      return;
    }
    const melee = e.source === 'punch' || (e.source === 'weapon' && e.weapon !== null && WEAPONS[e.weapon].family === 'melee');
    const impact = e.source === 'punch' ? PUNCH_IMPACT : melee && e.weapon !== null ? IMPACT_PROGRESS[e.weapon] : -1;
    // Shooters are far from where their shot lands; kegs and reflected damage have no swing to hold.
    const attacker = melee || e.source === 'skill' ? e.attackerId : null;
    fighters.hit(e.victimId, attacker, e.dir, severity, impact);
  }

  const api: GameRenderer = {
    setMap(m) {
      map = m;
      light.setMap(m);
      floor.setMap(m);
      walls.setMap(m);
      arena.setMap(m);
      zone.setMap(m);
      overlays.setMap(m);
      const dw = Math.min(DECAL_MAX, Math.round(m.width * DECAL_SCALE));
      const dh = Math.min(DECAL_MAX, Math.round(m.height * DECAL_SCALE));
      if (decalTarget.width !== dw || decalTarget.height !== dh) decalTarget.setSize(dw, dh);
      clearDecals();
      frame.mapW = m.width;
      frame.mapH = m.height;
      needsSnap = true;
      if (!ctx) {
        ctx = {
          renderer, scene, camera, map: m, floorDecalTarget: decalTarget, floorSize: { x: m.width, y: m.height },
          fighterVisual: (id) => fighters.visual(id),
        };
        fx.init(ctx);
      } else {
        // The context is a live object: same scene, camera and decal target, new map.
        ctx.map = m;
        ctx.floorSize.x = m.width;
        ctx.floorSize.y = m.height;
        fx.reset();
      }
    },

    render(prev, curr, alpha, frameDt) {
      if (disposed || !map) return;
      const dt = Math.max(0, Math.min(frameDt, 0.25));
      const gameDt = dt * timeScale;
      time += gameDt;
      const a = clamp(alpha, 0, 1);

      glow.begin();
      fire.begin();
      acid.begin();
      shadows.begin();
      fighters.update(prev, curr, a, time, gameDt, selectedId, hoveredId);
      arena.update(curr, time, gameDt, fire, glow, light);
      projectiles.update(curr, a, time, glow, light, shadows);
      glow.end();
      fire.end();
      acid.end();
      shadows.end();
      zone.update(curr.suddenDeath, gameDt);

      fillFrame();
      if (needsSnap) {
        director.snap(frame);
        needsSnap = false;
      } else {
        director.update(dt, frame);
      }
      applyCamera();
      const known = selectedId !== null ? knowledgeOf(selectedId) : null;
      overlays.update(curr, fighters, selectedId, selectedId !== null ? decisionOf(selectedId) : null, known, dt, time, 1 / director.zoom);
      tags.update(curr, fighters, director.zoom, gameDt, view.nameTags, view.hpBars, overlays.visibleToViewer);
      light.update(time, gameDt);
      fx.update(gameDt, curr, a);
      post.punch.value = Math.max(0, post.punch.value - dt * 3.2);
      post.render();
    },

    onEvents(events: GameEvent[], state: WorldState) {
      for (const e of events) {
        // Catch-up after a seek: fx still paints the gore, but old moments move no camera and flash nothing.
        if (state.tick - e.tick > LIVE_EVENT_TICKS) continue;
        director.addTrauma(eventTrauma(e, view.shake));
        const moment = eventMoment(e);
        if (moment > 0 && 'pos' in e) director.addMoment(e.pos.x, e.pos.y, moment);
        switch (e.type) {
          case 'hit':
            onHit(e);
            break;
          case 'kill':
            post.punch.value = 1;
            light.flash(e.pos.x, e.pos.y, 150, 2.2, 0xff6040, 0.35);
            break;
          case 'explosion':
            light.flash(e.pos.x, e.pos.y, e.radius * 2.6, 6, 0xffa040, 0.55);
            break;
          case 'pickup':
          case 'pickup_spawn':
            arena.onEvent(e, state, light);
            break;
          case 'sudden_death':
          case 'escalation':
            zone.onEvent(e);
            break;
          case 'skill':
            light.flash(e.pos.x, e.pos.y, 150, 2.4, SKILL_FLASH[e.skill], 0.3);
            break;
          case 'parry':
            light.flash(e.pos.x, e.pos.y, 90, 2.5, 0x8fe6ff, 0.2);
            break;
          default:
            break;
        }
      }
      fx.onEvents(events, state);
    },

    setSelected(id) {
      selectedId = id;
    },
    setHovered(id) {
      hoveredId = id;
    },
    setFollow(id) {
      followId = id;
    },
    zoomAt(clientX, clientY, factor) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      director.zoomAt(((clientX - rect.left) / rect.width) * viewW, ((clientY - rect.top) / rect.height) * viewH, factor, frame);
    },
    panBy(dx, dy) {
      director.panBy(dx, dy, frame);
    },
    resetCamera() {
      director.release();
    },
    setView(v) {
      view = { ...v };
      overlays.setView(v);
      fx.setView(v);
    },
    setDecisionProvider(fn) {
      decisionOf = fn;
    },
    setKnowledgeProvider(fn) {
      knowledgeOf = fn;
    },

    pick(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const nx = (clientX - rect.left) / rect.width;
      const ny = (clientY - rect.top) / rect.height;
      const wx = camera.position.x + camera.left + nx * (camera.right - camera.left);
      const wy = camera.position.z - camera.top + ny * (camera.top - camera.bottom);
      const i = pickIndex(fighters.xs, fighters.ys, fighters.rs, fighters.alive, fighters.count, wx, wy, 8 / director.zoom);
      return i >= 0 ? fighters.ids[i]! : null;
    },

    setTimeScale(s) {
      timeScale = Math.max(0, s);
    },

    resize(w, h) {
      viewW = Math.max(1, Math.floor(w));
      viewH = Math.max(1, Math.floor(h));
      renderer.setSize(viewW, viewH, false);
      post.setAspect(viewW / viewH);
    },

    captureStream(fps) {
      return canvas.captureStream(fps);
    },

    reset() {
      fx.reset();
      if (map) clearDecals();
      light.clearDynamic();
      tags.reset();
      fighters.resetHits();
      arena.resetPickups();
      zone.reset();
      post.punch.value = 0;
      needsSnap = true;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      fx.dispose();
      fighters.dispose();
      arena.dispose();
      projectiles.dispose();
      overlays.dispose();
      tags.dispose();
      shadows.dispose();
      zone.dispose();
      glow.dispose();
      fire.dispose();
      acid.dispose();
      floor.dispose();
      walls.dispose();
      light.dispose();
      post.dispose();
      decalTarget.dispose();
      cutout.dispose();
      renderer.dispose();
    },
  };
  return api;
}
