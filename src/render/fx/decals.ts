// Owned by: render-fx
/**
 * Paints persistent gore into the floor decal target. The target holds a multiply colour for the
 * floor (white = clean) and gore coverage in alpha (the floor reads it as wetness). Stamps queued
 * during a frame are drawn as instanced quads with the procedural masks in one pass. Each stamp is
 * a transmittance multiplied into the target (see `decalShade`), so blood builds up like a real
 * absorbing film: a single spray stays bright red, pools and trampled areas darken to maroon.
 *
 * Decal space: an orthographic camera spans [0, floorSize.x] x [0, floorSize.y] with world y = 0 at
 * the top of the target, so the floor shader reads world (x, y) at
 * `texture(target.texture, vec2(x / floorSize.x, y / floorSize.y))` (verified on WebGPU: with
 * y = 0 at the bottom the gore came out mirrored). The flip reverses triangle winding, so every
 * decal material is double-sided.
 *
 * Curing: after every batch of stamps (and every `DRYING.interval` otherwise) one full-target quad
 * clamps the colour up to `GORE_FLOOR` (max blending), so overlapping blood ends as deep maroon
 * instead of black, and dries the wetness in alpha (`DRYING.wetHalfLife`). Blood never fades.
 */

import * as THREE from 'three/webgpu';
import { cos, float, instanceIndex, positionLocal, select, sin, uniform, uv, varying, vec2, vec3, vec4 } from 'three/tsl';
import type { Vec2 } from '../../core';
import { InstanceBuffers } from './instances';
import { DECAL, decalShade } from './masks';
import { DRYING, GORE_FLOOR, dryFraction } from './palette';


/**
 * Decal blending: colour = target x stamp transmittance; alpha = coverage union (blood) or the
 * target's coverage reduced by the stamp's (scorch dries blood out).
 */
export function useDecalBlend(m: THREE.Material, dries = false): void {
  m.transparent = true;
  m.depthTest = false;
  m.depthWrite = false;
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.DstColorFactor;
  m.blendDst = THREE.ZeroFactor;
  m.blendEquationAlpha = THREE.AddEquation;
  m.blendSrcAlpha = dries ? THREE.ZeroFactor : THREE.OneFactor;
  m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
}

export class DecalPainter {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly capacity: number;
  private readonly data: InstanceBuffers;
  private readonly meshes: THREE.Mesh[];
  /** Full-target quad that resets the target to white with zero coverage. */
  private readonly clearScene = new THREE.Scene();
  private readonly clearMesh: THREE.Mesh;
  /** Full-target quad drawn last in every pass: clamps colour to GORE_FLOOR, dries wetness. */
  private readonly cureMesh: THREE.Mesh;
  private readonly dryU = uniform(0);
  /** Game seconds since the last cure pass. */
  private sinceCure = 0;
  private target: THREE.RenderTarget;
  private n = 0;
  /** Stamps dropped because the frame's queue was full (diagnostics). */
  dropped = 0;

