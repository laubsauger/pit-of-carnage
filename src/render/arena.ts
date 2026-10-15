/**
 * Set dressing driven by the map and the live world state: wall torches, props (kegs, amphoras,
 * crates), hazards (spikes, saws with their tracks, acid, fire pits), shrines, power-up pedestals
 * and items lying on the floor. Cut-out parts share the fighter material (lit by the light field);
 * flames and halos go into the renderer's shared fire and glow batches.
 *
 * Power-ups are worth a detour and must read from across the arena: a pedestal that is always
 * there, runes and a ring in the power-up's colour that fill up toward the respawn (pulsing through
 * the last second), and once it is back a floating charm that pops in, glows and lights the floor.
 */

import * as THREE from 'three/webgpu';
import { HAZARD_RULES, LAYER_HEIGHT, PICKUP_RULES, PROP_RULES, TICK_HZ, hashString } from '../core';
import type { FloorItem, GameEvent, HazardState, MapDef, PickupKind, WorldState } from '../core';
import { affine, setFrame } from './affine';
import { PartBatch, SLOT, buildCutout, colorOf, newStyle } from './cutout';
import { DynamicMesh } from './dynmesh';
import type { LightField } from './lightfield';
import { collectMapLights, flicker } from './lightmath';
import type { LightSource } from './lightmath';
import { C, floorItemGeometry } from './parts';
import { arcBand, circle, rect, roundRect, star, taperedCurve, transformPoly } from './poly';
import type { Poly } from './poly';
import { spikeCycle, spikeWarning } from './hazards';
import type { QuadBatch } from './sprites';

const MAX_PROPS = 48;
const MAX_HAZARDS = 48;
const MAX_ITEMS = 96;
const MAX_TORCHES = 32;
const MAX_PICKUPS = 16;
/** A map light this close to a wall is drawn as a torch on that wall. */
const TORCH_REACH = 42;
/** Power-up colours (linear rgb): rune inlays, ring, halo and the light pool. */
const PICKUP_RGB: Readonly<Record<PickupKind, readonly [number, number, number]>> = {
  haste: [0.25, 0.78, 1.0],
  berserk: [1.0, 0.18, 0.1],
};
const PICKUP_HEX: Readonly<Record<PickupKind, number>> = { haste: 0x6fe3ff, berserk: 0xff4a3a };
/** Respawn ring radius around a pedestal (px). */
const PICKUP_RING = 32;
/** Seconds of the "about to respawn" pulse. */
const PICKUP_URGENT = 1;

const H = {
  track: LAYER_HEIGHT.floor + 0.3,
  acid: LAYER_HEIGHT.floorFx + 0.2,
  items: LAYER_HEIGHT.floorItems,
  hazard: LAYER_HEIGHT.props,
  spikes: LAYER_HEIGHT.props + 1,
  shrine: LAYER_HEIGHT.props,
  pedestal: LAYER_HEIGHT.props + 0.5,
  pickup: LAYER_HEIGHT.props + 1.5,
  prop: LAYER_HEIGHT.props + 3,
  fire: LAYER_HEIGHT.props + 4,
  torch: LAYER_HEIGHT.walls + 0.6,
  torchFire: LAYER_HEIGHT.walls + 1.2,
} as const;

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

function kegGeometry(): THREE.BufferGeometry {
  const cross = (rot: number): Poly => transformPoly(rect(-6.5, -1.5, 6.5, 1.5), 0, 0, rot);
  return buildCutout([
    { poly: circle(0, 0, 17, 28), color: 0x7a4a26, dome: true },
    { poly: arcBand(0, 0, 13.4, 15.2, 0, Math.PI * 2, 28), color: C.iron, outline: 0 },
    { poly: circle(0, 0, 9, 20), color: 0x8c5730, outline: 0.8 },
    { poly: cross(Math.PI / 4), color: 0xc4302b, outline: 0 },
    { poly: cross(-Math.PI / 4), color: 0xc4302b, outline: 0 },
    { poly: taperedCurve([0, 0], [7, -3], [12, -9], 1.6, 1.2, 8), color: 0x2a211a, outline: 0.6 },
    { poly: circle(12, -9, 1.8, 8), color: C.glowGold, slot: SLOT.glow, outline: 0 },
  ]);
}

