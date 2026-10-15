// Owned by: render-fx
/**
 * Kill stamps (Bangers, blood-red with an ink outline) and bark speech bubbles that follow their
 * speaker. Each popup is a pooled canvas texture on a floor-facing quad, redrawn only when reused.
 * Popups keep a constant size on screen whatever the camera zoom, and never cover each other: newer
 * ones glide aside (eased, never a jump).
 *
 * Kill stamps (stampLayout.ts, easing.ts): small, a little above the kill spot, an elastic pop, then
 * they shrink and float up while fading, gone by about 1.2 s; several stack upward.
 *
 * Barks are small and rare (see barks.ts): at most `BARK_RULES.maxVisible` bubbles, about five
 * words, gone in `BARK_RULES.visibleSeconds`, sitting above the speaker's name tag and stepping up
 * out of the way of other bubbles and other fighters' tags and HP bars.
 */

import * as THREE from 'three/webgpu';
import { BARK_RULES, LAYER_HEIGHT } from '../../core';
import type { FighterState, WorldState } from '../../core';
import { liftClear, pickBarkSlot, tagBox, tagStackPx, truncateBark } from './barks';
import type { Box } from './barks';
import { barkDuration, barkEnvelope, glideUp, stampDuration, stampEnvelope } from './easing';
import { FixedPool } from './pool';
import type { Pooled } from './pool';
import { floorQuad } from './quads';
import { STAMP, stackStamps, stampHeightPx } from './stampLayout';

const FONT = 'Bangers, Impact, "Arial Black", sans-serif';
const INK = '#130908';

/** Bark quad height in CSS px (the bubble itself is a bit smaller, the tail sits below it). */
const BARK_PX = 46;
/** Gap (CSS px) between a bubble and what it dodges. */
const BARK_GAP = 3;
/** How fast a placed bubble glides to a new spot (1/s, exponential). */
const DODGE_RATE = 14;
/** How fast a stamp glides up out of the way of an older one floating up under it. */
const STACK_RATE = 30;

type Popup = Pooled & {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicNodeMaterial;
  tex: THREE.CanvasTexture;
  ctx: CanvasRenderingContext2D;
  /** Canvas aspect (width / height). */
  aspect: number;
  /** Fraction of the canvas width / height (from the bottom) the drawn content uses (for overlap tests). */
  contentW: number;
  contentH: number;
  t: number;
  dur: number;
  x: number;
  y: number;
  tilt: number;
  fighterId: string;
  /** Bark placement bookkeeping for the current frame. */
  placed: boolean;
  /** Current on-screen rect in world units (centre and half extents), for de-overlap. */
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  /** How far it has been lifted above its own spot to dodge (world units), eased; < 0 = not placed yet. */
  lift: number;
  /** Kill stamp placed under its kill spot (no room above it near the top of the map). */
  below: boolean;
};

function makePopup(w: number, h: number, order: number): Popup {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable for popups');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.MeshBasicNodeMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, alphaTest: 0.02 });
  mat.lights = false;
  const mesh = new THREE.Mesh(floorQuad(), mat);
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  mesh.name = 'fx-popup';
  return {
    active: false, serial: 0, mesh, mat, tex, ctx, aspect: w / h, contentW: 1, contentH: 1, t: 0, dur: 1,
    x: 0, y: 0, tilt: 0, fighterId: '', placed: false, cx: 0, cy: 0, hw: 0, hh: 0, lift: -1, below: false,
  };
}

function fitFont(ctx: CanvasRenderingContext2D, text: string, start: number, maxW: number): number {
  let size = start;
  ctx.font = `${size}px ${FONT}`;
  const w = ctx.measureText(text).width;
  if (w > maxW) {
    size = Math.max(12, Math.floor((size * maxW) / w));
    ctx.font = `${size}px ${FONT}`;
  }
  return size;
}

