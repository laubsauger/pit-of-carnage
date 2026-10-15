/**
 * Attacks, projectiles and skills.
 *
 * An attack runs windup (telegraph) -> strike (damage resolves on its first tick) -> recovery ->
 * idle. The next windup waits for idle and `attackCd`, which starts at the strike, so the cycle is
 * windup + max(cooldown, strike + recovery). Parry is rolled once when an enemy's melee windup aims
 * at a fighter who faces it and whose brain allows parrying; an open parry window turns the blow
 * back on the attacker.
 *
 * Fog of war binds attacks: a shot only starts and only releases at a target seen this tick, and
 * the release waits until the shooter faces it (COMBAT.releaseFacingTolerance); a melee swing at a
 * named target needs it seen, or heard with its estimate within reach. Shots fly along the aim line
 * (imperfectly led, COMBAT.aimLead) turned by a random angle within `shotSpread`, which grows with
 * the shooter's speed and the distance. A melee hit on a ranged attacker in windup cancels the shot
 * (see damage.ts).
 *
 * Projectiles leave from the weapon's muzzle (staff tip, bow string, throwing hand) and are swept
 * every tick from their old to their new position, stopping at the first thing on that segment:
 * wall, pillar, prop or any fighter (crowds take stray shots). A raised shield stops every
 * projectile from the front; a staff orb bursts on it and spares the bearer.
 */

import {
  COMBAT,
  SKILLS,
  SPEED_SCALE,
  WEAPONS,
  angleDiff,
  attackCooldown,
  damageMultiplier,
  projectileSpeed,
  projectileTtl,
  resolveDamage,
  segmentCircleT,
  shotSpread,
  skillCooldown,
  skillDamage,
} from '../core';
import type { FighterRt, SimCtx } from './context';
import type { AnimPhase, FighterState, ProjectileState, Vec2, WeaponId } from '../core';
import { applyDamage, bark, blow, canHurt, damageProp, dropItem } from './damage';
import { circleBlocked, staticLosBlocked, staticSegmentT } from './geometry';
import { remembers } from './perception';

/** Punches (weapon arm gone, or a ranged weapon out of ammo): phase lengths and arc. */
const PUNCH = { windup: 7, strike: 5, recovery: 8, arc: 1.4, knockback: 3, backstabMult: 1.45 } as const;
/** A windup counts as "aimed at" a fighter this far beyond the weapon's reach (they may step in). */
const PARRY_REACH_SLACK = 30;
/** Most ticks of lead ever applied. */
const MAX_LEAD_TICKS = 45;
/** A finished ranged windup waits at most this long to face its target, then the shot is abandoned. */
const MAX_HOLD_TICKS = 45;
/** A punch only starts when a perceived enemy is within punch reach + this (px). */
const PUNCH_START_SLACK = 12;
/** Extra radius (px) a fighter offers to projectiles, so grazing shots count. */
const PROJECTILE_BODY_SLACK = 2;
/** Spent arrows and axes land this far back from a wall they hit (px). */
const DROP_BACKOFF = 10;
/** Splash knockback relative to the weapon's knockback. */
const SPLASH_KNOCKBACK = 0.6;
/** SHADOWSTEP tries these rotations (radians) around the target's back when the spot is blocked. */
const STEP_TRIES = [0, 0.5, -0.5, 1, -1, 1.6, -1.6];

/**
 * Where each ranged weapon lets go of its projectile, in the shooter's body frame: `u` px ahead
 * along its facing, `v` px toward its right hand, for a body of MUZZLE_RADIUS (scaled by radius /
 * MUZZLE_RADIUS, like the drawn rig). Read off the renderer's rig at release (render/fighters.ts
 * with SWING_KEYS in render/rig.ts): the staff's orb tip at the end of the windup, the bow string
 * at rest, and the throwing hand as the axe leaves it (a left-hand throw mirrors `v`).
 */
const MUZZLE: Readonly<Partial<Record<WeaponId, { u: number; v: number }>>> = {
  THROWING_AXES: { u: 16, v: 15 },
  LONGBOW: { u: 13, v: -3 },
  ARCANE_STAFF: { u: 69.5, v: 20 },
};
const NO_MUZZLE = { u: 0, v: 0 };
/** Body radius the rig is drawn at (the renderer's NOMINAL_RADIUS). */
const MUZZLE_RADIUS = 18;

function setPhase(f: FighterState, phase: AnimPhase, dur: number): void {
  f.anim.phase = phase;
  f.anim.t = 0;
  f.anim.dur = dur;
}

