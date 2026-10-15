/**
 * Readability overlays, each switched by the viewer's View settings:
 * - Vision cones (off / selected / all): soft team-coloured fans on the floor, drawn as exact
 *   visibility polygons around an eased heading, so they neither pop on pillar corners nor twitch
 *   with the head; a visible step at 45% range marks how far the fighter sees into shadow.
 * - Fog of war for the selected fighter: outside its cone the arena dims, the hearing circle less.
 *   Other fighters' tags show only while the selected fighter actually sees them (its knowledge).
 * - What the selected fighter knows (`Match.knowledge`, never the live world): a ghost at each
 *   enemy's last seen spot with "lost sight N s ago" (with fog), rough ripples around where it
 *   hears someone, never an exact marker (hearing), and the target line to where it believes its
 *   target is (rings).
 * - Steering ring for the selected fighter, from the brain's last decision (rings).
 */

import * as THREE from 'three/webgpu';
import {
  Fn, If, abs, atan, float, int, length, mix, positionWorld, select, smoothstep, uniform, uniformArray, vec3,
} from 'three/tsl';
import { DEFAULT_VIEW_SETTINGS, LAYER_HEIGHT, PERCEPTION, STEER_DIRS, TAU, TICK_HZ, hearingRadius, visionFov, visionRange } from '../core';
import type { Decision, FighterState, KnownFighter, MapDef, Rect, ViewSettings, WorldState } from '../core';
import { basicMaterial, colorOf } from './cutout';
import { DynamicMesh } from './dynmesh';
import type { FighterLayer } from './fighters';
import { LabelLayer } from './labels';
import { castFan, castVisibility, easeAngle } from './vision';

/** Even rays per cone (corner rays come on top). */
const RAYS = 48;
/** Most rays one cone may use, corners included. */
const CONE_CAP = 256;
/** Rays of the fog fan (sampled per pixel, interpolated between rays). */
const FOG_RAYS = 128;
/** How fast a drawn cone follows the head (per second). */
const CONE_EASE = 14;
const CONE_H = LAYER_HEIGHT.floorFx + 0.4;
const FOG_H = LAYER_HEIGHT.walls - 2;
const RING_H = LAYER_HEIGHT.overlay;
const KNOW_H = LAYER_HEIGHT.overlay + 0.5;
const MEMORY_SECONDS = PERCEPTION.memoryTicks / TICK_HZ;

/** Cone opacity at distance d: fades to `aInner` at the shadow-sight radius, then steps down and fades out. */
function coneAlpha(d: number, inner: number, range: number, aCentre: number, aInner: number, aOuter: number): number {
  if (d <= inner) return aCentre + (aInner - aCentre) * (d / inner);
  return aOuter * (1 - ((d - inner) / Math.max(1, range - inner)) * 0.85);
}

function findRecord(known: readonly KnownFighter[] | null, id: string | null): KnownFighter | null {
  if (!known || id === null) return null;
  for (let i = 0; i < known.length; i++) if (known[i]!.id === id) return known[i]!;
  return null;
}

export class OverlayLayer {
  readonly group = new THREE.Group();
  /** Per roster slot: may the viewer see this fighter's tag (always true when fog is off). */
  readonly visibleToViewer = new Uint8Array(64).fill(1);
  private readonly cones: DynamicMesh;
  private readonly ring: DynamicMesh;
  private readonly know: DynamicMesh;
  private readonly labels = new LabelLayer();
  private readonly fog: THREE.Mesh;
  private readonly fogDists: number[] = new Array(FOG_RAYS + 1).fill(0);
  private readonly fogDistNode = uniformArray<'float'>(this.fogDists, 'float');
  private readonly fogOrigin = uniform(new THREE.Vector2());
  private readonly fogHeading = uniform(0);
  private readonly fogFov = uniform(1);
  private readonly fogHearing = uniform(0);
  private readonly fan = new Float32Array(FOG_RAYS + 1);
  private readonly coneAng = new Float32Array(CONE_CAP);
  private readonly coneDist = new Float32Array(CONE_CAP);
  private readonly coneHeads = new Float32Array(64);
  private rosterVersion = -1;
  private blockers: Rect[] = [];
  private overlay: ViewSettings = { ...DEFAULT_VIEW_SETTINGS };