function amphoraGeometry(): THREE.BufferGeometry {
  return buildCutout([
    { poly: circle(0, 0, 15, 26), color: 0xb0643a, dome: true },
    { poly: arcBand(0, 0, 10, 11.4, 0, Math.PI * 2, 24), color: 0x7e3f22, outline: 0 },
    { poly: circle(0, 0, 6.2, 16), color: 0x8a4a2a, outline: 0.8 },
    { poly: circle(0, 0, 4, 14), color: 0x7dff6a, slot: SLOT.glow, outline: 0 },
  ]);
}

function crateGeometry(): THREE.BufferGeometry {
  const plank = (v: number): Poly => rect(-16, v - 0.6, 16, v + 0.6);
  return buildCutout([
    { poly: roundRect(0, 0, 38, 38, 2), color: 0x8a6338 },
    { poly: plank(-9), color: 0x5e4224, outline: 0 },
    { poly: plank(0), color: 0x5e4224, outline: 0 },
    { poly: plank(9), color: 0x5e4224, outline: 0 },
    { poly: transformPoly(rect(-22, -2.4, 22, 2.4), 0, 0, Math.PI / 4), color: 0x6d4c2a, outline: 0.8 },
  ]);
}

function spikePlateGeometry(): THREE.BufferGeometry {
  const specs = [{ poly: circle(0, 0, 40, 32), color: 0x34363b, dome: true }];
  const holes = [{ poly: circle(0, 0, 4.2, 10), color: 0x0d0d0f, outline: 0 }];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    holes.push({ poly: circle(Math.cos(a) * 22, Math.sin(a) * 22, 4.2, 10), color: 0x0d0d0f, outline: 0 });
  }
  return buildCutout([...specs, { poly: arcBand(0, 0, 34, 38, 0, Math.PI * 2, 32), color: 0x55575d, outline: 0 }, ...holes]);
}

/** Spike tips (scaled up when the trap fires). Glow strips double as the telegraph. */
function spikesGeometry(): THREE.BufferGeometry {
  const specs = [{ poly: star(0, 0, 7, 2.6, 4, Math.PI / 4), color: 0xd9dde2 }];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    specs.push({ poly: star(Math.cos(a) * 22, Math.sin(a) * 22, 7, 2.6, 4, a + Math.PI / 4), color: 0xd9dde2 });
  }
  return buildCutout(specs);
}

/** Red telegraph glow in the spike holes. */
function spikeGlowGeometry(): THREE.BufferGeometry {
  const specs = [{ poly: circle(0, 0, 3.6, 10), color: 0xff3a20, slot: SLOT.glow, outline: 0 }];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    specs.push({ poly: circle(Math.cos(a) * 22, Math.sin(a) * 22, 3.6, 10), color: 0xff3a20, slot: SLOT.glow, outline: 0 });
  }
  return buildCutout(specs);
}

function sawGeometry(): THREE.BufferGeometry {
  const teeth: Poly = [];
  const n = 18;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 0.6) / n) * Math.PI * 2;
    teeth.push(Math.cos(a0) * 21, Math.sin(a0) * 21, Math.cos(a1) * 26.5, Math.sin(a1) * 26.5);
  }
  return buildCutout([
    { poly: teeth, color: 0xcfd5dc },
    { poly: arcBand(0, 0, 14, 17.5, 0, Math.PI * 2, 24), color: 0xff4a2a, slot: SLOT.glow, outline: 0 },
    { poly: circle(0, 0, 8, 16), color: C.iron, outline: 1 },
    { poly: circle(0, 0, 2.6, 10), color: 0x15171b, outline: 0 },
  ]);
}

