/**
 * Perception: what every fighter sees, hears and remembers, refreshed every tick. Enemy records
 * are the observer's own memory, never a window onto the live fighter (see KnownFighter).
 *
 * - Vision: a cone around the head angle (`visionFov`), out to `visionRange`, blocked by walls and
 *   pillars (and the sudden-death wall). A target standing in shadow (light < shadowLight) is only
 *   seen within `shadowVisionMul` of the range: darkness is how lurkers get close. Seeing writes
 *   everything, exactly.
 * - Hearing: 360 degrees, radius `hearingRadius` x the target's noise (fast and fighting = loud,
 *   slow or creeping = quiet), x `hearingWallMul` through a wall or pillar. Hearing gives a rough
 *   position only: an estimate offset from the truth by half to all of `estimateError` (which grows
 *   with distance), in a direction that is deterministic per pair and refresh, refreshed every
 *   `hearingRefreshTicks` and still in between. Velocity, facing, HP and the rest stay as last seen.
 * - Memory: a record per enemy, kept for `memoryTicks` after the last perception. When neither
 *   seen nor heard nothing in it changes: it does not follow the real fighter.
 *
 * No allocation per tick: records are created the first time a pair perceives each other and are
 * reused for the rest of the match.
 */

import { PERCEPTION, TAU, WEAPONS, angleDiff, noiseMultiplier } from '../core';
import type { KnownFighter, PerceptionView } from '../core';
import type { FighterRt, SimCtx } from './context';
import { sampleLight, staticLosBlocked } from './geometry';

const UINT32 = 4294967296;

/** Walls, pillars and (in sudden death) the closing arena wall block the segment. */
export function losBlocked(ctx: SimCtx, ax: number, ay: number, bx: number, by: number): boolean {
  if (ctx.state.suddenDeath.active) {
    const b = ctx.bounds;
    const r = b.x + b.w;
    const d = b.y + b.h;
    if (ax < b.x || ax > r || ay < b.y || ay > d || bx < b.x || bx > r || by < b.y || by > d) return true;
  }
  return staticLosBlocked(ctx.geo, ax, ay, bx, by);
}

/**
 * Would `o` see a body of radius `r` standing at (x, y), where the light level is `light`?
 * Range is measured to the centre; the cone test allows for the body's angular width.
 */
export function canSee(ctx: SimCtx, o: FighterRt, x: number, y: number, r: number, light: number): boolean {
  const f = o.f;
  const dx = x - f.pos.x;
  const dy = y - f.pos.y;
  const d2 = dx * dx + dy * dy;
  const range = light < PERCEPTION.shadowLight ? o.vision * PERCEPTION.shadowVisionMul : o.vision;
  if (d2 > range * range) return false;
  const d = Math.sqrt(d2);
  // Bodies in contact always notice each other, whatever the head is doing.
  if (d > f.radius + r + 4) {
    const half = o.fov / 2 + (r > 0 ? Math.asin(Math.min(1, r / d)) : 0);
    if (Math.abs(angleDiff(f.headAngle, Math.atan2(dy, dx))) > half) return false;
  }
  return !losBlocked(ctx, f.pos.x, f.pos.y, x, y);
}

/**
 * Would fighter `o` see point (x, y), judged only from what the asker knows of `o` (its record
 * `rec`): the record's position and its facing as last seen. A record never seen has no known
 * facing, so the cone test is skipped. Range and field of view come from `o`'s build (public).
 */
export function recordSees(ctx: SimCtx, o: FighterRt, rec: KnownFighter, x: number, y: number, light: number): boolean {
  const dx = x - rec.pos.x;
  const dy = y - rec.pos.y;
  const d2 = dx * dx + dy * dy;
  const range = light < PERCEPTION.shadowLight ? o.vision * PERCEPTION.shadowVisionMul : o.vision;
  if (d2 > range * range) return false;
  if (rec.lastSeenTick >= 0 && d2 > 1e-6 && Math.abs(angleDiff(rec.facing, Math.atan2(dy, dx))) > o.fov / 2) return false;
  return !losBlocked(ctx, rec.pos.x, rec.pos.y, x, y);
}

