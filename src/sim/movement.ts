/**
 * Turning the latest decision into motion, then moving bodies and resolving collisions.
 *
 * Three headings per fighter:
 * - legs (`moveDir`) turn toward the decision heading quickly, so steering feels responsive;
 * - the torso (`facing`) turns at the build's turn rate toward the target when one is close,
 *   else toward where the legs go. Weapons swing along the torso;
 * - the head (`headAngle`, the vision cone) looks at what the fighter knows of its target: the
 *   target while seen or heard (the rough estimate, which only moves when it refreshes); once
 *   lost, the spot where it was last perceived for `searchStareTicks`, then a sweep around that
 *   spot. With no target it scans slowly around the torso. Never more than HEAD_MAX from the
 *   torso, and eased (fast for big turns, slowing near its goal) so the cone never snaps or jitters.
 * Walking away from where the torso faces is slower (`facingMoveMul`, so kiting costs), melee
 * swings lunge forward at the end of the windup, and ranged attackers plant to shoot.
 */

import { COMBAT, MAX_FIGHTERS, PERCEPTION, STANCES, WEAPONS, angleDiff, circleRectPush, clamp, clamp01, facingMoveMul, stepAngle } from '../core';
import type { Vec2 } from '../core';
import { aimPoint, decisionTarget } from './combat';
import type { FighterRt, SimCtx } from './context';
import { GORE_SPOTS } from './damage';
import { remembers } from './perception';

/** Legs turn this many times faster than the torso. */
const LEG_TURN_MUL = 2.5;
/** Head turns at most this many times faster than the torso. */
const HEAD_TURN_MUL = 2.2;
/** Head easing: share of the remaining turn taken per tick (below the rate cap), plus a small floor (radians). */
const HEAD_EASE = 0.2;
const HEAD_EASE_MIN = 0.002;
/** Furthest the head turns away from the torso (radians). */
const HEAD_MAX = 1.4;
/** Idle head scan: amplitude (radians) and speed (radians of scan phase per tick). */
const SCAN_AMPLITUDE = 0.75;
const SCAN_SPEED = 0.035;
/** The torso turns to face a perceived target within weapon reach + this (px). */
const FACE_TARGET_SLACK = 140;
/** Torso turn rate multiplier while winding up (tracking a dodging target is hard). */
const WINDUP_TURN_MUL = 0.6;
/** Move speed multiplier of a melee fighter while winding up or striking. */
const ATTACK_MOVE_MUL_MELEE = 0.45;
/** A melee lunge (WeaponRule.lunge) is spread over the last this-many ticks of the windup. */
const LUNGE_TICKS = 6;
/** The lunge stops this far (px, edge to edge) short of the locked target, so it never shoves it. */
const LUNGE_STOP = 4;
/** Share of the gap to the desired velocity closed per tick (acceleration and knockback decay). */
const ACCEL = 0.22;
/** Same while stunned: knocked-back fighters slide further. */
const STUN_FRICTION = 0.1;
/** Walk cycle phase (radians) per px travelled; a footstep every π. */
const STRIDE = 0.09;
/** Movement below this (px per tick) does not print footsteps. */
const STEP_MIN_SPEED = 0.3;
/** Footsteps after walking through gore that print blood. */
const BLOODY_STEPS = 8;
/** Walking within this distance (px) of a gore spot bloodies the boots. */
const GORE_RADIUS = 20;
const SOLVER_PASSES = 2;

const aim: Vec2 = { x: 0, y: 0 };
const push: Vec2 = { x: 0, y: 0 };
const prevX = new Float64Array(MAX_FIGHTERS);
const prevY = new Float64Array(MAX_FIGHTERS);

/** Torso target angle: the attack target while attacking, a close perceived target, else NaN. */
function aimAngle(ctx: SimCtx, rt: FighterRt): number {
  const f = rt.f;
  const attacking = f.anim.phase === 'windup' || f.anim.phase === 'strike';
  let j = attacking && rt.attackTarget >= 0 ? rt.attackTarget : decisionTarget(ctx, rt);
  if (j < 0 || !ctx.rts[j]!.f.alive || !remembers(ctx, rt, j)) return NaN;
  const rec = rt.mem[j]!;
  if (!attacking) {
    if (!rec.seen && !rec.heard) return NaN;
    const w = WEAPONS[f.weapon];
    const reach = w.family === 'ranged' && f.ammo > 0 ? w.range : w.range + ctx.rts[j]!.f.radius;
    if (Math.hypot(rec.pos.x - f.pos.x, rec.pos.y - f.pos.y) > reach + FACE_TARGET_SLACK) return NaN;
  }
  aimPoint(ctx, rt, j, aim);
  return Math.atan2(aim.y - f.pos.y, aim.x - f.pos.x);
}

/**
 * Head target angle from the fighter's knowledge: its target's record while seen or heard; once
 * lost, a stare at where it was last perceived, then a sweep around that spot; with no target, a
 * slow scan around the torso.
 */
