/**
 * Name tags and HP bars above each fighter, at a constant screen size whatever the zoom.
 *
 * - Names come from a canvas text atlas (one row per fighter, drawn at 2x for crisp text), rebuilt
 *   only when the roster changes or the web fonts finish loading.
 * - HP bars are drawn by a TSL shader: team-colour fill, a pale damage chip that holds then drains
 *   (shows how big the last blow was), quarter ticks, and ammo pips for ranged builds.
 */

import * as THREE from 'three/webgpu';
import { Fn, attribute, float, floor, fract, mix, select, smoothstep, step, texture, uv, vec2, vec3, vec4 } from 'three/tsl';
import { LAYER_HEIGHT, MAX_FIGHTERS } from '../core';
import type { WorldState } from '../core';
import { affine, setFrame } from './affine';
import { basicMaterial } from './cutout';
import type { FighterLayer } from './fighters';
import { ghostHit, stepGhost } from './hud';
import type { HpGhost } from './hud';
import { QuadBatch } from './sprites';

const ATLAS_W = 1024;
const ROW_H = 56;
const ATLAS_H = ROW_H * MAX_FIGHTERS;
/** Atlas pixels per CSS pixel. */
const ATLAS_SCALE = 2;
const FONT = `600 ${13 * ATLAS_SCALE}px Inter, system-ui, sans-serif`;
const BAR_W = 46;
const BAR_H = 6;
const PIP_H = 3;
const PIP_GAP = 2;
const TAG_H = 18;

export class TagLayer {
  readonly group = new THREE.Group();
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly atlas: THREE.CanvasTexture;
  private readonly tags: QuadBatch;
  private readonly bars: QuadBatch;
  private readonly widths = new Float32Array(MAX_FIGHTERS);
  private readonly ghosts: HpGhost[] = [];
  private readonly lastHp = new Float32Array(MAX_FIGHTERS);
  private rosterVersion = -1;
  private readonly T = affine();

  constructor() {
    this.group.name = 'tags';
    this.canvas = document.createElement('canvas');
    this.canvas.width = ATLAS_W;
    this.canvas.height = ATLAS_H;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Name tags need a 2D canvas context.');
    this.ctx = ctx;
    this.atlas = new THREE.CanvasTexture(this.canvas);
    this.atlas.colorSpace = THREE.SRGBColorSpace;
    this.atlas.generateMipmaps = false;
    this.atlas.minFilter = THREE.LinearFilter;
    this.atlas.magFilter = THREE.LinearFilter;
    this.tags = new QuadBatch('name-tags', this.tagMaterial(), MAX_FIGHTERS);
    this.tags.mesh.renderOrder = 60;
    this.bars = new QuadBatch('hp-bars', barMaterial(), MAX_FIGHTERS);
    this.bars.mesh.renderOrder = 61;
    this.group.add(this.tags.mesh, this.bars.mesh);
    for (let i = 0; i < MAX_FIGHTERS; i++) this.ghosts.push({ value: 1, hold: 0 });
    if (typeof document !== 'undefined' && document.fonts) {
      document.fonts.load(FONT).then(
        () => {
          // Redraw the atlas with the real font once it has loaded.
          this.rosterVersion = -1;
        },
        () => undefined,
      );
    }
  }

  /** Forget damage chips (new match or seek). */
  reset(): void {
    for (const g of this.ghosts) {
      g.value = 1;
      g.hold = 0;
    }
    this.lastHp.fill(-1);
  }

