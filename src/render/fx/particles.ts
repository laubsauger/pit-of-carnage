// Owned by: render-fx
/**
 * GPU particles: blood drops, mist, sparks, dust, debris and embers, simulated by a TSL compute
 * kernel over storage buffers and drawn as one instanced quad mesh. The CPU only writes newly
 * spawned particles (ring-allocated slots, uploaded as dirty ranges), so live particles never travel
 * back to the CPU.
 *
 * Blood drops that touch the floor flip to a "landed" state for exactly one frame. A second mesh in
 * the decal scene reads the same buffers and stamps every landed drop into the floor decal target as
 * a crowned, impact-stretched splat. Everything stays on the GPU.
 */

import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  Discard, Fn, If, abs, atan, clamp, exp, float, instanceIndex, instancedArray, length, max, mix, positionLocal,
  pow, select, step, uniform, uv, varying, vec2, vec3,
} from 'three/tsl';
import { LAYER_HEIGHT } from '../../core';
import { useDecalBlend } from './decals';
import { DECAL, decalShade } from './masks';
import { DRAG, GRAVITY, GROWTH, PK } from './particleRules';
import type { ParticleKind } from './particleRules';
import { RingSlots } from './pool';
import { floorQuad, setEmissive, usePremultipliedBlend, sstep } from './quads';

const KINDS: readonly ParticleKind[] = [PK.blood, PK.mist, PK.spark, PK.dust, PK.debris, PK.ember];

/** Per-kind constant chosen in the shader: select(kind == k, table[k], ...). */
function perKind(kind: Node<'float'>, table: Readonly<Record<ParticleKind, number>>) {
  let n: Node<'float'> = float(table[PK.dead]);
  for (const k of KINDS) n = select(kind.equal(k), float(table[k]), n);
  return n;
}

export class GpuParticles {
  readonly capacity: number;
  /** Scene mesh (airborne and floor-hugging particles). */
  readonly mesh: THREE.Mesh;
  /** Decal-scene mesh that stamps landed blood drops into the floor decal target. */
  readonly decalMesh: THREE.Mesh;

  private readonly ring: RingSlots;
  private readonly bufP;
  private readonly bufV;
  private readonly bufC;
  private readonly bufM;
  private readonly bufs;
  private readonly arrays: Float32Array[];
  private readonly dtU = uniform(0);
  private readonly kernel;
  private time = 0;
  /** Game time until which some particle may still be alive / some blood drop still in flight. */
  private aliveUntil = -1;
  private bloodUntil = -1;
  private landingsThisFrame = false;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.ring = new RingSlots(capacity);
    // P: x, y, height, size | V: vx, vy, vz, life left | C: linear rgb, alpha | M: kind, state, life, seed
    // state: 0 dead, 1 alive, 2 blood drop that landed this frame (stamped, then dead).
    this.bufP = instancedArray(capacity, 'vec4');
    this.bufV = instancedArray(capacity, 'vec4');
    this.bufC = instancedArray(capacity, 'vec4');
    this.bufM = instancedArray(capacity, 'vec4');
    this.bufs = [this.bufP, this.bufV, this.bufC, this.bufM];
    this.arrays = this.bufs.map((b) => b.value.array as Float32Array);

    const P = this.bufP;
    const V = this.bufV;
    const M = this.bufM;
    const C = this.bufC;
    const dt = this.dtU;

    this.kernel = Fn(() => {
      const p = P.element(instanceIndex);
      const v = V.element(instanceIndex);
      const m = M.element(instanceIndex);
      const kind = m.x;
      If(m.y.greaterThan(1.5), () => {
        m.y.assign(0);
        p.w.assign(0);
      });
      If(m.y.greaterThan(0.5), () => {
        v.z.subAssign(perKind(kind, GRAVITY).mul(dt));
        const damp = exp(perKind(kind, DRAG).negate().mul(dt));
        v.x.mulAssign(damp);
        v.y.mulAssign(damp);
        p.x.addAssign(v.x.mul(dt));
        p.y.addAssign(v.y.mul(dt));
        p.z.addAssign(v.z.mul(dt));
        p.w.mulAssign(float(1).add(perKind(kind, GROWTH).mul(dt)));
        v.w.subAssign(dt);
        If(p.z.lessThan(0), () => {
          p.z.assign(0);
          If(kind.equal(PK.blood), () => {
            m.y.assign(2);
          })
            .ElseIf(kind.equal(PK.spark).or(kind.equal(PK.debris)).or(kind.equal(PK.ember)), () => {
              v.z.assign(v.z.negate().mul(0.32));
              v.x.mulAssign(0.6);
              v.y.mulAssign(0.6);
            })
            .Else(() => {
              v.z.assign(0);
            });
        });
        If(v.w.lessThan(0).and(m.y.lessThan(1.5)), () => {
          m.y.assign(0);
          p.w.assign(0);
        });
      });
    })().compute(capacity);