function firePitGeometry(): THREE.BufferGeometry {
  const stones: { poly: Poly; color: number }[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    stones.push({ poly: circle(Math.cos(a) * 36, Math.sin(a) * 36, 7.5, 10), color: i % 2 ? 0x4a443d : 0x5a5249 });
  }
  return buildCutout([{ poly: circle(0, 0, 34, 28), color: 0x241310 }, { poly: circle(0, 0, 24, 22), color: 0x6a1a08, slot: SLOT.glow, outline: 0 }, ...stones]);
}

function shrineGeometry(): THREE.BufferGeometry {
  const runes: { poly: Poly; color: number; slot: number; outline: number }[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    runes.push({ poly: transformPoly(rect(-1.2, -3.2, 1.2, 3.2), Math.cos(a) * 28, Math.sin(a) * 28, a), color: 0x7dffb0, slot: SLOT.glow, outline: 0 });
  }
  return buildCutout([
    { poly: circle(0, 0, 34, 32), color: 0x5a544c, dome: true },
    { poly: arcBand(0, 0, 24, 31, 0, Math.PI * 2, 32), color: 0x48433c, outline: 0 },
    ...runes,
    { poly: circle(0, 0, 21, 28), color: 0x1f2a24, outline: 1.2 },
    { poly: circle(0, 0, 14, 22), color: 0x7dffb0, slot: SLOT.glow, outline: 0 },
  ]);
}

function hasteGeometry(): THREE.BufferGeometry {
  const bolt: Poly = [-10, -3, 1, -7, -1, -1.5, 10, 3, -1, 7, 1, 1.5];
  return buildCutout([
    { poly: circle(0, 0, 15, 22), color: 0x2b3440, dome: true },
    { poly: transformPoly(bolt, 0, 0, -0.5), color: 0x6fe3ff, slot: SLOT.glow, outline: 1.2 },
  ]);
}

function berserkGeometry(): THREE.BufferGeometry {
  return buildCutout([
    { poly: circle(0, 0, 15, 22), color: 0x40282b, dome: true },
    { poly: circle(-2, 0, 8, 18), color: 0xff3a3a, slot: SLOT.glow, outline: 1.2 },
    { poly: roundRect(7.5, 0, 6, 4.4, 1), color: 0xc9a46a, outline: 1 },
    { poly: circle(-4, -3, 2, 8), color: 0xffffff, slot: SLOT.glow, outline: 0 },
  ]);
}

/** Octagonal stone pedestal with rune inlays and a socket rim in the power-up's colour. */
function pedestalGeometry(kind: PickupKind): THREE.BufferGeometry {
  const glow = PICKUP_HEX[kind];
  const runes: { poly: Poly; color: number; slot: number; outline: number }[] = [];
  for (let i = 0; i < 8; i++) {
    const a = ((i + 0.5) / 8) * Math.PI * 2;
    runes.push({ poly: transformPoly(rect(-1, -2.6, 1, 2.6), Math.cos(a) * 19, Math.sin(a) * 19, a), color: glow, slot: SLOT.glow, outline: 0 });
  }
  return buildCutout([
    { poly: transformPoly(circle(0, 0, 26, 8), 0, 0, Math.PI / 8), color: 0x57504a, dome: true },
    { poly: transformPoly(circle(0, 0, 22, 8), 0, 0, Math.PI / 8), color: 0x433d37, outline: 0 },
    ...runes,
    { poly: circle(0, 0, 14.5, 24), color: glow, slot: SLOT.glow, outline: 0.8 },
    { poly: circle(0, 0, 12.2, 24), color: 0x191614, outline: 0 },
  ]);
}

function sconceGeometry(): THREE.BufferGeometry {
  return buildCutout([
    { poly: roundRect(-7, 0, 12, 4, 1.5), color: C.iron },
    { poly: circle(0, 0, 6.5, 14), color: 0x2c2723, dome: true },
    { poly: circle(0, 0, 4, 12), color: 0xff8a3c, slot: SLOT.glow, outline: 0 },
  ]);
}