  /** `names` and `bars` follow the viewer's View settings; `visible` hides fighters the fog viewer cannot see. */
  update(state: WorldState, fighters: FighterLayer, zoom: number, gameDt: number, names: boolean, bars: boolean, visible: Uint8Array): void {
    if (fighters.rosterVersion !== this.rosterVersion) this.rebuildAtlas(state, fighters);
    this.tags.begin();
    this.bars.begin();
    const px = 1 / Math.max(zoom, 1e-3);
    const T = this.T;
    for (let i = 0; i < fighters.count; i++) {
      const f = state.fighters[i];
      if (!f) continue;
      const frac = f.maxHp > 0 ? Math.max(0, f.hp / f.maxHp) : 0;
      const g = this.ghosts[i]!;
      const last = this.lastHp[i]!;
      if (last >= 0 && frac < last - 1e-6) ghostHit(g);
      if (last < 0) g.value = frac;
      this.lastHp[i] = frac;
      stepGhost(g, frac, gameDt);
      if (!f.alive || !visible[i]) continue;
      const x = fighters.xs[i]!;
      const top = fighters.ys[i]! - f.radius - 10 * px;
      const ranged = f.maxAmmo > 0;
      // Without bars the name tag drops into their place.
      const barH = bars ? BAR_H + (ranged ? PIP_H + PIP_GAP : 0) : -3;
      const barCy = top - (barH / 2) * px;
      const k = bars ? this.bars.push(scaleFrame(T, x, barCy, BAR_W * px, barH * px), LAYER_HEIGHT.overlay + 1) : -1;
      if (k >= 0) {
        const d = this.bars.data;
        const c = fighters.teamColor(i);
        d[k] = c.r;
        d[k + 1] = c.g;
        d[k + 2] = c.b;
        d[k + 3] = frac;
        d[k + 4] = Math.max(g.value, frac);
        d[k + 5] = ranged ? f.ammo : 0;
        d[k + 6] = ranged ? f.maxAmmo : 0;
        d[k + 7] = 1;
        d[k + 8] = BAR_W;
        d[k + 9] = barH;
        d[k + 10] = f.hitFlash > 0 ? 1 : 0;
      }
      if (!names) continue;
      const w = this.widths[i]!;
      const tagCy = top - (barH + 3 + TAG_H / 2) * px;
      const t = this.tags.push(scaleFrame(T, x, tagCy, w * px, TAG_H * px), LAYER_HEIGHT.overlay);
      if (t >= 0) {
        const d = this.tags.data;
        // Atlas rect in uv (v measured from the bottom, canvas textures are flipped on upload).
        d[t] = 0;
        d[t + 1] = 1 - ((i + 1) * ROW_H) / ATLAS_H;
        d[t + 2] = (w * ATLAS_SCALE) / ATLAS_W;
        d[t + 3] = 1 - (i * ROW_H + (ROW_H - TAG_H * ATLAS_SCALE)) / ATLAS_H;
        d[t + 4] = 1;
      }
    }
    this.tags.end();
    this.bars.end();
  }

  private rebuildAtlas(state: WorldState, fighters: FighterLayer): void {
    this.rosterVersion = fighters.rosterVersion;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, ATLAS_W, ATLAS_H);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    const s = ATLAS_SCALE;
    for (let i = 0; i < fighters.count; i++) {
      const f = state.fighters[i];
      if (!f) continue;
      const name = f.name.length > 22 ? `${f.name.slice(0, 21)}…` : f.name;
      const textW = ctx.measureText(name).width;
      const w = Math.min(ATLAS_W / s - 2, Math.ceil(textW / s) + 18);
      this.widths[i] = w;
      // Row content sits at the bottom TAG_H of the row (matches the uv rect above).
      const y0 = i * ROW_H + (ROW_H - TAG_H * s);
      const h = TAG_H * s;
      ctx.fillStyle = 'rgba(14, 13, 12, 0.82)';
      roundRectPath(ctx, 0, y0, w * s, h, 5 * s);
      ctx.fill();
      ctx.fillStyle = f.color;
      roundRectPath(ctx, 3 * s, y0 + 4 * s, 3 * s, h - 8 * s, 1.5 * s);
      ctx.fill();
      ctx.fillStyle = '#e8e2d9';
      ctx.fillText(name, 10 * s, y0 + h / 2 + 0.5 * s);
    }
    this.atlas.needsUpdate = true;
  }

  private tagMaterial(): THREE.MeshBasicNodeMaterial {
    const m = basicMaterial('name-tag');
    m.transparent = true;
    m.depthWrite = false;
    m.depthTest = false;
    const q0 = attribute('q0', 'vec4');
    const q1 = attribute('q1', 'vec4');
    const tex = texture(this.atlas, mix(q0.xy, q0.zw, uv()));
    m.colorNode = tex.xyz;
    m.opacityNode = tex.w.mul(q1.x);
    return m;
  }

  dispose(): void {
    this.atlas.dispose();
    this.tags.dispose();
    this.bars.dispose();
  }
}

