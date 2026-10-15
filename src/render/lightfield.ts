/**
 * The arena light field: a TSL compute pass that writes the light falling on every floor cell
 * into a storage texture each frame. Floor, fighters and items sample it at their world position,
 * so everything standing in a gameplay shadow (the sim's `lightAt` < 0.35) looks like it is in
 * shadow, and every map light casts hard 2D shadows behind walls and pillars, exactly like the sim.
 *
 * Texel layout: rgb = light colour (HDR, linear), a = the sim's scalar light level (0..~1.5,
 * unclamped) for readability tints. Texel (0, 0) covers world (0, 0); sample with uv = world / size.
 *
 * Also owns:
 * - the static wall occlusion texture (contact AO + a south-east drop shadow under walls), built
 *   once per map by a second compute pass;
 * - mirrored three.js PointLights (no shadows) so any lit node material the fx module uses still
 *   matches the torchlight.
 */

import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, atan, float, instanceIndex, int, length, max, min, smoothstep, storage, texture, textureStore, uniform,
  uniformArray, ivec2, vec2, vec3, vec4,
} from 'three/tsl';
import type { MapDef } from '../core';
import { LIGHT_HEIGHT, buildOcclusion, collectMapLights, flicker, lightBlockers, pickShadowLights } from './lightmath';
import type { LightSource, ShadowLight, ShadowSource } from './lightmath';

/** Most lights the field handles at once (static map lights + transient flashes). */
export const MAX_LIGHTS = 40;
/** Slots reserved for transient lights (explosion flashes, staff orbs, skill flashes). */
export const DYNAMIC_LIGHTS = 12;
const MAX_STATIC = MAX_LIGHTS - DYNAMIC_LIGHTS;
/** Angular resolution of the occlusion table. */
export const OCC_ANGLES = 1024;
/** World px per light-map texel. */
export const LIGHT_CELL = 2;
/** World px per AO texel. */
const AO_CELL = 2;
const MAX_BLOCKERS = 192;
/** Visual gain from gameplay intensity to HDR light. */
const VISUAL_GAIN = 1.55;
/** Light colours are pulled this far toward warm white, so floors are not dyed one hue. */
const COLOR_DESAT = 0.35;
/** Ambient light colour (cool, so darkness reads as darkness and torchlight as warm). */
const AMBIENT_TINT = new THREE.Color(0.55, 0.62, 0.85);
const AMBIENT_GAIN = 1.5;
/** Drop-shadow offset (world px) of walls on the floor: a fixed "overhead" light from the north-west. */
const DROP_X = 7;
const DROP_Y = 10;
/** Transient flashes (explosions, skills) sit lower than wall torches, so they throw longer shadows. */
const FLASH_HEIGHT = 45;
/** A light must supply at least this share of the light on a body for its shadow to be drawn. */
const SHADOW_MIN_SHARE = 0.08;

