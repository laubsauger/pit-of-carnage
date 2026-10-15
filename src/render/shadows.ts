/**
 * Soft body shadows. Walls and pillars get their torch shadows from the light field (the same 2D
 * occlusion the sim uses); fighters, their weapons and projectiles in flight are not part of that
 * model, so they get cosmetic shadows here: for each light that noticeably lights a caster (up to
 * three: wall torches, fire pits, explosion flashes) one soft quad on the floor darkens it away
 * from that light.
 *
 * - A body is an upright column: its shadow runs from its feet to where its top projects, tapered
 *   and fading toward the far end, with a penumbra that widens with length.
 * - The held weapon is a thin bar at hand height, projected end to end, in the same quad as the
 *   body (union, so a body and its sword from one torch never darken each other twice).
 * - Projectiles are short bars high in the air: a small shadow pushed a little away from the light.
 *
 * How dark a shadow gets is that light's share of the light falling on the caster, so a body under
 * a single torch throws a deep shadow while one in a bright, evenly lit hall throws faint ones.
 * Quads sit just above the floor, under every floor item, prop and fighter (depth-tested), and
 * blend transparent black, so gore under a body darkens with the floor.
 */

import type * as THREE from 'three/webgpu';
import { Fn, attribute, dot, float, length, max, mix, positionWorld, smoothstep, step, vec3 } from 'three/tsl';
import { LAYER_HEIGHT } from '../core';
import type { Vec2 } from '../core';
import { affine } from './affine';
import { basicMaterial } from './cutout';
import type { LightField } from './lightfield';
import { newShadowLight, projectShadow } from './lightmath';
import type { ShadowLight } from './lightmath';
import { QuadBatch } from './sprites';

/** Most lights one caster throws shadows from. */
const LIGHTS_PER_CASTER = 3;
const CAPACITY = 768;
/** Darkest a body shadow gets (a wall's shadow is fully dark; a body is smaller and softer). */
const DARKNESS = 0.82;
/**
 * Removing a light's share of the light reads much weaker after tone mapping in a bright torch
 * pool, so the share is boosted: a light giving 40% of the light throws a clearly visible shadow.
 */
const SHARE_GAIN = 1.7;
/** Shadow strength left at the far end of a body shadow (contact shadows are darkest). */
const FAR_FADE = 0.4;

function shadowStrength(share: number): number {
  return Math.min(DARKNESS, share * SHARE_GAIN);
}
const HEIGHT = LAYER_HEIGHT.floor + 0.25;

/** A thin object held or flying at height `h` (world px), from (ax, ay) to (bx, by), radius `r`. */
export type ShadowBar = { ax: number; ay: number; bx: number; by: number; r: number; h: number; on: boolean };

export function newShadowBar(): ShadowBar {
  return { ax: 0, ay: 0, bx: 0, by: 0, r: 0, h: 0, on: false };
}

export class ShadowLayer {
  readonly mesh: THREE.InstancedMesh;
  private readonly batch: QuadBatch;
  private readonly field: LightField;
  private readonly lights: ShadowLight[] = [];
  private readonly T = affine();
  private readonly top: Vec2 = { x: 0, y: 0 };
  private readonly c: Vec2 = { x: 0, y: 0 };
  private readonly d: Vec2 = { x: 0, y: 0 };

  constructor(field: LightField) {
    this.field = field;
    for (let i = 0; i < LIGHTS_PER_CASTER; i++) this.lights.push(newShadowLight());
    this.batch = new QuadBatch('body-shadows', shadowMaterial(), CAPACITY, 4);
    this.mesh = this.batch.mesh;
    // After the floor (-10), before acid pools and every other transparent floor effect.
    this.mesh.renderOrder = -5;
  }

  begin(): void {
    this.batch.begin();
  }

  end(): void {
    this.batch.end();
  }

  /**
   * An upright body standing at (x, y): radius `r0` at the feet, `r1` at its top (height `h`),
   * shadow at most `maxLen` px long, plus an optional held bar (its weapon). `strength` scales it
   * (a fading corpse, a half-visible effect).
   */
  body(x: number, y: number, r0: number, r1: number, h: number, maxLen: number, held: ShadowBar | null, heldMax: number, strength = 1): void {
    const n = this.field.shadowLights(x, y, this.lights, LIGHTS_PER_CASTER);
    for (let i = 0; i < n; i++) {
      const l = this.lights[i]!;
      const len = projectShadow(l.x, l.y, l.height, x, y, h, maxLen, this.top);
      const k = this.quad(x, y, this.top.x, this.top.y, r0, r1, 1.5, 2 + len * 0.12, held, heldMax, l, shadowStrength(l.share) * strength, FAR_FADE);
      if (k < 0) return;
    }
  }