function drawStamp(p: Popup, text: string): void {
  const { ctx } = p;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  const size = fitFont(ctx, text, Math.floor(H * 0.7), W * 0.86);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const x = W / 2;
  const y = H / 2 + size * 0.04;
  // Drop shadow, ink outline, bone inner outline, then a red gradient face.
  ctx.fillStyle = 'rgba(8,3,3,0.75)';
  ctx.lineWidth = size * 0.2;
  ctx.strokeStyle = 'rgba(8,3,3,0.75)';
  ctx.strokeText(text, x + size * 0.05, y + size * 0.07);
  ctx.lineWidth = size * 0.17;
  ctx.strokeStyle = INK;
  ctx.strokeText(text, x, y);
  ctx.lineWidth = size * 0.07;
  ctx.strokeStyle = '#f4e4c4';
  ctx.strokeText(text, x, y);
  const g = ctx.createLinearGradient(0, y - size * 0.45, 0, y + size * 0.45);
  g.addColorStop(0, '#ff6a45');
  g.addColorStop(0.5, '#e0241f');
  g.addColorStop(1, '#8e0c14');
  ctx.fillStyle = g;
  ctx.fillText(text, x, y);
  p.contentW = Math.min(1, (ctx.measureText(text).width + size * 0.3) / W);
  p.contentH = 1;
  p.tex.needsUpdate = true;
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number, out: string[]): string[] {
  out.length = 0;
  const words = text.trim().split(/\s+/);
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && ctx.measureText(next).width > maxW && out.length === 0) {
      out.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out;
}

const lines: string[] = [];

function drawBark(p: Popup, text: string, color: string): void {
  const { ctx } = p;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  const tail = H * 0.18;
  const pad = H * 0.09;
  let size = Math.floor(H * 0.36);
  ctx.font = `${size}px ${FONT}`;
  wrapLines(ctx, text, W * 0.82, lines);
  const widest = (): number => {
    let w = 0;
    for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
    return w;
  };
  const fitW = W - pad * 2 - 16;
  const fitH = H - tail - pad * 2 - 12;
  while (size > 14 && (widest() > fitW || lines.length * size * 1.02 > fitH)) {
    size -= 2;
    ctx.font = `${size}px ${FONT}`;
  }
  const lineH = size * 1.02;
  const bw = Math.min(W - 12, widest() + pad * 2.4);
  const bh = lines.length * lineH + pad * 1.6;
  const bx = (W - bw) / 2;
  const by = Math.max(6, H - tail - bh - 4);
  const r = Math.min(bh / 2, size * 0.55);
  // Bubble with a tail toward the speaker.
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, r);
  ctx.moveTo(W / 2 - tail * 0.7, by + bh - 1);
  ctx.lineTo(W / 2 - tail * 0.15, H - 4);
  ctx.lineTo(W / 2 + tail * 0.35, by + bh - 1);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 8;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.fillStyle = '#f4ecdc';
  ctx.fill();
  // Speaker colour stripe along the left edge ties the bubble to its fighter.
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, r);
  ctx.clip();
  ctx.fillStyle = color;
  ctx.fillRect(bx, by, Math.max(8, pad * 0.45), bh);
  ctx.restore();
  ctx.fillStyle = '#1d1411';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const x = W / 2 + pad * 0.15;
  let y = by + bh / 2 - ((lines.length - 1) * lineH) / 2 + size * 0.04;
  for (const l of lines) {
    ctx.fillText(l, x, y);
    y += lineH;
  }
  p.contentW = (bw + 8) / W;
  p.contentH = (H - by + 4) / H;
  p.tex.needsUpdate = true;
}

const env = { scale: 0, alpha: 0, rise: 0 };
/** Reused obstacle boxes for bark placement (tags, then placed bubbles). */
const obstacles: Box[] = [];
function obstacle(i: number): Box {
  while (obstacles.length <= i) obstacles.push({ cx: 0, cy: 0, hw: 0, hh: 0 });
  return obstacles[i];
}
/** Reused stamp boxes (active stamps, oldest first) and their popups. */
const stampBoxes: Box[] = [];
const stampOrder: Popup[] = [];
const stampBelow: boolean[] = [];

export class Popups {
  readonly group = new THREE.Group();
  private readonly stamps: FixedPool<Popup>;
  /** Exactly `BARK_RULES.maxVisible` bubbles; slots are chosen by `pickBarkSlot`. */
  private readonly barks: Popup[];
  private barkSerial = 0;
  private mapW = 1;
  private mapH = 1;

  constructor() {
    this.stamps = new FixedPool(5, () => makePopup(768, 256, 101));
    // Bubbles draw over kill stamps: they are small, and a kill line under its own stamp is lost.
    this.barks = Array.from({ length: BARK_RULES.maxVisible }, () => makePopup(512, 160, 102));
    for (const p of [...this.stamps.items, ...this.barks]) this.group.add(p.mesh);
    this.group.name = 'fx-popups';
    // Load Bangers before the first stamp is drawn (the page links it; this only waits for it).
    if (typeof document !== 'undefined' && document.fonts) void document.fonts.load(`64px ${FONT}`).catch(() => undefined);
  }