function edgeDistance(a: FighterState, b: FighterState): number {
  return Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y) - b.radius;
}

/** Index of the decision's target if it is a living enemy this fighter remembers, else -1. */
export function decisionTarget(ctx: SimCtx, rt: FighterRt): number {
  const id = rt.decision?.targetId;
  if (!id) return -1;
  const j = ctx.byId.get(id);
  if (j === undefined || j === rt.idx) return -1;
  const t = ctx.rts[j]!;
  if (!t.f.alive || t.f.squad === rt.f.squad || !remembers(ctx, rt, j)) return -1;
  return j;
}

// ---------------------------------------------------------------------------------------------
// Attacks
// ---------------------------------------------------------------------------------------------

export function updateAttacks(ctx: SimCtx): void {
  for (const rt of ctx.rts) {
    const f = rt.f;
    if (!f.alive) continue;
    const a = f.anim;
    if (a.phase !== 'idle') {
      if (a.phase === 'windup' && f.stunTicks > 0) {
        setPhase(f, 'idle', 0);
      } else if (a.phase === 'windup' && a.t + 1 >= a.dur && isShot(rt)) {
        releaseShot(ctx, rt);
      } else if (++a.t >= a.dur) {
        if (a.phase === 'windup') strike(ctx, rt);
        else if (a.phase === 'strike') setPhase(f, 'recovery', rt.punching ? PUNCH.recovery : WEAPONS[f.weapon].recovery);
        else setPhase(f, 'idle', 0);
      }
    }
    if (f.alive && a.phase === 'idle' && f.attackCd === 0 && f.stunTicks === 0 && rt.decision?.attack) startAttack(ctx, rt);
  }
}

/** The current attack is a shot (a ranged weapon with ammo, not a punch). */
function isShot(rt: FighterRt): boolean {
  return !rt.punching && WEAPONS[rt.f.weapon].family === 'ranged';
}

function startAttack(ctx: SimCtx, rt: FighterRt): void {
  const f = rt.f;
  const w = WEAPONS[f.weapon];
  if (!f.limbs.armR && !f.limbs.armL) return;
  const punching = !f.limbs.armR || (w.family === 'ranged' && f.ammo <= 0);
  const target = decisionTarget(ctx, rt);
  // A decision naming someone this fighter does not know (or no longer can: dead, an ally) is no
  // licence to swing; only a decision with no target at all may swing at the air (or a keg).
  if (target < 0 && rt.decision?.targetId) return;
  if (punching || w.family === 'melee') {
    const reach = punching ? COMBAT.punchRange : w.range;
    // A swing at a named target needs it seen, or heard close enough that a blind swing could land.
    if (target >= 0 && !rt.mem[target]!.seen && !(rt.mem[target]!.heard && knownEdgeDistance(ctx, rt, target) <= reach)) return;
    // A punch only starts when someone perceived is within reach: a bow with no arrows does not
    // flail at an archer across the arena.
    if (punching && !knownInReach(ctx, rt, COMBAT.punchRange + PUNCH_START_SLACK)) return;
  } else if (target < 0 || !rt.mem[target]!.seen) {
    // Never a shot at someone out of sight.
    return;
  }
  rt.punching = punching;
  rt.attackTarget = target;
  rt.holdTicks = 0;
  setPhase(f, 'windup', punching ? PUNCH.windup : w.windup);
  rt.lastCombatTick = ctx.state.tick;
  ctx.events.push({ type: 'swing', tick: ctx.state.tick, fighterId: f.id, weapon: f.weapon });
  if ((punching || w.family === 'melee') && target >= 0) rollParry(ctx, rt, ctx.rts[target]!, punching ? COMBAT.punchRange : w.range);
}

/** Distance from rt to the edge of enemy j's body as rt perceives it (record position; body size is public). */
function knownEdgeDistance(ctx: SimCtx, rt: FighterRt, j: number): number {
  const rec = rt.mem[j]!;
  return Math.hypot(rec.pos.x - rt.f.pos.x, rec.pos.y - rt.f.pos.y) - ctx.rts[j]!.f.radius;
}

/** Some enemy rt sees or hears right now is within `reach` of it (by rt's own records). */
function knownInReach(ctx: SimCtx, rt: FighterRt, reach: number): boolean {
  for (let j = 0; j < ctx.rts.length; j++) {
    const rec = rt.mem[j];
    if (!rec || !(rec.seen || rec.heard) || !ctx.rts[j]!.f.alive) continue;
    if (knownEdgeDistance(ctx, rt, j) <= reach) return true;
  }
  return false;
}

const shotAim: Vec2 = { x: 0, y: 0 };