  /** A thin object in flight (arrow, axe): both ends pushed away from each light, never more than `maxOffset` px. */
  flying(bar: ShadowBar, maxOffset: number, strength = 1): void {
    const n = this.field.shadowLights((bar.ax + bar.bx) / 2, (bar.ay + bar.by) / 2, this.lights, LIGHTS_PER_CASTER);
    for (let i = 0; i < n; i++) {
      const l = this.lights[i]!;
      const off = projectShadow(l.x, l.y, l.height, bar.ax, bar.ay, bar.h, maxOffset, this.c);
      projectShadow(l.x, l.y, l.height, bar.bx, bar.by, bar.h, maxOffset, this.d);
      const s = 1.2 + off * 0.06;
      // Higher objects throw paler shadows (more light wraps around them).
      if (this.quad(this.c.x, this.c.y, this.d.x, this.d.y, bar.r, bar.r, s, s, null, 0, l, shadowStrength(l.share) * 0.7 * strength, 1) < 0) return;
    }
  }

  dispose(): void {
    this.batch.dispose();
  }

  /** One shadow quad: capsule a-b (radii r0..r1, softness s0..s1), plus the held bar projected from light `l`. */
  private quad(
    ax: number, ay: number, bx: number, by: number, r0: number, r1: number, s0: number, s1: number,
    held: ShadowBar | null, heldMax: number, l: ShadowLight, strength: number, fade: number,
  ): number {
    let minX = Math.min(ax, bx);
    let maxX = Math.max(ax, bx);
    let minY = Math.min(ay, by);
    let maxY = Math.max(ay, by);
    let pad = Math.max(r0 + s0, r1 + s1);
    let hr = 0;
    let hs = 0;
    const c = this.c;
    const d = this.d;
    if (held && held.on) {
      const off = projectShadow(l.x, l.y, l.height, held.ax, held.ay, held.h, heldMax, c);
      projectShadow(l.x, l.y, l.height, held.bx, held.by, held.h, heldMax, d);
      hr = held.r;
      hs = 1.5 + off * 0.08;
      minX = Math.min(minX, c.x, d.x);
      maxX = Math.max(maxX, c.x, d.x);
      minY = Math.min(minY, c.y, d.y);
      maxY = Math.max(maxY, c.y, d.y);
      pad = Math.max(pad, hr + hs);
    }
    const T = this.T;
    T.a = maxX - minX + pad * 2;
    T.b = 0;
    T.c = 0;
    T.d = maxY - minY + pad * 2;
    T.tx = (minX + maxX) / 2;
    T.ty = (minY + maxY) / 2;
    const k = this.batch.push(T, HEIGHT);
    if (k < 0) return -1;
    const q = this.batch.data;
    q[k] = ax;
    q[k + 1] = ay;
    q[k + 2] = bx;
    q[k + 3] = by;
    q[k + 4] = r0;
    q[k + 5] = r1;
    q[k + 6] = s0;
    q[k + 7] = s1;
    q[k + 8] = hr > 0 ? c.x : 0;
    q[k + 9] = hr > 0 ? c.y : 0;
    q[k + 10] = hr > 0 ? d.x : 0;
    q[k + 11] = hr > 0 ? d.y : 0;
    q[k + 12] = hr;
    q[k + 13] = hs;
    q[k + 14] = strength;
    q[k + 15] = fade;
    return k;
  }
}

/**
 * q0 = capsule a, b (world); q1 = radius at a, at b, softness at a, at b; q2 = held bar ends
 * (world); q3 = held radius (0 = none), held softness, strength, fade at b.
 */
function shadowMaterial(): THREE.MeshBasicNodeMaterial {
  const m = basicMaterial('body-shadow');
  m.transparent = true;
  m.depthWrite = false;
  const q0 = attribute('q0', 'vec4');
  const q1 = attribute('q1', 'vec4');
  const q2 = attribute('q2', 'vec4');
  const q3 = attribute('q3', 'vec4');
  m.colorNode = vec3(0);
  m.opacityNode = Fn(() => {
    const p = positionWorld.xz;
    // Tapered capsule (the body column or the flying bar).
    const pa = p.sub(q0.xy);
    const ba = q0.zw.sub(q0.xy);
    const t = dot(pa, ba).div(max(dot(ba, ba), 1e-4)).clamp(0, 1);
    const r = mix(q1.x, q1.y, t);
    const s = mix(q1.z, q1.w, t).max(0.5);
    const d1 = length(pa.sub(ba.mul(t))).sub(r);
    const o1 = smoothstep(s.negate(), s, d1).oneMinus().mul(mix(float(1), q3.w, t));
    // Held bar.
    const pc = p.sub(q2.xy);
    const dc = q2.zw.sub(q2.xy);
    const t2 = dot(pc, dc).div(max(dot(dc, dc), 1e-4)).clamp(0, 1);
    const s2 = q3.y.max(0.5);
    const d2 = length(pc.sub(dc.mul(t2))).sub(q3.x);
    const o2 = smoothstep(s2.negate(), s2, d2).oneMinus().mul(step(0.01, q3.x));
    return max(o1, o2).mul(q3.z);
  })();
  return m;
}
