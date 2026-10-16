/**
 * Spent arrows and axes: stuck in walls, pillars and props at the angle they hit, stuck in bodies
 * (the comic pincushion, riding along with the fighter), stuck point-first in the floor, and lying
 * on the floor. Everything here is ammo someone can take back, and it says so: the fletching or the
 * grip band carries the owner's colour, and every retrievable piece catches the light now and then
 * with a small glint. Ammo in a living body is out of play and never glints.
 *
 * - A fresh stick quivers for half a second (the "doinggg"), whatever holds it.
 * - Ammo in a body is placed from the contract's body frame (`StuckIn` u, v, turn) on the body as it
 *   is drawn this frame (interpolated, hit-stop included), so it moves and turns with the fighter.
 * - When what held it goes away (the body dies, the prop breaks) the sim drops it as a floor item:
 *   a live drop falls from where it was drawn to where it lands, with a little spin, before the
 *   floor item shows.
 *
 * All per-frame work writes into preallocated batches; the only allocations are one small record
 * per newly seen stuck piece.
 */

import * as THREE from 'three/webgpu';
import { LAYER_HEIGHT, hashString } from '../core';
import type { AmmoKind, GameEvent, StuckAmmo, WorldState } from '../core';
import { affine, setChild, setFrame } from './affine';
import { PartBatch, newStyle } from './cutout';
import type { FighterLayer } from './fighters';
import { floorItemGeometry, looseArrowGeometry, stuckArrowGeometry, stuckAxeGeometry } from './parts';
import { QuadBatch, glowMaterial } from './sprites';

const MAX_STUCK = 128;
const MAX_FLOOR = 128;
const MAX_FALLS = 32;
const MAX_GLINTS = 48;

const H = {
  floor: LAYER_HEIGHT.floorItems + 0.1,
  upright: LAYER_HEIGHT.floorItems + 0.3,
  /** Under the walls (which hide the buried tip) and the fighters, over props' bases. */
  wall: LAYER_HEIGHT.props + 3.5,
  prop: LAYER_HEIGHT.props + 3.7,
  /** Over the torso, arms, weapon and hands, under the head: the pincushion always shows. */
  body: LAYER_HEIGHT.fighters + 5.5,
  falling: LAYER_HEIGHT.props + 4.5,
  glint: LAYER_HEIGHT.props + 5,
} as const;

/** Px a shaft in a body (or an axe's blade) is drawn past the contact point, so it sits in what it hit. */
const SINK = 3;
/** Stuck ammo in bodies is drawn a little smaller, so a full pincushion stays readable. */
const BODY_SCALE = 0.78;
/** Foreshortening of an arrow standing point-first in the floor, seen from straight above. */
const UPRIGHT_SQUASH = 0.42;
/** Seconds (game time) a fresh stick quivers. */
export const QUIVER_SECONDS = 0.55;
/** Seconds (game time) a dropped piece takes to fall from where it was to the floor. */
export const FALL_SECONDS = 0.42;
/** How often (seconds) a piece of ammo lying around glints, and how long the glint lasts. */
export const GLINT_PERIOD = 3.2;
const GLINT_LENGTH = 0.32;

export type Pose = { x: number; y: number; angle: number };

/** World point of a body-frame offset (u ahead along `facing`, v toward the right hand), written into `out`. */
export function bodyPoint(x: number, y: number, facing: number, u: number, v: number, out: Pose): Pose {
  const c = Math.cos(facing);
  const s = Math.sin(facing);
  out.x = x + u * c - v * s;
  out.y = y + u * s + v * c;
  return out;
}

/**
 * Where to draw a stuck piece: its tip and shaft angle. In a body it rides the body as drawn
 * (`body` x, y, facing; null = not on screen, use the sim's world pose); elsewhere it stays put.
 */
