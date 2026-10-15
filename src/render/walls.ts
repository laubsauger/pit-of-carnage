/**
 * Walls and pillars: low bevelled blocks merged into one mesh. Seen from straight above only the
 * top and the bevel are visible; the bevel faces are shaded per light direction so torch-facing
 * edges catch the light and blocks read as raised. Their shadows on the floor come from the light
 * field (the same 2D shadows the sim uses), so they are not drawn here.
 */

import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, attribute, dot, float, floor, fract, hash, length, max, min, mix, mx_noise_float, normalize, positionWorld,
  select, smoothstep, vec2, vec3,
} from 'three/tsl';
import { LAYER_HEIGHT } from '../core';
import type { MapDef, Rect } from '../core';
import { basicMaterial } from './cutout';
import type { LightField } from './lightfield';

/** Height of a light above the floor when shading wall bevels (px). */
const LIGHT_HEIGHT = 70;
const TOP = LAYER_HEIGHT.walls;
/** Fixed overhead key light from the north-west, for bevel readability in the dark. */
const KEY_DIR = vec3(-0.45, 0.75, -0.48).normalize();

function lin(hex: number): THREE.Node<'vec3'> {
  const c = new THREE.Color(hex);
  return vec3(c.r, c.g, c.b);
}

/** One rect as a bevelled top: inner top quad plus four sloped bevel quads. */
function addBlock(r: Rect, kind: number, pos: number[], nrm: number[], box: number[], kinds: number[]): void {
  const b = Math.min(6, r.w / 4, r.h / 4);
  const drop = b * 1.3;
  const x0 = r.x;
  const y0 = r.y;
  const x1 = r.x + r.w;
  const y1 = r.y + r.h;
  const ix0 = x0 + b;
  const iy0 = y0 + b;
  const ix1 = x1 - b;
  const iy1 = y1 - b;
  const lo = TOP - drop;
  const quad = (a: number[], bq: number[], c: number[], d: number[], n: number[]) => {
    for (const v of [a, bq, c, a, c, d]) {
      pos.push(v[0]!, v[1]!, v[2]!);
      nrm.push(n[0]!, n[1]!, n[2]!);
      box.push(r.x, r.y, r.x + r.w, r.y + r.h);
      kinds.push(kind);
    }
  };
  const s = 1 / Math.hypot(drop, b);
  // Top.
  quad([ix0, TOP, iy0], [ix1, TOP, iy0], [ix1, TOP, iy1], [ix0, TOP, iy1], [0, 1, 0]);
  // North bevel (toward -y = three -Z).
  quad([x0, lo, y0], [x1, lo, y0], [ix1, TOP, iy0], [ix0, TOP, iy0], [0, b * s, -drop * s]);
  // South bevel.
  quad([ix0, TOP, iy1], [ix1, TOP, iy1], [x1, lo, y1], [x0, lo, y1], [0, b * s, drop * s]);
  // West bevel.
  quad([x0, lo, y0], [ix0, TOP, iy0], [ix0, TOP, iy1], [x0, lo, y1], [-drop * s, b * s, 0]);
  // East bevel.
  quad([ix1, TOP, iy0], [x1, lo, y0], [x1, lo, y1], [ix1, TOP, iy1], [drop * s, b * s, 0]);
}

export class Walls {
  readonly mesh: THREE.Mesh;
  private readonly light: LightField;

  constructor(light: LightField) {
    this.light = light;
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.buildMaterial());
    this.mesh.name = 'walls';
    this.mesh.frustumCulled = false;
  }

  setMap(map: MapDef): void {
    const pos: number[] = [];
    const nrm: number[] = [];
    const box: number[] = [];
    const kinds: number[] = [];
    for (const r of map.walls) addBlock(r, 0, pos, nrm, box, kinds);
    for (const r of map.pillars) addBlock(r, 1, pos, nrm, box, kinds);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('wallNormal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('box', new THREE.Float32BufferAttribute(box, 4));
    g.setAttribute('kind', new THREE.Float32BufferAttribute(kinds, 1));
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
  }

  private buildMaterial(): THREE.MeshBasicNodeMaterial {
    const m = basicMaterial('walls');
    const light = this.light;
    const nrm = attribute('wallNormal', 'vec3');
    const box = attribute('box', 'vec4');
    const kind = attribute('kind', 'float');
    m.colorNode = Fn(() => {
      const p = positionWorld.xz;
      const h = positionWorld.y;
      const n = normalize(nrm);
      // Stone courses run along the block's long axis.
      const size = box.zw.sub(box.xy);
      const along = select(size.x.greaterThan(size.y), p, vec2(p.y, p.x));
      const bw = float(34);
      const bh = float(17);
      const row = floor(along.y.div(bh));
      const q = vec2(along.x.add(row.mod(2).mul(bw.mul(0.5))), along.y);
      const cell = floor(q.div(vec2(bw, bh)));
      const f = fract(q.div(vec2(bw, bh)));
      const edge = min(min(f.x, float(1).sub(f.x)).mul(bw), min(f.y, float(1).sub(f.y)).mul(bh));
      const mortar = smoothstep(0.6, 2.2, edge);
      const tint = hash(cell.x.add(cell.y.mul(311)).add(kind.mul(71)));
      const grain = mx_noise_float(vec3(p.mul(1 / 7), 3.0)).mul(0.07).add(1);
      const wallStone = mix(lin(0x5a5248), lin(0x6e655a), tint);
      // Pillars: a carved cap ring inset from the edge.
      const edgeDist = min(min(p.x.sub(box.x), box.z.sub(p.x)), min(p.y.sub(box.y), box.w.sub(p.y)));
      const capRing = smoothstep(0, 1.5, edgeDist.sub(9).abs()).oneMinus().mul(kind);
      const stone = mix(lin(0x17140f), wallStone.mul(grain), mortar).mul(float(1).sub(capRing.mul(0.45)));
      // Unoccluded light with a Lambert term (bevels facing a torch catch it).
      const sum = vec3(light.ambientColor).mul(1.2).toVar();
      Loop({ start: 0, end: light.lightCount, type: 'int' }, ({ i }) => {
        const lp = light.lightPos.element(i);
        const lc = light.lightCol.element(i);
        const d2 = p.sub(lp.xy);
        const dist = length(d2);
        If(dist.lessThan(lp.z), () => {
          const x = float(1).sub(dist.div(lp.z));
          const fall = x.mul(x).mul(float(3).sub(x.mul(2)));
          const l3 = normalize(vec3(d2.x.negate(), float(LIGHT_HEIGHT).sub(h), d2.y.negate()));
          const lambert = max(dot(n, l3), 0);
          sum.addAssign(lc.xyz.mul(fall).mul(lambert.mul(0.75).add(0.25)));
        });
      });
      // Readability in the dark: a fixed key light from the north-west (the same direction the
      // drop shadows fall from) shades the bevels, a small base keeps tops above the floor, and a
      // dark ink line outlines every block like the fighters.
      const key = max(dot(n, KEY_DIR), 0);
      const shade = stone.mul(sum.mul(0.85).add(0.07).add(key.mul(0.16)));
      const ink = smoothstep(0.4, 1.4, edgeDist).oneMinus();
      return mix(shade, vec3(0.012, 0.01, 0.009), ink);
    })();
    return m;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
