/**
 * The arena itself: hazards, kegs and amphoras going off, shrines, pickups, spent ammo on the
 * floor and the sudden-death wall.
 */

import { BLEED_RULES, HAZARD_RULES, MATCH_RULES, PICKUP_RULES, PROP_RULES, SPEED_SCALE, clamp, clamp01, resolveDamage, zoneBoundsAfter } from '../core';
import type { FighterState, HazardKind, HazardState, Vec2 } from '../core';
import type { FighterRt, HazardRt, SimCtx } from './context';
import { applyDamage, blow, damageProp } from './damage';
import { arenaBounds, maxInset, staticLosBlocked } from './geometry';
import { OUTER_WALL } from './maps';
import { hazardRadius } from './query';

/** Spikes stay up (visible, `active`) this many ticks after they thrust. */
const SPIKE_UP_TICKS = 14;
/** Keg blast damage at the edge of the radius, relative to the centre. */
const BLAST_EDGE = 0.6;
/** Breaks resolved at most per tick (a keg chain is long before this). */
const MAX_BREAKS_PER_TICK = 64;
/** Fighters touch floor items within body radius + this. */
const ITEM_PICK_SLACK = 14;
/** Sudden-death wall knocks fighters caught outside back in with this impulse (a backstop: movement keeps everyone inside). */
const WALL_SHOVE = 4;

/** A body within this distance (px) of the wall's face touches it. */
const CONTACT_SLACK = 0.5;
/** A body the wall holds deeper than this (px) inside a wall, pillar or prop is pinned there. */
const PIN_DEPTH = 2;
/** The wall sweeps floor items along this far (px) inside its face, so they stay within reach. */
const ITEM_INSET = 8;

// ---------------------------------------------------------------------------------------------
// Hazards
// ---------------------------------------------------------------------------------------------