// ---------------------------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------------------------

type Torch = { x: number; y: number; angle: number; light: LightSource };

export class ArenaLayer {
  readonly group = new THREE.Group();
  private readonly keg: PartBatch;
  private readonly amphora: PartBatch;
  private readonly crate: PartBatch;
  private readonly spikePlate: PartBatch;
  private readonly spikes: PartBatch;
  private readonly spikeGlow: PartBatch;
  private readonly saw: PartBatch;
  private readonly firePit: PartBatch;
  private readonly shrine: PartBatch;
  private readonly haste: PartBatch;
  private readonly berserk: PartBatch;
  private readonly pedestals: Record<PickupKind, PartBatch>;
  private readonly sconce: PartBatch;
  private readonly items: Record<FloorItem['kind'], PartBatch>;
  private readonly batches: PartBatch[];
  private readonly tracks: DynamicMesh;
  private readonly marks: DynamicMesh;
  private readonly acid: QuadBatch;
  private readonly style = newStyle();
  private readonly T = affine();
  private readonly T2 = affine();
  private torches: Torch[] = [];
  private map: MapDef | null = null;
  private propHp: number[] = [];
  private propJiggle: number[] = [];
  private readonly fighterColor = new THREE.Color();
  /** Game seconds since each pedestal's power-up appeared / was taken (large = long ago). */
  private readonly spawnAge = new Float32Array(MAX_PICKUPS).fill(99);
  private readonly takenAge = new Float32Array(MAX_PICKUPS).fill(99);
  private pickupIds: string[] = [];

  constructor(material: THREE.Material, acid: QuadBatch) {
    this.group.name = 'arena';
    const mk = (name: string, g: THREE.BufferGeometry, cap: number) => new PartBatch(name, g, material, cap);
    this.keg = mk('keg', kegGeometry(), MAX_PROPS);
    this.amphora = mk('amphora', amphoraGeometry(), MAX_PROPS);
    this.crate = mk('crate', crateGeometry(), MAX_PROPS);
    this.spikePlate = mk('spike-plate', spikePlateGeometry(), MAX_HAZARDS);
    this.spikes = mk('spikes', spikesGeometry(), MAX_HAZARDS);
    this.spikeGlow = mk('spike-glow', spikeGlowGeometry(), MAX_HAZARDS);
    this.saw = mk('saw', sawGeometry(), MAX_HAZARDS);
    this.firePit = mk('fire-pit', firePitGeometry(), MAX_HAZARDS);
    this.shrine = mk('shrine', shrineGeometry(), 8);
    this.haste = mk('pickup-haste', hasteGeometry(), 16);
    this.berserk = mk('pickup-berserk', berserkGeometry(), 16);
    this.pedestals = {
      haste: mk('pedestal-haste', pedestalGeometry('haste'), MAX_PICKUPS),
      berserk: mk('pedestal-berserk', pedestalGeometry('berserk'), MAX_PICKUPS),
    };
    this.sconce = mk('torch', sconceGeometry(), MAX_TORCHES);
    this.items = {
      arrow: mk('item-arrow', floorItemGeometry('arrow'), MAX_ITEMS),
      axe: mk('item-axe', floorItemGeometry('axe'), MAX_ITEMS),
      weapon: mk('item-weapon', floorItemGeometry('weapon'), MAX_ITEMS),
      helmet: mk('item-helmet', floorItemGeometry('helmet'), MAX_ITEMS),
    };
    this.batches = [
      this.keg, this.amphora, this.crate, this.spikePlate, this.spikes, this.spikeGlow, this.saw, this.firePit, this.shrine,
      this.haste, this.berserk, this.pedestals.haste, this.pedestals.berserk, this.sconce, ...Object.values(this.items),
    ];
    this.tracks = new DynamicMesh('saw-tracks', 6 * 256);
    this.marks = new DynamicMesh('arena-marks', 6 * 2048, { emissive: 0.6 });
    this.acid = acid;
    this.group.add(this.tracks.mesh, this.marks.mesh, ...this.batches.map((b) => b.mesh));
    this.style.team.setRGB(1, 1, 1);
    this.style.skin.setRGB(1, 1, 1);
  }