  setBounds(w: number, h: number): void {
    this.mapW = w;
    this.mapH = h;
  }

  /** Pop a kill stamp above world (x, y), the kill spot. `text` is the sim's 1-3 word title. */
  stamp(text: string, x: number, y: number): void {
    const p = this.stamps.acquire();
    drawStamp(p, text.toUpperCase());
    p.t = 0;
    p.dur = stampDuration();
    p.x = x;
    p.y = y;
    p.tilt = (Math.random() - 0.5) * 0.16;
    p.fighterId = '';
    p.lift = -1;
    p.below = false;
  }

  /**
   * Show a speech bubble over a fighter (replaces that fighter's current bubble). The line is cut
   * to about five words. Returns false when the line was dropped because the screen already holds
   * `BARK_RULES.maxVisible` fresh bubbles.
   */
  bark(fighterId: string, text: string, color: string, x: number, y: number): boolean {
    const p = pickBarkSlot(this.barks, fighterId);
    if (!p) return false;
    p.active = true;
    p.serial = ++this.barkSerial;
    drawBark(p, truncateBark(text), color);
    p.t = 0;
    p.dur = barkDuration();
    p.x = x;
    p.y = y;
    p.tilt = 0;
    p.fighterId = fighterId;
    p.lift = -1;
    return true;
  }

  /**
   * Advance and place popups. `px` is world units per CSS px (constant on-screen sizes), `viewPx`
   * the view height in CSS px; `nameTags` says whether tags are drawn, so bubbles know how high the
   * tag stack is.
   */
  update(dt: number, state: WorldState, px: number, viewPx: number, nameTags: boolean): void {
    this.placeBarks(dt, state, px, nameTags);
    this.placeStamps(dt, state, px, viewPx, nameTags);
  }

  private placeBarks(dt: number, state: WorldState, px: number, nameTags: boolean): void {
    // Every living fighter's HP bar and name tag is an obstacle; placed bubbles join the list.
    let n = 0;
    for (const f of state.fighters) {
      if (!f.alive) continue;
      tagBox(obstacle(n++), f.pos.x, f.pos.y, f.radius, f.name, nameTags, px);
    }
    for (const p of this.barks) {
      p.placed = false;
      if (!p.active) continue;
      p.t += dt;
      if (p.t >= p.dur) p.active = false;
    }
    const h = BARK_PX * px;
    const gap = BARK_GAP * px;
    // Oldest first, so a newer bubble steps aside rather than shoving an older one around.
    for (;;) {
      let p: Popup | null = null;
      for (const b of this.barks) if (b.active && !b.placed && (!p || b.serial < p.serial)) p = b;
      if (!p) break;
      p.placed = true;
      barkEnvelope(env, p.t);
      const f = findFighter(state, p.fighterId);
      if (f && f.alive) {
        p.x = f.pos.x;
        p.y = f.pos.y;
      }
      const radius = f ? f.radius : 18;
      const w = h * p.aspect;
      // Content box (bubble + tail), its bottom just above the speaker's tag stack.
      const box = obstacle(n);
      box.hw = (w * p.contentW) / 2;
      box.hh = (h * p.contentH) / 2;
      box.cx = clampTo(p.x, box.hw + 4, this.mapW - box.hw - 4);
      const rest = p.y - radius - tagStackPx(nameTags) * px - gap - box.hh;
      box.cy = rest;
      liftClear(box, obstacles, n, gap);
      // Placed bubbles stay put; when something moves into them they glide up, never jump.
      p.lift = glideUp(p.lift, rest - box.cy, dt, DODGE_RATE);
      box.cy = Math.max(rest - p.lift, box.hh + 4);
      n++;
      // The quad's bottom is the content's bottom: the tail points down at the speaker.
      const s = Math.max(0.001, env.scale);
      p.mesh.visible = env.alpha > 0.001;
      p.mesh.position.set(box.cx, LAYER_HEIGHT.popups + 2, box.cy + box.hh - (h / 2) * s);
      p.mesh.scale.set(w * s, 1, h * s);
      p.mesh.rotation.y = 0;
      p.mat.opacity = env.alpha;
    }
    for (const p of this.barks) if (!p.active) p.mesh.visible = false;
  }

