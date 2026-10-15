// Owned by: render-fx
/**
 * Damage numbers: small, short-lived, coloured by the attacker, crits bigger with a "!", backstabs
 * labelled. Glyphs come from a canvas atlas drawn once (white fill, ink outline); each glyph is one
 * instance of a floor-facing quad, tinted in the shader, so a hit costs no canvas work. Layout is
 * numberLayout.ts: beside the victim's body, stacked downward, never over its HP bar or name tag.
 */

import * as THREE from 'three/webgpu';
import { instanceIndex, mix, positionLocal, texture, uv, varying, vec2, vec3 } from 'three/tsl';
import { LAYER_HEIGHT } from '../../core';
import type { WorldState } from '../../core';
import { InstanceBuffers } from './instances';
import { DAMAGE_NUMBERS, damageText, mergesInto, numberEnvelope, numberOffsetY } from './numberLayout';
import { FixedPool } from './pool';
import type { Pooled } from './pool';
import { findFighter } from './popups';
import { floorQuad } from './quads';

const FONT_FAMILY = '"JetBrains Mono", ui-monospace, Menlo, monospace';
const ATLAS_W = 1024;
const ATLAS_H = 256;
/** Canvas px per glyph row and the font size drawn in it. */
const ROW = 112;
const FONT_PX = 80;
const STROKE = 16;
const GLYPHS = '0123456789!';
const LABEL = 'BACKSTAB';
const BANG = 10;
const LABEL_INDEX = 11;
const MAX_NUMBERS = 48;
const MAX_QUADS = MAX_NUMBERS * 6;

type Glyph = { u0: number; v0: number; u1: number; v1: number; adv: number; w: number };

type DamageNumber = Pooled & {
  victimId: string;
  attackerId: string;
  amount: number;
  x: number;
  y: number;
  radius: number;
  text: string;
  crit: boolean;
  backstab: boolean;
  r: number;
  g: number;
  b: number;
  t: number;
  slot: number;
  /** Displayed slot, eased toward `slot`. */
  ys: number;
};

function makeNumber(): DamageNumber {
  return {
    active: false, serial: 0, victimId: '', attackerId: '', amount: 0, x: 0, y: 0, radius: 18, text: '', crit: false, backstab: false,
    r: 1, g: 1, b: 1, t: 0, slot: 0, ys: 0,
  };
}

const env = { scale: 1, alpha: 1, rise: 0 };

export class DamageNumbers {
  readonly mesh: THREE.Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly atlas: THREE.CanvasTexture;
  private readonly data: InstanceBuffers;
  private readonly glyphs: Glyph[] = [];
  private readonly pool = new FixedPool<DamageNumber>(MAX_NUMBERS, makeNumber);
  private atlasDirty = true;
  /** Quads written this frame. */
  private q = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = ATLAS_W;
    this.canvas.height = ATLAS_H;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable for damage numbers');
    this.ctx = ctx;
    this.atlas = new THREE.CanvasTexture(this.canvas);
    this.atlas.colorSpace = THREE.SRGBColorSpace;
    this.atlas.generateMipmaps = false;
    this.atlas.minFilter = THREE.LinearFilter;
    this.atlas.magFilter = THREE.LinearFilter;
    for (let i = 0; i <= LABEL_INDEX; i++) this.glyphs.push({ u0: 0, v0: 0, u1: 0, v1: 0, adv: 0, w: 0 });
    this.drawAtlas();
    if (typeof document !== 'undefined' && document.fonts) {
      document.fonts.load(`600 ${FONT_PX}px ${FONT_FAMILY}`).then(
        () => {
          this.atlasDirty = true;
        },
        () => undefined,
      );
    }

