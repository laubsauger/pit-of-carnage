/**
 * Small readout labels on the arena at a constant screen size, built from a static glyph atlas so
 * the changing numbers never redraw or re-upload a texture: "lost sight 2.3 s ago" under a ghost
 * marker. A dark pill with a chip in the remembered fighter's colour sits behind the text.
 */

import * as THREE from 'three/webgpu';
import { Fn, attribute, float, length, max, mix, smoothstep, texture, uv, vec2, vec3, vec4 } from 'three/tsl';
import { LAYER_HEIGHT } from '../core';
import { affine, setFrame } from './affine';
import { basicMaterial } from './cutout';
import { DOT, secondsDigits } from './hud';
import { QuadBatch } from './sprites';

const S = 2;
const FONT_PX = 11;
const FONT = `500 ${FONT_PX * S}px "JetBrains Mono", ui-monospace, monospace`;
const CELL_H = 20;
const ATLAS_W = 512;
const ATLAS_H = 64;
const PILL_H = 17;
const PAD_X = 6;
const CHIP_W = 3;
const MAX_LABELS = 16;
const H = LAYER_HEIGHT.overlay + 2;

/** Atlas entries: the digits 0-9 at their own index, the decimal point at DOT, then the fixed words. */
const ENTRY_TEXT = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', 'lost sight ', ' s ago'];
const PREFIX = DOT + 1;
const SUFFIX = DOT + 2;

type Entry = { u0: number; u1: number; v0: number; v1: number; w: number };

export class LabelLayer {
  readonly group = new THREE.Group();
  private readonly canvas: HTMLCanvasElement;
  private readonly atlas: THREE.CanvasTexture;
  private readonly glyphs: QuadBatch;
  private readonly pills: QuadBatch;
  private readonly entries: Entry[] = [];
  private readonly digits = new Int8Array(4);
  private readonly T = affine();

  constructor() {
    this.group.name = 'labels';
    this.canvas = document.createElement('canvas');
    this.canvas.width = ATLAS_W;
    this.canvas.height = ATLAS_H;
    this.atlas = new THREE.CanvasTexture(this.canvas);
    this.atlas.colorSpace = THREE.SRGBColorSpace;
    this.atlas.generateMipmaps = false;
    this.atlas.minFilter = THREE.LinearFilter;
    this.atlas.magFilter = THREE.LinearFilter;
    for (let i = 0; i < ENTRY_TEXT.length; i++) this.entries.push({ u0: 0, u1: 0, v0: 0, v1: 0, w: 0 });
    this.draw();
    if (typeof document !== 'undefined' && document.fonts) document.fonts.load(FONT).then(() => this.draw(), () => undefined);
    this.pills = new QuadBatch('label-pills', pillMaterial(), MAX_LABELS);
    this.pills.mesh.renderOrder = 62;
    this.glyphs = new QuadBatch('label-glyphs', this.glyphMaterial(), MAX_LABELS * 6);
    this.glyphs.mesh.renderOrder = 63;
    this.group.add(this.pills.mesh, this.glyphs.mesh);
  }

  begin(): void {
    this.pills.begin();
    this.glyphs.begin();
  }

  end(): void {
    this.pills.end();
    this.glyphs.end();
  }

  /**
   * "lost sight N s ago" with its top edge `gap` screen px below world (x, y). `px` = world px per
   * screen px (1 / zoom). `color` tints the chip (the remembered fighter).
   */
  lostSight(x: number, y: number, gap: number, seconds: number, color: THREE.Color, alpha: number, px: number): void {
    const nd = secondsDigits(seconds, this.digits);
    const e = this.entries;
    let textW = e[PREFIX]!.w + e[SUFFIX]!.w;
    for (let i = 0; i < nd; i++) textW += e[this.digits[i]!]!.w;
    const w = textW + PAD_X * 2 + CHIP_W + 3;
    const cy = y + (gap + PILL_H / 2) * px;
    const k = this.pills.push(box(this.T, x, cy, w * px, PILL_H * px), H);
    if (k < 0) return;
    const q = this.pills.data;
    q[k] = w;
    q[k + 1] = PILL_H;
    q[k + 2] = alpha;
    q[k + 4] = color.r;
    q[k + 5] = color.g;
    q[k + 6] = color.b;
    let cx = x + (-w / 2 + PAD_X + CHIP_W + 3) * px;
    cx = this.glyph(PREFIX, cx, cy, px, 0.64, alpha);
    for (let i = 0; i < nd; i++) cx = this.glyph(this.digits[i]!, cx, cy, px, 1, alpha);
    this.glyph(SUFFIX, cx, cy, px, 0.64, alpha);
  }

