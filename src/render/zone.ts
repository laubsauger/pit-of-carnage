/**
 * Sudden death, drawn so nobody can miss it:
 *
 * - The closing wall is a grinding iron wall with a row of steel spikes along its inner face, drawn
 *   from `SuddenDeathState.bounds` on every side. While it moves the spikes grind along the face
 *   (clockwise round the arena) with a hot line and sparks where they scrape; once it stops they
 *   heat up with every escalation level. Behind it the crushed part of the arena goes dark.
 * - The floor shows a warning band where the wall will be in 3 s (inside `bounds`, outside
 *   `warning`): stripes crawl inward at the wall's own speed, edged by a dashed line where the
 *   spikes will reach.
 * - Once the escalated damage hits everyone (`everywhere`), a blood tide pulses over the whole zone.
 *
 * Two meshes share one shader recipe: the floor part sits under floor items, props and gore effects;
 * the wall part sits above props (they get crushed) but under fighters, who always stay on top.
 */

import * as THREE from 'three/webgpu';
import {
  Fn, abs, float, floor, fract, hash, length, max, mix, mx_noise_float, positionWorld, select, sin, smoothstep, step,
  uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { LAYER_HEIGHT, MATCH_RULES, TICK_HZ, clamp01 } from '../core';
import type { GameEvent, MapDef, SuddenDeathState } from '../core';
import { basicMaterial, setEmissive } from './cutout';
import type { LightField } from './lightfield';

/** Depth (px) of the spike row in front of the wall face; the tips sit exactly on the zone edge. */
const SPIKE = 16;
/** Spike spacing along the wall (px). */
const PERIOD = 22;
/** Wall thickness behind the spikes (px), then the crushed arena. */
const WALL = 48;
/** How fast the spikes grind along the face while the wall moves (px per game second). */
const GRIND_SPEED = 26;
/** Speed (px per game second) the wall closes in: warning stripes crawl inward at the same pace. */
const CLOSE_SPEED = MATCH_RULES.suddenDeathInsetPerTick * TICK_HZ;
/** Escalation level at which the spikes glow fully red-hot. */
const HEAT_LEVELS = 6;

function lin(hex: number): THREE.Node<'vec3'> {
  const c = new THREE.Color(hex);
  return vec3(c.r, c.g, c.b);
}

export class ZoneLayer {
  readonly group = new THREE.Group();
  private readonly floorMesh: THREE.Mesh;
  private readonly wallMesh: THREE.Mesh;
  private readonly light: LightField;
  /** Playable rect (x0, y0, x1, y1) and where it will be in 3 s. */
  private readonly bounds = uniform(new THREE.Vector4(0, 0, 1, 1));
  private readonly warning = uniform(new THREE.Vector4(0, 0, 1, 1));
  /** Game seconds the wall has been grinding (stops when the wall stops or the game pauses). */
  private readonly grind = uniform(0);
  /** Game seconds since sudden death began (pulses, tide). */
  private readonly clock = uniform(0);
  private readonly moving = uniform(0);
  private readonly heat = uniform(0);
  private readonly tide = uniform(0);
  /** Flash on the start and on every escalation step, decaying. */
  private readonly pulse = uniform(0);

  constructor(light: LightField) {
    this.light = light;
    this.group.name = 'sudden-death';
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.floorMesh = new THREE.Mesh(geo, this.material('floor'));
    this.floorMesh.name = 'zone-floor';
    // After the floor and body shadows, before acid pools and floor effects.
    this.floorMesh.renderOrder = -4;
    this.wallMesh = new THREE.Mesh(geo, this.material('wall'));
    this.wallMesh.name = 'zone-wall';
    this.wallMesh.renderOrder = 3;
    this.floorMesh.visible = false;
    this.wallMesh.visible = false;
    this.group.add(this.floorMesh, this.wallMesh);
  }

  setMap(map: MapDef): void {
    for (const m of [this.floorMesh, this.wallMesh]) m.scale.set(map.width, 1, map.height);
    this.floorMesh.position.set(map.width / 2, LAYER_HEIGHT.floorFx - 0.1, map.height / 2);
    // Above props and floor items (crushed under the wall), below every fighter.
    this.wallMesh.position.set(map.width / 2, LAYER_HEIGHT.fighters - 2, map.height / 2);
    this.reset();
  }

  reset(): void {
    this.grind.value = 0;
    this.clock.value = 0;
    this.pulse.value = 0;
    this.tide.value = 0;
  }

  onEvent(e: GameEvent): void {
    if (e.type === 'sudden_death') this.pulse.value = 1;
    // Escalation steps come every second: a heartbeat, not a flash.
    else if (e.type === 'escalation') this.pulse.value = Math.max(this.pulse.value, 0.35);
  }

  update(z: Readonly<SuddenDeathState>, gameDt: number): void {
    const on = z.active;
    this.floorMesh.visible = on;
    this.wallMesh.visible = on;
    if (!on) return;
    const b = z.bounds;
    const w = z.warning;
    this.bounds.value.set(b.x, b.y, b.x + b.w, b.y + b.h);
    this.warning.value.set(w.x, w.y, w.x + w.w, w.y + w.h);
    const moving = z.closedAtTick < 0;
    this.moving.value = moving ? 1 : 0;
    if (moving) this.grind.value += gameDt;
    this.clock.value += gameDt;
    this.heat.value = clamp01(z.escalation / HEAT_LEVELS);
    // The tide rises over a second instead of popping in.
    this.tide.value = z.everywhere ? Math.min(1, this.tide.value + gameDt) : 0;
    this.pulse.value = Math.max(0, this.pulse.value - gameDt * 1.6);
  }

  dispose(): void {
    this.floorMesh.geometry.dispose();
    (this.floorMesh.material as THREE.Material).dispose();
    (this.wallMesh.material as THREE.Material).dispose();
  }

  private material(part: 'floor' | 'wall'): THREE.MeshBasicNodeMaterial {
    const m = basicMaterial(`zone-${part}`);
    m.transparent = true;
    m.depthWrite = false;
    const b = this.bounds;
    const w = this.warning;
    const grind = this.grind;
    const clock = this.clock;
    const moving = this.moving;
    const heat = this.heat;
    const tide = this.tide;
    const pulse = this.pulse;
    const light = this.light;
    const p = positionWorld.xz;

    // Per-axis distance outside the playable rect (> 0 outside), and the larger of the two.
    const ox = max(b.x.sub(p.x), p.x.sub(b.z));
    const oy = max(b.y.sub(p.y), p.y.sub(b.w));
    const out = max(ox, oy);
    const sideWall = ox.greaterThan(oy);
    // Coordinate along the wall, and the grind direction (clockwise round the arena).
    const along = select(sideWall, p.y, p.x);
    const sgn = select(sideWall, select(p.x.greaterThan(b.z), float(1), float(-1)), select(p.y.lessThan(b.y), float(1), float(-1)));

    const lightTerm = Fn(() => {
      const l = light.sample(p).xyz;
      const lum = l.x.mul(0.2126).add(l.y.mul(0.7152)).add(l.z.mul(0.0722));
      return mix(vec3(lum), l, 0.3).clamp(0.3, 1.3);
    });

    if (part === 'floor') {
      const result = Fn(() => {
        const inside = step(out, 0);
        // The wall's drop shadow on the arena edge.
        const shade = smoothstep(-24, 0, out).mul(inside);
        const shadowA = shade.mul(shade).mul(0.5);
        // Warning band: inside the zone, outside where the zone will be in 3 s.
        const wo = max(max(w.x.sub(p.x), p.x.sub(w.z)), max(w.y.sub(p.y), p.y.sub(w.w)));
        const band = step(0, wo).mul(inside);
        const crawl = fract(out.negate().add(along.mul(0.55)).sub(grind.mul(CLOSE_SPEED)).div(16));
        const stripe = smoothstep(0.42, 0.5, crawl).mul(smoothstep(0.98, 0.9, crawl));
        const throb = sin(clock.mul(7)).mul(0.5).add(0.5);
        const bandA = band.mul(stripe.mul(0.3).add(0.12).add(throb.mul(0.08)));
        const bandCol = mix(lin(0x5a120c), lin(0xe0a03c), stripe);
        // Dashed line where the spike tips will be in 3 s.
        const dash = step(0.45, fract(along.div(18).sub(grind.mul(0.6))));
        const line = smoothstep(2.2, 0.6, abs(wo)).mul(inside).mul(dash).mul(step(0.5, moving));
        // Blood tide: everywhere damage is on.
        const blot = mx_noise_float(vec3(p.mul(1 / 90), clock.mul(0.35))).mul(0.5).add(0.5);
        const swell = sin(clock.mul(3.2).add(blot.mul(4))).mul(0.5).add(0.5);
        // Thickest along the walls, creeping in toward the centre.
        const creep = smoothstep(-220, 0, out).mul(0.22);
        const tideA = tide.mul(inside).mul(blot.mul(0.2).add(swell.mul(0.12)).add(creep).add(0.16)).min(0.75);
        const tideCol = mix(lin(0x4a0605), lin(0xa8120a), blot);
        // Composite: the shadow darkens, then band, tide and line paint over.
        const col = vec3(0).toVar();
        const a = shadowA.toVar();
        col.assign(mix(col, bandCol, bandA.div(max(a.add(bandA), 1e-3))));
        a.assign(a.add(bandA.mul(float(1).sub(a))));
        col.assign(mix(col, tideCol, tideA.div(max(a.add(tideA), 1e-3))));
        a.assign(a.add(tideA.mul(float(1).sub(a))));
        col.assign(mix(col, lin(0xffd27a), line));
        a.assign(max(a, line.mul(0.9)));
        return vec4(col.mul(lightTerm()), a);
      })();
      m.colorNode = result.xyz;
      m.opacityNode = result.w;
      setEmissive(m, Fn(() => {
        const wo = max(max(w.x.sub(p.x), p.x.sub(w.z)), max(w.y.sub(p.y), p.y.sub(w.w)));
        const dash = step(0.45, fract(along.div(18).sub(grind.mul(0.6))));
        const line = smoothstep(2.2, 0.6, abs(wo)).mul(step(out, 0)).mul(dash).mul(step(0.5, moving));
        return vec3(1.2, 0.62, 0.15).mul(line).mul(0.7);
      })());
      return m;
    }

    // Wall part: spikes, wall body, crushed arena.
    const s = along.sub(sgn.mul(grind).mul(GRIND_SPEED));
    const u = fract(s.div(PERIOD)).sub(0.5);
    const halfW = out.div(SPIKE).clamp(0, 1).mul(0.46);
    const inSpikeRow = step(0, out).mul(step(out, SPIKE));
    const edge = halfW.sub(abs(u)).mul(PERIOD);
    const tooth = step(0, edge).mul(inSpikeRow);
    const result = Fn(() => {
      const lit = lightTerm();
      // Spikes: steel, one flank catching the light, ink edges, red-hot with escalation.
      const flank = select(u.lessThan(0), float(1), float(0.6));
      const steel = mix(lin(0x6d737c), lin(0xd6dce3), flank.mul(out.div(SPIKE).oneMinus().mul(0.5).add(0.5)));
      const hot = mix(steel, lin(0xff4a1e), heat.mul(out.div(SPIKE).oneMinus()).mul(0.85));
      const toothCol = mix(lin(0x0b0908), hot.mul(lit), smoothstep(0.4, 1.4, edge));
      // Between the spikes the floor shows through, deep in the wall's shadow.
      const gapA = float(0.55).mul(out.div(SPIKE).add(0.4).clamp(0, 1));
      // Wall body: riveted iron plates with a bright bevel along the face.
      const depth = out.sub(SPIKE);
      const plate = fract(s.div(64));
      const seam = smoothstep(0.012, 0.03, plate).mul(smoothstep(0.988, 0.97, plate));
      const rivetP = vec2(fract(s.div(64).add(0.5)).sub(0.5).abs().sub(0.36).mul(64), depth.sub(WALL / 2 - SPIKE / 2).abs());
      const rivet = smoothstep(2.6, 1.6, length(rivetP));
      const grain = mx_noise_float(vec3(p.mul(1 / 11), 4.0)).mul(0.08).add(1);
      const iron = mix(lin(0x2b2724), lin(0x48423c), seam).mul(grain);
      const bevel = smoothstep(4, 0, depth);
      const back = smoothstep(WALL - SPIKE - 10, WALL - SPIKE, depth);
      let wallCol = mix(iron, lin(0x8c857b), bevel.mul(0.8));
      wallCol = mix(wallCol, lin(0x6e665c), rivet);
      wallCol = mix(wallCol, lin(0x0b0908), max(seam.oneMinus().mul(0.7), back.mul(0.6)));
      wallCol = wallCol.mul(lit);
      // Crushed arena: dark gore and rubble, slow red hatch.
      const hatch = step(0.5, fract(p.x.add(p.y).div(26).add(clock.mul(0.25))));
      const crushed = mix(lin(0x0d0605), lin(0x1f0807), hatch.mul(0.7).add(heat.mul(0.3)));
      const isWall = step(SPIKE, out).mul(step(out, WALL));
      const isCrushed = step(WALL, out);
      const col = vec3(0).toVar();
      col.assign(mix(col, toothCol, tooth));
      col.assign(mix(col, wallCol, isWall));
      col.assign(mix(col, crushed, isCrushed));
      const a = max(max(tooth, inSpikeRow.mul(gapA)), max(isWall, isCrushed.mul(0.93)));
      return vec4(col, a);
    })();
    m.colorNode = result.xyz;
    m.opacityNode = result.w;
    setEmissive(m, Fn(() => {
      const depth = out.sub(SPIKE);
      // Hot grinding line and sparks where the spikes scrape the face (only while moving).
      const scrape = smoothstep(3, 0, abs(depth)).mul(step(0, out));
      const flick = hash(floor(s.div(5)).add(floor(grind.mul(24)).mul(17.3)));
      const spark = step(0.9, flick).mul(scrape);
      const grindGlow = scrape.mul(0.35).add(spark.mul(2.2)).mul(moving);
      // Red-hot spikes with escalation, and the pulse on start and every escalation step.
      const heatGlow = tooth.mul(heat).mul(out.div(SPIKE).oneMinus()).mul(1.1);
      const face = step(SPIKE, out).mul(step(out, WALL)).mul(pulse).mul(0.3);
      return vec3(1.5, 0.42, 0.08).mul(grindGlow).add(vec3(1.3, 0.12, 0.03).mul(heatGlow.add(face).add(tooth.mul(pulse).mul(0.6))));
    })());
    return m;
  }
}