/**
 * The end of a ranged windup. The shot releases only at a target seen this tick that the shooter
 * faces within COMBAT.releaseFacingTolerance of the aim line; while it turns, the windup holds (at
 * most MAX_HOLD_TICKS). A target that is gone (out of sight, dead) cancels the shot: no ammo spent.
 */
function releaseShot(ctx: SimCtx, rt: FighterRt): void {
  const f = rt.f;
  const j = rt.attackTarget;
  const rec = j >= 0 ? rt.mem[j] : null;
  if (!rec || !rec.seen || !ctx.rts[j]!.f.alive || rt.holdTicks >= MAX_HOLD_TICKS) {
    rt.holdTicks = 0;
    setPhase(f, 'idle', 0);
    return;
  }
  aimPoint(ctx, rt, j, shotAim);
  if (Math.abs(angleDiff(f.facing, Math.atan2(shotAim.y - f.pos.y, shotAim.x - f.pos.x))) > COMBAT.releaseFacingTolerance) {
    rt.holdTicks++;
    return;
  }
  rt.holdTicks = 0;
  f.anim.t++;
  strike(ctx, rt);
}

/** The victim of a windup may get a parry window: once per windup, if allowed, ready and facing it. */
function rollParry(ctx: SimCtx, art: FighterRt, vrt: FighterRt, reach: number): void {
  const v = vrt.f;
  const a = art.f;
  if (!vrt.decision?.parry || v.parryCd > 0 || v.stunTicks > 0) return;
  if (v.anim.phase === 'windup' || v.anim.phase === 'strike') return;
  if (edgeDistance(a, v) > reach + PARRY_REACH_SLACK) return;
  const toAttacker = Math.atan2(a.pos.y - v.pos.y, a.pos.x - v.pos.x);
  if (Math.abs(angleDiff(v.facing, toAttacker)) > COMBAT.parryFacingArc) return;
  if (!ctx.combatRng.chance(vrt.parryChance)) return;
  v.parryTicks = COMBAT.parryTicks;
  v.parryCd = COMBAT.parryCooldown;
}

function strike(ctx: SimCtx, rt: FighterRt): void {
  const f = rt.f;
  const w = WEAPONS[f.weapon];
  setPhase(f, 'strike', rt.punching ? PUNCH.strike : w.strike);
  f.attackCd = rt.punching ? COMBAT.punchCooldown : attackCooldown(f.attributes, f.weapon);
  rt.lastCombatTick = ctx.state.tick;
  if (rt.punching || w.family === 'melee') meleeStrike(ctx, rt);
  else fire(ctx, rt);
}

const inArc: number[] = [];

function meleeStrike(ctx: SimCtx, rt: FighterRt): void {
  const f = rt.f;
  const w = WEAPONS[f.weapon];
  const reach = rt.punching ? COMBAT.punchRange : w.range;
  const halfArc = (rt.punching ? PUNCH.arc : w.arc) / 2;
  const cleave = !rt.punching && w.cleave;

  inArc.length = 0;
  for (const o of ctx.rts) {
    if (!o.f.alive || !canHurt(ctx, rt, o)) continue;
    const dx = o.f.pos.x - f.pos.x;
    const dy = o.f.pos.y - f.pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d - o.f.radius > reach) continue;
    const slack = d > o.f.radius ? Math.asin(o.f.radius / d) : Math.PI;
    if (Math.abs(angleDiff(f.facing, Math.atan2(dy, dx))) > halfArc + slack) continue;
    if (staticLosBlocked(ctx.geo, f.pos.x, f.pos.y, o.f.pos.x, o.f.pos.y)) continue;
    inArc.push(o.idx);
  }

  let hit = false;
  if (cleave) {
    for (const j of inArc) hitFighter(ctx, rt, j);
    hit = inArc.length > 0;
  } else if (inArc.length > 0) {
    // The locked target if it is in the arc, else whoever is closest.
    let j = inArc.includes(rt.attackTarget) ? rt.attackTarget : -1;
    if (j < 0) {
      let best = Infinity;
      for (const k of inArc) {
        const d = edgeDistance(f, ctx.rts[k]!.f);
        if (d < best) {
          best = d;
          j = k;
        }
      }
    }
    hitFighter(ctx, rt, j);
    hit = true;
  }

  // Props in the arc take the blow too: all of them on a cleave, else the nearest when no fighter was hit.
  if (cleave || !hit) {
    const props = ctx.state.props;
    const mult = damageMultiplier(f.attributes, f.buffs.berserk > 0);
    const base = rt.punching ? COMBAT.punchDamage : w.damage;
    let nearest = -1;
    let nearestD = Infinity;
    for (let i = 0; i < props.length; i++) {
      const p = props[i]!;
      if (!p.alive) continue;
      const dx = p.pos.x - f.pos.x;
      const dy = p.pos.y - f.pos.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d - p.radius > reach) continue;
      if (Math.abs(angleDiff(f.facing, Math.atan2(dy, dx))) > halfArc + Math.asin(Math.min(1, p.radius / Math.max(d, 1)))) continue;
      if (cleave) damageProp(ctx, i, base * mult, rt.idx);
      else if (d < nearestD) {
        nearestD = d;
        nearest = i;
      }
    }
    if (nearest >= 0) damageProp(ctx, nearest, base * mult, rt.idx);
  }
}