/** Hearing multiplier against `t` this tick: attacking or being hit is loud; otherwise speed and stance decide. */
function noiseOf(ctx: SimCtx, t: FighterRt): number {
  const phase = t.f.anim.phase;
  if (phase === 'windup' || phase === 'strike' || ctx.state.tick - t.lastCombatTick <= 1) return PERCEPTION.hearingFastMul;
  const v = t.f.vel;
  return noiseMultiplier(Math.sqrt(v.x * v.x + v.y * v.y), t.f.stance);
}

/** Hearing reaches `hearing x noise` in the open, `hearingWallMul` of that through a wall or pillar. */
function canHear(ctx: SimCtx, o: FighterRt, t: FighterRt): boolean {
  const dx = t.f.pos.x - o.f.pos.x;
  const dy = t.f.pos.y - o.f.pos.y;
  const d2 = dx * dx + dy * dy;
  const r = o.hearing * noiseOf(ctx, t);
  if (d2 > r * r) return false;
  const muffled = r * PERCEPTION.hearingWallMul;
  if (d2 <= muffled * muffled) return true;
  return !staticLosBlocked(ctx.geo, o.f.pos.x, o.f.pos.y, t.f.pos.x, t.f.pos.y);
}

function isFighting(ctx: SimCtx, t: FighterRt): boolean {
  return ctx.state.tick - t.lastCombatTick <= PERCEPTION.fightingWindowTicks;
}

/** A first record of `t`: what anyone knows of a fighter before seeing it (its build and how it started). */
function newRecord(t: FighterRt): KnownFighter {
  const f = t.f;
  return {
    id: f.id,
    squad: f.squad,
    pos: { x: t.spawnPos.x, y: t.spawnPos.y },
    vel: { x: 0, y: 0 },
    facing: t.spawnFacing,
    hp: f.maxHp,
    maxHp: f.maxHp,
    weapon: f.weapon,
    family: WEAPONS[f.weapon].family,
    seen: false,
    heard: false,
    estimateError: 0,
    lastSeenTick: -1,
    lastSeenPos: { x: t.spawnPos.x, y: t.spawnPos.y },
    fighting: false,
    ammo: f.maxAmmo,
    kills: 0,
    windingUp: false,
  };
}

/** Seeing reveals everything, exactly. */
function writeSeen(ctx: SimCtx, rec: KnownFighter, t: FighterRt): void {
  const f = t.f;
  rec.pos.x = f.pos.x;
  rec.pos.y = f.pos.y;
  rec.vel.x = f.vel.x;
  rec.vel.y = f.vel.y;
  rec.seen = true;
  rec.heard = false;
  rec.estimateError = 0;
  rec.fighting = isFighting(ctx, t);
  rec.facing = f.facing;
  rec.hp = f.hp;
  rec.maxHp = f.maxHp;
  rec.ammo = f.ammo;
  rec.kills = f.kills;
  rec.windingUp = f.anim.phase === 'windup';
  if (f.bleed) rec.bleeding = true;
  else if (rec.bleeding) rec.bleeding = false;
  rec.lastSeenTick = ctx.state.tick;
  rec.lastSeenPos.x = f.pos.x;
  rec.lastSeenPos.y = f.pos.y;
}

/**
 * Hearing reveals a rough position and whether `t` is fighting, nothing else. The estimate moves
 * only when the record was not heard last tick (just lost from sight, or newly heard) or every
 * `hearingRefreshTicks`; in between it stays put.
 */
function writeHeard(ctx: SimCtx, o: FighterRt, rec: KnownFighter, t: FighterRt): void {
  const tick = ctx.state.tick;
  const refresh = !rec.heard || tick - o.heardAt[t.idx]! >= PERCEPTION.hearingRefreshTicks;
  rec.seen = false;
  rec.heard = true;
  rec.windingUp = false;
  rec.fighting = isFighting(ctx, t);
  if (!refresh) return;
  o.heardAt[t.idx] = tick;
  estimate(ctx, o, t, rec);
}