export function makeHazardRt(h: HazardState, index: number, fighters: number): HazardRt {
  const rule = HAZARD_RULES[h.kind];
  let pathLength = 0;
  if (h.path && h.path.length > 1) {
    for (let i = 0; i < h.path.length; i++) {
      const a = h.path[i]!;
      const b = h.path[(i + 1) % h.path.length]!;
      pathLength += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  const period = h.period ?? rule.period;
  return { travelled: 0, pathLength, nextHit: new Int32Array(fighters), offset: h.kind === 'spike' ? (index % 2) * Math.floor(period / 2) : 0 };
}

/** Position `dist` px along a closed path. */
function alongPath(path: readonly Vec2[], dist: number, out: Vec2): void {
  for (let i = 0; i < path.length; i++) {
    const a = path[i]!;
    const b = path[(i + 1) % path.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (dist <= len || i === path.length - 1) {
      const t = len > 0 ? Math.min(1, dist / len) : 0;
      out.x = a.x + (b.x - a.x) * t;
      out.y = a.y + (b.y - a.y) * t;
      return;
    }
    dist -= len;
  }
}

export function updateHazards(ctx: SimCtx): void {
  const hs = ctx.state.hazards;
  const tick = ctx.state.tick;
  let k = 0;
  while (k < hs.length) {
    const h = hs[k]!;
    const hr = ctx.hazardRts[k]!;
    const rule = HAZARD_RULES[h.kind];
    const radius = hazardRadius(h);
    if (h.kind === 'spike') {
      const period = h.period ?? rule.period;
      const trigger = Math.floor(period * rule.triggerAt);
      const local = (tick + hr.offset) % period;
      h.phase = local / period;
      h.active = local >= trigger && local < trigger + SPIKE_UP_TICKS;
      if (local === trigger) spikeThrust(ctx, h, radius);
    } else {
      if (h.kind === 'saw' && h.path && hr.pathLength > 0) {
        const speed = rule.speed * SPEED_SCALE * (ctx.state.suddenDeath.active ? MATCH_RULES.suddenDeathSawSpeedMul : 1);
        hr.travelled = (hr.travelled + speed) % hr.pathLength;
        alongPath(h.path, hr.travelled, h.pos);
        h.phase = hr.travelled / hr.pathLength;
      }
      h.active = true;
      // How far the hazard reaches into a body: `HazardRule.bodyShare` (the renderer's acid look uses the same).
      const share = rule.bodyShare;
      for (const rt of ctx.rts) {
        const f = rt.f;
        if (!f.alive || tick < hr.nextHit[rt.idx]!) continue;
        const dx = f.pos.x - h.pos.x;
        const dy = f.pos.y - h.pos.y;
        const reach = radius + f.radius * share;
        if (dx * dx + dy * dy >= reach * reach) continue;
        hr.nextHit[rt.idx] = tick + rule.intervalTicks;
        hazardHit(ctx, h, rt.idx, Math.atan2(dy, dx));
      }
    }
    if (h.ttl !== null && --h.ttl <= 0) {
      hs.splice(k, 1);
      ctx.hazardRts.splice(k, 1);
      continue;
    }
    k++;
  }
}

function spikeThrust(ctx: SimCtx, h: HazardState, radius: number): void {
  let any = false;
  for (const rt of ctx.rts) {
    const f = rt.f;
    if (!f.alive) continue;
    const dx = f.pos.x - h.pos.x;
    const dy = f.pos.y - h.pos.y;
    const reach = radius + f.radius * HAZARD_RULES.spike.bodyShare;
    if (dx * dx + dy * dy >= reach * reach) continue;
    any = true;
    hazardHit(ctx, h, rt.idx, Math.atan2(dy, dx));
  }
  if (!any) ctx.events.push({ type: 'hazard', tick: ctx.state.tick, hazardId: h.id, victimId: null, pos: { x: h.pos.x, y: h.pos.y } });
}

function hazardHit(ctx: SimCtx, h: HazardState, vi: number, dir: number): void {
  const rule = HAZARD_RULES[h.kind];
  const v = ctx.rts[vi]!.f;
  ctx.events.push({ type: 'hazard', tick: ctx.state.tick, hazardId: h.id, victimId: v.id, pos: { x: v.pos.x, y: v.pos.y } });
  const info = blow(-1, 'hazard', 'hazard', dir);
  info.hazardKind = h.kind;
  info.knockback = rule.knockback;
  info.slowTicks = rule.slowTicks;
  applyDamage(ctx, vi, resolveDamage(rule.damage, 1, v.attributes), info);
}

// ---------------------------------------------------------------------------------------------
// Kegs and amphoras
// ---------------------------------------------------------------------------------------------

/** Resolve queued prop breaks: keg blasts (which may break more props) and acid spills. */
export function resolveBreaks(ctx: SimCtx): void {
  let n = 0;
  while (ctx.breakQueue.length > 0 && n++ < MAX_BREAKS_PER_TICK) {
    const { prop, by } = ctx.breakQueue.shift()!;
    const p = ctx.state.props[prop]!;
    const rule = PROP_RULES[p.kind];
    if (rule.blastDamage > 0) {
      ctx.events.push({ type: 'explosion', tick: ctx.state.tick, pos: { x: p.pos.x, y: p.pos.y }, radius: rule.blastRadius });
      for (const rt of ctx.rts) {
        const f = rt.f;
        if (!f.alive) continue;
        const d = Math.hypot(f.pos.x - p.pos.x, f.pos.y - p.pos.y);
        if (d - f.radius > rule.blastRadius) continue;
        if (staticLosBlocked(ctx.geo, p.pos.x, p.pos.y, f.pos.x, f.pos.y)) continue;
        const falloff = 1 - (1 - BLAST_EDGE) * clamp01(d / rule.blastRadius);
        const info = blow(by, 'keg', 'keg', Math.atan2(f.pos.y - p.pos.y, f.pos.x - p.pos.x));
        info.knockback = rule.knockback;
        applyDamage(ctx, rt.idx, resolveDamage(rule.blastDamage * falloff, 1, f.attributes), info);
      }
      const props = ctx.state.props;
      for (let i = 0; i < props.length; i++) {
        const q = props[i]!;
        if (q.alive && Math.hypot(q.pos.x - p.pos.x, q.pos.y - p.pos.y) - q.radius <= rule.blastRadius) damageProp(ctx, i, rule.blastDamage, by);
      }
    }
    if (rule.spills) spill(ctx, rule.spills, p.pos, p.id);
  }
}

function spill(ctx: SimCtx, kind: HazardKind, pos: Vec2, from: string): void {
  const rule = HAZARD_RULES[kind];
  const h: HazardState = {
    id: `${from}_spill${ctx.nextId++}`,
    kind,
    pos: { x: pos.x, y: pos.y },
    radius: rule.radius,
    phase: 0,
    active: true,
    ttl: rule.durationTicks,
  };
  ctx.state.hazards.push(h);
  ctx.hazardRts.push(makeHazardRt(h, ctx.state.hazards.length - 1, ctx.rts.length));
}

// ---------------------------------------------------------------------------------------------
// Shrines, pickups, floor items
// ---------------------------------------------------------------------------------------------

const ANYONE = 0;
const WOUNDED = 1;
const NEEDS_ARROW = 2;
const NEEDS_AXE = 3;

function wants(ctx: SimCtx, i: number, who: number): boolean {
  const f = ctx.rts[i]!.f;
  if (who === ANYONE) return true;
  if (who === WOUNDED) return f.hp < f.maxHp;
  if (f.ammo >= f.maxAmmo) return false;
  return who === NEEDS_ARROW ? f.weapon === 'LONGBOW' : f.weapon === 'THROWING_AXES';
}

/** Nearest living fighter touching (x, y) within `radius` that `wants` it, or -1. */
function nearestToucher(ctx: SimCtx, x: number, y: number, radius: number, who: number): number {
  let best = -1;
  let bestD = Infinity;
  for (const rt of ctx.rts) {
    const f = rt.f;
    if (!f.alive) continue;
    const d = Math.hypot(f.pos.x - x, f.pos.y - y);
    if (d > radius + f.radius || d >= bestD || !wants(ctx, rt.idx, who)) continue;
    best = rt.idx;
    bestD = d;
  }
  return best;
}

export function updatePickups(ctx: SimCtx): void {
  const tick = ctx.state.tick;
  const shrine = PICKUP_RULES.shrine;
  for (const s of ctx.state.shrines) {
    if (s.cooldown > 0) {
      s.cooldown--;
      continue;
    }
    const i = nearestToucher(ctx, s.pos.x, s.pos.y, shrine.radius, WOUNDED);
    if (i < 0) continue;
    const f = ctx.rts[i]!.f;
    const amount = Math.min(f.maxHp - f.hp, Math.round(f.maxHp * shrine.amount));
    f.hp += amount;
    if (BLEED_RULES.shrineCures && f.bleed) f.bleed = null;
    s.cooldown = shrine.cooldownTicks;
    ctx.events.push({ type: 'heal', tick, fighterId: f.id, amount, pos: { x: s.pos.x, y: s.pos.y }, shrineId: s.id });
  }

  // Power-ups: `cooldown` counts down to the next appearance (PickupState). Each appearance is
  // announced with `pickup_spawn`; the power-up can be taken from the next tick on.
  for (const p of ctx.state.pickups) {
    if (p.cooldown > 0) {
      if (--p.cooldown === 0) ctx.events.push({ type: 'pickup_spawn', tick, pickupId: p.id, kind: p.kind, pos: { x: p.pos.x, y: p.pos.y } });
      continue;
    }
    // There from the start (firstSpawnTicks 0): it appears on the first tick.
    if (tick === 1) ctx.events.push({ type: 'pickup_spawn', tick, pickupId: p.id, kind: p.kind, pos: { x: p.pos.x, y: p.pos.y } });
    const rule = PICKUP_RULES[p.kind];
    const i = nearestToucher(ctx, p.pos.x, p.pos.y, rule.radius, ANYONE);
    if (i < 0) continue;
    const f = ctx.rts[i]!.f;
    if (p.kind === 'haste') f.buffs.haste = Math.max(f.buffs.haste, rule.durationTicks);
    else f.buffs.berserk = Math.max(f.buffs.berserk, rule.durationTicks);
    p.cooldown = rule.cooldownTicks;
    ctx.events.push({ type: 'pickup', tick, fighterId: f.id, kind: p.kind, pos: { x: p.pos.x, y: p.pos.y } });
  }

  // Spent arrows and axes: whoever uses that ammo and has room walks over it and takes it.
  const floor = ctx.state.floor;
  let w = 0;
  for (let k = 0; k < floor.length; k++) {
    const it = floor[k]!;
    if (it.kind === 'arrow' || it.kind === 'axe') {
      const i = nearestToucher(ctx, it.pos.x, it.pos.y, ITEM_PICK_SLACK, it.kind === 'arrow' ? NEEDS_ARROW : NEEDS_AXE);
      if (i >= 0) {
        const f = ctx.rts[i]!.f;
        f.ammo++;
        ctx.events.push({ type: 'pickup', tick, fighterId: f.id, kind: it.kind, pos: { x: it.pos.x, y: it.pos.y } });
        continue;
      }
    }
    floor[w++] = it;
  }
  floor.length = w;
}

// ---------------------------------------------------------------------------------------------
// Sudden death
// ---------------------------------------------------------------------------------------------

/**
 * Start and advance the sudden-death wall (the zone); keeps `bounds`, `warning`, `closedAtTick`
 * and the escalation level of `state.suddenDeath` current. Runs before perception each tick.
 *
 * Sudden death starts at the time limit, or earlier when no fighter has damaged another for
 * MATCH_RULES.stalemateTicks (only in matches with sudden death on). The wall closes to `final`;
 * from the tick it stops the escalation level is 1, rising one level every escalationStepTicks,
 * and from escalationEverywhereTicks after the stop the escalated damage reaches inside the zone.
 */
export function updateSuddenDeathWall(ctx: SimCtx): void {
  const sd = ctx.state.suddenDeath;
  const tick = ctx.state.tick;
  if (!sd.active) {
    if (!ctx.config.suddenDeath) return;
    const reason = tick >= ctx.config.timeLimitTicks ? 'time' : tick - ctx.lastFighterDamageTick >= MATCH_RULES.stalemateTicks ? 'stalemate' : null;
    if (!reason) return;
    sd.active = true;
    sd.reason = reason;
    sd.startedAtTick = tick;
    sd.inset = OUTER_WALL;
    ctx.events.push({ type: 'sudden_death', tick, reason });
  } else if (sd.closedAtTick < 0) {
    const max = maxInset(ctx.map);
    sd.inset = Math.min(max, sd.inset + MATCH_RULES.suddenDeathInsetPerTick);
    if (sd.inset >= max) sd.closedAtTick = tick;
  }
  arenaBounds(ctx.map, sd.inset, ctx.bounds);
  // The wall sweeps spent ammo and dropped gear along in front of it: nothing lies out of reach.
  const b = ctx.bounds;
  for (const it of ctx.state.floor) {
    it.pos.x = clamp(it.pos.x, b.x + ITEM_INSET, b.x + b.w - ITEM_INSET);
    it.pos.y = clamp(it.pos.y, b.y + ITEM_INSET, b.y + b.h - ITEM_INSET);
  }
  if (sd.closedAtTick >= 0) {
    const level = 1 + Math.floor((tick - sd.closedAtTick) / MATCH_RULES.escalationStepTicks);
    if (level > sd.escalation) {
      sd.escalation = level;
      // A level reaches inside the zone when it starts at least escalationEverywhereTicks after the stop.
      sd.everywhere = (level - 1) * MATCH_RULES.escalationStepTicks >= MATCH_RULES.escalationEverywhereTicks;
      const damage = MATCH_RULES.suddenDeathDamage + MATCH_RULES.escalationDamage * level;
      ctx.events.push({ type: 'escalation', tick, level, damage, everywhere: sd.everywhere });
    }
  }
  zoneBoundsAfter(sd, MATCH_RULES.warningTicks, sd.warning);
}

/**
 * The closing wall bites. Every tick, whoever touches it is pushed back in, ground on its spikes
 * and crushed while it pins them (`grindWall`). Every suddenDeathIntervalTicks, counted from the
 * start of sudden death: anyone caught outside the zone (a backstop; movement keeps every body
 * inside) takes `suddenDeathDamage + escalationDamage x level` and is shoved back in; once
 * `everywhere` is on, fighters inside take `escalationDamage x level`. The level climbs every
 * second after the wall stops, so the match always ends (no strategy can hide or out-heal it).
 */
export function suddenDeathDamage(ctx: SimCtx): void {
  const sd = ctx.state.suddenDeath;
  if (!sd.active) return;
  for (const rt of ctx.rts) if (rt.f.alive) grindWall(ctx, rt);
  const tick = ctx.state.tick;
  if ((tick - sd.startedAtTick) % MATCH_RULES.suddenDeathIntervalTicks !== 0) return;
  const b = ctx.bounds;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const escalated = MATCH_RULES.escalationDamage * sd.escalation;
  for (const rt of ctx.rts) {
    const f = rt.f;
    if (!f.alive) continue;
    const outside = f.pos.x < b.x || f.pos.x > b.x + b.w || f.pos.y < b.y || f.pos.y > b.y + b.h;
    const amount = outside ? MATCH_RULES.suddenDeathDamage + escalated : sd.everywhere ? escalated : 0;
    if (amount <= 0) continue;
    const info = blow(-1, 'sudden_death', 'sudden_death', Math.atan2(cy - f.pos.y, cx - f.pos.x));
    if (outside) info.knockback = WALL_SHOVE;
    applyDamage(ctx, rt.idx, amount, info);
  }
}

/**
 * A living fighter touching the closing wall (moving or stopped): pushed straight back in with
 * MATCH_RULES.wallPushKnockback every tick of contact, whether it walks into the wall or stands
 * still, ground on the spikes for MATCH_RULES.wallContactDamage, and crushed (wallCrushDamage more,
 * kill flag `crushed`) while the wall holds it inside a wall, pillar or prop. `wall_contact`
 * (the cue for sparks and blood, at the contact point on the wall's face) precedes the `hit`.
 */
function grindWall(ctx: SimCtx, rt: FighterRt): void {
  const f = rt.f;
  const b = ctx.bounds;
  const reach = f.radius + CONTACT_SLACK;
  const left = f.pos.x - b.x <= reach;
  const right = b.x + b.w - f.pos.x <= reach;
  const top = f.pos.y - b.y <= reach;
  const bottom = b.y + b.h - f.pos.y <= reach;
  if (!left && !right && !top && !bottom) return;
  const crushed = pinDepth(ctx, f) > PIN_DEPTH;
  const amount = MATCH_RULES.wallContactDamage + (crushed ? MATCH_RULES.wallCrushDamage : 0);
  ctx.events.push({
    type: 'wall_contact',
    tick: ctx.state.tick,
    fighterId: f.id,
    damage: Math.min(amount, f.hp),
    pos: { x: left ? b.x : right ? b.x + b.w : f.pos.x, y: top ? b.y : bottom ? b.y + b.h : f.pos.y },
  });
  // Inward: away from every face it touches (diagonal in a corner).
  const nx = (left ? 1 : 0) - (right ? 1 : 0);
  const ny = (top ? 1 : 0) - (bottom ? 1 : 0);
  const info = blow(-1, 'sudden_death', 'sudden_death', Math.atan2(ny, nx));
  info.knockback = MATCH_RULES.wallPushKnockback;
  info.crushed = crushed;
  applyDamage(ctx, rt.idx, amount, info);
}

/** How deep (px) the body sits inside the wall, pillar or live prop it overlaps most; 0 or less when clear. */
function pinDepth(ctx: SimCtx, f: FighterState): number {
  let depth = 0;
  for (const r of ctx.geo.blockers) {
    const qx = clamp(f.pos.x, r.x, r.x + r.w);
    const qy = clamp(f.pos.y, r.y, r.y + r.h);
    depth = Math.max(depth, f.radius - Math.hypot(f.pos.x - qx, f.pos.y - qy));
  }
  for (const p of ctx.state.props) {
    if (p.alive) depth = Math.max(depth, f.radius + p.radius - Math.hypot(f.pos.x - p.pos.x, f.pos.y - p.pos.y));
  }
  return depth;
}