  constructor() {
    this.group.name = 'overlays';
    this.cones = new DynamicMesh('vision-cones', 16 * CONE_CAP * 9);
    this.cones.mesh.renderOrder = 2;
    this.ring = new DynamicMesh('steering', 6 * 400, { depthTest: false, emissive: 0.3 });
    this.ring.mesh.renderOrder = 50;
    this.know = new DynamicMesh('knowledge', 6 * 4096, { depthTest: false, emissive: 0.25 });
    this.know.mesh.renderOrder = 51;
    this.fog = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.fogMaterial());
    this.fog.name = 'fog';
    this.fog.renderOrder = 40;
    this.fog.visible = false;
    this.group.add(this.cones.mesh, this.fog, this.ring.mesh, this.know.mesh, this.labels.group);
  }

  setMap(map: MapDef): void {
    this.blockers = [...map.walls, ...map.pillars];
    // Extend past the map so the fog also covers the margin the camera may show.
    this.fog.scale.set(map.width + 400, 1, map.height + 400);
    this.fog.position.set(map.width / 2, FOG_H, map.height / 2);
    this.rosterVersion = -1;
  }

  setView(v: ViewSettings): void {
    this.overlay = { ...v };
  }

  /**
   * `known` is the selected fighter's knowledge (null when nothing is selected). `dt` is real
   * frame seconds (cone easing), `time` the cosmetic clock, `px` world px per screen px.
   */
  update(
    state: WorldState, fighters: FighterLayer, selectedId: string | null, decision: Decision | null,
    known: readonly KnownFighter[] | null, dt: number, time: number, px: number,
  ): void {
    const o = this.overlay;
    this.cones.begin();
    this.ring.begin();
    this.know.begin();
    this.labels.begin();
    const sel = fighters.indexOf(selectedId);
    const selState = sel >= 0 ? state.fighters[sel] : undefined;
    const selAlive = selState !== undefined && selState.alive;

    // Drawn cone headings glide after the head (snapped when the roster changes).
    const snap = fighters.rosterVersion !== this.rosterVersion;
    this.rosterVersion = fighters.rosterVersion;
    for (let i = 0; i < fighters.count; i++) {
      this.coneHeads[i] = snap ? fighters.heads[i]! : easeAngle(this.coneHeads[i]!, fighters.heads[i]!, dt, CONE_EASE);
    }

    // Cones. The closing wall blocks sight like walls do.
    const zone = state.suddenDeath.active ? state.suddenDeath.bounds : null;
    for (let i = 0; i < fighters.count; i++) {
      const f = state.fighters[i];
      if (!f || !f.alive) continue;
      const show = o.cones === 'all' || (o.cones === 'selected' && i === sel);
      if (!show) continue;
      this.cone(f, fighters, i, i === sel ? 1 : 0.6, zone);
    }

    // Fog for the selected fighter; tags only for the fighters it sees (and its squad).
    this.visibleToViewer.fill(1);
    const fogOn = o.fog && selAlive;
    this.fog.visible = fogOn;
    if (fogOn && selState) {
      const x = fighters.xs[sel]!;
      const y = fighters.ys[sel]!;
      const heading = this.coneHeads[sel]!;
      const range = visionRange(selState.attributes, selState.weapon);
      const fov = visionFov(selState.attributes, selState.weapon);
      castFan(x, y, heading, fov, range, this.blockers, FOG_RAYS, this.fan, zone);
      for (let k = 0; k <= FOG_RAYS; k++) this.fogDists[k] = this.fan[k]!;
      this.fogOrigin.value.set(x, y);
      this.fogHeading.value = heading;
      this.fogFov.value = fov;
      this.fogHearing.value = hearingRadius(selState.attributes);
      for (let i = 0; i < fighters.count; i++) {
        const f = state.fighters[i];
        if (i === sel || !f) continue;
        if (f.squad === selState.squad) continue;
        this.visibleToViewer[i] = findRecord(known, f.id)?.seen ? 1 : 0;
      }
    }

    if (selAlive && selState && known) {
      if (o.fog) this.ghosts(state, fighters, known, px);
      if (o.hearing) this.ripples(fighters, known, time);
    }

    // Steering ring and the line to where it believes its target is.
    if (o.rings && selAlive && selState) this.steering(selState, fighters, sel, decision, known);

    this.cones.end();
    this.ring.end();
    this.know.end();
    this.labels.end();
  }

  private cone(f: FighterState, fighters: FighterLayer, i: number, strength: number, zone: Rect | null): void {
    const x = fighters.xs[i]!;
    const y = fighters.ys[i]!;
    const heading = this.coneHeads[i]!;
    const range = visionRange(f.attributes, f.weapon);
    const fov = visionFov(f.attributes, f.weapon);
    const n = castVisibility(x, y, heading, fov, range, this.blockers, RAYS, this.coneAng, this.coneDist, zone);
    const c = colorOf(f.color);
    const inner = range * PERCEPTION.shadowVisionMul;
    // Alpha depends only on distance from the eye, so neighbouring rays blend seamlessly. The step
    // at `inner` marks how far the fighter sees into shadow.
    const aCentre = 0.13 * strength;
    const aInner = 0.075 * strength;
    const aOuter = 0.04 * strength;
    for (let k = 0; k + 1 < n; k++) {
      const ang0 = this.coneAng[k]!;
      const ang1 = this.coneAng[k + 1]!;
      const d0 = this.coneDist[k]!;
      const d1 = this.coneDist[k + 1]!;
      const c0 = Math.cos(ang0);
      const s0 = Math.sin(ang0);
      const c1 = Math.cos(ang1);
      const s1 = Math.sin(ang1);
      const i0 = Math.min(d0, inner);
      const i1 = Math.min(d1, inner);
      this.vert(x, y, c, aCentre);
      this.vert(x + c0 * i0, y + s0 * i0, c, coneAlpha(i0, inner, range, aCentre, aInner, aOuter));
      this.vert(x + c1 * i1, y + s1 * i1, c, coneAlpha(i1, inner, range, aCentre, aInner, aOuter));
      if (d0 <= inner && d1 <= inner) continue;
      const o0 = Math.max(d0, inner);
      const o1 = Math.max(d1, inner);
      const ai0 = d0 > inner ? aOuter : 0;
      const ai1 = d1 > inner ? aOuter : 0;
      const ao0 = d0 > inner ? coneAlpha(o0, inner, range, aCentre, aInner, aOuter) : 0;
      const ao1 = d1 > inner ? coneAlpha(o1, inner, range, aCentre, aInner, aOuter) : 0;
      this.vert(x + c0 * i0, y + s0 * i0, c, ai0);
      this.vert(x + c0 * o0, y + s0 * o0, c, ao0);
      this.vert(x + c1 * i1, y + s1 * i1, c, ai1);
      this.vert(x + c0 * o0, y + s0 * o0, c, ao0);
      this.vert(x + c1 * o1, y + s1 * o1, c, ao1);
      this.vert(x + c1 * i1, y + s1 * i1, c, ai1);
    }
  }

  private vert(x: number, y: number, c: THREE.Color, a: number): void {
    this.cones.vert(x, y, CONE_H, c.r, c.g, c.b, a);
  }

  /** Ghost at every enemy's last seen spot (as it was then: size, facing), with "lost sight N s ago". */
  private ghosts(state: WorldState, fighters: FighterLayer, known: readonly KnownFighter[], px: number): void {
    for (let n = 0; n < known.length; n++) {
      const rec = known[n]!;
      if (rec.seen || rec.lastSeenTick < 0) continue;
      const t = fighters.indexOf(rec.id);
      const c = t >= 0 ? fighters.teamColor(t) : colorOf('#a39a8e');
      const r = (t >= 0 ? fighters.rs[t]! : 18) + 3;
      const age = Math.max(0, (state.tick - rec.lastSeenTick) / TICK_HZ);
      const fade = 1 - 0.55 * Math.min(1, age / MEMORY_SECONDS);
      const x = rec.lastSeenPos.x;
      const y = rec.lastSeenPos.y;
      // Faint body, dashed outline, and a notch for the way it was facing.
      const segs = 20;
      for (let k = 0; k < segs; k++) {
        const a0 = (k / segs) * TAU;
        const a1 = ((k + 1) / segs) * TAU;
        this.know.vert(x, y, KNOW_H, c.r, c.g, c.b, 0.13 * fade);
        this.know.vert(x + Math.cos(a0) * r, y + Math.sin(a0) * r, KNOW_H, c.r, c.g, c.b, 0.05 * fade);
        this.know.vert(x + Math.cos(a1) * r, y + Math.sin(a1) * r, KNOW_H, c.r, c.g, c.b, 0.05 * fade);
        if (k % 2 === 0) {
          this.know.line(x + Math.cos(a0) * r, y + Math.sin(a0) * r, x + Math.cos(a1) * r, y + Math.sin(a1) * r, 2, KNOW_H + 0.05, c.r, c.g, c.b, 0.8 * fade);
        }
      }
      const fx = Math.cos(rec.facing);
      const fy = Math.sin(rec.facing);
      this.know.line(x + fx * r * 0.35, y + fy * r * 0.35, x + fx * (r + 6), y + fy * (r + 6), 2.4, KNOW_H + 0.05, c.r, c.g, c.b, 0.85 * fade);
      this.labels.lostSight(x, y + r, 5, age, c, 0.92 * fade, px);
    }
  }

  /** Rough ripples spreading over the area where a heard-only enemy may be (never a point). */
  private ripples(fighters: FighterLayer, known: readonly KnownFighter[], time: number): void {
    for (let n = 0; n < known.length; n++) {
      const rec = known[n]!;
      if (!rec.heard || rec.seen) continue;
      const t = fighters.indexOf(rec.id);
      const base = t >= 0 ? fighters.teamColor(t) : colorOf('#a39a8e');
      const cr = base.r + (1 - base.r) * 0.35;
      const cg = base.g + (1 - base.g) * 0.35;
      const cb = base.b + (1 - base.b) * 0.35;
      const err = Math.max(rec.estimateError, 14);
      const seed = (n * 2.39) % TAU;
      for (let k = 0; k < 3; k++) {
        const phase = (time * 0.55 + k / 3 + seed * 0.1) % 1;
        const radius = err * (0.3 + 0.85 * phase);
        const alpha = 0.6 * (1 - phase) * Math.min(1, phase * 5);
        if (alpha <= 0.01) continue;
        const segs = 30;
        let px0 = 0;
        let py0 = 0;
        for (let s = 0; s <= segs; s++) {
          const a = (s / segs) * TAU;
          const wob = 1 + 0.09 * Math.sin(a * 5 + seed + time * 1.7) + 0.05 * Math.sin(a * 3 - time * 1.1 + seed * 2);
          const px1 = rec.pos.x + Math.cos(a) * radius * wob;
          const py1 = rec.pos.y + Math.sin(a) * radius * wob;
          if (s > 0) this.know.line(px0, py0, px1, py1, 2.2, KNOW_H, cr, cg, cb, alpha);
          px0 = px1;
          py0 = py1;
        }
      }
    }
  }

  private steering(f: FighterState, fighters: FighterLayer, i: number, d: Decision | null, known: readonly KnownFighter[] | null): void {
    const x = fighters.xs[i]!;
    const y = fighters.ys[i]!;
    const base = f.radius + 12;
    if (d && d.ring.length === STEER_DIRS) {
      let best = 0;
      for (let k = 1; k < STEER_DIRS; k++) if (d.ring[k]! > d.ring[best]!) best = k;
      for (let k = 0; k < STEER_DIRS; k++) {
        const v = d.ring[k]!;
        const a = (k * TAU) / STEER_DIRS;
        const len = 4 + Math.min(1, Math.abs(v)) * 26;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const pos = v >= 0;
        const r = pos ? 0.37 : 0.88;
        const g = pos ? 0.83 : 0.32;
        const b = pos ? 0.54 : 0.25;
        this.ring.line(x + ca * base, y + sa * base, x + ca * (base + len), y + sa * (base + len), k === best ? 4.5 : 3, RING_H, r, g, b, k === best ? 0.95 : 0.7);
      }
      // Chosen heading: a white arrow just outside the ring.
      const h = d.heading;
      const tipR = base + 40;
      const tx = x + Math.cos(h) * tipR;
      const ty = y + Math.sin(h) * tipR;
      this.ring.line(x + Math.cos(h) * (base + 30), y + Math.sin(h) * (base + 30), tx, ty, 3, RING_H + 0.1, 1, 0.96, 0.88, 0.95);
      const wing = 7;
      this.ring.line(tx, ty, tx - Math.cos(h - 0.5) * wing, ty - Math.sin(h - 0.5) * wing, 3, RING_H + 0.1, 1, 0.96, 0.88, 0.95);
      this.ring.line(tx, ty, tx - Math.cos(h + 0.5) * wing, ty - Math.sin(h + 0.5) * wing, 3, RING_H + 0.1, 1, 0.96, 0.88, 0.95);
    }
    // Target line, toward what the fighter knows: the body while seen, the estimate while only
    // heard (ending in its uncertainty circle), the remembered spot otherwise. No record, no line.
    const targetId = d?.targetId ?? f.targetId;
    const rec = findRecord(known, targetId);
    if (!rec) return;
    const t = fighters.indexOf(rec.id);
    const seen = rec.seen && t >= 0 && fighters.alive[t] === 1;
    const tx = seen ? fighters.xs[t]! : rec.pos.x;
    const ty = seen ? fighters.ys[t]! : rec.pos.y;
    const endR = seen ? fighters.rs[t]! + 7 : rec.heard ? Math.max(rec.estimateError, 14) : (t >= 0 ? fighters.rs[t]! : 18) + 7;
    const alpha = seen ? 0.85 : rec.heard ? 0.6 : 0.4;
    const c = colorOf(f.color);
    const dx = tx - x;
    const dy = ty - y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    const ux = dx / len;
    const uy = dy / len;
    const start = f.radius + 6;
    const end = len - (seen ? endR + 1 : Math.min(endR, len * 0.5));
    const gap = seen ? 16 : 22;
    for (let s = start; s < end; s += gap) {
      const e = Math.min(end, s + 9);
      this.ring.line(x + ux * s, y + uy * s, x + ux * e, y + uy * e, 2.5, RING_H, c.r, c.g, c.b, alpha);
    }
    const segs = seen ? 20 : 28;
    for (let k = 0; k < segs; k += 2) {
      const a0 = (k / segs) * TAU;
      const a1 = ((k + 1) / segs) * TAU;
      this.ring.line(tx + Math.cos(a0) * endR, ty + Math.sin(a0) * endR, tx + Math.cos(a1) * endR, ty + Math.sin(a1) * endR, 2.5, RING_H, c.r, c.g, c.b, alpha);
    }
  }

  private fogMaterial(): THREE.MeshBasicNodeMaterial {
    const m = basicMaterial('fog');
    m.transparent = true;
    m.depthWrite = false;
    const dists = this.fogDistNode;
    const origin = this.fogOrigin;
    const heading = this.fogHeading;
    const fov = this.fogFov;
    const hearing = this.fogHearing;
    const alpha = Fn(() => {
      const p = positionWorld.xz;
      const d = p.sub(origin);
      const dist = length(d);
      const rel = atan(d.y, d.x).sub(heading);
      // Wrap to (-π, π].
      const wrapped = rel.sub(float(TAU).mul(rel.add(Math.PI).div(TAU).floor()));
      const inFov = abs(wrapped).lessThan(fov.mul(0.5));
      const f = wrapped.add(fov.mul(0.5)).div(fov).mul(FOG_RAYS).clamp(0, FOG_RAYS - 0.001);
      const k = int(f.floor());
      const t = f.fract();
      const reach = mix(dists.element(k), dists.element(k.add(1)), t);
      const seen = select(inFov, smoothstep(reach.sub(14), reach, dist).oneMinus(), float(0));
      const heard = smoothstep(hearing.sub(24), hearing, dist).oneMinus();
      const a = float(0.8).toVar();
      a.assign(mix(a, float(0.5), heard));
      If(seen.greaterThan(0), () => {
        a.assign(mix(a, float(0), seen));
      });
      return a;
    })();
    m.colorNode = vec3(0.012, 0.012, 0.02);
    m.opacityNode = alpha;
    return m;
  }

  dispose(): void {
    this.cones.dispose();
    this.ring.dispose();
    this.know.dispose();
    this.labels.dispose();
    this.fog.geometry.dispose();
    (this.fog.material as THREE.Material).dispose();
  }
}
