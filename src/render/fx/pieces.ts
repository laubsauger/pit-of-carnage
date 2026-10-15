// Owned by: render-fx
/**
 * CPU physics for thrown pieces (gibs, severed limbs, helmets, dropped weapons): ballistic flight
 * with spin, bounces that lose energy, sliding with friction, walls and pillars that stop them, and
 * a final settle where they stay on the floor until the next match. Bloody pieces report impacts and
 * streak stamps through a sink so the caller can paint the floor. Cosmetic only (uses the supplied
 * random source, never the sim rng).
 */

import { circleRectPush } from '../../core';
import type { Rect, Vec2 } from '../../core';
import { MATERIALS, PARTS } from './parts';
import type { PartId, PartMaterial } from './parts';
import { createTrail } from './bleeders';
import type { Trail } from './bleeders';
import { createStreak, resetStreak, streakStep } from './streaks';
import type { StreakStamp, StreakState } from './streaks';
import type { Pooled } from './pool';

export const PIECE_PHYS = {
  /** px/s^2. Gibs fall a little faster than real gravity at this scale, which reads punchier. */
  gravity: 980,
  /** A sliding piece slower than this (px/s) settles. */
  settleSpeed: 7,
  maxBounces: 4,
  /** Pieces below this height collide with walls and pillars (walls are 48 px tall). */
  wallHeight: 46,
  /** Fraction of horizontal speed kept when bouncing off a wall. */
  wallRestitution: 0.35,
  /** Longest physics sub-step (s), so fast pieces never tunnel through a pillar. */
  maxStep: 1 / 90,
};

export type Piece = Pooled & {
  part: PartId;
  material: PartMaterial;
  x: number;
  y: number;
  /** Height above the floor (px). */
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Rotation around the vertical axis (radians, world convention). */
  rot: number;
  /** rad/s. */
  spin: number;
  /** Tumble phase for rolling pieces (drawn as a squash), radians. */
  tumble: number;
  radius: number;
  /** Mirror the part (left vs right limbs). */
  flip: number;
  /** Owner colour (linear rgb) for tinted parts. */
  r: number;
  g: number;
  b: number;
  bounces: number;
  settled: boolean;
  age: number;
  streak: StreakState;
  /** Blood shed in flight (severed limbs); off for everything else. */
  bleed: Trail;
};

export function createPiece(): Piece {
  return {
    active: false, serial: 0, part: 'skull', material: 'bone',
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rot: 0, spin: 0, tumble: 0, radius: 6, flip: 1,
    r: 1, g: 1, b: 1, bounces: 0, settled: false, age: 0, streak: createStreak(0, 0), bleed: createTrail(),
  };
}

/** (Re)launch a pooled piece. Velocities in px/s. */
export function launchPiece(
  p: Piece, part: PartId, x: number, y: number, z: number,
  vx: number, vy: number, vz: number, rot: number, spin: number, flip = 1,
): Piece {
  const def = PARTS[part];
  p.part = part;
  p.material = def.material;
  p.x = x;
  p.y = y;
  p.z = z;
  p.vx = vx;
  p.vy = vy;
  p.vz = vz;
  p.rot = rot;
  p.spin = spin;
  p.tumble = 0;
  p.radius = def.radius;
  p.flip = flip;
  p.bounces = 0;
  p.settled = false;
  p.age = 0;
  resetStreak(p.streak, def.streakWidth, def.wet);
  p.bleed.on = false;
  return p;
}

export type PieceSink = {
  /** The piece hit the floor with vertical speed `speed` (px/s). */
  impact(p: Piece, speed: number): void;
  /** A blood streak stamp along the slide path (the stamp object is reused). */
  streak(p: Piece, st: StreakStamp): void;
  /** The piece bounced off a wall or pillar with speed `speed` (px/s). */
  wall(p: Piece, speed: number): void;
};

const push: Vec2 = { x: 0, y: 0 };