/** Fold integer k into hash h (murmur3 finalizer steps); deterministic on every engine. */
function mix(h: number, k: number): number {
  h = Math.imul(h ^ Math.imul(k + 1, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function hash4(a: number, b: number, c: number, d: number): number {
  return mix(mix(mix(a >>> 0, b), c), d);
}

/**
 * Put `rec.pos` at a rough guess of where `t` is: off by half to all of `estimateError` in a
 * direction fixed by (match, listener, source, refresh period). Regular refreshes are a full period
 * apart, so each gets a new guess; a fighter flickering in and out of sight within one period keeps
 * the same offset instead of a new random one each time (no jumping record, no jittering head).
 * An offset that would leave the map is mirrored per axis, which keeps its length (the map is far
 * wider than any error).
 */
function estimate(ctx: SimCtx, o: FighterRt, t: FighterRt, rec: KnownFighter): void {
  const tx = t.f.pos.x;
  const ty = t.f.pos.y;
  const err = PERCEPTION.hearingErrorBase + PERCEPTION.hearingErrorPerPx * Math.hypot(tx - o.f.pos.x, ty - o.f.pos.y);
  const h1 = hash4(ctx.hearingSalt, o.idx, t.idx, Math.floor(ctx.state.tick / PERCEPTION.hearingRefreshTicks));
  const h2 = hash4(h1, o.idx, t.idx, 0x51ed);
  const angle = (h1 / UINT32) * TAU;
  const r = err * (0.5 + 0.5 * (h2 / UINT32));
  let ex = Math.cos(angle) * r;
  let ey = Math.sin(angle) * r;
  if (tx + ex < 0 || tx + ex > ctx.map.width) ex = -ex;
  if (ty + ey < 0 || ty + ey > ctx.map.height) ey = -ey;
  rec.pos.x = tx + ex;
  rec.pos.y = ty + ey;
  rec.estimateError = err;
}

/** Light and shadow at every living fighter. Run before `perceive`. */
export function updateLight(ctx: SimCtx): void {
  for (const rt of ctx.rts) {
    if (!rt.f.alive) continue;
    rt.light = sampleLight(ctx.geo, rt.f.pos.x, rt.f.pos.y);
    rt.f.inShadow = rt.light < PERCEPTION.shadowLight;
  }
}

/** Refresh every fighter's knowledge of every enemy, and `FighterState.seen`. */
export function perceive(ctx: SimCtx): void {
  const rts = ctx.rts;
  const n = rts.length;
  const tick = ctx.state.tick;
  for (let i = 0; i < n; i++) rts[i]!.f.seen = false;
  for (let i = 0; i < n; i++) {
    const o = rts[i]!;
    if (!o.f.alive) continue;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const t = rts[j]!;
      if (t.f.squad === o.f.squad) continue;
      let rec = o.mem[j] ?? null;
      const seen = t.f.alive && canSee(ctx, o, t.f.pos.x, t.f.pos.y, t.f.radius, t.light);
      const heard = t.f.alive && !seen && canHear(ctx, o, t);
      if (seen || heard) {
        if (!rec) rec = o.mem[j] = newRecord(t);
        if (seen) writeSeen(ctx, rec, t);
        else writeHeard(ctx, o, rec, t);
        o.memTick[j] = tick;
        if (seen) t.f.seen = true;
      } else if (rec) {
        rec.seen = false;
        rec.heard = false;
        rec.windingUp = false;
      }
    }
  }
}

/** True while `o` still remembers fighter j (perceived within PERCEPTION.memoryTicks). */
export function remembers(ctx: SimCtx, o: FighterRt, j: number): boolean {
  const t = o.memTick[j]!;
  return t >= 0 && ctx.state.tick - t <= PERCEPTION.memoryTicks;
}

/** Fill and return the reusable view for `rt.brain.think`. */
export function buildView(ctx: SimCtx, rt: FighterRt): PerceptionView {
  const rts = ctx.rts;
  const view = rt.view;
  view.tick = ctx.state.tick;
  view.suddenDeath = ctx.state.suddenDeath.active;
  rt.known.length = 0;
  rt.allies.length = 0;
  for (let j = 0; j < rts.length; j++) {
    if (j === rt.idx) continue;
    const t = rts[j]!;
    if (!t.f.alive) continue;
    if (t.f.squad === rt.f.squad) {
      let rec = rt.allyMem[j] ?? null;
      if (!rec) rec = rt.allyMem[j] = newRecord(t);
      writeSeen(ctx, rec, t);
      rt.allies.push(rec);
    } else if (remembers(ctx, rt, j)) {
      rt.known.push(rt.mem[j]!);
    }
  }
  const last = rt.f.lastHitBy;
  const li = last === null ? undefined : ctx.byId.get(last);
  view.lastAttackerId = li !== undefined && rts[li]!.f.alive && rts[li]!.f.squad !== rt.f.squad ? last : null;
  return view;
}