/** Axis-aligned frame of size (w, h) centred on (x, y): u spans w, v spans h. */
function scaleFrame(out: ReturnType<typeof affine>, x: number, y: number, w: number, h: number): ReturnType<typeof affine> {
  setFrame(out, x, y, 0, 1);
  out.a = w;
  out.d = h;
  return out;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * HP bar. q0 = team rgb + hp fraction, q1 = chip fraction, ammo, max ammo, alpha,
 * q2 = width px, height px, hit flash.
 */
function barMaterial(): THREE.MeshBasicNodeMaterial {
  const m = basicMaterial('hp-bar');
  m.transparent = true;
  m.depthWrite = false;
  m.depthTest = false;
  const q0 = attribute('q0', 'vec4');
  const q1 = attribute('q1', 'vec4');
  const q2 = attribute('q2', 'vec4');
  const out = Fn(() => {
    // Pixel coordinates inside the quad; y measured downward from the top edge.
    const p = vec2(uv().x.mul(q2.x), float(1).sub(uv().y).mul(q2.y));
    const inBar = step(p.y, BAR_H);
    // Bar: 1 px ink border, dark well, fill, chip, quarter ticks.
    const ix = p.x.sub(1).div(q2.x.sub(2));
    const border = float(1).sub(step(1, p.x).mul(step(p.x, q2.x.sub(1))).mul(step(1, p.y)).mul(step(p.y, BAR_H - 1)));
    const fill = step(ix, q0.w);
    const chip = step(q0.w, ix).mul(step(ix, q1.x));
    const tick = step(fract(ix.mul(4)).sub(0.5).abs(), 0.5 - 0.5 / 46).oneMinus().mul(step(0.05, ix)).mul(step(ix, 0.95));
    const low = smoothstep(0.18, 0.32, q0.w).oneMinus();
    const fillCol = mix(q0.xyz, vec3(1.0, 0.25, 0.18), low.mul(0.5));
    let barCol = mix(vec3(0.09, 0.08, 0.07), fillCol, fill);
    barCol = mix(barCol, vec3(0.98, 0.9, 0.8), chip);
    barCol = mix(barCol, barCol.mul(0.45), tick.mul(fill.add(chip).clamp(0, 1)));
    barCol = mix(barCol, vec3(0.03, 0.025, 0.02), border);
    barCol = mix(barCol, vec3(1), q2.z.mul(0.35));
    // Ammo pips below the bar.
    const n = q1.z.max(1);
    const slot = p.x.div(q2.x).mul(n);
    const pipIndex = floor(slot);
    const inPip = step(0.12, fract(slot)).mul(step(fract(slot), 0.88));
    const pipY = step(BAR_H + PIP_GAP, p.y);
    const filled = step(pipIndex.add(0.5), q1.y);
    const pipCol = mix(vec3(0.23, 0.21, 0.18), vec3(0.91, 0.89, 0.85), filled);
    const pipA = inPip.mul(pipY).mul(step(0.5, q1.z));
    const col = select(inBar.greaterThan(0.5), barCol, pipCol);
    const a = select(inBar.greaterThan(0.5), float(0.95), pipA.mul(0.9)).mul(q1.w);
    return vec4(col, a);
  })();
  m.colorNode = out.xyz;
  m.opacityNode = out.w;
  return m;
}