    // ---- Scene mesh -------------------------------------------------------------------------
    const p = P.element(instanceIndex);
    const v = V.element(instanceIndex);
    const m = M.element(instanceIndex);
    const c = C.element(instanceIndex);
    const kind = m.x;
    const alive = select(m.y.greaterThan(0.5).and(m.y.lessThan(1.5)), float(1), float(0));
    const corner = vec2(positionLocal.x, positionLocal.z);
    const vel = vec2(v.x, v.y);
    const sp = length(vel);
    const dir = select(sp.greaterThan(1), vel.div(max(sp, 1)), vec2(1, 0));
    const hotV = kind.equal(PK.spark).or(kind.equal(PK.ember));
    const stretch = select(hotV, float(1).add(sp.mul(0.016)).min(6), select(kind.equal(PK.blood), float(1).add(sp.mul(0.003)).min(2.2), float(1)));
    const size = p.w.mul(alive).mul(float(1).add(p.z.mul(0.006)));
    const off = dir.mul(corner.x.mul(size).mul(stretch)).add(vec2(dir.y.negate(), dir.x).mul(corner.y.mul(size)));
    const grounded = kind.equal(PK.dust).or(p.z.lessThan(0.5));
    const height = select(grounded, float(LAYER_HEIGHT.floorFx + 0.2), float(LAYER_HEIGHT.air).add(p.z.mul(0.01)));

    const mat = new THREE.MeshBasicNodeMaterial();
    mat.lights = false;
    usePremultipliedBlend(mat);
    mat.positionNode = vec3(p.x.add(off.x), height, p.y.add(off.y));
    const vKind = varying(kind);
    const vLife = varying(clamp(v.w.div(max(m.z, 0.001)), 0, 1));
    const vCol = varying(c);
    // Kinds are whole numbers; round away interpolation noise before comparing.
    const k = vKind.add(0.5).floor();
    const q = uv().mul(2).sub(1);
    const d = length(q);
    const hot = k.equal(PK.spark).or(k.equal(PK.ember));
    const isBlood = k.equal(PK.blood);
    // Covering kinds: blood (glossy dot), mist and dust (soft puffs), debris (hard chip).
    const bloodA = sstep(1.0, 0.72, d);
    const mistA = pow(clamp(float(1).sub(d), 0, 1), 2).mul(vLife);
    const dustA = sstep(1.0, 0.05, d).mul(vLife);
    const chipA = step(max(abs(q.x), abs(q.y)), 0.78).mul(clamp(vLife.mul(5), 0, 1));
    const shapeA = select(isBlood, bloodA, select(k.equal(PK.mist), mistA, select(k.equal(PK.dust), dustA, select(k.equal(PK.debris), chipA, float(0)))));
    const a = select(hot, float(0), shapeA.mul(vCol.w));
    const hl = sstep(0.55, 0.0, length(q.sub(vec2(-0.3, 0.3))));
    const base = select(isBlood, vCol.xyz.mul(float(0.85).add(hl.mul(1.2))), vCol.xyz);
    // Hot kinds add light (alpha 0) and feed the bloom through the emissive output.
    const core = exp(d.mul(d).mul(-18));
    const glowMask = sstep(1.0, 0.0, d);
    const glow = select(hot, mix(vCol.xyz, vec3(1.0, 0.96, 0.85), core).mul(glowMask).mul(vCol.w).mul(vLife.mul(0.7).add(0.3)), vec3(0));
    mat.colorNode = Fn(() => {
      // Empty quad corners must not write (they would also blank the bloom input under them).
      If(a.lessThan(0.003).and(max(glow.x, glow.y).lessThan(0.003)), () => {
        Discard();
      });
      return base.mul(a);
    })();
    mat.opacityNode = a;
    setEmissive(mat, glow);

    this.mesh = new THREE.Mesh(floorQuad(), mat);
    this.mesh.count = capacity;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
    this.mesh.name = 'fx-particles';

