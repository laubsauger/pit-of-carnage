/**
 * Everything that happens when something gets hurt: HP, knockback, stun and slow, hit flash,
 * dismemberment, death (kill credit, flags, stamp, drops), barks, gore spots and prop damage.
 * Combat, hazards, kegs and sudden death all go through `applyDamage`, so every source follows
 * the same rules and emits the same events.
 */

import { BARK_RULES, BLEED_RULES, COMBAT, MATCH_RULES, PROP_RULES, WEAPONS } from '../core';
import type { BarkKind, DamageSource, FloorItemKind, KillCause, KillFlag, Limb } from '../core';
import type { DamageInfo, FighterRt, SimCtx } from './context';
import { killStamp } from './copy';
import { circleBlocked } from './geometry';

/** Ticks of white hit flash after any damage. */
const HIT_FLASH_TICKS = 8;
/** Hits at least this big pop the victim's eyes (cosmetic). */
const EYE_POP_DAMAGE = 24;
const EYE_POP_TICKS = 24;
/** Hits at least this big leave a gore spot (bloody footprints). */
const GORE_DAMAGE = 20;
/** Knockback is scaled by this radius over the victim's radius: big bodies fly less far. */
const KNOCKBACK_REF_RADIUS = 20;
/** A hazard or wall death within this many ticks of being hit credits the hitter ("fed to the saw"). */
const CREDIT_WINDOW_TICKS = 150;
/** The victim had not seen the killer for this many ticks: the kill counts as `unseen`. */
const UNSEEN_TICKS = 60;
/** A killer below this HP share landing the kill gets a CLUTCH stamp. */
const CLUTCH_HP = 0.15;
/** Damage beyond the victim's remaining HP that counts as `overkill`. */
const OVERKILL_MARGIN = 20;
/** Landing a hit this big may trigger a `hit` bark. */
const HIT_BARK_DAMAGE = 15;
/** Minimum ticks between low-priority barks (hit, taunt) across all fighters, so lines do not pile up. */
const CHATTER_GAP_TICKS = 45;
/** Cosmetic floor items (helmets, weapons) kept at most; ammo items are never culled. */
const MAX_COSMETIC_ITEMS = 24;
/** Ammo items a dead fighter spills at most. */
const MAX_AMMO_SPILL = 4;
const ITEM_RADIUS = 6;
export const GORE_SPOTS = 64;

const INFO: DamageInfo = {
  attacker: -1,
  source: 'weapon',
  weapon: null,
  skill: null,
  dir: 0,
  knockback: 0,
  crit: false,
  backstab: false,
  stunTicks: 0,
  slowTicks: 0,
  ranged: false,
  splash: false,
  reflect: false,
  hazardKind: null,
  crushed: false,
  cause: 'weapon',
};

/**
 * Reset and return the shared damage descriptor. Fill extra fields, then pass it straight to
 * `applyDamage`; it is reused by the next call, so never keep it.
 */
export function blow(attacker: number, source: DamageSource, cause: KillCause, dir: number): DamageInfo {
  INFO.attacker = attacker;
  INFO.source = source;
  INFO.cause = cause;
  INFO.dir = dir;
  INFO.weapon = null;
  INFO.skill = null;
  INFO.knockback = 0;
  INFO.crit = false;
  INFO.backstab = false;
  INFO.stunTicks = 0;
  INFO.slowTicks = 0;
  INFO.ranged = false;
  INFO.splash = false;
  INFO.reflect = false;
  INFO.hazardKind = null;
  INFO.crushed = false;
  return INFO;
}

/** May fighter `a` hurt fighter `b` with this match's friendly-fire rule? */
export function canHurt(ctx: SimCtx, a: FighterRt, b: FighterRt): boolean {
  return a !== b && (a.f.squad !== b.f.squad || ctx.config.friendlyFire);
}

/**
 * Deal `amount` (already final: armor applied by the caller) to fighter `vi`. Returns the HP
 * actually removed. Emits `hit`, and `dismember`/`kill` when they happen.
 */