  private placeStamps(dt: number, state: WorldState, px: number, viewPx: number, nameTags: boolean): void {
    const h = stampHeightPx(viewPx) * px;
    const gap = STAMP.gapPx * px;
    let n = 0;
    for (const p of this.stamps.items) {
      if (!p.active) {
        p.mesh.visible = false;
        continue;
      }
      p.t += dt;
      if (p.t >= p.dur) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }
      // Oldest first (insertion sort by serial; at most a handful of stamps).
      let i = n++;
      while (i > 0 && stampOrder[i - 1].serial > p.serial) {
        stampOrder[i] = stampOrder[i - 1];
        i--;
      }
      stampOrder[i] = p;
    }
    if (n === 0) return;
    // Living fighters' tags first (stamps must not cover them), then the stamps, oldest first.
    let tags = 0;
    for (const f of state.fighters) {
      if (!f.alive) continue;
      while (stampBoxes.length <= tags) stampBoxes.push({ cx: 0, cy: 0, hw: 0, hh: 0 });
      tagBox(stampBoxes[tags++], f.pos.x, f.pos.y, f.radius, f.name, nameTags, px);
    }
    while (stampBoxes.length < tags + n) stampBoxes.push({ cx: 0, cy: 0, hw: 0, hh: 0 });
    const top = h / 2 + 4;
    const place = (): void => {
      for (let i = 0; i < n; i++) {
        const p = stampOrder[i];
        stampEnvelope(env, p.t);
        const box = stampBoxes[tags + i];
        box.hw = (h * p.aspect * p.contentW) / 2;
        box.hh = h / 2;
        box.cx = clampTo(p.x, box.hw + 4, this.mapW - box.hw - 4);
        // Above the kill spot, never on the body; floats up as it fades (down when it sits below).
        // Stacking uses the full-size box, so the elastic pop does not shove its neighbours around.
        const drift = env.rise * STAMP.risePx * px;
        box.cy = p.below ? p.y + STAMP.offsetPx * px + h / 2 + drift : p.y - STAMP.offsetPx * px - h / 2 - drift;
        p.cy = box.cy;
        stampBelow[i] = p.below;
      }
      stackStamps(stampBoxes, tags, tags + n, gap, stampBelow);
    };
    place();
    // A new stamp with no room above it (near the top of the map) goes under its kill spot for good.
    let flipped = false;
    for (let i = 0; i < n; i++) {
      const p = stampOrder[i];
      if (p.lift < 0 && !p.below && stampBoxes[tags + i].cy < top) {
        p.below = true;
        flipped = true;
      }
    }
    if (flipped) place();
    for (let i = 0; i < n; i++) {
      const p = stampOrder[i];
      const box = stampBoxes[tags + i];
      stampEnvelope(env, p.t);
      // Moved out of the way by stacking: glide there, then stay put.
      p.lift = glideUp(p.lift, Math.abs(p.cy - box.cy), dt, STACK_RATE);
      const cy = clampTo(p.below ? p.cy + p.lift : p.cy - p.lift, top, this.mapH - h / 2 - 4);
      const s = Math.max(0.001, env.scale);
      p.cx = box.cx;
      p.hw = box.hw;
      p.hh = box.hh;
      p.mesh.visible = env.alpha > 0.001;
      p.mesh.position.set(box.cx, LAYER_HEIGHT.popups + 1, cy);
      p.mesh.scale.set(h * p.aspect * s, 1, h * s);
      p.mesh.rotation.y = p.tilt;
      p.mat.opacity = env.alpha;
    }
  }

  clear(): void {
    this.clearBarks();
    this.clearStamps();
  }

  clearBarks(): void {
    for (const p of this.barks) {
      p.active = false;
      p.mesh.visible = false;
    }
  }

  clearStamps(): void {
    for (const p of this.stamps.items) {
      p.active = false;
      p.mesh.visible = false;
    }
  }

  dispose(): void {
    for (const p of [...this.stamps.items, ...this.barks]) {
      p.mesh.geometry.dispose();
      p.mat.dispose();
      p.tex.dispose();
    }
  }
}

function clampTo(v: number, lo: number, hi: number): number {
  return lo > hi ? (lo + hi) / 2 : v < lo ? lo : v > hi ? hi : v;
}

export function findFighter(state: WorldState, id: string): FighterState | null {
  for (const f of state.fighters) if (f.id === id) return f;
  return null;
}