  setMap(map: MapDef): void {
    this.map = map;
    const blockers = [...map.walls, ...map.pillars];
    this.torches = [];
    for (const l of collectMapLights(map)) {
      if (!map.lights.some((m) => m.id === l.id)) continue;
      let best = Infinity;
      let ang = 0;
      for (const r of blockers) {
        const cx = Math.max(r.x, Math.min(l.x, r.x + r.w));
        const cy = Math.max(r.y, Math.min(l.y, r.y + r.h));
        const d = Math.hypot(l.x - cx, l.y - cy);
        if (d < best) {
          best = d;
          ang = Math.atan2(cy - l.y, cx - l.x);
        }
      }
      if (best <= TORCH_REACH && this.torches.length < MAX_TORCHES) this.torches.push({ x: l.x, y: l.y, angle: ang, light: l });
    }
    // Saw tracks: a dark groove along every saw path, drawn once.
    this.tracks.begin();
    for (const h of map.hazards) {
      if (h.kind !== 'saw' || !h.path || h.path.length < 2) continue;
      for (let i = 0; i < h.path.length; i++) {
        const a = h.path[i]!;
        const b = h.path[(i + 1) % h.path.length]!;
        this.tracks.line(a.x, a.y, b.x, b.y, 12, H.track, 0.02, 0.018, 0.016, 0.85);
        this.tracks.line(a.x, a.y, b.x, b.y, 3, H.track + 0.05, 0.12, 0.1, 0.09, 0.9);
      }
    }
    this.tracks.end();
    this.propHp = map.props.map((p) => PROP_RULES[p.kind].hp);
    this.propJiggle = map.props.map(() => 0);
    this.pickupIds = map.pickups.map((p) => p.id);
    this.resetPickups();
  }

  /** Forget pop and burst animations (new match or seek). */
  resetPickups(): void {
    this.spawnAge.fill(99);
    this.takenAge.fill(99);
  }

  /** Live events: a power-up popping onto its pedestal, or being taken off it. */
  onEvent(e: GameEvent, state: WorldState, light: LightField): void {
    if (e.type === 'pickup_spawn') {
      const i = this.pickupIds.indexOf(e.pickupId);
      if (i >= 0 && i < MAX_PICKUPS) this.spawnAge[i] = 0;
      light.flash(e.pos.x, e.pos.y, 170, 3, PICKUP_HEX[e.kind], 0.5);
    } else if (e.type === 'pickup' && (e.kind === 'haste' || e.kind === 'berserk')) {
      // The event names the fighter, not the pedestal: it is the one of that kind at this spot.
      for (let i = 0; i < state.pickups.length && i < MAX_PICKUPS; i++) {
        const p = state.pickups[i]!;
        if (p.kind === e.kind && Math.hypot(p.pos.x - e.pos.x, p.pos.y - e.pos.y) < 1) this.takenAge[i] = 0;
      }
      light.flash(e.pos.x, e.pos.y, 140, 2.4, PICKUP_HEX[e.kind], 0.35);
    }
  }