function hitFighter(ctx: SimCtx, rt: FighterRt, j: number): void {
  const f = rt.f;
  const vrt = ctx.rts[j]!;
  const v = vrt.f;
  // A cleave stops when a parry earlier in the same swing killed the swinger.
  if (!v.alive || !f.alive) return;
  const w = WEAPONS[f.weapon];
  const punching = rt.punching;
  const base = punching ? COMBAT.punchDamage : w.damage;
  const dir = Math.atan2(v.pos.y - f.pos.y, v.pos.x - f.pos.x);
  let mult = damageMultiplier(f.attributes, f.buffs.berserk > 0);

  // An open parry window facing the attacker turns the blow around.
  if (v.parryTicks > 0 && v.stunTicks === 0 && Math.abs(angleDiff(v.facing, dir + Math.PI)) <= COMBAT.parryFacingArc) {
    ctx.events.push({ type: 'parry', tick: ctx.state.tick, fighterId: v.id, attackerId: f.id, pos: { x: v.pos.x, y: v.pos.y } });
    const info = blow(j, 'reflect', 'weapon', dir + Math.PI);
    info.weapon = v.limbs.armR ? v.weapon : null;
    info.reflect = true;
    info.stunTicks = COMBAT.parryStunTicks;
    info.knockback = PUNCH.knockback;
    applyDamage(ctx, rt.idx, resolveDamage(base, mult * COMBAT.parryReflect, f.attributes), info);
    return;
  }

  const backstab = Math.abs(angleDiff(v.facing, dir)) <= COMBAT.backstabArc;
  if (backstab) mult *= punching ? PUNCH.backstabMult : w.backstabMult;
  const crit = !backstab && base * mult >= COMBAT.critMinDamage && ctx.combatRng.chance(COMBAT.critChance);
  if (crit) mult *= COMBAT.critMult;
  if (crit && v.helmet && ctx.combatRng.chance(COMBAT.helmetKnockChance)) {
    v.helmet = false;
    dropItem(ctx, 'helmet', v.pos.x + Math.cos(dir) * 24, v.pos.y + Math.sin(dir) * 24, v.pos.x, v.pos.y, v.id);
  }
  const info = blow(rt.idx, punching ? 'punch' : 'weapon', 'weapon', dir);
  info.weapon = punching ? null : f.weapon;
  info.crit = crit;
  info.backstab = backstab;
  info.knockback = punching ? PUNCH.knockback : w.knockback;
  info.stunTicks = punching ? 0 : w.stunTicks;
  info.slowTicks = punching ? 0 : w.slowTicks;
  applyDamage(ctx, j, resolveDamage(base, mult, v.attributes), info);
}

const muzzle: Vec2 = { x: 0, y: 0 };

/**
 * World position of f's muzzle (see MUZZLE), written into `out`. Axes alternate hands when both
 * arms are there: an odd count throws from the right (the hand that holds a lone axe), an even
 * count from the left.
 */
function muzzlePoint(f: FighterState, out: Vec2): Vec2 {
  const m = MUZZLE[f.weapon] ?? NO_MUZZLE;
  const side = f.weapon === 'THROWING_AXES' && f.limbs.armL && f.ammo % 2 === 0 ? -1 : 1;
  const s = f.radius / MUZZLE_RADIUS;
  const u = m.u * s;
  const v = m.v * side * s;
  const c = Math.cos(f.facing);
  const n = Math.sin(f.facing);
  out.x = f.pos.x + u * c - v * n;
  out.y = f.pos.y + u * n + v * c;
  return out;
}

