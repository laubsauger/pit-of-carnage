/**
 * Stuck arrows and axes (`WorldState.stuck`, rules in `STUCK_AMMO`).
 *
 * A spent arrow or axe ends where its flight ended: stuck in a wall or pillar, in a crate, keg or
 * amphora, in a body (the comic pincushion), point-first in the floor, or lying flat on the floor
 * as a plain `FloorItem`. Ammo in a wall, prop or the floor is taken back by touching its
 * `pickupPos` (just in front of the surface it hit); ammo in a living body is out of play and
 * drops to the floor around the corpse when that body dies. A prop that breaks and the closing
 * wall that passes over a pickup point drop what they held too, so nothing is ever out of reach
 * for good.
 *
 * Events: `ammo_stick` right after the shot's `projectile_end`; `ammo_unstick` when it leaves its
 * spot (`pickup`, followed by the usual `pickup` event, or `drop`, which creates a floor item).
 * Stick rolls draw from their own stream (`stuckRng`), so they never shift combat rolls.
 */

import { STUCK_AMMO, clamp, wrapAngle } from '../core';
import type { AmmoKind, ProjectileState, StuckAmmo, StuckIn, Vec2 } from '../core';
import type { SimCtx } from './context';
import { dropItem } from './damage';
import { circleBlocked } from './geometry';

/** How far (share of its body radius) an arrow's tip sinks into a body along its flight. */
const BODY_DEPTH = 0.45;
/** Dropped ammo is kept this far (px) inside the closing wall, like the floor items it sweeps. */
const ZONE_INSET = 8;
/** A pickup point needs this much free floor (px radius) around it; otherwise it backs off further. */
const PICKUP_CLEAR = 4;
/** Back-off tries for a pickup point, in multiples of STUCK_AMMO.pickupOffset. */
const PICKUP_TRIES = [1, 1.75, 2.5];
/** Golden angle: spreads ammo dropped from one corpse evenly without a random draw. */
const GOLDEN = 2.39996;

/** What stopped a spent arrow or axe (see `landAmmo`). */
export type AmmoStop =
  | { kind: 'wall' }
  /** The closing sudden-death wall: never holds ammo. */
  | { kind: 'zone' }
  | { kind: 'prop'; index: number }
  | { kind: 'fighter'; index: number }
  /** A raised shield turned it aside. */
  | { kind: 'shield' }
  /** Its flight ran out over open floor. */
  | { kind: 'floor' };

export function ammoKindOf(p: ProjectileState): AmmoKind {
  return p.weapon === 'LONGBOW' ? 'arrow' : 'axe';
}

function roll(ctx: SimCtx, chance: number): boolean {
  return chance >= 1 || (chance > 0 && ctx.stuckRng.chance(chance));
}

/**
 * Where spent ammo `p` comes to rest: (x, y) is where its flight stopped, (bx, by) a point backed
 * off from there into open floor (where a dropped piece lands). Sticks it (`ammo_stick`) when the
 * thing that stopped it holds ammo and the stick roll says so; otherwise drops a floor item.
 * Call after the shot's `projectile_end`.
 */