  update(state: WorldState, time: number, gameDt: number, fire: QuadBatch, glow: QuadBatch, light: LightField): void {
    const map = this.map;
    if (!map) return;
    for (const b of this.batches) b.begin();
    this.marks.begin();
    const st = this.style;
    const T = this.T;
    st.flash = 0;
    st.shadow = 0;
    st.berserk = 0;

    // Torches on walls.
    for (const t of this.torches) {
      const f = flicker(time, t.light.seed, t.light.flicker);
      this.sconce.push(setFrame(T, t.x, t.y, t.angle + Math.PI, 1), H.torch, st, 0.8 * f);
      const k = fire.push(setFrame(T, t.x, t.y, time * 0.3, 30 * (0.85 + 0.15 * f)), H.torchFire);
      if (k >= 0) {
        fire.data[k] = t.light.seed;
        fire.data[k + 1] = 0.6 * f;
        fire.data[k + 2] = 0.6;
      }
      this.pushGlow(glow, t.x, t.y, 64 * f, 0.5 * f, 0.26 * f, 0.1 * f, H.torchFire - 0.1);
    }

    // Props.
    for (let i = 0; i < state.props.length; i++) {
      const p = state.props[i]!;
      if (!p.alive) continue;
      if (i < this.propHp.length) {
        if (p.hp < this.propHp[i]!) this.propJiggle[i] = 0.3;
        this.propHp[i] = p.hp;
        this.propJiggle[i] = Math.max(0, this.propJiggle[i]! - gameDt);
      }
      const jig = (this.propJiggle[i] ?? 0) * 10;
      const jx = Math.sin(time * 70 + i) * jig;
      const rule = PROP_RULES[p.kind];
      const damaged = 1 - p.hp / rule.hp;
      st.flash = jig > 0 ? 0.35 : 0;
      const nominal = p.kind === 'keg' ? 17 : p.kind === 'amphora' ? 15 : 21;
      const rot = p.kind === 'crate' ? 0 : (hashString(p.id) % 628) / 100;
      setFrame(T, p.pos.x + jx, p.pos.y, rot, p.radius / nominal);
      const batch = p.kind === 'keg' ? this.keg : p.kind === 'amphora' ? this.amphora : this.crate;
      batch.push(T, H.prop, st, p.kind === 'keg' ? 0.5 + 0.5 * Math.sin(time * 9 + i) + damaged : 0.3 + damaged);
    }
    st.flash = 0;

    // Hazards.
    for (let i = 0; i < state.hazards.length; i++) {
      const h = state.hazards[i]!;
      this.drawHazard(h, i, time, fire, glow);
    }

    // Shrines: runes glow when ready; a ring fills while recharging.
    for (const s of state.shrines) {
      const ready = s.cooldown <= 0;
      const pulse = 0.75 + 0.25 * Math.sin(time * 3);
      this.shrine.push(setFrame(T, s.pos.x, s.pos.y, 0, 1), H.shrine, st, ready ? 0.9 * pulse : 0.05);
      if (ready) this.pushGlow(glow, s.pos.x, s.pos.y, 120, 0.15 * pulse, 0.5 * pulse, 0.3 * pulse, H.shrine + 0.6);
      else this.progressRing(s.pos.x, s.pos.y, 37, 1 - s.cooldown / PICKUP_RULES.shrine.cooldownTicks, 0.4, 0.95, 0.65);
    }

    // Power-up pedestals.
    for (let i = 0; i < state.pickups.length; i++) this.drawPickup(state.pickups[i]!, i, time, gameDt, glow, light);

    // Spent arrows and axes on the floor. Dropped weapons and helmets belong to fx, which throws and
    // rolls them as pieces; drawing them here too would show each one twice.
    for (const it of state.floor) {
      if (it.kind === 'weapon' || it.kind === 'helmet') continue;
      const rot = (hashString(it.id) % 628) / 100;
      this.ownerColor(state, it.ownerId);
      st.team.copy(this.fighterColor);
      this.items[it.kind].push(setFrame(T, it.pos.x, it.pos.y, rot, 1), H.items, st, 0);
    }
    st.team.setRGB(1, 1, 1);

    for (const b of this.batches) b.end();
    this.marks.end();
  }

