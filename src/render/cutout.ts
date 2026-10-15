/**
 * Vector cut-out art: flat 2D shapes with a dark outline, lit by the arena light field.
 *
 * Every fighter part, prop, item and projectile is a small geometry built from polygons in its
 * local frame (u = forward = three X, v = right = three Z, height = three Y). Each fill gets an
 * outline polygon drawn just under it, so shapes stay crisp and readable at any zoom and over any
 * gore. Parts of the same kind are drawn with one InstancedMesh (one draw call for all fighters).
 *
 * Per-vertex attributes: `color` (linear rgb), `slot` (how the colour is resolved, see SLOT) and
 * `shade` (0 rim .. 1 centre, a soft dome so bodies read as round).
 * Per-instance data (12 floats): team rgb, hit flash, skin rgb, shadow, glow, berserk, alpha, spare.
 */

import * as THREE from 'three/webgpu';
import { Fn, attribute, float, luminance, mix, positionWorld, select, sin, step, time, vec3 } from 'three/tsl';
import type { Affine } from './affine';
import type { LightField } from './lightfield';
import { offsetPoly } from './poly';
import type { Poly } from './poly';

/** How a vertex colour is resolved. */
export const SLOT = {
  /** Vertex colour as is (metal, wood, leather...). */
  fixed: 0,
  /** Instance team colour x vertex colour (1 = team colour, 0.5 = darker trim). */
  team: 1,
  /** Instance skin tone x vertex colour. */
  skin: 2,
  /** Outline ink (unlit). */
  ink: 3,
  /** Emissive: vertex colour, glowing with the instance glow (weapon telegraph, staff orb). */
  glow: 4,
} as const;

/** Outline width in world px. */
export const OUTLINE = 1.6;
/** Height step between successive shapes inside one part. */
const LAYER_STEP = 0.03;
/** Fighters never go fully black, even in deep shadow (readability floor). */
const MIN_LIGHT = 0.42;
const INK = new THREE.Color(0x0b0908);

export type ShapeSpec = {
  poly: Poly;
  color?: THREE.ColorRepresentation;
  slot?: number;
  /** Outline width; 0 = none. Defaults to OUTLINE. */
  outline?: number;
  /** Dome shading from the centroid (convex shapes only). */
  dome?: boolean;
};

const _c = new THREE.Color();

const colorCache = new Map<string, THREE.Color>();

/** Parsed CSS colour (linear), cached: per-frame code never re-parses colour strings. */
export function colorOf(css: string): THREE.Color {
  let c = colorCache.get(css);
  if (!c) {
    c = new THREE.Color(css);
    colorCache.set(css, c);
  }
  return c;
}

/** Build one part geometry from shapes listed bottom to top. */
export function buildCutout(specs: readonly ShapeSpec[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const slot: number[] = [];
  const shade: number[] = [];
  const push = (u: number, h: number, v: number, c: THREE.Color, s: number, sh: number) => {
    pos.push(u, h, v);
    col.push(c.r, c.g, c.b);
    slot.push(s);
    shade.push(sh);
  };
  const addPoly = (p: Poly, h: number, c: THREE.Color, s: number, dome: boolean) => {
    const n = p.length / 2;
    if (dome) {
      let cu = 0;
      let cv = 0;
      for (let i = 0; i < n; i++) {
        cu += p[i * 2]!;
        cv += p[i * 2 + 1]!;
      }
      cu /= n;
      cv /= n;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        push(cu, h, cv, c, s, 1);
        push(p[i * 2]!, h, p[i * 2 + 1]!, c, s, 0);
        push(p[j * 2]!, h, p[j * 2 + 1]!, c, s, 0);
      }
      return;
    }
    const contour: THREE.Vector2[] = [];
    for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(p[i * 2]!, p[i * 2 + 1]!));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    for (const t of tris) {
      for (const k of t) push(contour[k]!.x, h, contour[k]!.y, c, s, 0.55);
    }
  };
  specs.forEach((spec, i) => {
    const h = i * LAYER_STEP;
    const outline = spec.outline ?? OUTLINE;
    if (outline > 0) addPoly(offsetPoly(spec.poly, outline), h - LAYER_STEP / 2, INK, SLOT.ink, false);
    _c.set(spec.color ?? 0xffffff);
    addPoly(spec.poly, h, _c, spec.slot ?? SLOT.fixed, spec.dome ?? false);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('slot', new THREE.Float32BufferAttribute(slot, 1));
  g.setAttribute('shade', new THREE.Float32BufferAttribute(shade, 1));
  return g;
}

/**
 * Unlit node material for everything the renderer draws: lighting comes from the light field, so
 * scene lights (kept only for the fx module's lit materials) are skipped entirely.
 */
export function basicMaterial(name: string): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = name;
  m.lights = false;
  m.side = THREE.DoubleSide;
  return m;
}

/**
 * Emissive output of any node material. `NodeMaterial.setupLighting` adds `emissiveNode` to the
 * colour and writes it to the `emissive` MRT target (bloom input) for every node material, but the
 * typings only declare it on the lit materials.
 */
export function setEmissive(m: THREE.NodeMaterial, node: THREE.Node): void {
  (m as unknown as { emissiveNode: THREE.Node | null }).emissiveNode = node;
}

// ---------------------------------------------------------------------------------------------
// Instance style + batches
// ---------------------------------------------------------------------------------------------

export const INSTANCE_FLOATS = 12;