export function stuckPose(s: StuckAmmo, body: { x: number; y: number; facing: number } | null, out: Pose): Pose {
  if (s.in.kind === 'fighter' && body) {
    bodyPoint(body.x, body.y, body.facing, s.in.u, s.in.v, out);
    out.angle = body.facing + s.in.turn;
    return out;
  }
  out.x = s.pos.x;
  out.y = s.pos.y;
  out.angle = s.angle;
  return out;
}

/** Angle wobble (radians) of a piece `age` game seconds after it stuck: a fast, decaying quiver. */
export function quiver(age: number): number {
  if (!(age >= 0) || age >= QUIVER_SECONDS) return 0;
  const k = 1 - age / QUIVER_SECONDS;
  return Math.sin(age * 2 * Math.PI * 13) * 0.2 * k * k;
}

/** Glint strength 0..1 of a piece with `seed` at game time `time`: a short flash every GLINT_PERIOD. */
export function glint(time: number, seed: number): number {
  const p = (((time + seed * GLINT_PERIOD) % GLINT_PERIOD) + GLINT_PERIOD) % GLINT_PERIOD;
  return p < GLINT_LENGTH ? Math.sin((p / GLINT_LENGTH) * Math.PI) : 0;
}

/** Resting rotation of a floor item (stable per id, the same everywhere it is drawn). */
export function floorRotation(id: string): number {
  return (hashString(id) % 628) / 100;
}

type Fall = {
  active: boolean;
  itemId: string;
  kind: AmmoKind;
  ownerId: string | null;
  from: Pose;
  to: Pose;
  age: number;
  spin: number;
};

/**
 * Pose of a falling piece at `t` 0..1 of its fall: it drops under gravity from `from` to `to` (ease
 * in), turns to its resting angle with an extra `spin` (a whole turn, +-2 pi), and swells a little
 * mid-fall (it is closer to the camera). Returns the scale.
 */
export function fallPose(from: Pose, to: Pose, spin: number, t: number, out: Pose): number {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const g = k * k;
  out.x = from.x + (to.x - from.x) * g;
  out.y = from.y + (to.y - from.y) * g;
  let d = (to.angle - from.angle) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  const turn = 1 - (1 - k) * (1 - k);
  out.angle = k >= 1 ? to.angle : from.angle + (d + spin) * turn;
  return 1 + 0.22 * Math.sin(Math.PI * k);
}

type Seen = { pose: Pose; ownerId: string | null; frame: number };

export class AmmoLayer {
  readonly group = new THREE.Group();
  private readonly stuckArrow: PartBatch;
  private readonly looseArrow: PartBatch;
  private readonly stuckAxe: PartBatch;
  private readonly floorArrow: PartBatch;
  private readonly floorAxe: PartBatch;
  private readonly glints: QuadBatch;
  private readonly batches: PartBatch[];
  private readonly style = newStyle();
  private readonly T = affine();
  private readonly T2 = affine();
  private readonly pose: Pose = { x: 0, y: 0, angle: 0 };
  private readonly body = { x: 0, y: 0, facing: 0 };
  /** Where each stuck piece was drawn last (a drop falls from there). */
  private readonly seen = new Map<string, Seen>();
  private readonly falls: Fall[] = [];
  /** Floor items still falling (not drawn on the floor yet). */
  private readonly falling = new Set<string>();
  private frame = 0;

