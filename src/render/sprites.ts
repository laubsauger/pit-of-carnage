/**
 * Instanced flat quads with procedural TSL fragment shaders: fighter ground decals (contact
 * shadow, team ring, selection), additive glows (orbs, shrine, pickups, torch halos), fire, acid
 * pools and smoke (acid fumes, sizzling fighters).
 *
 * Geometry is a unit quad on the floor plane (u along three X, v along three Z), placed by the
 * same 2D affine + height as the cut-out parts. Each instance carries 12 floats as q0, q1, q2 (or
 * 16 with q3, for materials that need more).
 */

import * as THREE from 'three/webgpu';
import {
  Fn, atan, attribute, cos, float, floor, fract, hash, length, max, mix, mx_noise_float, positionWorld, smoothstep, sin, step, time, uv,
  vec2, vec3,
} from 'three/tsl';
import { basicMaterial, setEmissive } from './cutout';
import type { Affine } from './affine';
import type { LightField } from './lightfield';

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
 * Acid pool seen from above: an opaque, sunken, churning liquid, never a see-through green light.
 * Out to in: a scorched, corroded halo eaten into the floor; a crusty, pitted rim; a dark inner
 * lip (the surface sits below the floor); then the liquid, toxic green at the shallow edge and
 * near-black toward the deep centre, slowly churning, with bubbles that swell and pop and a few
 * bright glints. Lit by the light field like the floor; only a faint glow of its own, so it reads
 * in the dark without becoming a lamp. Blood and floor never show through the liquid.
 *
 * The quad spans 2.2 x the pool radius, so the pool's edge sits at 0.91 of the half-size.
 * q0.x = seed, q0.y = life 0..1 (a drying spill shrinks toward its centre and leaves the scorch).
 */