export function applyDamage(ctx: SimCtx, vi: number, amount: number, info: DamageInfo): number {
  const vrt = ctx.rts[vi]!;
  const v = vrt.f;
  if (!v.alive || amount <= 0) return 0;
  const tick = ctx.state.tick;
  const hpBefore = v.hp;
  const dealt = Math.min(amount, hpBefore);
  v.hp = Math.max(0, hpBefore - amount);
  v.damageTaken += dealt;
  v.lastHitTick = tick;
  vrt.lastCombatTick = tick;
  v.hitFlash = HIT_FLASH_TICKS;
  if (amount >= EYE_POP_DAMAGE) v.eyePop = EYE_POP_TICKS;

  const art = info.attacker >= 0 ? ctx.rts[info.attacker]! : null;
  if (art && art !== vrt) {
    art.f.damageDealt += dealt;
    art.lastCombatTick = tick;
    v.lastHitBy = art.f.id;
    vrt.hitByTick = tick;
    // Fighter-on-fighter damage (weapons, skills, kegs someone broke) holds off the stalemate.
    ctx.lastFighterDamageTick = tick;
  }

  if (info.knockback > 0) {
    const k = info.knockback * COMBAT.knockbackScale * (KNOCKBACK_REF_RADIUS / v.radius);
    v.vel.x += Math.cos(info.dir) * k;
    v.vel.y += Math.sin(info.dir) * k;
  }
  // A melee hit on a ranged attacker winding up a shot cancels it (no ammo spent) and staggers them.
  const melee = art && art !== vrt && !info.ranged && (info.source === 'weapon' || info.source === 'punch');
  if (melee && v.anim.phase === 'windup' && !vrt.punching && WEAPONS[v.weapon].family === 'ranged') {
    setIdle(vrt);
    v.stunTicks = Math.max(v.stunTicks, COMBAT.interruptStaggerTicks);
  }
  if (info.stunTicks > 0) {
    v.stunTicks = Math.max(v.stunTicks, info.stunTicks);
    if (v.anim.phase === 'windup') setIdle(vrt);
  }
  if (info.slowTicks > 0) v.buffs.slow = Math.max(v.buffs.slow, info.slowTicks);

  ctx.events.push({
    type: 'hit',
    tick,
    attackerId: art ? art.f.id : null,
    victimId: v.id,
    amount: dealt,
    pos: { x: v.pos.x, y: v.pos.y },
    dir: info.dir,
    crit: info.crit,
    backstab: info.backstab,
    weapon: info.weapon,
    knockback: info.knockback,
    source: info.source,
  });
  if (dealt >= GORE_DAMAGE) addGore(ctx, v.pos.x, v.pos.y);

  if (v.hp <= 0) {
    killFighter(ctx, vi, info, amount, hpBefore);
    return dealt;
  }
  if (art && art !== vrt && art.f.squad !== v.squad && dealt >= HIT_BARK_DAMAGE && art.f.alive) bark(ctx, art, 'hit');
  if (!vrt.lowHpBarked && v.hp < v.maxHp * BARK_RULES.lowHp) {
    vrt.lowHpBarked = true;
    bark(ctx, vrt, 'low_hp');
  }
  if (amount >= COMBAT.dismemberMinDamage && v.hp < v.maxHp * COMBAT.dismemberBelowHp && ctx.combatRng.chance(COMBAT.dismemberChance)) {
    dismember(ctx, vrt, info.dir, art ? art.f.id : null);
    openWound(ctx, vrt, BLEED_RULES.limbLossTicks, BLEED_RULES.limbLossDamage, info);
  }
  return dealt;
}

// ---------------------------------------------------------------------------------------------
// Bleeding (BLEED_RULES; nothing here runs while it is disabled)
// ---------------------------------------------------------------------------------------------

/**
 * Open a wound on a living fighter: it bleeds `damage` every BLEED_RULES.intervalTicks for `ticks`
 * ticks (at most maxTicks). A new wound refreshes the time left and keeps the larger damage (and
 * the opener of that one). `info` is the blow that opened it: the bleed credits its attacker and a
 * bleed-out kill keeps its cause and weapon.
 */