export function landAmmo(ctx: SimCtx, p: ProjectileState, stop: AmmoStop, x: number, y: number, bx: number, by: number): void {
  const kind = ammoKindOf(p);
  const angle = Math.atan2(p.vel.y, p.vel.x);
  switch (stop.kind) {
    case 'wall':
      if (roll(ctx, STUCK_AMMO.wallStickChance)) return stickAt(ctx, p, kind, x, y, angle, { kind: 'wall' });
      break;
    case 'prop': {
      const pr = ctx.state.props[stop.index]!;
      // A prop the shot just broke holds nothing.
      if (pr.alive && roll(ctx, STUCK_AMMO.propStickChance)) return stickAt(ctx, p, kind, x, y, angle, { kind: 'prop', propId: pr.id });
      break;
    }
    case 'fighter': {
      const v = ctx.rts[stop.index]!.f;
      // A shot that killed its victim lands by the corpse; a full pincushion sheds it at its feet.
      if (!v.alive || bodyCount(ctx, v.id) >= STUCK_AMMO.maxPerBody || !roll(ctx, STUCK_AMMO.bodyStickChance)) {
        dropItem(ctx, kind, bx, by, v.pos.x, v.pos.y, p.ownerId);
        return;
      }
      // The tip sinks in along the flight; kept in the body frame so it rides along.
      const tx = x + Math.cos(angle) * v.radius * BODY_DEPTH - v.pos.x;
      const ty = y + Math.sin(angle) * v.radius * BODY_DEPTH - v.pos.y;
      const c = Math.cos(v.facing);
      const n = Math.sin(v.facing);
      const into: StuckIn = { kind: 'fighter', fighterId: v.id, u: tx * c + ty * n, v: -tx * n + ty * c, turn: wrapAngle(angle - v.facing) };
      return stickAt(ctx, p, kind, v.pos.x + tx, v.pos.y + ty, angle, into);
    }
    case 'floor':
      if (roll(ctx, STUCK_AMMO.floorStickChance)) return stickAt(ctx, p, kind, x, y, angle, { kind: 'floor' });
      break;
    case 'zone':
    case 'shield':
      break;
  }
  dropItem(ctx, kind, bx, by, bx, by, p.ownerId);
}

function bodyCount(ctx: SimCtx, fighterId: string): number {
  let n = 0;
  for (const s of ctx.state.stuck) if (s.in.kind === 'fighter' && s.in.fighterId === fighterId) n++;
  return n;
}

function stickAt(ctx: SimCtx, p: ProjectileState, kind: AmmoKind, x: number, y: number, angle: number, into: StuckIn): void {
  const stuck = ctx.state.stuck;
  if (stuck.length >= STUCK_AMMO.maxStuck) drop(ctx, 0, fallbackPos(ctx, stuck[0]!));
  const s: StuckAmmo = {
    id: `s${ctx.nextId++}`,
    kind,
    ownerId: p.ownerId,
    pos: { x, y },
    angle,
    in: into,
    pickupPos: into.kind === 'fighter' ? null : into.kind === 'floor' ? { x, y } : pickupPoint(ctx, x, y, angle),
    tick: ctx.state.tick,
  };
  stuck.push(s);
  ctx.events.push({ type: 'ammo_stick', tick: ctx.state.tick, stuckId: s.id, projectileId: p.id, kind, ownerId: p.ownerId, pos: { x, y }, angle, in: into });
}

/**
 * Where ammo stuck in a wall or prop is taken back: `pickupOffset` px straight back along its flight
 * from the impact point, further back if that spot is inside another wall or pillar (a corner).
 */
function pickupPoint(ctx: SimCtx, x: number, y: number, angle: number): Vec2 {
  const c = Math.cos(angle);
  const n = Math.sin(angle);
  let back = STUCK_AMMO.pickupOffset;
  for (const k of PICKUP_TRIES) {
    back = STUCK_AMMO.pickupOffset * k;
    if (!circleBlocked(ctx.geo, x - c * back, y - n * back, PICKUP_CLEAR)) break;
  }
  return { x: x - c * back, y: y - n * back };
}

/** Where a piece lands when it drops out of something that is not a body: its pickup point. */
function fallbackPos(ctx: SimCtx, s: StuckAmmo): Vec2 {
  if (s.pickupPos) return s.pickupPos;
  const i = s.in.kind === 'fighter' ? ctx.byId.get(s.in.fighterId) : undefined;
  return i === undefined ? s.pos : ctx.rts[i]!.f.pos;
}

