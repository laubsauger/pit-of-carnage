/**
 * A preallocated triangle soup rewritten every frame: position + rgba per vertex, one draw call.
 * Used for strike smears, vision cones, the steering ring and target lines. Nothing is allocated
 * after construction; `begin()` / `tri()` / `end()` fill the buffers in place.
 */

import * as THREE from 'three/webgpu';
import { attribute, float } from 'three/tsl';
import { basicMaterial, setEmissive } from './cutout';

export class DynamicMesh {
  readonly mesh: THREE.Mesh;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private n = 0;

  constructor(name: string, readonly maxVerts: number, opts: { additive?: boolean; emissive?: number; depthTest?: boolean } = {}) {
    this.pos = new Float32Array(maxVerts * 3);
    this.col = new Float32Array(maxVerts * 4);
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('vcol', this.colAttr);
    g.setDrawRange(0, 0);
    const m = basicMaterial(name);
    m.transparent = true;
    m.depthWrite = false;
    m.depthTest = opts.depthTest ?? true;
    if (opts.additive) m.blending = THREE.AdditiveBlending;
    const vcol = attribute('vcol', 'vec4');
    m.colorNode = vcol.xyz;
    m.opacityNode = vcol.w;
    if (opts.emissive) setEmissive(m, vcol.xyz.mul(vcol.w).mul(float(opts.emissive)));
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
  }

  begin(): void {
    this.n = 0;
  }

  /** Room left, in vertices. */
  room(): number {
    return this.maxVerts - this.n;
  }

  /** Append one vertex (world x, y at height h) with colour (linear rgb) and alpha. */
  vert(x: number, y: number, h: number, r: number, g: number, b: number, a: number): void {
    if (this.n >= this.maxVerts) return;
    const i = this.n++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = h;
    this.pos[i * 3 + 2] = y;
    this.col[i * 4] = r;
    this.col[i * 4 + 1] = g;
    this.col[i * 4 + 2] = b;
    this.col[i * 4 + 3] = a;
  }

  /** Quad from two edge pairs: (x0,y0)-(x1,y1) at alpha a0 and (x2,y2)-(x3,y3) at alpha a1. */
  quad(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, h: number, r: number, g: number, b: number, a0: number, a1: number): void {
    if (this.room() < 6) return;
    this.vert(x0, y0, h, r, g, b, a0);
    this.vert(x1, y1, h, r, g, b, a0);
    this.vert(x2, y2, h, r, g, b, a1);
    this.vert(x1, y1, h, r, g, b, a0);
    this.vert(x3, y3, h, r, g, b, a1);
    this.vert(x2, y2, h, r, g, b, a1);
  }

  /** Thick line segment from (x0, y0) to (x1, y1). */
  line(x0: number, y0: number, x1: number, y1: number, width: number, h: number, r: number, g: number, b: number, a0: number, a1 = a0): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) return;
    const nx = (-dy / len) * width * 0.5;
    const ny = (dx / len) * width * 0.5;
    this.quad(x0 + nx, y0 + ny, x0 - nx, y0 - ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, h, r, g, b, a0, a1);
  }

  end(): void {
    this.mesh.geometry.setDrawRange(0, this.n);
    if (this.n > 0) {
      this.posAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