export function acidMaterial(light: LightField): THREE.MeshBasicNodeMaterial {
  const m = basicMaterial('acid');
  m.transparent = true;
  m.depthWrite = false;
  const seed = q0.x;
  const life = q0.y.clamp(0, 1);
  const p = centred;
  const t = time.add(seed.mul(7.3));
  const d = length(p);
  const ang = atan(p.y, p.x);
  // Ragged outline, stable over time (a spill does not wobble like jelly).
  const ragged = mx_noise_float(vec3(cos(ang).mul(1.8), sin(ang).mul(1.8), seed)).mul(0.07);
  const e = d.add(ragged).div(mix(float(0.35), float(1), life));
  const liquid = smoothstep(0.735, 0.72, e);
  const rim = smoothstep(0.83, 0.8, e).mul(float(1).sub(liquid));
  const halo = smoothstep(1.0, 0.78, d.add(ragged)).mul(float(1).sub(liquid).sub(rim).max(0));

  // Churning surface: two slow noise fields drifting against each other.
  const w1 = mx_noise_float(vec3(p.mul(2.6).add(vec2(t.mul(0.07), t.mul(-0.05))), t.mul(0.11)));
  const w2 = mx_noise_float(vec3(p.mul(5.3).sub(vec2(t.mul(0.09), t.mul(0.04))).add(w1.mul(0.6)), t.mul(0.17).add(4.0)));
  const churn = w1.mul(0.6).add(w2.mul(0.4));
  const depth = smoothstep(0.1, 0.72, e);
  const surface = mix(vec3(0.002, 0.009, 0.003), vec3(0.045, 0.085, 0.01), depth.pow(2.2)).mul(churn.mul(0.3).add(1.0));
  // Foam streaks where the churn folds, mostly in the shallows.
  const foam = smoothstep(0.35, 0.55, churn).mul(depth.mul(0.8).add(0.2));
  // Sunken: a dark lip just inside the rim, as if the rim shades the surface below it.
  const lip = smoothstep(0.6, 0.725, e);
  const liquidCol = surface.add(vec3(0.016, 0.03, 0.004).mul(foam)).mul(float(1).sub(lip.mul(0.85)));

  // Bubbles: one per cell of a jittered grid, swelling and popping on its own clock.
  const g = p.mul(5.5).add(vec2(seed.mul(3.1), seed.mul(1.7)));
  const cell = floor(g);
  const f = fract(g);
  const h1 = hash(cell.x.add(cell.y.mul(57)).add(seed.mul(13)));
  const h2 = hash(cell.x.mul(31).add(cell.y).add(seed.mul(7)));
  const centre = vec2(h1, h2).mul(0.4).add(0.3);
  const cycle = fract(t.mul(h1.mul(0.35).add(0.22)).add(h2));
  const r = cycle.mul(0.24).add(0.04);
  const bd = length(f.sub(centre));
  const some = step(0.25, h2);
  const live = step(cycle, 0.86).mul(some);
  const bubble = smoothstep(r, r.sub(0.05), bd).mul(live);
  const bubbleRim = smoothstep(0.035, 0.0, bd.sub(r).abs()).mul(live);
  const popT = cycle.sub(0.86).div(0.14).clamp(0, 1);
  const pop = smoothstep(0.04, 0.0, bd.sub(popT.mul(0.42).add(0.24)).abs()).mul(step(0.86, cycle)).mul(float(1).sub(popT)).mul(some);
  const inPool = smoothstep(0.7, 0.4, e);
  const bubbled = mix(liquidCol, liquidCol.mul(0.55).add(vec3(0.02, 0.1, 0.01)), bubble.mul(inPool))
    .add(vec3(0.045, 0.13, 0.018).mul(bubbleRim.mul(0.5).add(pop.mul(0.7))).mul(inPool));
  // A few bright glints catching the light on the churning surface.
  const glint = smoothstep(0.62, 0.7, mx_noise_float(vec3(p.mul(9.0), t.mul(0.5)))).mul(smoothstep(0.1, 0.3, churn)).mul(liquid);

  // Rim: corroded crust, yellow-brown with dark pits. Halo: floor scorched dark by the fumes.
  const pits = smoothstep(0.1, 0.35, mx_noise_float(vec3(p.mul(18.0), seed)));
  const crust = mix(vec3(0.012, 0.01, 0.005), vec3(0.09, 0.085, 0.025), pits);
  const scorch = vec3(0.012, 0.014, 0.006);

  const lit = light.sample(positionWorld.xz).xyz.clamp(0.1, 1.0);
  // Faint glow of its own (the material adds the emissive to the colour and the bloom input).
  const glow = vec3(0.006, 0.03, 0.004).mul(liquid).mul(depth.add(0.3)).add(vec3(0.35, 0.8, 0.25).mul(glint.mul(0.7)));
  m.colorNode = bubbled.mul(liquid).add(crust.mul(rim)).mul(lit).add(scorch.mul(halo));
  m.opacityNode = liquid.add(rim).add(halo.mul(0.55)).clamp(0, 1).mul(smoothstep(0.0, 0.15, life));
  setEmissive(m, glow);
  return m;
}

/**
 * Smoke puff seen from above: a soft, noise-eroded blob that grows and thins as it ages. Normal
 * alpha blending (smoke is not a light). q0 = rgb + alpha, q1.x = seed, q1.y = age 0..1.
 */
export function smokeMaterial(): THREE.MeshBasicNodeMaterial {
  const m = basicMaterial('smoke');
  m.transparent = true;
  m.depthWrite = false;
  const d = length(centred);
  const age = q1.y.clamp(0, 1);
  // Two octaves of noise erode the disc into a wisp; older puffs fray more.
  const n = mx_noise_float(vec3(centred.mul(2.4), q1.x.add(age.mul(1.5)))).add(mx_noise_float(vec3(centred.mul(5.1), q1.x.add(3.7))).mul(0.5));
  const puff = smoothstep(1.0, 0.2, d.add(n.mul(0.45).add(age.mul(0.25))));
  m.colorNode = q0.xyz;
  m.opacityNode = puff.mul(q0.w);
  return m;
}