export function openWound(ctx: SimCtx, vrt: FighterRt, ticks: number, damage: number, info: DamageInfo): void {
  const v = vrt.f;
  if (!BLEED_RULES.enabled || ticks <= 0 || damage <= 0 || !v.alive) return;
  const sourceId = info.attacker >= 0 && info.attacker !== vrt.idx ? ctx.rts[info.attacker]!.f.id : null;
  const cur = v.bleed;
  const left = Math.min(BLEED_RULES.maxTicks, Math.max(ticks, cur ? cur.ticks : 0));
  vrt.bleedFrom = ctx.state.tick;
  if (!cur) vrt.bleedNext = ctx.state.tick + BLEED_RULES.intervalTicks;
  if (!cur || damage >= cur.damagePerTick) {
    v.bleed = { ticks: left, damagePerTick: damage, sourceId };
    vrt.bleedCause = info.cause;
    vrt.bleedWeapon = info.weapon;
  } else {
    cur.ticks = left;
  }
}

/** Open wounds bleed: damage every intervalTicks while ticks last (a `hit` with source `bleed`). */
export function updateBleeding(ctx: SimCtx): void {
  if (!BLEED_RULES.enabled) return;
  const tick = ctx.state.tick;
  for (const rt of ctx.rts) {
    const f = rt.f;
    const b = f.bleed;
    // The tick a wound opens is not one of its bleeding ticks: a 150-tick wound bleeds 150 more.
    if (!b || !f.alive || tick === rt.bleedFrom) continue;
    if (tick >= rt.bleedNext) {
      rt.bleedNext = tick + BLEED_RULES.intervalTicks;
      const src = b.sourceId === null ? -1 : (ctx.byId.get(b.sourceId) ?? -1);
      const info = blow(src, 'bleed', rt.bleedCause, f.facing + Math.PI);
      info.weapon = rt.bleedWeapon;
      applyDamage(ctx, rt.idx, b.damagePerTick, info);
      if (!f.alive) continue;
    }
    if (--b.ticks <= 0) f.bleed = null;
  }
}

const LIMBS: readonly Limb[] = ['armL', 'armR', 'legL', 'legR'];
const attached: Limb[] = [];

/** Sever a random attached limb. Losing `armR` (the weapon arm) drops the weapon. */
function dismember(ctx: SimCtx, vrt: FighterRt, dir: number, attackerId: string | null): void {
  const v = vrt.f;
  attached.length = 0;
  for (const l of LIMBS) if (v.limbs[l]) attached.push(l);
  if (attached.length === 0) return;
  const limb = ctx.combatRng.pick(attached);
  v.limbs[limb] = false;
  const speed = 3 + ctx.combatRng.next() * 2;
  const spin = (ctx.combatRng.next() - 0.5) * 1.2;
  ctx.events.push({
    type: 'dismember',
    tick: ctx.state.tick,
    attackerId,
    victimId: v.id,
    limb,
    pos: { x: v.pos.x, y: v.pos.y },
    vel: { x: Math.cos(dir + spin) * speed, y: Math.sin(dir + spin) * speed },
  });
  addGore(ctx, v.pos.x, v.pos.y);
  if (limb === 'armR') dropItem(ctx, 'weapon', v.pos.x + Math.cos(dir) * 18, v.pos.y + Math.sin(dir) * 18, v.pos.x, v.pos.y, v.id);
}

function setIdle(rt: FighterRt): void {
  const a = rt.f.anim;
  a.phase = 'idle';
  a.t = 0;
  a.dur = 0;
}