function lookAngle(ctx: SimCtx, rt: FighterRt): number {
  const f = rt.f;
  const j = decisionTarget(ctx, rt);
  if (j >= 0) {
    const rec = rt.mem[j]!;
    const at = Math.atan2(rec.pos.y - f.pos.y, rec.pos.x - f.pos.x);
    if (rec.seen || rec.heard) return at;
    const lost = ctx.state.tick - rt.memTick[j]!;
    if (lost <= PERCEPTION.searchStareTicks) return at;
    const sweep = ((lost - PERCEPTION.searchStareTicks) / PERCEPTION.searchScanTicks) * Math.PI * 2;
    return at + Math.sin(sweep) * (PERCEPTION.searchScanArc / 2);
  }
  return f.facing + Math.sin((ctx.state.tick + rt.idx * 53) * SCAN_SPEED) * SCAN_AMPLITUDE;
}

/** Turn the head toward its look angle: eased, rate-capped, and kept within HEAD_MAX of the torso. */
function turnHead(ctx: SimCtx, rt: FighterRt): void {
  const f = rt.f;
  const want = f.facing + clamp(angleDiff(f.facing, lookAngle(ctx, rt)), -HEAD_MAX, HEAD_MAX);
  const gap = Math.abs(angleDiff(f.headAngle, want));
  f.headAngle = stepAngle(f.headAngle, want, Math.min(rt.turn * HEAD_TURN_MUL, gap * HEAD_EASE + HEAD_EASE_MIN));
  f.headAngle = f.facing + clamp(angleDiff(f.facing, f.headAngle), -HEAD_MAX, HEAD_MAX);
}

/** Ranged attackers plant while shooting: windup (including a held release), strike and recovery. */
function planted(rt: FighterRt): boolean {
  return !rt.punching && WEAPONS[rt.f.weapon].family === 'ranged' && rt.f.anim.phase !== 'idle';
}

/**
 * Px a melee fighter lunges along its facing this tick: WeaponRule.lunge spread over the last
 * LUNGE_TICKS of the windup, stopping LUNGE_STOP short of the locked target's body.
 */
function lungeStep(ctx: SimCtx, rt: FighterRt): number {
  const f = rt.f;
  const a = f.anim;
  if (a.phase !== 'windup' || rt.punching || f.stunTicks > 0) return 0;
  const lunge = WEAPONS[f.weapon].lunge;
  const ticks = Math.min(LUNGE_TICKS, a.dur);
  if (lunge <= 0 || a.t < a.dur - ticks) return 0;
  let step = lunge / ticks;
  const j = rt.attackTarget;
  if (j >= 0 && ctx.rts[j]!.f.alive) {
    const t = ctx.rts[j]!.f;
    const gap = Math.hypot(t.pos.x - f.pos.x, t.pos.y - f.pos.y) - f.radius - t.radius - LUNGE_STOP;
    step = Math.min(step, Math.max(0, gap));
  }
  return step;
}

/** Apply each fighter's latest decision: headings, torso, head and target velocity. */
export function steer(ctx: SimCtx): void {
  for (const rt of ctx.rts) {
    const f = rt.f;
    if (!f.alive) continue;
    const d = rt.decision;
    const stunned = f.stunTicks > 0;
    let throttle = 0;
    // A non-finite heading or speed from a brain means "stand still", never NaN positions.
    if (d && !stunned && Number.isFinite(d.heading) && Number.isFinite(d.speed)) {
      throttle = clamp01(d.speed);
      if (throttle > 0) rt.moveDir = stepAngle(rt.moveDir, d.heading, rt.turn * LEG_TURN_MUL);
    }

    const phase = f.anim.phase;
    if (!stunned && phase !== 'strike') {
      const target = aimAngle(ctx, rt);
      const want = !Number.isNaN(target) ? target : throttle > 0.05 ? rt.moveDir : f.facing;
      f.facing = stepAngle(f.facing, want, phase === 'windup' ? rt.turn * WINDUP_TURN_MUL : rt.turn);
    }
    turnHead(ctx, rt);

    let speed = rt.baseSpeed * throttle * STANCES[f.stance].moveMul;
    if (f.buffs.haste > 0) speed *= COMBAT.hasteMoveMul;
    if (f.buffs.slow > 0) speed *= COMBAT.slowMoveMul;
    if (!f.limbs.legL) speed *= COMBAT.leglessMoveMul;
    if (!f.limbs.legR) speed *= COMBAT.leglessMoveMul;
    if (planted(rt)) speed *= COMBAT.rangedPlantMoveMul;
    else if (phase === 'windup' || phase === 'strike') speed *= ATTACK_MOVE_MUL_MELEE;
    speed *= facingMoveMul(rt.moveDir, f.facing);

    const k = stunned ? STUN_FRICTION : ACCEL;
    f.vel.x += (Math.cos(rt.moveDir) * speed - f.vel.x) * k;
    f.vel.y += (Math.sin(rt.moveDir) * speed - f.vel.y) * k;
  }
}