  constructor(material: THREE.Material) {
    this.group.name = 'ammo';
    this.stuckArrow = new PartBatch('stuck-arrows', stuckArrowGeometry(), material, MAX_STUCK);
    this.looseArrow = new PartBatch('falling-arrows', looseArrowGeometry(), material, MAX_FALLS);
    this.stuckAxe = new PartBatch('stuck-axes', stuckAxeGeometry(), material, MAX_STUCK + MAX_FALLS);
    this.floorArrow = new PartBatch('floor-arrows', floorItemGeometry('arrow'), material, MAX_FLOOR);
    this.floorAxe = new PartBatch('floor-axes', floorItemGeometry('axe'), material, MAX_FLOOR);
    this.batches = [this.stuckArrow, this.looseArrow, this.stuckAxe, this.floorArrow, this.floorAxe];
    this.glints = new QuadBatch('ammo-glints', glowMaterial(), MAX_GLINTS);
    this.glints.mesh.renderOrder = 5;
    this.group.add(...this.batches.map((b) => b.mesh), this.glints.mesh);
    this.style.skin.setRGB(1, 1, 1);
    for (let i = 0; i < MAX_FALLS; i++) {
      this.falls.push({ active: false, itemId: '', kind: 'arrow', ownerId: null, from: { x: 0, y: 0, angle: 0 }, to: { x: 0, y: 0, angle: 0 }, age: 0, spin: 0 });
    }
  }

  /** Live events: a piece leaving a body or a broken prop starts its fall to the floor. */
  onEvent(e: GameEvent): void {
    if (e.type !== 'ammo_unstick' || e.reason !== 'drop' || e.floorItemId === null) return;
    let slot = this.falls.find((f) => !f.active);
    if (!slot) slot = this.falls.reduce((a, b) => (a.age > b.age ? a : b));
    if (slot.active) this.falling.delete(slot.itemId);
    const last = this.seen.get(e.stuckId);
    slot.active = true;
    slot.itemId = e.floorItemId;
    slot.kind = e.kind;
    slot.ownerId = last ? last.ownerId : null;
    slot.age = 0;
    slot.from.x = last ? last.pose.x : e.pos.x;
    slot.from.y = last ? last.pose.y : e.pos.y;
    slot.from.angle = last ? last.pose.angle : 0;
    slot.to.x = e.pos.x;
    slot.to.y = e.pos.y;
    slot.to.angle = floorRotation(e.floorItemId);
    slot.spin = (hashString(e.floorItemId) % 2 === 0 ? 2 : -2) * Math.PI;
    this.falling.add(e.floorItemId);
  }

  /** Forget falls and quiver history (new match or seek). */
  reset(): void {
    for (const f of this.falls) f.active = false;
    this.falling.clear();
    this.seen.clear();
  }