function lum(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export type DynamicLight = {
  x: number;
  y: number;
  radius: number;
  /** Peak HDR intensity (already visual units). */
  intensity: number;
  color: THREE.Color;
  /** Seconds of game time left; the light fades out over `life`. */
  left: number;
  life: number;
  active: boolean;
};

export class LightField {
  readonly lightTexture: THREE.StorageTexture;
  readonly aoTexture: THREE.StorageTexture;
  /** Map size in world px, for uv = world / size. */
  readonly size = uniform(new THREE.Vector2(1, 1));
  readonly group = new THREE.Group();
  readonly dynamic: DynamicLight[] = [];
  /** Uniform arrays shared with the wall material (unoccluded lighting of wall tops). */
  readonly posArray: THREE.Vector4[];
  readonly colArray: THREE.Vector4[];
  readonly lightPos;
  readonly lightCol;
  readonly lightCount = uniform(0, 'int');
  readonly ambientColor = uniform(new THREE.Vector3(0, 0, 0));
  readonly ambientLevel = uniform(0);

  private readonly renderer: THREE.WebGPURenderer;
  private readonly occData: Float32Array;
  private readonly occAttr: THREE.StorageBufferAttribute;
  private readonly blockerArray: THREE.Vector4[];
  private readonly blockerCount = uniform(0, 'int');
  private readonly cell = uniform(new THREE.Vector2(LIGHT_CELL, LIGHT_CELL));
  private readonly aoCell = uniform(new THREE.Vector2(AO_CELL, AO_CELL));
  private lightCompute: THREE.ComputeNode | null = null;
  private aoCompute: THREE.ComputeNode | null = null;
  private lw = 0;
  private lh = 0;
  private aw = 0;
  private ah = 0;
  private statics: LightSource[] = [];
  /** Parsed, desaturated colour of each static light (no string parsing per frame). */
  private staticColors: THREE.Color[] = [];
  private readonly frameData = new Float32Array(DYNAMIC_LIGHTS * 6);
  private frameCount = 0;
  private points: THREE.PointLight[] = [];
  private readonly ambientLight = new THREE.AmbientLight(0x8890b0, 0.25);
  /** Lights as body shadows see them, refreshed every frame (static first, then live flashes). */
  private readonly shadowSources: ShadowSource[] = [];
  private shadowSourceCount = 0;
  private ambientLum = 0;

  constructor(renderer: THREE.WebGPURenderer) {
    this.renderer = renderer;
    this.lightTexture = new THREE.StorageTexture(4, 4);
    this.lightTexture.type = THREE.HalfFloatType;
    this.lightTexture.name = 'pit-light-map';
    this.aoTexture = new THREE.StorageTexture(4, 4);
    this.aoTexture.type = THREE.HalfFloatType;
    this.aoTexture.name = 'pit-wall-ao';
    this.occData = new Float32Array(MAX_LIGHTS * OCC_ANGLES);
    this.occAttr = new THREE.StorageBufferAttribute(this.occData, 1);
    this.posArray = Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4());
    this.colArray = Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4());
    this.lightPos = uniformArray<'vec4'>(this.posArray, 'vec4');
    this.lightCol = uniformArray<'vec4'>(this.colArray, 'vec4');
    this.blockerArray = Array.from({ length: MAX_BLOCKERS }, () => new THREE.Vector4());
    for (let i = 0; i < DYNAMIC_LIGHTS; i++) {
      this.dynamic.push({ x: 0, y: 0, radius: 1, intensity: 0, color: new THREE.Color(), left: 0, life: 1, active: false });
    }
    for (let i = 0; i < MAX_LIGHTS; i++) this.shadowSources.push({ x: 0, y: 0, radius: 1, height: LIGHT_HEIGHT, gain: 0, occRow: -1 });
    this.group.name = 'fx-compat-lights';
    this.group.add(this.ambientLight);
  }

  setMap(map: MapDef): void {
    const lw = Math.ceil(map.width / LIGHT_CELL);
    const lh = Math.ceil(map.height / LIGHT_CELL);
    if (lw !== this.lw || lh !== this.lh) {
      this.lw = lw;
      this.lh = lh;
      this.lightTexture.setSize(lw, lh, 1);
      this.lightCompute = this.buildLightCompute(lw, lh);
    }
    const aw = Math.ceil(map.width / AO_CELL);
    const ah = Math.ceil(map.height / AO_CELL);
    if (aw !== this.aw || ah !== this.ah) {
      this.aw = aw;
      this.ah = ah;
      this.aoTexture.setSize(aw, ah, 1);
      this.aoCompute = this.buildAoCompute(aw, ah);
    }
    this.size.value.set(map.width, map.height);
    this.cell.value.set(map.width / lw, map.height / lh);
    this.aoCell.value.set(map.width / aw, map.height / ah);

    this.statics = collectMapLights(map).slice(0, MAX_STATIC);
    this.staticColors = this.statics.map((l) => new THREE.Color(l.color).lerp(_warmWhite, COLOR_DESAT));
    this.occData.fill(0);
    buildOcclusion(this.statics, lightBlockers(map), OCC_ANGLES, this.occData);
    this.occAttr.needsUpdate = true;

    const blockers = [...map.walls, ...map.pillars].slice(0, MAX_BLOCKERS);
    blockers.forEach((r, i) => this.blockerArray[i]!.set(r.x, r.y, r.x + r.w, r.y + r.h));
    this.blockerCount.value = blockers.length;
    this.ambientColor.value.set(AMBIENT_TINT.r, AMBIENT_TINT.g, AMBIENT_TINT.b).multiplyScalar(map.ambient * AMBIENT_GAIN);
    this.ambientLevel.value = map.ambient;
    this.ambientLum = lum(this.ambientColor.value.x, this.ambientColor.value.y, this.ambientColor.value.z);
    this.shadowSourceCount = 0;
    for (const d of this.dynamic) d.active = false;

    // Mirror lights for lit fx materials (no shadows: the light field draws the real shadows).
    for (const p of this.points) {
      this.group.remove(p);
      p.dispose();
    }
    this.points = this.statics.map((l) => {
      const p = new THREE.PointLight(l.color, l.intensity * 6, l.radius * 1.15, 0);
      p.position.set(l.x, 70, l.y);
      p.castShadow = false;
      this.group.add(p);
      return p;
    });
    this.ambientLight.intensity = 0.15 + map.ambient * 1.2;

    if (this.aoCompute) this.renderer.compute(this.aoCompute);
  }

  /** Start a transient light (explosion, orb, skill flash). Reuses the oldest slot when full. */
  flash(x: number, y: number, radius: number, intensity: number, color: THREE.ColorRepresentation, life: number): DynamicLight {
    let slot = this.dynamic.find((d) => !d.active);
    if (!slot) slot = this.dynamic.reduce((a, b) => (a.left < b.left ? a : b));
    slot.x = x;
    slot.y = y;
    slot.radius = radius;
    slot.intensity = intensity;
    slot.color.set(color);
    slot.left = life;
    slot.life = life;
    slot.active = true;
    return slot;
  }

  /** A light for this frame only (moving sources: staff orbs). Unoccluded. Linear HDR colour. */
  frameLight(x: number, y: number, radius: number, r: number, g: number, b: number): void {
    if (this.frameCount >= DYNAMIC_LIGHTS) return;
    const o = this.frameCount * 6;
    this.frameData[o] = x;
    this.frameData[o + 1] = y;
    this.frameData[o + 2] = radius;
    this.frameData[o + 3] = r;
    this.frameData[o + 4] = g;
    this.frameData[o + 5] = b;
    this.frameCount++;
  }

  clearDynamic(): void {
    for (const d of this.dynamic) d.active = false;
  }

  /**
   * The lights throwing a visible shadow of a body standing at world (x, y), strongest first, with
   * each one's share of the light there (CPU side, from the last frame's flicker). Returns the count.
   */
  shadowLights(x: number, y: number, out: ShadowLight[], max: number): number {
    return pickShadowLights(this.shadowSources, this.shadowSourceCount, this.ambientLum, this.occData, OCC_ANGLES, x, y, out, max, SHADOW_MIN_SHARE);
  }

  /**
   * Update flicker and transient lights, then run the light pass. `time` is the cosmetic clock,
   * `gameDt` the scaled frame time (flashes freeze in hit-stop with everything else).
   */
  update(time: number, gameDt: number): void {
    let n = 0;
    for (let i = 0; i < this.statics.length; i++) {
      const l = this.statics[i]!;
      const f = flicker(time, l.seed, l.flicker);
      this.posArray[n]!.set(l.x, l.y, l.radius, l.intensity);
      const c = this.staticColors[i]!;
      const g = l.intensity * VISUAL_GAIN * f;
      this.colArray[n]!.set(c.r * g, c.g * g, c.b * g, l.occluded ? i + 1 : 0);
      const p = this.points[i];
      if (p) p.intensity = l.intensity * 6 * f;
      const s = this.shadowSources[n]!;
      s.x = l.x;
      s.y = l.y;
      s.radius = l.radius;
      s.height = LIGHT_HEIGHT;
      s.gain = lum(c.r, c.g, c.b) * g;
      s.occRow = l.occluded ? i : -1;
      n++;
    }
    for (const d of this.dynamic) {
      if (!d.active || n >= MAX_LIGHTS) continue;
      d.left -= gameDt;
      if (d.left <= 0) {
        d.active = false;
        continue;
      }
      const k = d.left / d.life;
      const g = d.intensity * k * k;
      this.posArray[n]!.set(d.x, d.y, d.radius, 0);
      this.colArray[n]!.set(d.color.r * g, d.color.g * g, d.color.b * g, 0);
      const s = this.shadowSources[n]!;
      s.x = d.x;
      s.y = d.y;
      s.radius = d.radius;
      s.height = FLASH_HEIGHT;
      s.gain = lum(d.color.r, d.color.g, d.color.b) * g;
      s.occRow = -1;
      n++;
    }
    this.shadowSourceCount = n;
    for (let k = 0; k < this.frameCount && n < MAX_LIGHTS; k++) {
      const o = k * 6;
      const fd = this.frameData;
      this.posArray[n]!.set(fd[o]!, fd[o + 1]!, fd[o + 2]!, 0);
      this.colArray[n]!.set(fd[o + 3]!, fd[o + 4]!, fd[o + 5]!, 0);
      n++;
    }
    this.frameCount = 0;
    this.lightCount.value = n;
    if (this.lightCompute) this.renderer.compute(this.lightCompute);
  }

  /** Light at a world position (x, y) as vec4(rgb, gameplay level). For fragment shaders. */
  sample(worldXY: THREE.Node<'vec2'>): THREE.TextureNode {
    return texture(this.lightTexture, worldXY.div(this.size));
  }

  /** Wall contact occlusion at a world position: x = AO 0..1 (1 = open floor). */
  sampleAo(worldXY: THREE.Node<'vec2'>): THREE.TextureNode {
    return texture(this.aoTexture, worldXY.div(this.size));
  }

  dispose(): void {
    this.lightTexture.dispose();
    this.aoTexture.dispose();
    for (const p of this.points) p.dispose();
    this.ambientLight.dispose();
  }

  private buildLightCompute(lw: number, lh: number): THREE.ComputeNode {
    const occ = storage(this.occAttr, 'float', MAX_LIGHTS * OCC_ANGLES).toReadOnly();
    const lightPos = this.lightPos;
    const lightCol = this.lightCol;
    const count = this.lightCount;
    const cell = this.cell;
    const ambient = this.ambientColor;
    const ambientLevel = this.ambientLevel;
    const tex = this.lightTexture;
    const fn = Fn(() => {
      const ix = int(instanceIndex.mod(lw));
      const iy = int(instanceIndex.div(lw));
      const p = vec2(float(ix).add(0.5), float(iy).add(0.5)).mul(cell);
      const rgb = vec3(ambient).toVar();
      const level = float(ambientLevel).toVar();
      Loop({ start: 0, end: count, type: 'int' }, ({ i }) => {
        const lp = lightPos.element(i);
        const lc = lightCol.element(i);
        const d = p.sub(lp.xy);
        const dist = length(d);
        If(dist.lessThan(lp.z), () => {
          const x = float(1).sub(dist.div(lp.z));
          const fall = x.mul(x).mul(float(3).sub(x.mul(2)));
          const vis = float(1).toVar();
          // w > 0: occluded light, row w - 1 of the occlusion table.
          If(lc.w.greaterThan(0.5), () => {
            const row = int(lc.w).sub(1).mul(OCC_ANGLES);
            const a = atan(d.y, d.x).div(Math.PI * 2).add(1).fract().mul(OCC_ANGLES);
            // Soft penumbra: three taps across neighbouring angles, a few px of depth softness.
            const soft = dist.mul(0.03).add(3);
            const acc = float(0).toVar();
            for (const o of [-1.5, 0, 1.5]) {
              const ao = a.add(o + OCC_ANGLES);
              const k0 = int(ao).mod(OCC_ANGLES);
              const k1 = k0.add(1).mod(OCC_ANGLES);
              const f = ao.fract();
              const od = occ.element(row.add(k0)).mul(float(1).sub(f)).add(occ.element(row.add(k1)).mul(f));
              acc.addAssign(od.sub(dist).div(soft).add(0.5).clamp(0, 1));
            }
            vis.assign(acc.div(3));
          });
          // Colour uses a steeper falloff (pools of light, darker edges) for mood; the scalar
          // level keeps the sim's exact falloff, and the floor marks gameplay shadow from it.
          rgb.addAssign(lc.xyz.mul(fall.mul(fall).mul(vis)));
          level.addAssign(lp.w.mul(fall).mul(vis));
        });
      });
      textureStore(tex, ivec2(ix, iy), vec4(rgb, level));
    });
    return fn().compute(lw * lh);
  }

  private buildAoCompute(aw: number, ah: number): THREE.ComputeNode {
    const blockers = uniformArray<'vec4'>(this.blockerArray, 'vec4');
    const count = this.blockerCount;
    const cell = this.aoCell;
    const tex = this.aoTexture;
    const fn = Fn(() => {
      const ix = int(instanceIndex.mod(aw));
      const iy = int(instanceIndex.div(aw));
      const p = vec2(float(ix).add(0.5), float(iy).add(0.5)).mul(cell);
      const q = p.sub(vec2(DROP_X, DROP_Y));
      const near = float(1e5).toVar();
      const drop = float(1e5).toVar();
      Loop({ start: 0, end: count, type: 'int' }, ({ i }) => {
        const r = blockers.element(i);
        // Signed distance to the rect (negative inside).
        const c = r.xy.add(r.zw).mul(0.5);
        const h = r.zw.sub(r.xy).mul(0.5);
        const dp = p.sub(c).abs().sub(h);
        const sd = length(max(dp, 0)).add(min(max(dp.x, dp.y), 0));
        near.assign(min(near, sd));
        const dq = q.sub(c).abs().sub(h);
        drop.assign(min(drop, length(max(dq, 0)).add(min(max(dq.x, dq.y), 0))));
      });
      const ao = smoothstep(0, 22, near).mul(0.45).add(0.55);
      const dropShade = smoothstep(-2, 9, drop).mul(0.45).add(0.55);
      textureStore(tex, ivec2(ix, iy), vec4(min(ao, dropShade), near, 0, 1));
    });
    return fn().compute(aw * ah);
  }
}

const _warmWhite = new THREE.Color(1, 0.93, 0.82);
