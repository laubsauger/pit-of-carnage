// Owned by: render-fx
/**
 * Short-lived glowing shapes: impact flashes, explosion fireballs and shockwave rings (hot or dusty).
 * A small CPU pool animates them; one instanced quad mesh draws them with premultiplied blending,
 * so hot shapes add light (and bloom) while dusty rings cover the floor.
 */

import * as THREE from 'three/webgpu';
import {
  Discard, Fn, If, abs, atan, clamp, cos, exp, float, instanceIndex, length, max, mx_noise_float, positionLocal, sin, uv,
  varying, vec2, vec3,
} from 'three/tsl';
import { LAYER_HEIGHT } from '../../core';
import { cubicOut } from './easing';
import { InstanceBuffers } from './instances';
import { FixedPool } from './pool';
import type { Pooled } from './pool';
import { floorQuad, setEmissive, usePremultipliedBlend, sstep } from './quads';

export const SHAPE = { flash: 0, ring: 1 } as const;

type Shape = Pooled & {
  kind: number;
  x: number;
  y: number;
  /** Start and end radius (px). */
  r0: number;
  r1: number;
  t: number;
  dur: number;
  r: number;
  g: number;
  b: number;
  /** Brightness multiplier (HDR, > 1 blooms). */
  intensity: number;
  /** 0 = pure additive light, 1 = covers what is below (dusty ring). */
  cover: number;
  /** Ring band width as a fraction of the radius. */
  thickness: number;
  /** Draw above fighters (flashes) or on the floor (rings). */
  high: boolean;
  seed: number;
};

function makeShape(): Shape {
  return {
    active: false, serial: 0, kind: 0, x: 0, y: 0, r0: 0, r1: 0, t: 0, dur: 1, r: 1, g: 1, b: 1,
    intensity: 1, cover: 0, thickness: 0.2, high: true, seed: 0,
  };
}

export class Shapes {
  readonly mesh: THREE.Mesh;
  private readonly pool: FixedPool<Shape>;
  private readonly data: InstanceBuffers;

  constructor(capacity = 64) {
    this.pool = new FixedPool(capacity, makeShape);
    // A: x, y, radius, kind | B: rgb x intensity x fade, cover | C: thickness, height, seed, age 0..1
    this.data = new InstanceBuffers(capacity, 3);
    const [A, B, C] = this.data.nodes;
    const a = A.element(instanceIndex);
    const b = B.element(instanceIndex);
    const c = C.element(instanceIndex);
    const corner = vec2(positionLocal.x, positionLocal.z).mul(a.z.mul(2));
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.lights = false;
    usePremultipliedBlend(mat);
    mat.positionNode = vec3(a.x.add(corner.x), c.y, a.y.add(corner.y));
    const kind = varying(a.w);
    const col = varying(b);
    const thick = varying(c.x);
    const seed = varying(c.z);
    const age = varying(c.w);
    const m = Fn(() => {
      // Shared inputs as variables before branching (see masks.ts).
      const q = vec2(uv().mul(2).sub(1)).toVar();
      const d = length(q).toVar();
      const v = float(0).toVar();
      If(kind.lessThan(0.5), () => {
        // Flash: hot core with a soft halo and a few ragged rays.
        const ang = atan(q.y, q.x);
        const rays = mx_noise_float(vec3(cos(ang).mul(3), sin(ang).mul(3), seed)).mul(0.25).add(1);
        v.assign(exp(d.mul(d).mul(-9)).add(sstep(1.0, 0.0, d.mul(rays)).mul(0.35)));
      }).Else(() => {
        // Ring: band near the edge, torn up by noise as it ages.
        const band = sstep(thick, 0.0, abs(d.sub(float(1).sub(thick))));
        const tear = sstep(-0.2, 0.4, mx_noise_float(vec3(q.mul(3.5), seed)).add(float(0.6).sub(age)));
        v.assign(band.mul(tear));
      });
      return v;
    })();
    const cover = col.w;
    const alpha = clamp(m.mul(cover), 0, 1);
    // The hot part (1 - cover) adds light through the emissive output, which the post pass blooms.
    // Flashes get a white-hot core over their coloured falloff.
    const core = kind.lessThan(0.5).select(exp(length(vec2(uv().mul(2).sub(1))).pow(2).mul(-16)).mul(max(col.x, col.y)).mul(0.6), float(0));
    const glow = col.xyz.mul(m).add(vec3(core)).mul(float(1).sub(cover));
    mat.colorNode = Fn(() => {
      If(alpha.lessThan(0.003).and(max(glow.x, glow.y).lessThan(0.003)), () => {
        Discard();
      });
      return col.xyz.mul(m).mul(cover);
    })();
    mat.opacityNode = alpha;
    setEmissive(mat, glow);
    this.mesh = new THREE.Mesh(floorQuad(), mat);
    this.mesh.frustumCulled = false;
    this.mesh.count = 2;
    this.mesh.visible = false;
    this.mesh.renderOrder = 6;
    this.mesh.name = 'fx-shapes';
  }