/** Drop stuck[k] to the floor at `at` (kept inside the closing wall) and remove it. */
function drop(ctx: SimCtx, k: number, at: Vec2): void {
  const s = ctx.state.stuck[k]!;
  const b = ctx.bounds;
  const x = clamp(at.x, b.x + ZONE_INSET, b.x + b.w - ZONE_INSET);
  const y = clamp(at.y, b.y + ZONE_INSET, b.y + b.h - ZONE_INSET);
  const id = dropItem(ctx, s.kind, x, y, x, y, s.ownerId);
  ctx.state.stuck.splice(k, 1);
  ctx.events.push({ type: 'ammo_unstick', tick: ctx.state.tick, stuckId: s.id, kind: s.kind, pos: { x, y }, reason: 'drop', fighterId: null, floorItemId: id });
}

const scatter: Vec2 = { x: 0, y: 0 };

/**
 * Once per tick, after everything has moved: ammo in a living body follows it; ammo in a body that
 * died or a prop that broke, or whose pickup point the closing wall passed, drops to the floor; a
 * fighter that uses that ammo and has room takes back what it touches.
 */
export function updateStuckAmmo(ctx: SimCtx): void {
  const stuck = ctx.state.stuck;
  const b = ctx.bounds;
  const zone = ctx.state.suddenDeath.active;
  // Pieces dropped from each corpse so far this tick, for the scatter pattern.
  let dropped = 0;
  let k = 0;
  while (k < stuck.length) {
    const s = stuck[k]!;
    const into = s.in;
    if (into.kind === 'fighter') {
      const v = ctx.rts[ctx.byId.get(into.fighterId)!]!.f;
      if (!v.alive) {
        const a = s.angle + dropped * GOLDEN;
        const r = STUCK_AMMO.bodyDropScatter * (0.45 + 0.55 * (((dropped * 7) % 5) / 4));
        dropped++;
        scatter.x = v.pos.x + Math.cos(a) * r;
        scatter.y = v.pos.y + Math.sin(a) * r;
        drop(ctx, k, scatter);
        continue;
      }
      const c = Math.cos(v.facing);
      const n = Math.sin(v.facing);
      s.pos.x = v.pos.x + into.u * c - into.v * n;
      s.pos.y = v.pos.y + into.u * n + into.v * c;
      s.angle = wrapAngle(v.facing + into.turn);
      k++;
      continue;
    }
    const pp = s.pickupPos!;
    if (into.kind === 'prop' && !propAlive(ctx, into.propId)) {
      drop(ctx, k, pp);
      continue;
    }
    if (zone && (pp.x < b.x || pp.x > b.x + b.w || pp.y < b.y || pp.y > b.y + b.h)) {
      drop(ctx, k, pp);
      continue;
    }
    const i = taker(ctx, s.kind, pp);
    if (i >= 0) {
      const f = ctx.rts[i]!.f;
      f.ammo++;
      stuck.splice(k, 1);
      const tick = ctx.state.tick;
      ctx.events.push({ type: 'ammo_unstick', tick, stuckId: s.id, kind: s.kind, pos: { x: s.pos.x, y: s.pos.y }, reason: 'pickup', fighterId: f.id, floorItemId: null });
      ctx.events.push({ type: 'pickup', tick, fighterId: f.id, kind: s.kind, pos: { x: pp.x, y: pp.y } });
      continue;
    }
    k++;
  }
}

function propAlive(ctx: SimCtx, id: string): boolean {
  for (const p of ctx.state.props) if (p.id === id) return p.alive;
  return false;
}

/** Nearest living fighter touching `at` (within its radius + pickupSlack) that throws or shoots `kind` and has room, or -1. */
function taker(ctx: SimCtx, kind: AmmoKind, at: Vec2): number {
  const weapon = kind === 'arrow' ? 'LONGBOW' : 'THROWING_AXES';
  let best = -1;
  let bestD = Infinity;
  for (const rt of ctx.rts) {
    const f = rt.f;
    if (!f.alive || f.weapon !== weapon || f.ammo >= f.maxAmmo) continue;
    const d = Math.hypot(f.pos.x - at.x, f.pos.y - at.y);
    if (d > f.radius + STUCK_AMMO.pickupSlack || d >= bestD) continue;
    best = rt.idx;
    bestD = d;
  }
  return best;
}
