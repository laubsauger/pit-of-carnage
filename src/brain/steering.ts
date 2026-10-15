/**
 * Context steering. Each move term rates the STEER_DIRS headings in [-1, 1]; the brain sums them
 * with their weights, smooths the sum over thinks, adds a little momentum, subtracts wall and
 * hazard danger, and walks toward the best-rated heading. Ratings stay inspectable: every term
 * writes into its own buffer, which the inspector draws.
 */

import { STEER_COS, STEER_DIRS, STEER_SIN, TAU, clamp01 } from '../core';
import type { ThinkCtx } from './ctx';
import type { PlaceFn, PlaceOut, ZoneFn } from './registry';
import { STEERING } from './tuning';

/** Writes this term's unweighted rating of every direction into `out`. */
export type TermRater = (c: ThinkCtx, out: Float64Array) => void;

/** out[i] = strength x cos(angle between direction i and the unit vector (ux, uy)). */
function rateToward(out: Float64Array, ux: number, uy: number, strength: number): void {
  for (let i = 0; i < STEER_DIRS; i++) out[i] = (STEER_COS[i]! * ux + STEER_SIN[i]! * uy) * strength;
}

export function seekTerm(place: PlaceFn): TermRater {
  const p: PlaceOut = { x: 0, y: 0, fighter: null };
  return (c, out) => {
    if (!place(c, p)) return void out.fill(0);
    const sx = c.self.pos.x;
    const sy = c.self.pos.y;
    const dist = Math.hypot(p.x - sx, p.y - sy);
    let stop = STEERING.pointStop;
    let tx = p.x;
    let ty = p.y;
    const f = p.fighter;
    if (f) {
      stop = c.self.radius + STEERING.fighterStop;
      // Only a fighter in sight is led: a heard or remembered one's velocity is stale.
      if (f.seen) {
        const lead = Math.min(dist / Math.max(c.baseSpeed, 0.1), STEERING.leadMaxTicks);
        tx += f.vel.x * lead;
        ty += f.vel.y * lead;
      }
    }
    const strength = clamp01((dist - stop) / STEERING.arriveRamp);
    const dx = tx - sx;
    const dy = ty - sy;
    const d = Math.hypot(dx, dy);
    if (strength <= 0 || d < 1e-6) return void out.fill(0);
    rateToward(out, dx / d, dy / d, strength);
  };
}

export function fleeTerm(place: PlaceFn): TermRater {
  const p: PlaceOut = { x: 0, y: 0, fighter: null };
  return (c, out) => {
    if (!place(c, p)) return void out.fill(0);
    const dx = p.x - c.self.pos.x;
    const dy = p.y - c.self.pos.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return void out.fill(0);
    rateToward(out, -dx / d, -dy / d, 1);
  };
}

export function keepRangeTerm(place: PlaceFn, min: number, max: number): TermRater {
  const p: PlaceOut = { x: 0, y: 0, fighter: null };
  return (c, out) => {
    if (!place(c, p)) return void out.fill(0);
    const dx = p.x - c.self.pos.x;
    const dy = p.y - c.self.pos.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return void out.fill(0);
    if (d < min) rateToward(out, -dx / d, -dy / d, clamp01((min - d) / STEERING.rangeRamp));
    else if (d > max) rateToward(out, dx / d, dy / d, clamp01((d - max) / STEERING.rangeRamp));
    else out.fill(0);
  };
}

export function orbitTerm(place: PlaceFn, dir: 'cw' | 'ccw'): TermRater {
  const p: PlaceOut = { x: 0, y: 0, fighter: null };
  return (c, out) => {
    if (!place(c, p)) return void out.fill(0);
    const dx = p.x - c.self.pos.x;
    const dy = p.y - c.self.pos.y;
    if (Math.hypot(dx, dy) < 1e-6) return void out.fill(0);
    const toP = Math.atan2(dy, dx);
    // Clockwise on screen (+y down) is the tangent 90° before the direction to the centre.
    const t = dir === 'cw' ? toP - Math.PI / 2 + STEERING.orbitTilt : toP + Math.PI / 2 - STEERING.orbitTilt;
    rateToward(out, Math.cos(t), Math.sin(t), 1);
  };
}

/** avoid (sign -1) / prefer (sign +1): how much more of the zone lies each way than where you stand. */
export function zoneTerm(zone: ZoneFn, sign: 1 | -1): TermRater {
  return (c, out) => {
    const sx = c.self.pos.x;
    const sy = c.self.pos.y;
    const here = zone(c, sx, sy);
    for (let i = 0; i < STEER_DIRS; i++) {
      const cx = STEER_COS[i]!;
      const cy = STEER_SIN[i]!;
      const near = zone(c, sx + cx * STEERING.sampleNear, sy + cy * STEERING.sampleNear);
      const far = zone(c, sx + cx * STEERING.sampleFar, sy + cy * STEERING.sampleFar);
      const d = (near + far) / 2 - here;
      out[i] = d === 0 ? 0 : sign * d;
    }
  };
}

export type SteerTerm = { weight: number; rate: TermRater; buf: Float64Array };