function killFighter(ctx: SimCtx, vi: number, info: DamageInfo, amount: number, hpBefore: number): void {
  const tick = ctx.state.tick;
  const vrt = ctx.rts[vi]!;
  const v = vrt.f;
  v.alive = false;
  v.hp = 0;
  v.diedAtTick = tick;
  v.vel.x = 0;
  v.vel.y = 0;
  v.stunTicks = 0;
  v.parryTicks = 0;
  setIdle(vrt);

  // Credit: whoever dealt the blow, or whoever knocked the victim into a hazard moments ago.
  let ki = info.attacker;
  if (ki < 0 && info.cause === 'hazard' && v.lastHitBy !== null && tick - vrt.hitByTick <= CREDIT_WINDOW_TICKS) {
    ki = ctx.byId.get(v.lastHitBy) ?? -1;
  }
  const krt = ki >= 0 ? ctx.rts[ki]! : null;
  const self = krt === vrt;
  let cause = info.cause;
  if (krt && !self && krt.f.squad === v.squad) cause = 'friendly';

  const flags: KillFlag[] = [];
  if (info.backstab) flags.push('backstab');
  if (info.crit) flags.push('crit');
  if (info.ranged) flags.push('ranged');
  if (info.splash) flags.push('splash');
  if (info.reflect) flags.push('reflect');
  if (info.crushed) flags.push('crushed');
  let streak = 0;
  let avenged = false;
  let clutch = false;
  if (krt && !self) {
    const rec = vrt.mem[ki] ?? null;
    if (!rec || rec.lastSeenTick < tick - UNSEEN_TICKS) flags.push('unseen');
    if (cause !== 'friendly') {
      krt.killStreak = tick - krt.lastKillTick <= MATCH_RULES.multiKillWindowTicks ? krt.killStreak + 1 : 1;
      krt.lastKillTick = tick;
      streak = krt.killStreak;
      if (streak >= 2) flags.push('multi');
      krt.f.kills++;
      if (!krt.killedSquads.includes(v.squad)) krt.killedSquads.push(v.squad);
    }
    avenged = vrt.killedSquads.includes(krt.f.squad);
    if (avenged || krt.f.lastHitBy === v.id) flags.push('revenge');
    clutch = krt.f.alive && krt.f.hp < krt.f.maxHp * CLUTCH_HP;
  }
  if (amount >= hpBefore + OVERKILL_MARGIN) flags.push('overkill');

  const title = killStamp({ cause, weapon: info.weapon, skill: info.skill, hazard: info.hazardKind, flags, self, streak, avenged, clutch }, ctx.copyRng);
  ctx.events.push({
    type: 'kill',
    tick,
    killerId: krt ? krt.f.id : null,
    victimId: v.id,
    cause,
    pos: { x: v.pos.x, y: v.pos.y },
    dir: info.dir,
    title,
    killerBehaviour: krt ? krt.f.behaviour : null,
    victimBehaviour: v.behaviour,
    weapon: info.weapon,
    flags,
    hazard: info.hazardKind,
    // Set by `place` (match.ts) on the kill that ends an elimination match.
    final: false,
  });

  bark(ctx, vrt, 'death');
  if (krt && !self && krt.f.alive) bark(ctx, krt, 'kill');

  // Spilled ammo is real ammo: other archers and axe throwers can pick it up.
  const w = WEAPONS[v.weapon];
  if (w.ammoPickup && v.ammo > 0) {
    const kind: FloorItemKind = v.weapon === 'LONGBOW' ? 'arrow' : 'axe';
    const n = Math.min(v.ammo, MAX_AMMO_SPILL);
    for (let i = 0; i < n; i++) {
      const a = info.dir + (i - (n - 1) / 2) * 0.9;
      dropItem(ctx, kind, v.pos.x + Math.cos(a) * 20, v.pos.y + Math.sin(a) * 20, v.pos.x, v.pos.y, v.id);
    }
    v.ammo = 0;
  }
  if (v.limbs.armR) dropItem(ctx, 'weapon', v.pos.x + Math.cos(info.dir) * 14, v.pos.y + Math.sin(info.dir) * 14, v.pos.x, v.pos.y, v.id);
  if (v.helmet) {
    v.helmet = false;
    dropItem(ctx, 'helmet', v.pos.x - Math.cos(info.dir) * 10, v.pos.y - Math.sin(info.dir) * 10, v.pos.x, v.pos.y, v.id);
  }
  addGore(ctx, v.pos.x, v.pos.y);
  ctx.diedThisTick.push(vi);
}

