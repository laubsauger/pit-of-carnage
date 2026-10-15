/**
 * Arena floor: one plane with a procedural TSL material per floor type (sand, flagstone, flesh),
 * the shared gore decal target multiplied on top (alpha = wetness, adds a sheen near lights),
 * wall contact shadows, the light field and a cool tint over gameplay shadow. The sudden-death wall
 * is its own layer (zone.ts).
 */

import * as THREE from 'three/webgpu';
import {
  Fn, abs, float, floor, fract, hash, instanceIndex, int, ivec2, length, min, mix, mx_fractal_noise_float, mx_noise_float,
  mx_worley_noise_vec2, positionWorld, sin, smoothstep, texture, textureStore, time, vec2, vec3, vec4,
} from 'three/tsl';
import { LAYER_HEIGHT, PERCEPTION } from '../core';
import type { MapDef } from '../core';
import { basicMaterial } from './cutout';
import type { LightField } from './lightfield';

type FloorKind = MapDef['floor'];

/** Linear colour helper for TSL constants. */
function lin(hex: number): THREE.Node<'vec3'> {
  const c = new THREE.Color(hex);
  return vec3(c.r, c.g, c.b);
}

function sandAlbedo(p: THREE.Node<'vec2'>): THREE.Node<'vec3'> {
  return Fn(() => {
    const big = mx_fractal_noise_float(vec3(p.mul(1 / 260), 0.3), 3, 2.0, 0.5);
    const mottle = mx_noise_float(vec3(p.mul(1 / 34), 1.7));
    const grain = mx_noise_float(vec3(p.mul(0.55), 3.1));
    const warp = mx_noise_float(vec3(p.mul(1 / 170), 5.0)).mul(2.4);
    const ripple = sin(p.x.mul(0.07).add(p.y.mul(0.035)).add(warp)).mul(0.5).add(0.5);
    const base = mix(lin(0x7d6040), lin(0xae9064), big.mul(0.6).add(0.5).clamp(0, 1));
    return base.mul(mottle.mul(0.1).add(grain.mul(0.05)).add(ripple.mul(0.05)).add(0.93));
  })();
}

function stoneAlbedo(p: THREE.Node<'vec2'>): THREE.Node<'vec3'> {
  return Fn(() => {
    const tw = float(68);
    const th = float(50);
    const row = floor(p.y.div(th));
    const shifted = vec2(p.x.add(row.mod(2).mul(tw.mul(0.5))), p.y);
    const cell = floor(shifted.div(vec2(tw, th)));
    const f = fract(shifted.div(vec2(tw, th)));
    const edge = min(min(f.x, float(1).sub(f.x)).mul(tw), min(f.y, float(1).sub(f.y)).mul(th));
    const jag = mx_noise_float(vec3(p.mul(1 / 9), 2.0)).mul(1.2);
    const grout = smoothstep(1.2, 3.4, edge.add(jag));
    const rnd = hash(cell.x.add(cell.y.mul(157)));
    const tile = mix(lin(0x4f4a44), lin(0x6d665c), rnd);
    const wear = mx_fractal_noise_float(vec3(p.mul(1 / 46), 0.5), 3, 2.0, 0.5).mul(0.12);
    const pits = mx_noise_float(vec3(p.mul(0.5), 9.0)).mul(0.04);
    const bevel = smoothstep(2.5, 7, edge).mul(0.1).add(0.92);
    return mix(lin(0x1e1b18), tile.mul(wear.add(pits).add(1)).mul(bevel), grout);
  })();
}

function fleshAlbedo(p: THREE.Node<'vec2'>): THREE.Node<'vec3'> {
  return Fn(() => {
    const w = mx_worley_noise_vec2(vec3(p.mul(1 / 52), 0.0), 0.9);
    const vein = smoothstep(0.015, 0.16, w.y.sub(w.x));
    const mottle = mx_fractal_noise_float(vec3(p.mul(1 / 30), 4.0), 3, 2.0, 0.5).mul(0.14).add(1);
    const meat = mix(lin(0x4a2a29), lin(0x6e4440), w.x.clamp(0, 1));
    return mix(lin(0x1c0e10), meat.mul(mottle), vein);
  })();
}

/** Baked albedo texels per world px. */
const ALBEDO_SCALE = 1.5;
const ALBEDO_MAX = 4096;