/**
 * Loose a projectile at the locked target (seen this tick, checked by `releaseShot`) from the
 * weapon's muzzle: along the imperfectly led aim line from the muzzle, turned by a uniform random
 * angle within `shotSpread(speed, distance)`. A target closer than COMBAT.pointBlankRange makes it
 * a point-blank shot (reduced damage). The stretch from the body to the muzzle is swept first, so
 * a staff held into a wall or a body bursts there instead of reaching through.
 */
function fire(ctx: SimCtx, rt: FighterRt): void {
  const f = rt.f;
  const w = WEAPONS[f.weapon];
  const j = rt.attackTarget;
  const m = muzzlePoint(f, muzzle);
  let dir = f.facing;
  let distance = Infinity;
  if (j >= 0) {
    const rec = rt.mem[j]!;
    aimPoint(ctx, rt, j, shotAim);
    distance = Math.hypot(rec.pos.x - f.pos.x, rec.pos.y - f.pos.y);
    const spread = shotSpread(Math.hypot(f.vel.x, f.vel.y), distance);
    // Aimed from the muzzle, so a staff tip held off to the side still flies at the target.
    dir = Math.atan2(shotAim.y - m.y, shotAim.x - m.x) + ctx.combatRng.range(-spread, spread);
  }
  const speed = projectileSpeed(f.weapon);
  const p: ProjectileState = {
    id: `p${ctx.nextId++}`,
    ownerId: f.id,
    weapon: f.weapon,
    pos: { x: m.x, y: m.y },
    vel: { x: Math.cos(dir) * speed, y: Math.sin(dir) * speed },
    // The flight starts at the muzzle; the range still counts from the shooter.
    ttl: Math.max(1, projectileTtl(f.weapon) - Math.floor(Math.hypot(m.x - f.pos.x, m.y - f.pos.y) / speed)),
    origin: { x: m.x, y: m.y },
  };
  if (distance < COMBAT.pointBlankRange) ctx.pointBlank.add(p.id);
  f.ammo--;
  if (w.ammoRegenTicks > 0 && rt.ammoRegen === 0) rt.ammoRegen = w.ammoRegenTicks;
  ctx.events.push({ type: 'projectile', tick: ctx.state.tick, projectileId: p.id, ownerId: f.id, weapon: f.weapon, pos: { x: m.x, y: m.y }, dir });
  if (!sweep(ctx, p, f.pos, p.pos)) ctx.state.projectiles.push(p);
}

/**
 * Where to aim at enemy j: its perceived position, plus (for a shot at a target in sight) a lead of
 * COMBAT.aimLead times its seen motion over the projectile's flight. Heard and remembered records
 * carry stale motion, so they get no lead.
 */
export function aimPoint(ctx: SimCtx, rt: FighterRt, j: number, out: Vec2): Vec2 {
  const rec = rt.mem[j]!;
  out.x = rec.pos.x;
  out.y = rec.pos.y;
  if (!rec.seen || WEAPONS[rt.f.weapon].family !== 'ranged' || rt.punching) return out;
  const d = Math.hypot(rec.pos.x - rt.f.pos.x, rec.pos.y - rt.f.pos.y);
  const lead = Math.min(MAX_LEAD_TICKS, d / projectileSpeed(rt.f.weapon)) * COMBAT.aimLead;
  out.x += rec.vel.x * lead;
  out.y += rec.vel.y * lead;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Projectiles
// ---------------------------------------------------------------------------------------------

const segFrom: Vec2 = { x: 0, y: 0 };
const segTo: Vec2 = { x: 0, y: 0 };

/** Parameter t in [0, 1] where segment a->b leaves the box [x0, x1] x [y0, y1], or -1 if b is still inside. */
function exitT(a: Vec2, b: Vec2, x0: number, y0: number, x1: number, y1: number): number {
  let t = -1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const take = (v: number) => {
    if (v >= 0 && v <= 1 && (t < 0 || v < t)) t = v;
  };
  if (b.x < x0 && dx < 0) take((x0 - a.x) / dx);
  if (b.x > x1 && dx > 0) take((x1 - a.x) / dx);
  if (b.y < y0 && dy < 0) take((y0 - a.y) / dy);
  if (b.y > y1 && dy > 0) take((y1 - a.y) / dy);
  return t;
}

export function updateProjectiles(ctx: SimCtx): void {
  const ps = ctx.state.projectiles;
  let w = 0;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]!;
    if (!stepProjectile(ctx, p)) ps[w++] = p;
  }
  ps.length = w;
}

const HIT_NONE = 0;
const HIT_WALL = 1;
const HIT_PROP = 2;
const HIT_FIGHTER = 3;