  dispose(): void {
    this.atlas.dispose();
    this.pills.dispose();
    this.glyphs.dispose();
  }

  /** One atlas entry with its left edge at world x; returns the next left edge. */
  private glyph(index: number, left: number, cy: number, px: number, bright: number, alpha: number): number {
    const en = this.entries[index]!;
    const k = this.glyphs.push(box(this.T, left + (en.w / 2) * px, cy, en.w * px, CELL_H * px), H + 0.1);
    if (k < 0) return left + en.w * px;
    const q = this.glyphs.data;
    q[k] = en.u0;
    q[k + 1] = en.v0;
    q[k + 2] = en.u1;
    q[k + 3] = en.v1;
    q[k + 4] = alpha;
    q[k + 5] = bright;
    return left + en.w * px;
  }

  /** Lay the entries out in rows of the atlas and draw them white (the shader tints). */
  private draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, ATLAS_W, ATLAS_H);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    let x = 0;
    let row = 0;
    for (let i = 0; i < ENTRY_TEXT.length; i++) {
      const text = ENTRY_TEXT[i]!;
      const m = ctx.measureText(text);
      // A monospace point sits in a full digit cell ("1 .2"): crop it to its ink instead.
      const tight = i === DOT;
      const ink = Math.ceil(m.actualBoundingBoxLeft + m.actualBoundingBoxRight);
      const wPx = (tight ? ink + 2 * S : Math.ceil(m.width)) + 2;
      if (x + wPx > ATLAS_W) {
        x = 0;
        row++;
      }
      const y0 = row * CELL_H * S;
      ctx.fillText(text, x + 1 + (tight ? S + m.actualBoundingBoxLeft : 0), y0 + (CELL_H * S) / 2 + S * 0.5);
      // Canvas textures upload flipped: v is measured from the bottom.
      this.entries[i] = { u0: x / ATLAS_W, u1: (x + wPx) / ATLAS_W, v0: 1 - (y0 + CELL_H * S) / ATLAS_H, v1: 1 - y0 / ATLAS_H, w: wPx / S };
      x += wPx + 2;
    }
    this.atlas.needsUpdate = true;
  }

  private glyphMaterial(): THREE.MeshBasicNodeMaterial {
    const m = basicMaterial('label-glyph');
    m.transparent = true;
    m.depthWrite = false;
    m.depthTest = false;
    const q0 = attribute('q0', 'vec4');
    const q1 = attribute('q1', 'vec4');
    const tex = texture(this.atlas, mix(q0.xy, q0.zw, uv()));
    // Text #e8e2d9 for the number, #a39a8e for the words (q1.y picks).
    m.colorNode = mix(vec3(0.37, 0.32, 0.27), vec3(0.8, 0.76, 0.69), q1.y);
    m.opacityNode = tex.w.mul(q1.x);
    return m;
  }
}

/** Axis-aligned frame of size (w, h) centred on (x, y). */
function box(out: ReturnType<typeof affine>, x: number, y: number, w: number, h: number): ReturnType<typeof affine> {
  setFrame(out, x, y, 0, 1);
  out.a = w;
  out.d = h;
  return out;
}

/** Rounded dark pill with a colour chip on the left. q0 = width px, height px, alpha; q1 = chip rgb. */
function pillMaterial(): THREE.MeshBasicNodeMaterial {
  const m = basicMaterial('label-pill');
  m.transparent = true;
  m.depthWrite = false;
  m.depthTest = false;
  const q0 = attribute('q0', 'vec4');
  const q1 = attribute('q1', 'vec4');
  const out = Fn(() => {
    const size = vec2(q0.x, q0.y);
    const p = uv().sub(0.5).mul(size);
    const r = float(5);
    const d = length(max(p.abs().sub(size.mul(0.5)).add(r), 0)).sub(r);
    const a = smoothstep(0.8, -0.8, d);
    const fromLeft = p.x.add(size.x.mul(0.5));
    const chip = smoothstep(PAD_X - 0.5, PAD_X, fromLeft).mul(smoothstep(PAD_X + CHIP_W + 0.5, PAD_X + CHIP_W, fromLeft)).mul(smoothstep(4.5, 3.5, p.y.abs()));
    const col = mix(vec3(0.0044, 0.004, 0.0037), q1.xyz, chip);
    return vec4(col, a.mul(mix(float(0.82), float(1), chip)).mul(q0.z));
  })();
  m.colorNode = out.xyz;
  m.opacityNode = out.w;
  return m;
}