    // ---- Landed-drop decal mesh (decal scene: x right, y = world y, quad faces +z) ------------
    const landed = select(m.y.greaterThan(1.5).and(kind.equal(PK.blood)), float(1), float(0));
    const hs = length(vel);
    const ldir = select(hs.greaterThan(1), vel.div(max(hs, 1)), vec2(1, 0));
    const lstretch = float(1).add(clamp(hs.div(abs(v.z).add(60)).mul(0.5), 0, 1.3));
    // The drop shape sits inside ~45% of its quad, so the quad is drawn well above the drop size.
    const lsize = p.w.mul(3.2).mul(landed);
    const lcorner = vec2(positionLocal.x, positionLocal.y);
    const loff = ldir.mul(lcorner.x.mul(lsize).mul(lstretch)).add(vec2(ldir.y.negate(), ldir.x).mul(lcorner.y.mul(lsize)));
    const dmat = new THREE.MeshBasicNodeMaterial();
    dmat.lights = false;
    dmat.side = THREE.DoubleSide;
    useDecalBlend(dmat);
    dmat.positionNode = vec3(p.x.add(loff.x), p.y.add(loff.y), 0);
    dmat.fragmentNode = decalShade({
      q: uv().mul(2).sub(1),
      kind: float(DECAL.drop),
      seed: varying(m.w),
      wet: float(1),
      angle: varying(atan(ldir.y, ldir.x)),
      color: varying(vec3(c.x, c.y, c.z)),
      alpha: varying(c.w),
    });
    this.decalMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), dmat);
    this.decalMesh.count = capacity;
    this.decalMesh.frustumCulled = false;
    this.decalMesh.name = 'fx-landed-drops';
  }

  /** Queue one particle. Velocities in px/s, size in px, life in s, colour linear. */
  spawn(
    kind: ParticleKind, x: number, y: number, z: number, vx: number, vy: number, vz: number,
    size: number, life: number, r: number, g: number, b: number, a: number,
  ): void {
    const i = this.ring.alloc() * 4;
    const P = this.arrays[0];
    const V = this.arrays[1];
    const C = this.arrays[2];
    const M = this.arrays[3];
    P[i] = x;
    P[i + 1] = y;
    P[i + 2] = z;
    P[i + 3] = size;
    V[i] = vx;
    V[i + 1] = vy;
    V[i + 2] = vz;
    V[i + 3] = life;
    C[i] = r;
    C[i + 1] = g;
    C[i + 2] = b;
    C[i + 3] = a;
    M[i] = kind;
    M[i + 1] = 1;
    M[i + 2] = life;
    M[i + 3] = Math.random() * 97;
    const until = this.time + life + 0.1;
    if (until > this.aliveUntil) this.aliveUntil = until;
    if (kind === PK.blood) {
      const g0 = GRAVITY[PK.blood];
      const flight = (vz + Math.sqrt(vz * vz + 2 * g0 * Math.max(0, z))) / g0 + 0.1;
      if (this.time + flight > this.bloodUntil) this.bloodUntil = this.time + flight;
    }
  }

  private readonly addRange = (start: number, count: number): void => {
    for (const b of this.bufs) b.value.addUpdateRange(start * 4, count * 4);
  };

  /** Upload this frame's spawns and advance the simulation by `dt` (game seconds, may be 0). */
  update(renderer: THREE.WebGPURenderer, dt: number): void {
    const spawned = this.ring.pending > 0;
    if (spawned) {
      for (const b of this.bufs) b.value.clearUpdateRanges();
      this.ring.flush(this.addRange);
      for (const b of this.bufs) b.value.needsUpdate = true;
    }
    this.time += dt;
    const busy = spawned || this.time <= this.aliveUntil;
    this.mesh.visible = busy;
    // Run even when paused (dt 0): it retires drops that landed last frame so they stamp once.
    if (busy) {
      this.dtU.value = Math.min(dt, 1 / 20);
      renderer.compute(this.kernel);
    }
    this.landingsThisFrame = dt > 0 && this.time <= this.bloodUntil + dt;
  }

  /** True when blood drops may have landed in the last update (the decal pass must run). */
  get needsDecalPass(): boolean {
    return this.landingsThisFrame;
  }

  clear(): void {
    for (const a of this.arrays) a.fill(0);
    for (const b of this.bufs) {
      b.value.clearUpdateRanges();
      b.value.needsUpdate = true;
    }
    this.ring.reset();
    this.aliveUntil = -1;
    this.bloodUntil = -1;
    this.landingsThisFrame = false;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.decalMesh.geometry.dispose();
    (this.decalMesh.material as THREE.Material).dispose();
    this.kernel.dispose();
  }
}