  private drawHazard(h: HazardState, i: number, time: number, fire: QuadBatch, glow: QuadBatch): void {
    const st = this.style;
    const T = this.T;
    const rule = HAZARD_RULES[h.kind];
    const radius = h.radius || rule.radius;
    switch (h.kind) {
      case 'spike': {
        const s = radius / 42;
        // Telegraph: the holes glow up through the last stretch of the cycle before the thrust.
        const warn = h.active ? 1 : spikeWarning(spikeCycle(h, rule.period), rule.triggerAt);
        this.spikePlate.push(setFrame(T, h.pos.x, h.pos.y, 0, s), H.hazard, st);
        if (warn > 0) this.spikeGlow.push(setFrame(T, h.pos.x, h.pos.y, 0, s), H.hazard + 0.5, st, warn * warn * 1.5);
        if (h.active) this.spikes.push(setFrame(T, h.pos.x, h.pos.y, 0, s), H.spikes, st);
        break;
      }
      case 'saw': {
        const s = radius / 26;
        this.saw.push(setFrame(T, h.pos.x, h.pos.y, time * 14 + i, s), H.hazard + 1.5, st, h.active ? 0.7 : 0.15);
        break;
      }
      case 'acid': {
        const life = h.ttl === null ? 1 : Math.min(1, h.ttl / 60);
        const k = this.acid.push(setFrame(T, h.pos.x, h.pos.y, 0, radius * 2.2), H.acid);
        if (k >= 0) {
          this.acid.data[k] = (hashString(h.id) % 100) / 10;
          this.acid.data[k + 1] = life;
        }
        break;
      }
      case 'fire': {
        const s = radius / 40;
        this.firePit.push(setFrame(T, h.pos.x, h.pos.y, i, s), H.hazard, st, 0.6 + 0.3 * Math.sin(time * 7 + i));
        const k = fire.push(setFrame(this.T2, h.pos.x, h.pos.y, time * 0.2 + i, radius * 2.1), H.fire);
        if (k >= 0) {
          fire.data[k] = i * 1.7;
          fire.data[k + 1] = 0.7;
          fire.data[k + 2] = 0.8;
        }
        this.pushGlow(glow, h.pos.x, h.pos.y, radius * 3, 0.45, 0.17, 0.04, H.fire - 0.2);
        break;
      }
    }
  }

  private drawPickup(p: WorldState['pickups'][number], i: number, time: number, gameDt: number, glow: QuadBatch, light: LightField): void {
    const st = this.style;
    const T = this.T;
    const rule = PICKUP_RULES[p.kind];
    const [r, g, b] = PICKUP_RGB[p.kind];
    const x = p.pos.x;
    const y = p.pos.y;
    const k = Math.min(i, MAX_PICKUPS - 1);
    this.spawnAge[k] = this.spawnAge[k]! + gameDt;
    this.takenAge[k] = this.takenAge[k]! + gameDt;
    const ready = p.cooldown <= 0;
    const progress = ready ? 1 : Math.max(0, Math.min(1, 1 - p.cooldown / rule.cooldownTicks));
    const secondsLeft = p.cooldown / TICK_HZ;
    const urgent = !ready && secondsLeft <= PICKUP_URGENT;
    const blink = urgent ? 0.5 + 0.5 * Math.sin(time * 26) : 0;

    // Pedestal: runes brighten as the respawn nears, full glow while the power-up is there.
    const runeGlow = ready ? 0.75 + 0.25 * Math.sin(time * 3 + i) : 0.08 + 0.55 * progress * progress + 0.6 * blink;
    this.pedestals[p.kind].push(setFrame(T, x, y, 0, 1), H.pedestal, st, runeGlow);

    // Respawn ring: a dim track and a fill that sweeps clockwise from the top.
    const top = -Math.PI / 2;
    if (ready) {
      this.arc(x, y, PICKUP_RING, top, top + Math.PI * 2, 2.6, r, g, b, 0.38 + 0.12 * Math.sin(time * 3 + i));
    } else {
      this.arc(x, y, PICKUP_RING, top, top + Math.PI * 2, 3.5, r * 0.4, g * 0.4, b * 0.4, 0.22);
      this.arc(x, y, PICKUP_RING, top, top + Math.PI * 2 * progress, 3.5, r, g, b, 0.7 + 0.3 * blink);
      const ha = top + Math.PI * 2 * progress;
      this.pushGlow(glow, x + Math.cos(ha) * PICKUP_RING, y + Math.sin(ha) * PICKUP_RING, 16 + 10 * blink, r * 0.6, g * 0.6, b * 0.6, H.shrine + 1.3);
    }

    // Taken: a ring bursts outward in the power-up's colour.
    const ta = this.takenAge[k]!;
    if (ta < 0.45) {
      const t = ta / 0.45;
      this.arc(x, y, 26 + 60 * Math.sqrt(t), 0, Math.PI * 2, 5 * (1 - t) + 1, r, g, b, 0.9 * (1 - t));
    }
    if (!ready) return;

    // The charm floats over the socket: pops in with an elastic overshoot, then bobs.
    const sa = this.spawnAge[k]!;
    const pop = sa < 0.7 ? 1 - Math.exp(-sa * 7) * Math.cos(sa * 16) : 1;
    const bob = 1 + 0.06 * Math.sin(time * 4 + x);
    const batch = p.kind === 'haste' ? this.haste : this.berserk;
    batch.push(setFrame(T, x, y, Math.sin(time * 1.5) * 0.3, Math.max(0.01, pop) * bob), H.pickup, st, 0.9);
    const halo = 1 + (sa < 0.4 ? (1 - sa / 0.4) * 1.5 : 0);
    this.pushGlow(glow, x, y, 78 * halo, r * 0.55, g * 0.55, b * 0.55, H.pickup + 0.5);
    light.frameLight(x, y, 115, r * 0.9, g * 0.9, b * 0.9);
  }