// ---------------------------------------------------------------------------------------------
// Barks
// ---------------------------------------------------------------------------------------------

/**
 * Maybe say one of the strategy's lines for `kind`. Every kind, kill and death included, waits
 * out the per-fighter BARK_RULES.cooldownTicks; hit and taunt lines also respect a global gap.
 */
export function bark(ctx: SimCtx, rt: FighterRt, kind: BarkKind): void {
  const lines = rt.barks[kind];
  if (!lines) return;
  const tick = ctx.state.tick;
  if (tick - rt.lastBarkTick < BARK_RULES.cooldownTicks) return;
  const chatter = kind === 'hit' || kind === 'taunt';
  if (chatter && tick - ctx.lastChatterTick < CHATTER_GAP_TICKS) return;
  if (!ctx.barkRng.chance(BARK_RULES.chance[kind])) return;
  say(ctx, rt, kind, ctx.barkRng.pick(lines), chatter);
}

/** Emit a bark (no chance roll). Text is cut to BARK_RULES.maxLength. */
export function say(ctx: SimCtx, rt: FighterRt, kind: BarkKind, text: string, chatter: boolean): void {
  const tick = ctx.state.tick;
  ctx.events.push({ type: 'bark', tick, fighterId: rt.f.id, kind, text: text.slice(0, BARK_RULES.maxLength) });
  rt.lastBarkTick = tick;
  if (chatter) ctx.lastChatterTick = tick;
}

// ---------------------------------------------------------------------------------------------
// Gore, floor items, props
// ---------------------------------------------------------------------------------------------

export function addGore(ctx: SimCtx, x: number, y: number): void {
  const k = ctx.goreNext;
  ctx.gore[k * 2] = x;
  ctx.gore[k * 2 + 1] = y;
  ctx.goreNext = (k + 1) % GORE_SPOTS;
  if (ctx.goreCount < GORE_SPOTS) ctx.goreCount++;
}

/**
 * Put an item on the floor at (x, y), or at the fallback point when (x, y) is inside a wall, and
 * return its id. Cosmetic items (helmets, weapons) beyond MAX_COSMETIC_ITEMS replace the oldest one.
 */
export function dropItem(ctx: SimCtx, kind: FloorItemKind, x: number, y: number, fx: number, fy: number, ownerId: string | null): string {
  if (circleBlocked(ctx.geo, x, y, ITEM_RADIUS)) {
    x = fx;
    y = fy;
  }
  const floor = ctx.state.floor;
  if (kind === 'weapon' || kind === 'helmet') {
    let cosmetic = 0;
    let oldest = -1;
    for (let i = 0; i < floor.length; i++) {
      const k = floor[i]!.kind;
      if (k === 'weapon' || k === 'helmet') {
        cosmetic++;
        if (oldest < 0) oldest = i;
      }
    }
    if (cosmetic >= MAX_COSMETIC_ITEMS && oldest >= 0) floor.splice(oldest, 1);
  }
  const id = `i${ctx.nextId++}`;
  floor.push({ id, kind, pos: { x, y }, ownerId });
  return id;
}

/** Damage prop `pi`. A broken keg or amphora is queued; `resolveBreaks` makes it go off. */
export function damageProp(ctx: SimCtx, pi: number, amount: number, by: number): void {
  const p = ctx.state.props[pi]!;
  if (!p.alive || amount <= 0) return;
  p.hp -= amount;
  if (p.hp > 0) return;
  p.hp = 0;
  p.alive = false;
  ctx.events.push({ type: 'prop_break', tick: ctx.state.tick, propId: p.id, kind: p.kind, pos: { x: p.pos.x, y: p.pos.y } });
  const rule = PROP_RULES[p.kind];
  if (rule.blastDamage > 0 || rule.spills) ctx.breakQueue.push({ prop: pi, by });
}