/** Advance one projectile; returns true when it ended this tick. */
function stepProjectile(ctx: SimCtx, p: ProjectileState): boolean {
  segFrom.x = p.pos.x;
  segFrom.y = p.pos.y;
  segTo.x = p.pos.x + p.vel.x;
  segTo.y = p.pos.y + p.vel.y;
  if (sweep(ctx, p, segFrom, segTo)) return true;
  p.pos.x = segTo.x;
  p.pos.y = segTo.y;
  if (--p.ttl > 0) return false;
  endProjectile(ctx, p, ctx.rts[ctx.byId.get(p.ownerId)!]!, p.pos.x, p.pos.y, -1);
  return true;
}

/**
 * Sweep projectile p along `from` -> `to` and stop it at the first thing on that segment: a wall,
 * pillar or the closing wall, a live prop, or any fighter but its owner. Resolves what it hit
 * (damage, shield, prop damage, then `endProjectile`) and returns true; false when the way is clear.
 */
function sweep(ctx: SimCtx, p: ProjectileState, from: Vec2, to: Vec2): boolean {
  const oi = ctx.byId.get(p.ownerId)!;
  const owner = ctx.rts[oi]!;
  let tBest = 2;
  let kind = HIT_NONE;
  let idx = -1;
  const tw = staticSegmentT(ctx.geo, from, to);
  if (tw >= 0) {
    tBest = tw;
    kind = HIT_WALL;
  }
  if (ctx.state.suddenDeath.active) {
    const b = ctx.bounds;
    const te = exitT(from, to, b.x, b.y, b.x + b.w, b.y + b.h);
    if (te >= 0 && te < tBest) {
      tBest = te;
      kind = HIT_WALL;
    }
  }
  const props = ctx.state.props;
  for (let i = 0; i < props.length; i++) {
    const pr = props[i]!;
    if (!pr.alive) continue;
    const t = segmentCircleT(from, to, pr.pos, pr.radius);
    if (t >= 0 && t < tBest) {
      tBest = t;
      kind = HIT_PROP;
      idx = i;
    }
  }
  for (const o of ctx.rts) {
    if (!o.f.alive || o === owner) continue;
    // Without friendly fire, shots pass through squadmates instead of being soaked up by them.
    if (!ctx.config.friendlyFire && o.f.squad === owner.f.squad) continue;
    const t = segmentCircleT(from, to, o.f.pos, o.f.radius + PROJECTILE_BODY_SLACK);
    if (t >= 0 && t < tBest) {
      tBest = t;
      kind = HIT_FIGHTER;
      idx = o.idx;
    }
  }
  if (kind === HIT_NONE) return false;

  const ex = from.x + (to.x - from.x) * tBest;
  const ey = from.y + (to.y - from.y) * tBest;
  const w = WEAPONS[p.weapon];
  const dir = Math.atan2(p.vel.y, p.vel.x);
  const mult = shotMultiplier(ctx, p, owner);
  let hitId = -1;
  let spared = -1;
  if (kind === HIT_FIGHTER) {
    const vrt = ctx.rts[idx]!;
    const v = vrt.f;
    const shielded =
      WEAPONS[v.weapon].shield &&
      v.stance === 'guard' &&
      v.limbs.armL &&
      v.stunTicks === 0 &&
      Math.abs(angleDiff(v.facing, dir + Math.PI)) <= COMBAT.shieldArc / 2;
    if (shielded) {
      ctx.events.push({ type: 'parry', tick: ctx.state.tick, fighterId: v.id, attackerId: owner.f.id, pos: { x: ex, y: ey } });
      spared = idx;
    } else {
      hitId = idx;
      const backstab = Math.abs(angleDiff(v.facing, dir)) <= COMBAT.backstabArc;
      let m = backstab ? mult * w.backstabMult : mult;
      const crit = !backstab && w.damage * m >= COMBAT.critMinDamage && ctx.combatRng.chance(COMBAT.critChance);
      if (crit) m *= COMBAT.critMult;
      const info = blow(oi, 'weapon', 'weapon', dir);
      info.weapon = p.weapon;
      info.ranged = true;
      info.crit = crit;
      info.backstab = backstab;
      info.knockback = w.knockback;
      info.stunTicks = w.stunTicks;
      info.slowTicks = w.slowTicks;
      applyDamage(ctx, idx, resolveDamage(w.damage, m, v.attributes), info);
    }
  } else if (kind === HIT_PROP) {
    damageProp(ctx, idx, w.damage * mult, oi);
  }
  endProjectile(ctx, p, owner, ex, ey, hitId, hitId >= 0 ? hitId : spared);
  return true;
}