/**
 * Per-brain steering state. `run` rates all terms, combines them and returns the heading and
 * throttle; afterwards `ring` (final ratings), `danger` and each term's `buf` hold the reasoning.
 */
export class Steering {
  /** Smoothed weighted sum of the terms. */
  readonly interest = new Float64Array(STEER_DIRS);
  /** Raw 0..1 danger per direction (max of wall and hazard danger). */
  readonly danger = new Float64Array(STEER_DIRS);
  /** What danger subtracts: max(1, weight sum) x (danger - safest direction's danger). */
  readonly penalty = new Float64Array(STEER_DIRS);
  /** Final ratings: interest + momentum - penalty. */
  readonly ring = new Float64Array(STEER_DIRS);
  private readonly raw = new Float64Array(STEER_DIRS);
  private readonly whisker = { x: 0, y: 0 };
  private primed = false;

  run(c: ThinkCtx, terms: readonly SteerTerm[], weightSum: number): { heading: number; speed: number } {
    const raw = this.raw;
    raw.fill(0);
    for (const t of terms) {
      t.rate(c, t.buf);
      for (let i = 0; i < STEER_DIRS; i++) raw[i] += t.buf[i]! * t.weight;
    }

    const keep = this.primed ? STEERING.smoothing : 0;
    this.primed = true;
    for (let i = 0; i < STEER_DIRS; i++) this.interest[i] = keep * this.interest[i]! + (1 - keep) * raw[i]!;

    // Danger is measured from the front of the body and from both sides of it (so touching a wall
    // reads 1 and a body that would clip a corner sees it); only the part above the safest
    // direction counts, so standing in a uniformly dangerous spot still lets you pick the least
    // bad way out.
    let minDanger = Infinity;
    for (let i = 0; i < STEER_DIRS; i++) {
      const d = this.directionDanger(c, STEER_COS[i]!, STEER_SIN[i]!);
      this.danger[i] = d;
      if (d < minDanger) minDanger = d;
    }

    const vx = c.self.vel.x;
    const vy = c.self.vel.y;
    const v = Math.hypot(vx, vy);
    const mx = v > 0.05 ? (vx / v) * STEERING.momentum : 0;
    const my = v > 0.05 ? (vy / v) * STEERING.momentum : 0;
    const scale = Math.max(1, weightSum);
    let best = 0;
    let bestOpen = -1;
    let wantedRating = -Infinity;
    for (let i = 0; i < STEER_DIRS; i++) {
      this.penalty[i] = scale * (this.danger[i]! - minDanger);
      this.ring[i] = this.interest[i]! + STEER_COS[i]! * mx + STEER_SIN[i]! * my - this.penalty[i]!;
      if (this.ring[i]! > this.ring[best]!) best = i;
      if (this.danger[i]! - minDanger <= STEERING.slideOpen && (bestOpen < 0 || this.ring[i]! > this.ring[bestOpen]!)) bestOpen = i;
      if (this.interest[i]! > wantedRating) wantedRating = this.interest[i]!;
    }
    let speed = throttle(this.ring[best]!);
    // Sliding: when danger took away speed you wanted (a pillar between you and where you are
    // going), walk the best open direction at the speed you wanted, so you go round, not stop.
    const wanted = throttle(wantedRating);
    if (speed < wanted && bestOpen >= 0) {
      best = bestOpen;
      speed = wanted;
    }

    // Parabolic refinement between the best direction and its neighbours for a smooth heading.
    const l = this.ring[(best + STEER_DIRS - 1) % STEER_DIRS]!;
    const m = this.ring[best]!;
    const r = this.ring[(best + 1) % STEER_DIRS]!;
    const denom = l - 2 * m + r;
    const offset = denom < -1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / denom)) : 0;
    let heading = ((best + offset) * TAU) / STEER_DIRS;
    if (heading > Math.PI) heading -= TAU;
    return { heading, speed };
  }

  /** Danger of walking along (dx, dy): the worst of three rays, from the front of the body and from its two sides. */
  private directionDanger(c: ThinkCtx, dx: number, dy: number): number {
    const w = this.whisker;
    const pos = c.self.pos;
    const r = c.self.radius;
    let danger = 0;
    for (let k = -1; k <= 1; k++) {
      const side = k * SIDE * r;
      const fwd = k === 0 ? r : SIDE_FORWARD * r;
      w.x = pos.x + dx * fwd - dy * side;
      w.y = pos.y + dy * fwd + dx * side;
      const d = Math.max(c.world.wallDanger(w, dx, dy, STEERING.wallLookahead), c.world.hazardDanger(w, dx, dy, STEERING.hazardLookahead));
      if (d > danger) danger = d;
    }
    return danger;
  }
}

/** Side whiskers start on the body edge, this fraction of the radius out from the centre line. */
const SIDE = STEERING.whiskerSide;
const SIDE_FORWARD = Math.sqrt(1 - SIDE * SIDE);

function throttle(rating: number): number {
  return clamp01((rating - STEERING.throttleDead) / (STEERING.throttleFull - STEERING.throttleDead));
}