  /** Smooth ring arc from angle a0 to a1 (radians) on the marks layer. */
  private arc(x: number, y: number, radius: number, a0: number, a1: number, width: number, r: number, g: number, b: number, a: number): void {
    const segs = Math.max(2, Math.ceil((Math.abs(a1 - a0) / (Math.PI * 2)) * 48));
    for (let s = 0; s < segs; s++) {
      const t0 = a0 + ((a1 - a0) * s) / segs;
      const t1 = a0 + ((a1 - a0) * (s + 1)) / segs;
      this.marks.line(x + Math.cos(t0) * radius, y + Math.sin(t0) * radius, x + Math.cos(t1) * radius, y + Math.sin(t1) * radius, width, H.shrine + 1.2, r, g, b, a);
    }
  }

  private pushGlow(glow: QuadBatch, x: number, y: number, size: number, r: number, g: number, b: number, h: number): void {
    const k = glow.push(setFrame(this.T2, x, y, 0, size), h);
    if (k < 0) return;
    glow.data[k] = r;
    glow.data[k + 1] = g;
    glow.data[k + 2] = b;
  }

  /** Thin ring filling clockwise from the top (recharge progress). */
  private progressRing(x: number, y: number, r: number, t: number, cr: number, cg: number, cb: number): void {
    const segs = 32;
    const fill = Math.max(0, Math.min(1, t));
    for (let k = 0; k < segs; k++) {
      const a0 = -Math.PI / 2 + (k / segs) * Math.PI * 2;
      const a1 = -Math.PI / 2 + ((k + 1) / segs) * Math.PI * 2;
      const on = (k + 1) / segs <= fill + 1e-6;
      const a = on ? 0.55 : 0.12;
      this.marks.line(x + Math.cos(a0) * r, y + Math.sin(a0) * r, x + Math.cos(a1) * r, y + Math.sin(a1) * r, 2.4, H.shrine + 1.2, cr, cg, cb, a);
    }
  }

  private ownerColor(state: WorldState, ownerId: string | null): void {
    this.fighterColor.setRGB(0.55, 0.52, 0.48);
    if (ownerId === null) return;
    for (const f of state.fighters) {
      if (f.id === ownerId) {
        this.fighterColor.copy(colorOf(f.color));
        return;
      }
    }
  }

  dispose(): void {
    for (const b of this.batches) b.dispose();
    this.tracks.dispose();
    this.marks.dispose();
  }
}