  /**
   * Draw this frame. `tickTime` is the state's tick in seconds plus the interpolation alpha (for the
   * quiver), `time` the cosmetic game clock, `gameDt` the scaled frame time. Bodies come from the
   * fighter layer, already updated for this frame.
   */
  update(state: WorldState, tickTime: number, time: number, gameDt: number, fighters: FighterLayer): void {
    for (const b of this.batches) b.begin();
    this.glints.begin();
    this.frame++;
    const st = this.style;
    const T = this.T;
    const pose = this.pose;

    for (let k = 0; k < state.stuck.length; k++) {
      const s = state.stuck[k]!;
      let bodyOk = false;
      if (s.in.kind === 'fighter') {
        const i = fighters.indexOf(s.in.fighterId);
        if (i >= 0) {
          this.body.x = fighters.xs[i]!;
          this.body.y = fighters.ys[i]!;
          this.body.facing = fighters.facings[i]!;
          bodyOk = true;
        }
      }
      stuckPose(s, bodyOk ? this.body : null, pose);
      this.remember(s.id, s.ownerId, pose);
      const age = tickTime - s.tick / 60;
      const angle = pose.angle + quiver(age);
      const c = Math.cos(angle);
      const n = Math.sin(angle);
      // Shafts enter at the surface; in a body (drawn over it) and for an axe's bitten-in blade the
      // drawing starts a little deeper.
      const sink = s.in.kind === 'fighter' || s.kind === 'axe' ? SINK : 0;
      const x = pose.x + c * sink;
      const y = pose.y + n * sink;
      this.ownerColor(fighters, s.ownerId);
      const batch = s.kind === 'arrow' ? this.stuckArrow : this.stuckAxe;
      switch (s.in.kind) {
        case 'fighter':
          batch.push(setFrame(T, x, y, angle, BODY_SCALE), H.body, st, 0);
          break;
        case 'floor':
          // Point-first in the sand, leaning back the way it came: foreshortened from above.
          batch.push(setChild(this.T2, setFrame(T, pose.x, pose.y, angle, 1), 0, 0, 0, UPRIGHT_SQUASH, 1), H.upright, st, 0);
          break;
        case 'prop':
          batch.push(setFrame(T, x, y, angle, 1), H.prop, st, 0);
          break;
        case 'wall':
          batch.push(setFrame(T, x, y, angle, 1), H.wall, st, 0);
          break;
      }
      if (s.pickupPos !== null) {
        // The glint sits on the exposed end: the fletching of an arrow, the grip of an axe.
        const back = s.in.kind === 'floor' ? 8 : s.kind === 'arrow' ? 18 : 14;
        this.glintAt(pose.x - c * back, pose.y - n * back, time, hashString(s.id));
      }
    }
    this.forgetUnseen();

    for (const it of state.floor) {
      if ((it.kind !== 'arrow' && it.kind !== 'axe') || this.falling.has(it.id)) continue;
      this.ownerColor(fighters, it.ownerId);
      const rot = floorRotation(it.id);
      (it.kind === 'arrow' ? this.floorArrow : this.floorAxe).push(setFrame(T, it.pos.x, it.pos.y, rot, 1), H.floor, st, 0);
      const h = hashString(it.id);
      const tip = it.kind === 'arrow' ? 9 : 8;
      this.glintAt(it.pos.x + Math.cos(rot) * tip, it.pos.y + Math.sin(rot) * tip, time, h);
    }

    for (const f of this.falls) {
      if (!f.active) continue;
      f.age += gameDt;
      if (f.age >= FALL_SECONDS) {
        f.active = false;
        this.falling.delete(f.itemId);
        continue;
      }
      const scale = fallPose(f.from, f.to, f.spin, f.age / FALL_SECONDS, pose);
      this.ownerColor(fighters, f.ownerId);
      (f.kind === 'arrow' ? this.looseArrow : this.stuckAxe).push(setFrame(T, pose.x, pose.y, pose.angle, scale), H.falling, st, 0);
    }

    for (const b of this.batches) b.end();
    this.glints.end();
  }

  private remember(id: string, ownerId: string | null, pose: Pose): void {
    let s = this.seen.get(id);
    if (!s) {
      s = { pose: { x: 0, y: 0, angle: 0 }, ownerId, frame: 0 };
      this.seen.set(id, s);
    }
    s.pose.x = pose.x;
    s.pose.y = pose.y;
    s.pose.angle = pose.angle;
    s.frame = this.frame;
  }

  /** Drop records of pieces gone for a few frames (a drop is handled in the frame its event arrives). */
  private forgetUnseen(): void {
    if (this.frame % 30 !== 0) return;
    for (const [id, s] of this.seen) if (this.frame - s.frame > 30) this.seen.delete(id);
  }

  private glintAt(x: number, y: number, time: number, hash: number): void {
    const g = glint(time, (hash % 997) / 997);
    if (g <= 0.01) return;
    const k = this.glints.push(setFrame(this.T2, x, y, 0, 18 * (0.6 + 0.4 * g)), H.glint);
    if (k < 0) return;
    const d = this.glints.data;
    d[k] = 0.9 * g;
    d[k + 1] = 0.82 * g;
    d[k + 2] = 0.62 * g;
    d[k + 4] = 0.22;
  }

  /** Owner's colour into the style (neutral bone when unknown). */
  private ownerColor(fighters: FighterLayer, ownerId: string | null): void {
    const i = fighters.indexOf(ownerId);
    if (i >= 0) this.style.team.copy(fighters.teamColor(i));
    else this.style.team.setRGB(0.75, 0.72, 0.66);
  }

  dispose(): void {
    for (const b of this.batches) b.dispose();
    this.glints.dispose();
  }
}
