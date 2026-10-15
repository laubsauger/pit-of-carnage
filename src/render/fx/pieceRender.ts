// Owned by: render-fx
/**
 * Draws pieces (gibs, limbs, helmets, weapons) from the CPU piece pool as two instanced quad
 * meshes sampling the part atlas: a soft drop shadow on the floor that slides away and blurs as the
 * piece rises (the top-down camera's only height cue), and the lit piece itself. Owner colours are
 * applied through the atlas tint mask. Airborne pieces draw above fighters, landed ones below.
 */

import * as THREE from 'three/webgpu';
import {
  clamp, cos, float, instanceIndex, mix, positionLocal, select, sin, texture, uv, varying, vec2, vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { LAYER_HEIGHT } from '../../core';
import { InstanceBuffers } from './instances';
import { ATLAS, PARTS, partCell } from './parts';
import type { Piece } from './pieces';
import { floorQuad } from './quads';

/** Linear value of the atlas' base cloth grey; tinted texels are rescaled from it to the owner colour. */
const CLOTH_LINEAR = 0.552;

const GLOSS: Readonly<Record<Piece['material'], number>> = { meat: 0.85, bone: 0.35, metal: 0.7, cloth: 0.05, wood: 0.2 };

export class PieceRenderer {
  readonly group = new THREE.Group();
  private readonly data: InstanceBuffers;
  private readonly body: THREE.Mesh;
  private readonly shadow: THREE.Mesh;

  constructor(atlas: THREE.Texture, capacity: number) {
    // A: x, y, height, rotation | B: size, cell, flip, squash | C: owner rgb, gloss
    this.data = new InstanceBuffers(capacity, 3);
    const [A, B, C] = this.data.nodes;
    const a = A.element(instanceIndex);
    const b = B.element(instanceIndex);
    const c = C.element(instanceIndex);
    const z = a.z;
    const corner = vec2(positionLocal.x, positionLocal.z);

    const cell = varying(b.y);
    const col = cell.mod(ATLAS.cols);
    const row = cell.div(ATLAS.cols).floor();
    const atlasUv = (vOffsetRows: number) => {
      const t = uv();
      return vec2(col.add(t.x).div(ATLAS.cols), float(1).sub(row.add(vOffsetRows).add(float(1).sub(t.y)).div(ATLAS.rows * 2)));
    };

    const place = (scale: Node<'float'>, dx: Node<'float'>, dy: Node<'float'>) => {
      const local = vec2(corner.x.mul(scale), corner.y.mul(scale).mul(b.z).mul(b.w));
      const cr = cos(a.w);
      const sr = sin(a.w);
      return vec2(local.x.mul(cr).sub(local.y.mul(sr)).add(a.x).add(dx), local.x.mul(sr).add(local.y.mul(cr)).add(a.y).add(dy));
    };

    // ---- Shadow ---------------------------------------------------------------------------------
    const sp = place(b.x.mul(float(1).add(z.mul(0.01))), z.mul(0.42).add(1.2), z.mul(0.62).add(1.8));
    const smat = new THREE.MeshBasicNodeMaterial();
    smat.lights = false;
    smat.transparent = true;
    // Discard empty texels: they would otherwise blank the bloom (emissive) input under the quad.
    smat.alphaTest = 0.01;
    smat.depthWrite = false;
    smat.positionNode = vec3(sp.x, LAYER_HEIGHT.floorFx + 0.05, sp.y);
    const blur = varying(clamp(z.mul(0.05).add(1.2), 0, 5));
    const fade = varying(clamp(float(1).sub(z.div(170)), 0.15, 1));
    smat.colorNode = vec3(0.02, 0.01, 0.01);
    smat.opacityNode = texture(atlas, atlasUv(0)).level(blur).a.mul(0.5).mul(fade);
    this.shadow = new THREE.Mesh(floorQuad(), smat);

    // ---- Body -----------------------------------------------------------------------------------
    const bp = place(b.x.mul(float(1).add(z.mul(0.008))), float(0), float(0));
    const height = select(z.greaterThan(3), float(LAYER_HEIGHT.air).add(z.mul(0.01)), float(LAYER_HEIGHT.floorItems).add(a.w.mul(0.0001)));
    const bmat = new THREE.MeshStandardNodeMaterial();
    bmat.transparent = true;
    bmat.alphaTest = 0.02;
    bmat.depthWrite = false;
    bmat.positionNode = vec3(bp.x, height, bp.y);
    const tex = texture(atlas, atlasUv(0));
    const maskTex = texture(atlas, atlasUv(ATLAS.rows));
    const tint = varying(vec3(c.x, c.y, c.z));
    const mask = maskTex.r.mul(maskTex.a);
    const tinted = tint.mul(tex.rgb.div(CLOTH_LINEAR)).mul(0.95);
    bmat.colorNode = mix(tex.rgb, tinted, mask);
    bmat.opacityNode = tex.a;
    const gloss = varying(c.w);
    bmat.roughnessNode = float(0.92).sub(gloss.mul(0.6));
    bmat.metalnessNode = float(0);
    this.body = new THREE.Mesh(floorQuad(), bmat);
    this.body.receiveShadow = true;

    for (const m of [this.shadow, this.body]) {
      m.frustumCulled = false;
      m.count = 2;
      m.visible = false;
      this.group.add(m);
    }
    this.shadow.renderOrder = 1;
    this.body.renderOrder = 3;
    this.shadow.name = 'fx-piece-shadows';
    this.body.name = 'fx-pieces';
    this.group.name = 'fx-pieces';
  }

  /** Write the active pieces into the instance buffers. */
  sync(pieces: readonly Piece[]): void {
    const [A, B, C] = this.data.arrays;
    let n = 0;
    for (const p of pieces) {
      if (!p.active || n >= this.data.capacity) continue;
      const i = n * 4;
      const def = PARTS[p.part];
      A[i] = p.x;
      A[i + 1] = p.y;
      A[i + 2] = p.z;
      A[i + 3] = p.rot;
      B[i] = def.span;
      B[i + 1] = partCell(p.part);
      B[i + 2] = p.flip;
      B[i + 3] = def.rolls ? 0.62 + 0.38 * Math.abs(Math.cos(p.tumble)) : 1;
      C[i] = def.tinted ? p.r : 1;
      C[i + 1] = def.tinted ? p.g : 1;
      C[i + 2] = def.tinted ? p.b : 1;
      C[i + 3] = GLOSS[p.material] * (def.wet > 0 ? 0.4 + 0.6 * p.streak.wet : 1);
      n++;
    }
    const visible = n > 0;
    if (n === 1) {
      // Keep instance count >= 2 (see DecalPainter.render); the spare instance is zero-sized.
      B[4] = 0;
      n = 2;
    }
    this.shadow.visible = visible;
    this.body.visible = visible;
    if (!visible) return;
    this.shadow.count = n;
    this.body.count = n;
    this.data.upload(n);
  }

  dispose(): void {
    for (const m of [this.shadow, this.body]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