export class Floor {
  readonly mesh: THREE.Mesh;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly light: LightField;
  private readonly decal: THREE.Texture;
  /** Static procedural albedo (rgb) + wet-sheen breakup noise (a), baked once per map. */
  private readonly albedo: THREE.StorageTexture;
  private kind: FloorKind | null = null;
  private bakedFor = '';

  constructor(renderer: THREE.WebGPURenderer, light: LightField, decal: THREE.Texture) {
    this.renderer = renderer;
    this.light = light;
    this.decal = decal;
    this.albedo = new THREE.StorageTexture(4, 4);
    this.albedo.type = THREE.HalfFloatType;
    this.albedo.name = 'floor-albedo';
    const g = new THREE.PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(g, basicMaterial('floor'));
    this.mesh.name = 'floor';
    this.mesh.position.y = LAYER_HEIGHT.floor;
    this.mesh.renderOrder = -10;
  }

  setMap(map: MapDef): void {
    this.mesh.scale.set(map.width, 1, map.height);
    this.mesh.position.set(map.width / 2, LAYER_HEIGHT.floor, map.height / 2);
    if (this.kind !== map.floor) {
      this.kind = map.floor;
      const old = this.mesh.material as THREE.Material;
      this.mesh.material = this.buildMaterial(map.floor);
      old.dispose();
    }
    const key = `${map.floor}:${map.width}x${map.height}`;
    if (key !== this.bakedFor) {
      this.bakedFor = key;
      this.bake(map);
    }
  }

  /** Run the procedural floor once into the albedo texture (the per-frame shader only samples it). */
  private bake(map: MapDef): void {
    const aw = Math.min(ALBEDO_MAX, Math.ceil(map.width * ALBEDO_SCALE));
    const ah = Math.min(ALBEDO_MAX, Math.ceil(map.height * ALBEDO_SCALE));
    this.albedo.setSize(aw, ah, 1);
    const cell = vec2(map.width / aw, map.height / ah);
    const centre = vec2(map.width / 2, map.height / 2);
    const kind = map.floor;
    const tex = this.albedo;
    const fn = Fn(() => {
      const ix = int(instanceIndex.mod(aw));
      const iy = int(instanceIndex.div(aw));
      const p = vec2(float(ix).add(0.5), float(iy).add(0.5)).mul(cell);
      const albedo = kind === 'stone' ? stoneAlbedo(p) : kind === 'flesh' ? fleshAlbedo(p) : sandAlbedo(p);
      // Faint arena circle around the centre: a broadcast court marking worn into the floor.
      const ring = smoothstep(0.5, 2.5, abs(length(p.sub(centre)).sub(132))).oneMinus().mul(0.16);
      const sheen = mx_noise_float(vec3(p.mul(0.2), 7.0)).mul(0.5).add(0.5);
      textureStore(tex, ivec2(ix, iy), vec4(albedo.mul(float(1).sub(ring)), sheen));
    });
    this.renderer.compute(fn().compute(aw * ah));
  }

  private buildMaterial(kind: FloorKind): THREE.MeshBasicNodeMaterial {
    const m = basicMaterial(`floor-${kind}`);
    const light = this.light;
    const size = light.size;
    const decalTex = this.decal;
    const albedoTex = this.albedo;
    const wp = positionWorld.xz;
    const shade = Fn(() => {
      const uvw = wp.div(size);
      const baked = texture(albedoTex, uvw);
      const decal = texture(decalTex, uvw);
      const l = light.sample(wp);
      const ao = light.sampleAo(wp).x;
      // Flesh breathes.
      const pulse = kind === 'flesh' ? sin(time.mul(1.6).add(wp.x.mul(0.01))).mul(0.04).add(1) : float(1);
      const base = baked.xyz.mul(pulse).mul(decal.xyz);
      const lit = base.mul(l.xyz).mul(ao);
      // Wet gore catches the light.
      const sheen = decal.w.mul(l.xyz).mul(baked.w.mul(0.18).add(0.04));
      // Gameplay shadow (below the sim's shadow threshold) reads cool and a touch darker.
      const shadowAmt = smoothstep(PERCEPTION.shadowLight - 0.04, PERCEPTION.shadowLight + 0.04, l.w).oneMinus();
      const tinted = mix(lit, lit.mul(vec3(0.7, 0.78, 1.05)), shadowAmt.mul(0.65));
      return tinted.add(sheen);
    })();
    m.colorNode = shade;
    return m;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.albedo.dispose();
  }
}