    // A: x, y, half width, half height | B: uv rect (u0, v0, u1, v1) | C: linear rgb, alpha
    this.data = new InstanceBuffers(MAX_QUADS, 3);
    const [A, B, C] = this.data.nodes;
    const a = A.element(instanceIndex);
    const b = B.element(instanceIndex);
    const c = C.element(instanceIndex);
    const corner = vec2(positionLocal.x, positionLocal.z);
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.lights = false;
    mat.transparent = true;
    mat.depthTest = false;
    mat.depthWrite = false;
    // Discard empty texels: they would otherwise blank the bloom input under the quad.
    mat.alphaTest = 0.02;
    mat.positionNode = vec3(a.x.add(corner.x.mul(a.z.mul(2))), LAYER_HEIGHT.popups - 1, a.y.add(corner.y.mul(a.w.mul(2))));
    const rect = varying(b);
    const tint = varying(c);
    const tex = texture(this.atlas, mix(rect.xy, rect.zw, uv()));
    // White fill takes the attacker colour, the ink outline stays dark.
    mat.colorNode = tex.rgb.mul(tint.xyz);
    mat.opacityNode = tex.a.mul(tint.w);
    this.mesh = new THREE.Mesh(floorQuad(), mat);
    this.mesh.frustumCulled = false;
    this.mesh.count = 2;
    this.mesh.visible = false;
    this.mesh.renderOrder = 99;
    this.mesh.name = 'fx-damage-numbers';
  }

  /** Glyphs (white, ink outline) in row 0, the BACKSTAB label in row 1. */
  private drawAtlas(): void {
    this.atlasDirty = false;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, ATLAS_W, ATLAS_H);
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const draw = (index: number, text: string, x: number, row: number, size: number): number => {
      ctx.font = `600 ${size}px ${FONT_FAMILY}`;
      const adv = ctx.measureText(text).width;
      const w = adv + STROKE * 2;
      const y = row * ROW + ROW / 2 + size * 0.04;
      ctx.lineWidth = STROKE * (size / FONT_PX);
      ctx.strokeStyle = '#120a08';
      ctx.strokeText(text, x + STROKE, y);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, x + STROKE, y);
      const g = this.glyphs[index];
      g.u0 = x / ATLAS_W;
      g.u1 = (x + w) / ATLAS_W;
      g.v1 = 1 - (row * ROW) / ATLAS_H;
      g.v0 = 1 - ((row + 1) * ROW) / ATLAS_H;
      // Advance and cell width as fractions of the row height (the quad's height).
      g.adv = adv / ROW;
      g.w = w / ROW;
      return x + w + 4;
    };
    let x = 0;
    for (let i = 0; i < GLYPHS.length; i++) x = draw(i, GLYPHS[i], x, 0, FONT_PX);
    draw(LABEL_INDEX, LABEL, 0, 1, FONT_PX);
    this.atlas.needsUpdate = true;
  }

  /**
   * A hit on `victimId` for `amount`, in the attacker's colour (linear rgb). A quick follow-up from
   * the same attacker adds into the newest number; otherwise older numbers of the victim step down
   * and the oldest beyond `perVictim` goes. `attackerId` is '' for hazards.
   */
  add(victimId: string, attackerId: string, x: number, y: number, radius: number, amount: number, crit: boolean, backstab: boolean, r: number, g: number, b: number): void {
    let newest: DamageNumber | null = null;
    for (const n of this.pool.items) if (n.active && n.victimId === victimId && n.slot === 0) newest = n;
    if (newest && mergesInto(newest, attackerId)) {
      newest.amount += amount;
      newest.text = damageText(newest.amount);
      newest.crit = newest.crit || crit;
      newest.backstab = newest.backstab || backstab;
      newest.t = Math.min(newest.t, 0.04);
      return;
    }
    for (const n of this.pool.items) {
      if (!n.active || n.victimId !== victimId) continue;
      n.slot++;
      if (n.slot >= DAMAGE_NUMBERS.perVictim) n.active = false;
    }
    const n = this.pool.acquire();
    n.victimId = victimId;
    n.attackerId = attackerId;
    n.amount = amount;
    n.x = x;
    n.y = y;
    n.radius = radius;
    n.text = damageText(amount);
    n.crit = crit;
    n.backstab = backstab;
    n.r = r;
    n.g = g;
    n.b = b;
    n.t = 0;
    n.slot = 0;
    n.ys = 0;
  }

  /** `px` = world units per CSS px. */
  update(dt: number, state: WorldState, px: number): void {
    if (this.atlasDirty) this.drawAtlas();
    const d = DAMAGE_NUMBERS;
    this.q = 0;
    const ease = Math.min(1, dt * 16);
    for (const n of this.pool.items) {
      if (!n.active) continue;
      n.t += dt;
      if (n.t >= d.life) {
        n.active = false;
        continue;
      }
      n.ys += (n.slot - n.ys) * ease;
      const f = findFighter(state, n.victimId);
      if (f && f.alive) {
        n.x = f.pos.x;
        n.y = f.pos.y;
        n.radius = f.radius;
      }
      numberEnvelope(env, n.t, n.crit);
      const sizePx = (n.crit ? d.critSize : d.size) * env.scale;
      // Quad height covers the whole glyph row (font size x ROW / FONT_PX).
      const h = sizePx * (ROW / FONT_PX) * px;
      const radiusPx = n.radius / px;
      const cy = n.y + numberOffsetY(n.ys, env.rise, sizePx, radiusPx) * px;
      let x = n.x + n.radius + d.side * px;
      for (let k = 0; k < n.text.length; k++) {
        const gi = n.text.charCodeAt(k) - 48;
        if (gi < 0 || gi > 9) continue;
        const g = this.glyphs[gi];
        this.quad(gi, x + (g.adv * h) / 2, cy, h, n, env.alpha);
        x += g.adv * h;
      }
      if (n.crit) {
        const g = this.glyphs[BANG];
        this.quad(BANG, x + (g.adv * h) / 2, cy, h, n, env.alpha);
        x += g.adv * h;
      }
      if (n.backstab) {
        const lh = d.labelSize * (ROW / FONT_PX) * px;
        const g = this.glyphs[LABEL_INDEX];
        x += 3 * px;
        this.quad(LABEL_INDEX, x + (g.adv * lh) / 2, cy, lh, n, env.alpha);
      }
    }
    let q = this.q;
    this.mesh.visible = q > 0;
    if (q === 0) return;
    if (q === 1) {
      // Keep the instance count >= 2 (see DecalPainter.render); the spare quad is zero-sized.
      const A = this.data.arrays[0];
      A[6] = 0;
      A[7] = 0;
      q = 2;
    }
    this.mesh.count = q;
    this.data.upload(q);
  }

  /** Write one glyph quad (centre, height in world units). */
  private quad(gi: number, cx: number, cy: number, h: number, n: DamageNumber, alpha: number): void {
    if (this.q >= MAX_QUADS) return;
    const [A, B, C] = this.data.arrays;
    const g = this.glyphs[gi];
    const i = this.q * 4;
    A[i] = cx;
    A[i + 1] = cy;
    A[i + 2] = (g.w * h) / 2;
    A[i + 3] = h / 2;
    B[i] = g.u0;
    B[i + 1] = g.v0;
    B[i + 2] = g.u1;
    B[i + 3] = g.v1;
    C[i] = n.r;
    C[i + 1] = n.g;
    C[i + 2] = n.b;
    C[i + 3] = alpha;
    this.q++;
  }

  clear(): void {
    this.pool.releaseAll();
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.atlas.dispose();
  }
}