/** Per-instance look, copied into the batch on push. */
export type InstanceStyle = {
  team: THREE.Color;
  flash: number;
  skin: THREE.Color;
  /** 0..1: in gameplay shadow (cool, dimmed). */
  shadow: number;
  /** 0..1: emissive glow of glow-slot shapes. */
  glow: number;
  /** 0..1: berserk ink glow. */
  berserk: number;
};

export function newStyle(): InstanceStyle {
  return { team: new THREE.Color(1, 1, 1), flash: 0, skin: new THREE.Color(1, 1, 1), shadow: 0, glow: 0, berserk: 0 };
}

export class PartBatch {
  readonly mesh: THREE.InstancedMesh;
  private readonly data: Float32Array;
  private readonly dataBuffer: THREE.InstancedInterleavedBuffer;
  private readonly matrices: Float32Array;
  private n = 0;

  constructor(name: string, geometry: THREE.BufferGeometry, material: THREE.Material, readonly capacity: number) {
    this.data = new Float32Array(capacity * INSTANCE_FLOATS);
    this.dataBuffer = new THREE.InstancedInterleavedBuffer(this.data, INSTANCE_FLOATS, 1);
    this.dataBuffer.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('iTeam', new THREE.InterleavedBufferAttribute(this.dataBuffer, 4, 0));
    geometry.setAttribute('iSkin', new THREE.InterleavedBufferAttribute(this.dataBuffer, 4, 4));
    geometry.setAttribute('iFx', new THREE.InterleavedBufferAttribute(this.dataBuffer, 4, 8));
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

  /** Add one instance at height `h` with transform `t`. Silently ignored past capacity. */
  push(t: Affine, h: number, style: InstanceStyle, glow = style.glow, alpha = 1): void {
    const i = this.n;
    if (i >= this.capacity) return;
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
    const d = this.data;
    const k = i * INSTANCE_FLOATS;
    d[k] = style.team.r;
    d[k + 1] = style.team.g;
    d[k + 2] = style.team.b;
    d[k + 3] = style.flash;
    d[k + 4] = style.skin.r;
    d[k + 5] = style.skin.g;
    d[k + 6] = style.skin.b;
    d[k + 7] = style.shadow;
    d[k + 8] = glow;
    d[k + 9] = style.berserk;
    d[k + 10] = alpha;
    d[k + 11] = 0;
  }

  end(): void {
    this.mesh.count = this.n;
    if (this.n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.dataBuffer.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

/**
 * The shared cut-out material: vertex colour resolved by slot, lit by the light field (never below
 * MIN_LIGHT), cool-dimmed in gameplay shadow, flashed white on hits, glow shapes emissive (they
 * bloom), ink outlines pulse red while berserk.
 */
export function createCutoutMaterial(light: LightField, opts: { minLight?: number } = {}): THREE.MeshBasicNodeMaterial {
  const m = basicMaterial('cutout');
  const minLight = opts.minLight ?? MIN_LIGHT;
  const vColor = attribute('color', 'vec3');
  const vSlot = attribute('slot', 'float');
  const vShade = attribute('shade', 'float');
  const iTeam = attribute('iTeam', 'vec4');
  const iSkin = attribute('iSkin', 'vec4');
  const iFx = attribute('iFx', 'vec4');

  const isTeam = step(0.5, vSlot).mul(step(vSlot, 1.5));
  const isSkin = step(1.5, vSlot).mul(step(vSlot, 2.5));
  const isInk = step(2.5, vSlot).mul(step(vSlot, 3.5));
  const isGlow = step(3.5, vSlot);

  const lit = Fn(() => {
    const base = vColor.mul(mix(vec3(1), iTeam.xyz, isTeam)).mul(mix(vec3(1), iSkin.xyz, isSkin));
    // Fighters keep their true colours under coloured torchlight: brightness follows the light,
    // hue only a little, clamped so nobody vanishes in the dark or blows out under a brazier.
    const l = light.sample(positionWorld.xz).xyz;
    const lum = luminance(l);
    const lightTerm = mix(vec3(lum), l, 0.3).clamp(minLight, 1.35).mul(vShade.mul(0.32).add(0.82));
    const shadowTint = mix(vec3(1), vec3(0.62, 0.7, 0.98), iSkin.w.mul(0.55));
    const c = base.mul(lightTerm).mul(shadowTint);
    // Glow shapes: their own colour, brighter with the instance glow.
    const glowCol = vColor.mul(iFx.x.mul(1.4).add(0.55));
    const pulse = sin(time.mul(14)).mul(0.25).add(0.75);
    const inkCol = mix(vec3(INK.r, INK.g, INK.b), vec3(0.9, 0.06, 0.03), iFx.y.mul(pulse));
    // Hit flash whitens the fills but keeps the ink outline, so the silhouette stays readable.
    const flashed = mix(select(isGlow.greaterThan(0.5), glowCol, c), vec3(1.1), iTeam.w.mul(0.85));
    return select(isInk.greaterThan(0.5), inkCol, flashed);
  })();
  m.colorNode = lit;
  setEmissive(m, Fn(() => {
    const glow = vColor.mul(iFx.x.mul(2.4)).mul(isGlow);
    const rage = vec3(1.2, 0.08, 0.02).mul(iFx.y).mul(isInk);
    return glow.add(rage).add(vec3(iTeam.w.mul(0.12)).mul(float(1).sub(isInk)));
  })());
  m.opacityNode = float(1);
  return m;
}