// The piece and sink of the current step, so the streak callback below is created once, not per step.
let curPiece: Piece | null = null;
let curSink: PieceSink | null = null;
function emitStreak(st: StreakStamp): void {
  if (curPiece && curSink) curSink.streak(curPiece, st);
}

function collideWalls(p: Piece, walls: readonly Rect[], sink: PieceSink): void {
  if (p.z > PIECE_PHYS.wallHeight) return;
  for (const w of walls) {
    if (!circleRectPush(push, p, p.radius, w)) continue;
    p.x += push.x;
    p.y += push.y;
    const len = Math.hypot(push.x, push.y);
    if (len <= 0) continue;
    const nx = push.x / len;
    const ny = push.y / len;
    const vn = p.vx * nx + p.vy * ny;
    if (vn < 0) {
      // Reflect the normal component, damped; keep some of the tangential slide.
      const k = 1 + PIECE_PHYS.wallRestitution;
      p.vx -= k * vn * nx;
      p.vy -= k * vn * ny;
      p.vx *= 0.8;
      p.vy *= 0.8;
      p.spin = -p.spin * 0.6;
      sink.wall(p, -vn);
    }
  }
}

function subStep(p: Piece, dt: number, walls: readonly Rect[], rand: () => number, sink: PieceSink): void {
  const mat = MATERIALS[p.material];
  const rolls = PARTS[p.part].rolls;
  if (p.z > 0 || p.vz > 0) {
    p.vz -= PIECE_PHYS.gravity * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    p.rot += p.spin * dt;
    if (rolls) p.tumble += Math.abs(p.spin) * 0.5 * dt;
    if (p.z <= 0) {
      p.z = 0;
      const speed = -p.vz;
      sink.impact(p, speed);
      if (speed > mat.minBounce && p.bounces < PIECE_PHYS.maxBounces) {
        p.vz = speed * mat.restitution;
        p.bounces++;
        p.vx *= 0.72;
        p.vy *= 0.72;
        p.spin = p.spin * 0.55 + (rand() - 0.5) * 10 * Math.min(1, speed / 400);
      } else {
        p.vz = 0;
      }
    }
  } else {
    const speed = Math.hypot(p.vx, p.vy);
    if (speed < PIECE_PHYS.settleSpeed) {
      p.vx = 0;
      p.vy = 0;
      p.spin = 0;
      p.settled = true;
      return;
    }
    const ns = Math.max(0, speed - mat.friction * dt);
    const k = ns / speed;
    if (rolls) {
      // A rolling helmet curves and keeps spinning with its speed.
      const turn = 1.4 * dt * (p.flip > 0 ? 1 : -1);
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      const vx = p.vx * c - p.vy * s;
      p.vy = p.vx * s + p.vy * c;
      p.vx = vx;
      p.spin = (ns / Math.max(4, p.radius)) * 0.6 * (p.flip > 0 ? 1 : -1);
      p.tumble += (ns / Math.max(4, p.radius)) * dt;
    } else {
      p.spin *= Math.exp(-4 * dt);
    }
    const x0 = p.x;
    const y0 = p.y;
    p.vx *= k;
    p.vy *= k;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.spin * dt;
    if (p.streak.wet > 0) {
      curPiece = p;
      curSink = sink;
      streakStep(p.streak, x0, y0, p.x, p.y, ns, rand, emitStreak);
      curPiece = null;
      curSink = null;
    }
  }
  collideWalls(p, walls, sink);
}

/** Advance one piece by `dt` seconds (sub-stepped). Settled and inactive pieces are left alone. */
export function stepPiece(p: Piece, dt: number, walls: readonly Rect[], rand: () => number, sink: PieceSink): void {
  if (!p.active || p.settled || dt <= 0) return;
  p.age += dt;
  let left = dt;
  while (left > 0 && !p.settled) {
    const h = left > PIECE_PHYS.maxStep ? PIECE_PHYS.maxStep : left;
    subStep(p, h, walls, rand, sink);
    left -= h;
  }
}