/** Damage multiplier of a projectile: the owner's power and berserk, halved (pointBlankMul) for a point-blank shot. */
function shotMultiplier(ctx: SimCtx, p: ProjectileState, owner: FighterRt): number {
  const m = damageMultiplier(owner.f.attributes, owner.f.buffs.berserk > 0);
  return ctx.pointBlank.has(p.id) ? m * COMBAT.pointBlankMul : m;
}

/**
 * Splash (staff, sparing `spareIdx`: the fighter hit directly or the shield that stopped it), drop
 * spent ammo (arrows, axes) and emit `projectile_end`.
 */
function endProjectile(ctx: SimCtx, p: ProjectileState, owner: FighterRt, x: number, y: number, hitIdx: number, spareIdx = hitIdx): void {
  const w = WEAPONS[p.weapon];
  const len = Math.hypot(p.vel.x, p.vel.y) || 1;
  // Step back from whatever stopped it, so the burst and the dropped item sit in open floor.
  const bx = x - (p.vel.x / len) * DROP_BACKOFF;
  const by = y - (p.vel.y / len) * DROP_BACKOFF;
  if (w.splash > 0) splash(ctx, p, owner, bx, by, spareIdx);
  if (w.ammoPickup) dropItem(ctx, p.weapon === 'LONGBOW' ? 'arrow' : 'axe', bx, by, bx, by, p.ownerId);
  ctx.pointBlank.delete(p.id);
  ctx.events.push({ type: 'projectile_end', tick: ctx.state.tick, projectileId: p.id, pos: { x, y }, hitId: hitIdx >= 0 ? ctx.rts[hitIdx]!.f.id : null });
}

function splash(ctx: SimCtx, p: ProjectileState, owner: FighterRt, x: number, y: number, spareIdx: number): void {
  const w = WEAPONS[p.weapon];
  const mult = shotMultiplier(ctx, p, owner);
  for (const o of ctx.rts) {
    if (!o.f.alive || o.idx === spareIdx || !canHurt(ctx, owner, o)) continue;
    const d = Math.hypot(o.f.pos.x - x, o.f.pos.y - y);
    if (d - o.f.radius > w.splash) continue;
    if (staticLosBlocked(ctx.geo, x, y, o.f.pos.x, o.f.pos.y)) continue;
    const info = blow(owner.idx, 'weapon', 'weapon', Math.atan2(o.f.pos.y - y, o.f.pos.x - x));
    info.weapon = p.weapon;
    info.ranged = true;
    info.splash = true;
    info.knockback = w.knockback * SPLASH_KNOCKBACK;
    applyDamage(ctx, o.idx, resolveDamage(w.damage * w.splashMul, mult, o.f.attributes), info);
  }
  const props = ctx.state.props;
  for (let i = 0; i < props.length; i++) {
    const pr = props[i]!;
    if (pr.alive && Math.hypot(pr.pos.x - x, pr.pos.y - y) - pr.radius <= w.splash) damageProp(ctx, i, w.damage * w.splashMul * mult, owner.idx);
  }
}

// ---------------------------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------------------------

export function updateSkills(ctx: SimCtx): void {
  for (const rt of ctx.rts) {
    const f = rt.f;
    if (!f.alive || !rt.decision?.useSkill || f.skillCd > 0 || f.stunTicks > 0) continue;
    if (f.anim.phase === 'windup' || f.anim.phase === 'strike') continue;
    const ox = f.pos.x;
    const oy = f.pos.y;
    if (!useSkill(ctx, rt)) continue;
    f.skillCd = skillCooldown(f.attributes);
    // pos is where the skill happened; for SHADOWSTEP that is the departure point (the state has the arrival).
    ctx.events.push({ type: 'skill', tick: ctx.state.tick, fighterId: f.id, skill: f.skill, pos: { x: ox, y: oy } });
    bark(ctx, rt, 'skill');
  }
}