  constructor(target: THREE.RenderTarget, floorSize: Vec2, capacity = 8192) {
    this.target = target;
    this.capacity = capacity;
    this.camera = new THREE.OrthographicCamera(0, floorSize.x, 0, floorSize.y, 0.1, 100);
    this.camera.position.set(0, 0, 10);
    this.camera.updateMatrixWorld();
    this.camera.updateProjectionMatrix();

    // A: x, y, angle, kind | B: half length, half width, seed, wet | C: linear rgb, alpha
    this.data = new InstanceBuffers(capacity, 3);
    const [A, B, C] = this.data.nodes;
    const a = A.element(instanceIndex);
    const b = B.element(instanceIndex);
    const c = C.element(instanceIndex);
    const corner = vec2(positionLocal.x, positionLocal.y).mul(2);
    const ca = cos(a.z);
    const sa = sin(a.z);
    const isScorch = a.w.greaterThan(DECAL.print + 0.5);
    const shade = decalShade({
      q: uv().mul(2).sub(1),
      kind: varying(a.w),
      seed: varying(b.z),
      wet: varying(b.w),
      angle: varying(a.z),
      color: varying(vec3(c.x, c.y, c.z)),
      alpha: varying(float(c.w)),
    });

    // Two passes over the same stamps, both multiplying their transmittance into the colour. Blood
    // adds coverage to the target's alpha (wetness); scorch dries out what it burns (alpha shrinks).
    // Each pass collapses the other pass's stamps to zero size, so nothing is shaded twice.
    const layer = (scorch: boolean): THREE.Mesh => {
      const keep = scorch ? select(isScorch, float(1), float(0)) : select(isScorch, float(0), float(1));
      const local = vec2(corner.x.mul(b.x), corner.y.mul(b.y)).mul(keep);
      const world = vec2(local.x.mul(ca).sub(local.y.mul(sa)), local.x.mul(sa).add(local.y.mul(ca)));
      const mat = new THREE.MeshBasicNodeMaterial();
      mat.lights = false;
      mat.side = THREE.DoubleSide;
      useDecalBlend(mat, scorch);
      mat.positionNode = vec3(a.x.add(world.x), a.y.add(world.y), 0);
      mat.fragmentNode = shade;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      mesh.frustumCulled = false;
      mesh.count = 2;
      mesh.visible = false;
      mesh.renderOrder = scorch ? 1 : 0;
      mesh.name = scorch ? 'fx-decal-scorch' : 'fx-decal-blood';
      this.scene.add(mesh);
      return mesh;
    };
    this.meshes = [layer(false), layer(true)];

    // renderer.clear() premultiplies the clear colour by alpha when the canvas has alpha, which
    // would turn "white, no coverage" into black, so the target is reset by drawing instead.
    const cmat = new THREE.MeshBasicNodeMaterial();
    cmat.lights = false;
    cmat.side = THREE.DoubleSide;
    cmat.blending = THREE.NoBlending;
    cmat.depthTest = false;
    cmat.depthWrite = false;
    cmat.fragmentNode = vec4(1, 1, 1, 0);
    this.clearMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), cmat);
    this.clearMesh.frustumCulled = false;
    this.clearScene.add(this.clearMesh);

    // Cure: colour = max(target, GORE_FLOOR) (min/max blending requires factors of one); alpha =
    // target alpha x (1 - dry).
    const umat = new THREE.MeshBasicNodeMaterial();
    umat.lights = false;
    umat.side = THREE.DoubleSide;
    umat.transparent = true;
    umat.depthTest = false;
    umat.depthWrite = false;
    umat.blending = THREE.CustomBlending;
    umat.blendEquation = THREE.MaxEquation;
    umat.blendSrc = THREE.OneFactor;
    umat.blendDst = THREE.OneFactor;
    umat.blendEquationAlpha = THREE.AddEquation;
    umat.blendSrcAlpha = THREE.ZeroFactor;
    umat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    umat.fragmentNode = vec4(GORE_FLOOR.r, GORE_FLOOR.g, GORE_FLOOR.b, this.dryU);
    this.cureMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), umat);
    this.cureMesh.frustumCulled = false;
    this.cureMesh.renderOrder = 10;
    this.cureMesh.name = 'fx-decal-cure';
    this.scene.add(this.cureMesh);
    this.setFloorSize(floorSize);
  }

  /** Follow a map change: decal space always spans the current floor. */
  setFloorSize(size: Vec2): void {
    this.camera.right = size.x;
    this.camera.top = 0;
    this.camera.bottom = size.y;
    this.camera.updateProjectionMatrix();
    for (const m of [this.clearMesh, this.cureMesh]) {
      m.scale.set(size.x, size.y, 1);
      m.position.set(size.x / 2, size.y / 2, 0);
      m.updateMatrixWorld();
    }
  }

  /** Queued stamps this frame. */
  get pending(): number {
    return this.n;
  }

  /**
   * Queue a stamp. `halfLen` runs along `angle`, `halfWid` across it (px). Colour is the linear
   * multiply colour; `wet` 0..1 drives the gloss highlight.
   */
  stamp(
    kind: number, x: number, y: number, angle: number, halfLen: number, halfWid: number,
    r: number, g: number, b: number, alpha: number, wet: number, seed = Math.random() * 97,
  ): void {
    if (this.n >= this.capacity - 1) {
      this.dropped++;
      return;
    }
    const i = this.n * 4;
    const A = this.data.arrays[0];
    const B = this.data.arrays[1];
    const C = this.data.arrays[2];
    A[i] = x;
    A[i + 1] = y;
    A[i + 2] = angle;
    A[i + 3] = kind;
    B[i] = halfLen;
    B[i + 1] = halfWid;
    B[i + 2] = seed;
    B[i + 3] = wet;
    C[i] = r;
    C[i + 1] = g;
    C[i + 2] = b;
    C[i + 3] = alpha;
    this.n++;
  }

  /**
   * Draw queued stamps (and, when given, the GPU landed-drop mesh living in this scene) into the
   * target, then cure it. With nothing to draw, only cures every `DRYING.interval` game seconds.
   * `dt` is game seconds since the last call. Restores the renderer's target, MRT and autoClear.
   */
  render(renderer: THREE.WebGPURenderer, extraVisible: boolean, dt: number): void {
    this.sinceCure += dt > 0 ? dt : 0;
    const painting = this.n > 0 || extraVisible;
    if (!painting && this.sinceCure < DRYING.interval) return;
    this.dryU.value = dryFraction(this.sinceCure);
    this.sinceCure = 0;
    if (this.n === 1) {
      // Keep the instance count >= 2 so the render object never flips between instanced/non-instanced.
      this.data.arrays[1][4] = 0;
      this.data.arrays[1][5] = 0;
    }
    for (const m of this.meshes) {
      m.visible = this.n > 0;
      m.count = Math.max(2, this.n);
    }
    if (this.n > 0) this.data.upload(Math.max(2, this.n));

    this.draw(renderer, this.scene);
    this.n = 0;
  }

  /** Wipe the floor clean (white multiply, zero coverage) and drop queued stamps. */
  clear(renderer: THREE.WebGPURenderer): void {
    this.n = 0;
    this.sinceCure = 0;
    this.draw(renderer, this.clearScene);
  }

  private draw(renderer: THREE.WebGPURenderer, scene: THREE.Scene): void {
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevMrt = renderer.getMRT();
    renderer.setMRT(null);
    renderer.autoClear = false;
    renderer.setRenderTarget(this.target);
    renderer.render(scene, this.camera);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.setMRT(prevMrt);
  }

  dispose(): void {
    for (const m of [this.clearMesh, this.cureMesh]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    for (const m of this.meshes) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