/** Push fighter rt out of walls, pillars and live props; cancels velocity into the surface. */
function collideStatic(ctx: SimCtx, rt: FighterRt): void {
  const f = rt.f;
  const bs = ctx.geo.blockers;
  for (let pass = 0; pass < SOLVER_PASSES; pass++) {
    let moved = false;
    for (let i = 0; i < bs.length; i++) {
      const r = bs[i]!;
      if (f.pos.x + f.radius < r.x || f.pos.x - f.radius > r.x + r.w || f.pos.y + f.radius < r.y || f.pos.y - f.radius > r.y + r.h) continue;
      if (!circleRectPush(push, f.pos, f.radius, r)) continue;
      f.pos.x += push.x;
      f.pos.y += push.y;
      cancelInto(f.vel, push.x, push.y);
      moved = true;
    }
    for (const p of ctx.state.props) {
      if (!p.alive) continue;
      const dx = f.pos.x - p.pos.x;
      const dy = f.pos.y - p.pos.y;
      const min = f.radius + p.radius;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2);
      const nx = d > 1e-6 ? dx / d : 1;
      const ny = d > 1e-6 ? dy / d : 0;
      f.pos.x += nx * (min - d);
      f.pos.y += ny * (min - d);
      cancelInto(f.vel, nx, ny);
      moved = true;
    }
    if (!moved) break;
  }
  const m = ctx.map;
  f.pos.x = clamp(f.pos.x, f.radius, m.width - f.radius);
  f.pos.y = clamp(f.pos.y, f.radius, m.height - f.radius);
}

/** Remove the velocity component pointing against normal (nx, ny). */
function cancelInto(vel: Vec2, nx: number, ny: number): void {
  const len = Math.sqrt(nx * nx + ny * ny);
  if (len < 1e-9) return;
  const ux = nx / len;
  const uy = ny / len;
  const vn = vel.x * ux + vel.y * uy;
  if (vn < 0) {
    vel.x -= ux * vn;
    vel.y -= uy * vn;
  }
}

/** Integrate velocity, separate bodies, then advance walk cycles and print footsteps. */
export function moveFighters(ctx: SimCtx): void {
  const rts = ctx.rts;
  for (const rt of rts) {
    const f = rt.f;
    prevX[rt.idx] = f.pos.x;
    prevY[rt.idx] = f.pos.y;
    if (!f.alive) continue;
    const lunge = lungeStep(ctx, rt);
    f.pos.x += f.vel.x + Math.cos(f.facing) * lunge;
    f.pos.y += f.vel.y + Math.sin(f.facing) * lunge;
    collideStatic(ctx, rt);
  }

  // Bodies push each other apart, the lighter one (smaller radius) moving more.
  for (let i = 0; i < rts.length; i++) {
    const a = rts[i]!.f;
    if (!a.alive) continue;
    for (let j = i + 1; j < rts.length; j++) {
      const b = rts[j]!.f;
      if (!b.alive) continue;
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      const min = a.radius + b.radius;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2);
      const nx = d > 1e-6 ? dx / d : 1;
      const ny = d > 1e-6 ? dy / d : 0;
      const overlap = min - d;
      const ma = a.radius * a.radius;
      const mb = b.radius * b.radius;
      const sa = mb / (ma + mb);
      a.pos.x -= nx * overlap * sa;
      a.pos.y -= ny * overlap * sa;
      b.pos.x += nx * overlap * (1 - sa);
      b.pos.y += ny * overlap * (1 - sa);
    }
  }

  const tick = ctx.state.tick;
  for (const rt of rts) {
    const f = rt.f;
    if (!f.alive) continue;
    collideStatic(ctx, rt);
    const moved = Math.hypot(f.pos.x - prevX[rt.idx]!, f.pos.y - prevY[rt.idx]!);
    f.walkPhase += moved * STRIDE;
    const step = Math.floor(f.walkPhase / Math.PI);
    if (step === rt.stepCount) continue;
    rt.stepCount = step;
    if (moved < STEP_MIN_SPEED) continue;
    if (nearGore(ctx, f.pos.x, f.pos.y)) rt.bloodySteps = BLOODY_STEPS;
    const bloody = rt.bloodySteps > 0;
    if (bloody) rt.bloodySteps--;
    ctx.events.push({ type: 'footstep', tick, fighterId: f.id, pos: { x: f.pos.x, y: f.pos.y }, bloody });
  }
}

function nearGore(ctx: SimCtx, x: number, y: number): boolean {
  const g = ctx.gore;
  const n = Math.min(ctx.goreCount, GORE_SPOTS);
  for (let k = 0; k < n; k++) {
    const dx = g[k * 2]! - x;
    const dy = g[k * 2 + 1]! - y;
    if (dx * dx + dy * dy < GORE_RADIUS * GORE_RADIUS) return true;
  }
  return false;
}