/** Resolve the fighter's skill. Returns false (cooldown not spent) when it cannot be used right now. */
function useSkill(ctx: SimCtx, rt: FighterRt): boolean {
  const f = rt.f;
  const s = SKILLS[f.skill];
  switch (f.skill) {
    case 'WHIRLWIND':
      rt.lastCombatTick = ctx.state.tick;
      areaSkill(ctx, rt, s.radius, 0);
      return true;
    case 'SHOCKWAVE':
      rt.lastCombatTick = ctx.state.tick;
      f.parryTicks = Math.max(f.parryTicks, s.parryTicks);
      areaSkill(ctx, rt, s.radius, s.arc / 2);
      return true;
    case 'SHADOWSTEP':
      return shadowstep(ctx, rt);
    case 'DASH': {
      const h = rt.decision && Number.isFinite(rt.decision.heading) && rt.decision.speed > 0 ? rt.decision.heading : f.facing;
      f.vel.x += Math.cos(h) * s.impulse * SPEED_SCALE;
      f.vel.y += Math.sin(h) * s.impulse * SPEED_SCALE;
      rt.moveDir = h;
      f.buffs.haste = Math.max(f.buffs.haste, s.hasteTicks);
      return true;
    }
    case 'BLOODRAGE':
      f.buffs.berserk = Math.max(f.buffs.berserk, s.berserkTicks);
      f.buffs.haste = Math.max(f.buffs.haste, s.hasteTicks);
      return true;
  }
}

/** Damage, stun and knockback everyone within `radius` (and within `halfArc` of facing unless 0). */
function areaSkill(ctx: SimCtx, rt: FighterRt, radius: number, halfArc: number): void {
  const f = rt.f;
  const s = SKILLS[f.skill];
  const base = skillDamage(f.skill, f.attributes);
  for (const o of ctx.rts) {
    if (!o.f.alive || !canHurt(ctx, rt, o)) continue;
    const dx = o.f.pos.x - f.pos.x;
    const dy = o.f.pos.y - f.pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d - o.f.radius > radius) continue;
    const dir = Math.atan2(dy, dx);
    if (halfArc > 0 && Math.abs(angleDiff(f.facing, dir)) > halfArc + Math.asin(Math.min(1, o.f.radius / Math.max(d, 1)))) continue;
    if (staticLosBlocked(ctx.geo, f.pos.x, f.pos.y, o.f.pos.x, o.f.pos.y)) continue;
    const info = blow(rt.idx, 'skill', 'skill', dir);
    info.skill = f.skill;
    info.knockback = s.knockback;
    info.stunTicks = s.stunTicks;
    applyDamage(ctx, o.idx, resolveDamage(base, 1, o.f.attributes), info);
  }
  const props = ctx.state.props;
  for (let i = 0; i < props.length; i++) {
    const p = props[i]!;
    if (!p.alive) continue;
    const dx = p.pos.x - f.pos.x;
    const dy = p.pos.y - f.pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d - p.radius > radius) continue;
    if (halfArc > 0 && Math.abs(angleDiff(f.facing, Math.atan2(dy, dx))) > halfArc) continue;
    damageProp(ctx, i, base, rt.idx);
  }
}

/**
 * Teleport behind the decision's target, facing its back. Fails (cooldown not spent) without a
 * target in sight or a free spot: stepping behind someone only heard or remembered would land on
 * their true position and give away where they are.
 */
function shadowstep(ctx: SimCtx, rt: FighterRt): boolean {
  const s = SKILLS.SHADOWSTEP;
  const j = decisionTarget(ctx, rt);
  if (j < 0 || !rt.mem[j]!.seen) return false;
  const f = rt.f;
  const t = ctx.rts[j]!.f;
  if (Math.hypot(t.pos.x - f.pos.x, t.pos.y - f.pos.y) > s.maxRange) return false;
  const dist = t.radius + s.distance;
  const b = ctx.bounds;
  for (const off of STEP_TRIES) {
    const a = t.facing + Math.PI + off;
    const x = t.pos.x + Math.cos(a) * dist;
    const y = t.pos.y + Math.sin(a) * dist;
    if (circleBlocked(ctx.geo, x, y, f.radius)) continue;
    // The whole body lands inside the closing wall, never in or behind it.
    if (x - f.radius < b.x || x + f.radius > b.x + b.w || y - f.radius < b.y || y + f.radius > b.y + b.h) continue;
    if (overlapsBody(ctx, rt, x, y)) continue;
    f.pos.x = x;
    f.pos.y = y;
    f.vel.x = 0;
    f.vel.y = 0;
    f.facing = Math.atan2(t.pos.y - y, t.pos.x - x);
    f.headAngle = f.facing;
    rt.moveDir = f.facing;
    return true;
  }
  return false;
}

function overlapsBody(ctx: SimCtx, rt: FighterRt, x: number, y: number): boolean {
  const r = rt.f.radius;
  for (const o of ctx.rts) {
    if (o === rt || !o.f.alive) continue;
    if (Math.hypot(o.f.pos.x - x, o.f.pos.y - y) < r + o.f.radius) return true;
  }
  for (const p of ctx.state.props) {
    if (p.alive && Math.hypot(p.pos.x - x, p.pos.y - y) < r + p.radius) return true;
  }
  return false;
}
