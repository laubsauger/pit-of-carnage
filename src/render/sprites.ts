/**
 * Instanced flat quads with procedural TSL fragment shaders: fighter ground decals (contact
 * shadow, team ring, selection), additive glows (orbs, shrine, pickups, torch halos) and fire.
 *
 * Geometry is a unit quad on the floor plane (u along three X, v along three Z), placed by the
 * same 2D affine + height as the cut-out parts. Each instance carries 12 floats as q0, q1, q2 (or
 * 16 with q3, for materials that need more).
 */

import * as THREE from 'three/webgpu';
import {
  Fn, atan, attribute, float, fract, length, max, mix, mx_noise_float, smoothstep, sin, step, time, uv, vec2, vec3,
} from 'three/tsl';
import { basicMaterial, setEmissive } from './cutout';
import type { Affine } from './affine';

export const QUAD_FLOATS = 12;

function unitQuad(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  return g;
}

export class QuadBatch {
  readonly mesh: THREE.InstancedMesh;
  readonly data: Float32Array;
  /** Floats per instance (QUAD_FLOATS, or 16 with q3). */
  readonly stride: number;
  private readonly buffer: THREE.InstancedInterleavedBuffer;
  private readonly matrices: Float32Array;
  private n = 0;

  constructor(name: string, material: THREE.Material, readonly capacity: number, vec4s: 3 | 4 = 3) {
    const geometry = unitQuad();
    this.stride = vec4s * 4;
    this.data = new Float32Array(capacity * this.stride);
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, this.stride, 1);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < vec4s; i++) geometry.setAttribute(`q${i}`, new THREE.InterleavedBufferAttribute(this.buffer, 4, i * 4));
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.matrices = this.mesh.instanceMatrix.array as Float32Array;
  }

  begin(): void {
    this.n = 0;
  }

  /** Add an instance; returns its float offset into `data` (fill `stride` floats), or -1 when full. */
  push(t: Affine, h: number): number {
    const i = this.n;
    if (i >= this.capacity) return -1;
    this.n++;
    const m = this.matrices;
    const o = i * 16;
    m[o] = t.a;
    m[o + 1] = 0;
    m[o + 2] = t.b;
    m[o + 3] = 0;
    m[o + 4] = 0;
    m[o + 5] = 1;
    m[o + 6] = 0;
    m[o + 7] = 0;
    m[o + 8] = t.c;
    m[o + 9] = 0;
    m[o + 10] = t.d;
    m[o + 11] = 0;
    m[o + 12] = t.tx;
    m[o + 13] = h;
    m[o + 14] = t.ty;
    m[o + 15] = 1;
    const k = i * this.stride;
    this.data.fill(0, k, k + this.stride);
    return k;
  }

  end(): void {
    this.mesh.count = this.n;
    if (this.n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.buffer.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

const q0 = attribute('q0', 'vec4');
const q1 = attribute('q1', 'vec4');
const q2 = attribute('q2', 'vec4');

/** Centred quad coordinates in -1..1. */
const centred = uv().sub(0.5).mul(2);

/**
 * Fighter ground decal. q0 = team rgb + ring radius (0..1 of the quad half-size),
 * q1 = selected, hovered, haste, slow; q2 = shadow strength, berserk, alpha, spin seed.
 */
export function groundDecalMaterial(): THREE.MeshBasicNodeMaterial {
  const m = basicMaterial('fighter-ground');
  m.transparent = true;
  m.depthWrite = false;
  const d = length(centred);
  const ang = atan(centred.y, centred.x);
  const ringR = q0.w;
  const t = time;
  const shadow = float(1).sub(smoothstep(ringR.mul(0.35), ringR.mul(1.02), d)).mul(q2.x).mul(0.62);
  const ring = smoothstep(0.0, 0.035, d.sub(ringR).abs().sub(0.03)).oneMinus();
  // Selection: wider bright ring with rotating dashes.
  const dash = step(0.5, fract(ang.div(Math.PI * 2).mul(14).add(t.mul(0.35)).add(q2.w)));
  const selRing = smoothstep(0.0, 0.05, d.sub(ringR.add(0.16)).abs().sub(0.035)).oneMinus().mul(dash.mul(0.65).add(0.35)).mul(q1.x);
  const hovRing = smoothstep(0.0, 0.03, d.sub(ringR.add(0.12)).abs().sub(0.015)).oneMinus().mul(q1.y);
  // Haste: fast cyan dashes; slow: icy band.
  const hasteDash = step(0.62, fract(ang.div(Math.PI * 2).mul(9).sub(t.mul(1.6)))).mul(smoothstep(0.0, 0.04, d.sub(ringR.add(0.07)).abs().sub(0.02)).oneMinus()).mul(q1.z);
  const slowBand = smoothstep(0.0, 0.08, d.sub(ringR.sub(0.08)).abs().sub(0.05)).oneMinus().mul(q1.w).mul(0.7);
  const rage = sin(t.mul(12)).mul(0.3).add(0.7).mul(q2.y);
  const teamCol = mix(q0.xyz, vec3(1.0, 0.18, 0.08), rage.mul(0.6));
  const ringA = max(max(ring.mul(0.9), selRing), max(hovRing.mul(0.8), max(hasteDash, slowBand)));
  const ringCol = mix(mix(teamCol, vec3(1, 0.93, 0.78), selRing.add(hovRing).clamp(0, 1).mul(0.55)), vec3(0.45, 0.85, 1.0), max(hasteDash, slowBand));
  const alpha = float(1).sub(float(1).sub(shadow).mul(float(1).sub(ringA))).mul(q2.z);
  m.colorNode = Fn(() => ringCol.mul(ringA.div(max(alpha, 0.001))).mul(q2.z))();
  m.opacityNode = alpha;
  setEmissive(m, ringCol.mul(selRing.mul(0.5).add(hasteDash.mul(0.6))));
  return m;
}

/** Additive radial glow. q0 = rgb x intensity, q1.x = core size 0..1 (sharper hot centre). */
export function glowMaterial(): THREE.MeshBasicNodeMaterial {
  const m = basicMaterial('glow');
  m.transparent = true;
  m.depthWrite = false;
  m.blending = THREE.AdditiveBlending;
  const d = length(centred);
  const halo = float(1).sub(d).max(0).pow(2.2);
  const core = smoothstep(q1.x.mul(0.4), q1.x, d).oneMinus().mul(step(0.001, q1.x));
  const c = q0.xyz.mul(halo.add(core.mul(1.5)));
  m.colorNode = c;
  m.opacityNode = float(1);
  setEmissive(m, c.mul(0.8));
  return m;
}

/**
 * Fire seen from above: a ragged, licking blob with a white-hot core. q0.x = seed, q0.y = intensity,
 * q0.z = speed. Additive and emissive so it blooms.
 */
export function fireMaterial(): THREE.MeshBasicNodeMaterial {
  const m = basicMaterial('fire');
  m.transparent = true;
  m.depthWrite = false;
  m.blending = THREE.AdditiveBlending;
  const col = Fn(() => {
    const p = centred;
    const d = length(p);
    const ang = atan(p.y, p.x);
    const t = time.mul(q0.z.add(1)).add(q0.x.mul(17.0));
    const n1 = mx_noise_float(vec3(p.mul(2.6), t.mul(1.7)));
    const n2 = mx_noise_float(vec3(vec2(ang.mul(1.6), d.mul(3.0).sub(t.mul(2.4))), q0.x));
    const reach = n2.mul(0.22).add(n1.mul(0.12)).add(0.62);
    const heat = float(1).sub(d.div(reach)).clamp(0, 1);
    const flame = heat.pow(1.3);
    const c = mix(mix(vec3(0.75, 0.08, 0.02), vec3(1.0, 0.45, 0.06), smoothstep(0.0, 0.45, flame)), vec3(1.0, 0.92, 0.65), smoothstep(0.55, 0.95, flame));
    return c.mul(flame.mul(1.3)).mul(q0.y);
  })();
  m.colorNode = col;
  m.opacityNode = float(1);
  setEmissive(m, col.mul(0.9));
  return m;
}

/**
 * Acid pool: bubbling green with a bright rim, fading as it dries. q0.x = seed, q0.y = life 0..1.
 */
export function acidMaterial(): THREE.MeshBasicNodeMaterial {
  const m = basicMaterial('acid');
  m.transparent = true;
  m.depthWrite = false;
  const d = length(centred);
  const t = time.mul(0.8).add(q0.x);
  const wobble = mx_noise_float(vec3(centred.mul(2.2), t.mul(0.5))).mul(0.12);
  const edge = d.add(wobble);
  const body = smoothstep(0.7, 0.92, edge).oneMinus();
  const rim = smoothstep(0.0, 0.1, edge.sub(0.8).abs()).oneMinus();
  const bubbles = smoothstep(0.55, 0.85, mx_noise_float(vec3(centred.mul(7), t.mul(1.7))));
  const col = mix(vec3(0.08, 0.42, 0.05), vec3(0.45, 1.0, 0.25), bubbles.mul(0.6).add(rim.mul(0.8)));
  m.colorNode = col;
  m.opacityNode = body.mul(0.72).add(rim.mul(0.25)).mul(q0.y).clamp(0, 1);
  setEmissive(m, vec3(0.1, 0.5, 0.05).mul(bubbles.add(rim).mul(q0.y)).mul(0.6));
  return m;
}