  private start(kind: number, x: number, y: number, r0: number, r1: number, dur: number, r: number, g: number, b: number): Shape {
    const s = this.pool.acquire();
    s.kind = kind;
    s.x = x;
    s.y = y;
    s.r0 = r0;
    s.r1 = r1;
    s.t = 0;
    s.dur = dur;
    s.r = r;
    s.g = g;
    s.b = b;
    s.seed = Math.random() * 50;
    return s;
  }

  /**
   * Bright flash (impacts, explosions). Colour is linear; intensity > 1 blooms. `cover` > 0 makes
   * part of it an opaque fireball, so it keeps its colour over a bright floor.
   */
  flash(x: number, y: number, radius: number, dur: number, r: number, g: number, b: number, intensity: number, cover = 0): void {
    const s = this.start(SHAPE.flash, x, y, radius * 0.6, radius, dur, r, g, b);
    s.intensity = intensity;
    s.cover = cover;
    s.thickness = 0;
    s.high = true;
  }

  /** Expanding ring on the floor. `cover` 0 = hot light, 1 = dust. */
  ring(x: number, y: number, r0: number, r1: number, dur: number, r: number, g: number, b: number, intensity: number, cover: number, thickness = 0.22): void {
    const s = this.start(SHAPE.ring, x, y, r0, r1, dur, r, g, b);
    s.intensity = intensity;
    s.cover = cover;
    s.thickness = thickness;
    s.high = false;
  }

  update(dt: number): void {
    const [A, B, C] = this.data.arrays;
    let n = 0;
    for (const s of this.pool.items) {
      if (!s.active) continue;
      s.t += dt;
      if (s.t >= s.dur) {
        s.active = false;
        continue;
      }
      const k = s.t / s.dur;
      const grow = cubicOut(k);
      const radius = s.r0 + (s.r1 - s.r0) * grow;
      const fade = s.kind === SHAPE.flash ? (1 - k) * (1 - k) : 1 - k;
      const i = n * 4;
      A[i] = s.x;
      A[i + 1] = s.y;
      A[i + 2] = radius;
      A[i + 3] = s.kind;
      const lum = s.intensity * fade;
      B[i] = s.r * lum;
      B[i + 1] = s.g * lum;
      B[i + 2] = s.b * lum;
      B[i + 3] = s.cover * fade;
      C[i] = s.thickness * (1 - 0.5 * k);
      C[i + 1] = s.high ? LAYER_HEIGHT.air + 5 : LAYER_HEIGHT.floorFx + 0.3;
      C[i + 2] = s.seed;
      C[i + 3] = k;
      n++;
    }
    this.mesh.visible = n > 0;
    if (n === 0) return;
    if (n === 1) {
      A[6] = 0;
      n = 2;
    }
    this.mesh.count = n;
    this.data.upload(n);
  }

  clear(): void {
    this.pool.releaseAll();
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
