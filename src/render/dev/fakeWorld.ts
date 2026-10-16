/**
 * Dev-only fake world for the render harness: fighters wander, chase, wind up and strike, shoot,
 * get hit, lose limbs, die and respawn, and emit the same GameEvents the sim would, so the look of
 * the renderer and fx can be judged without the real simulation. Not deterministic, not gameplay:
 * cosmetic motion only (Math.random is fine here, this never runs in the sim).
 *
 * Arrows and axes stick like the contract says (`StuckAmmo`): in walls, props and bodies (riding
 * along in the body frame), now and then point-first in the floor; a body's ammo drops when it dies,
 * a prop's when it breaks, and a fighter takes stuck ammo back by touching its pickup point.
 *
 * It also keeps a rough knowledge list per fighter in the shape the sim gives (seen in the cone
 * with line of sight, heard as a fuzzy estimate, remembered for a while), so the fog, ghost markers
 * and hearing ripples can be judged too.
 */

import {
  STUCK_AMMO, FIGHTER_COLORS, HAZARD_RULES, MATCH_RULES, PERCEPTION, PICKUP_RULES, PROP_RULES, SKILL_IDS, WEAPONS, WEAPON_IDS, attackCooldown, circleHitsRect,
  fighterRadius, hearingRadius, initialSuddenDeathState, maxHp, moveSpeed, projectileSpeed, projectileTtl, segmentHitsRect, turnPerTick,
  visionFov, visionRange, wrapAngle, zoneBoundsAfter,
} from '../../core';
import type {
  AmmoKind, Attributes, Decision, FighterState, GameEvent, KnownFighter, Limb, MapDef, ProjectileState, Rect, SkillId, StuckAmmo, StuckIn,
  WeaponId, WorldState,
} from '../../core';

const NAMES = [
  'Apologetic Gary', 'Brenda the Unkind', 'Doug', 'Sir Stabsworth', 'Mildred Ninefingers', 'Big Kev', 'Lurking Lou',
  'Tim the Unready', 'Auntie Carnage', 'Polite Steve', 'The Accountant', 'Grandma Axe', 'Wet Nigel', 'Lady Bruise',
  'Kevin Again', 'Professor Ouch',
];

const LIMBS: Limb[] = ['armL', 'armR', 'legL', 'legR'];

function randomAttributes(): Attributes {
  const keys: (keyof Attributes)[] = ['vitality', 'power', 'agility', 'perception', 'armor', 'haste'];
  const a: Attributes = { vitality: 4, power: 4, agility: 4, perception: 4, armor: 4, haste: 4 };
  let left = 100 - 24;
  while (left > 0) {
    const k = keys[Math.floor(Math.random() * keys.length)]!;
    if (a[k] >= 40) continue;
    a[k]++;
    left--;
  }
  return a;
}

type Brainless = { targetIdx: number; wander: number; think: number; heading: number; hitStop: number };

export class FakeWorld {
  state: WorldState;
  prev: WorldState;
  readonly map: MapDef;
  private brains: Brainless[] = [];
  private nextId = 1;
  private blockers: Rect[];
  private roundOverAt = -1;
  private decisions = new Map<string, Decision>();
  private known = new Map<string, Map<string, KnownFighter>>();

  constructor(map: MapDef, count: number) {
    this.map = map;
    this.blockers = [...map.walls, ...map.pillars];
    this.state = this.freshState(count);
    this.prev = structuredClone(this.state);
  }

  decision(id: string): Decision | null {
    return this.decisions.get(id) ?? null;
  }

  /** The fighter's enemy records, like `Match.knowledge`. */
  knowledge(id: string): readonly KnownFighter[] {
    const m = this.known.get(id);
    return m ? [...m.values()] : [];
  }

  private freshState(count: number): WorldState {
    const fighters: FighterState[] = [];
    const spawns = this.map.spawns;
    this.brains = [];
    for (let i = 0; i < count; i++) {
      const weapon: WeaponId = WEAPON_IDS[i % WEAPON_IDS.length]!;
      const attributes = randomAttributes();
      const sp = spawns[Math.floor((i * spawns.length) / count) % spawns.length] ?? { x: 300 + i * 40, y: 300 };
      const facing = Math.atan2(this.map.height / 2 - sp.y, this.map.width / 2 - sp.x);
      const hp = maxHp(attributes);
      const w = WEAPONS[weapon];
      fighters.push({
        id: `f${i}`, entrantId: `e${i}`, squad: i, name: NAMES[i % NAMES.length]!, color: FIGHTER_COLORS[i % FIGHTER_COLORS.length]!,
        weapon, skill: SKILL_IDS[i % SKILL_IDS.length]!, attributes,
        pos: { x: sp.x, y: sp.y }, vel: { x: 0, y: 0 }, facing, headAngle: facing, radius: fighterRadius(attributes),
        hp, maxHp: hp, alive: true, diedAtTick: null, anim: { phase: 'idle', t: 0, dur: 0 }, walkPhase: Math.random() * 6,
        attackCd: 30 + Math.floor(Math.random() * 60), skillCd: 200, parryTicks: 0, parryCd: 0, stunTicks: 0,
        ammo: w.ammo, maxAmmo: w.ammo, buffs: { haste: 0, berserk: 0, slow: 0 },
        limbs: { armL: true, armR: true, legL: true, legR: true }, helmet: true, inShadow: false, seen: false,
        stance: 'normal', hitFlash: 0, eyePop: 0, behaviour: 'brawl', targetId: null, kills: 0, damageDealt: 0, damageTaken: 0,
        lastHitBy: null, lastHitTick: null, place: null,
      });
      this.brains.push({ targetIdx: -1, wander: Math.random() * 6, think: i % 6, heading: facing, hitStop: 0 });
    }
    return {
      tick: 0, mapId: this.map.id, fighters, projectiles: [], floor: [],
      props: this.map.props.map((p) => ({ ...p, alive: true, hp: PROP_RULES[p.kind].hp })),
      hazards: this.map.hazards.map((h) => ({ ...h, phase: 0, active: false, pos: { ...h.pos }, ttl: null })),
      shrines: this.map.shrines.map((s) => ({ ...s, cooldown: 0 })),
      stuck: [] as StuckAmmo[],
      pickups: this.map.pickups.map((p) => ({ ...p, cooldown: PICKUP_RULES[p.kind].firstSpawnTicks })),
      suddenDeath: initialSuddenDeathState(this.map), finished: false, ending: null, placements: [],
    };
  }

  restart(count: number): void {
    this.state = this.freshState(count);
    this.prev = structuredClone(this.state);
    this.roundOverAt = -1;
    this.known.clear();
  }

  /** Advance one tick; returns the events of that tick. */
  step(): GameEvent[] {
    this.prev = structuredClone(this.state);
    const s = this.state;
    const ev: GameEvent[] = [];
    s.tick++;
    const tick = s.tick;

    this.stepHazards();
    for (const sh of s.shrines) sh.cooldown = Math.max(0, sh.cooldown - 1);
    for (const p of s.pickups) {
      if (p.cooldown <= 0) continue;
      p.cooldown--;
      if (p.cooldown === 0) ev.push({ tick, type: 'pickup_spawn', pickupId: p.id, kind: p.kind, pos: { ...p.pos } });
    }
    this.stepWall(ev);
    if (tick % 6 === 0) this.perceive();

    s.fighters.forEach((f, i) => {
      if (!f.alive) return;
      this.stepFighter(f, i, ev);
    });
    this.stepProjectiles(ev);
    this.stepStuck(ev);
    this.acidBurn(ev);

    const alive = s.fighters.filter((f) => f.alive).length;
    // Long enough for the winner's moment and a few seconds of end card (the harness sends them).
    if (alive <= 1 && this.roundOverAt < 0) this.roundOverAt = tick + 600;
    if (this.roundOverAt >= 0 && tick >= this.roundOverAt) {
      const count = s.fighters.length;
      this.restart(count);
      return [];
    }
    for (const e of ev) e.tick = tick;
    return ev;
  }

  private stepHazards(): void {
    const s = this.state;
    for (const h of s.hazards) {
      if (h.kind === 'spike') {
        const period = h.period ?? 165;
        h.phase = ((s.tick + h.pos.x) % period) / period;
        h.active = h.phase >= 0.88 && h.phase < 0.98;
      } else if (h.kind === 'saw' && h.path && h.path.length > 1) {
        const total = h.path.length;
        const t = (s.tick * 0.006 + h.pos.y * 0.001) % total;
        const a = h.path[Math.floor(t)]!;
        const b = h.path[(Math.floor(t) + 1) % total]!;
        const f = t - Math.floor(t);
        h.pos.x = a.x + (b.x - a.x) * f;
        h.pos.y = a.y + (b.y - a.y) * f;
        h.active = true;
      } else {
        h.active = true;
      }
    }
    // Spilled acid dries up.
    for (const h of s.hazards) if (h.ttl !== null) h.ttl--;
    s.hazards = s.hazards.filter((h) => h.ttl === null || h.ttl > 0);
  }

  /** Acid hurts whoever stands in it (like the sim: radius + 30% of the body, every 24 ticks). */
  private acidBurn(ev: GameEvent[]): void {
    const s = this.state;
    const rule = HAZARD_RULES.acid;
    if (s.tick % rule.intervalTicks !== 0) return;
    for (const h of s.hazards) {
      if (h.kind !== 'acid') continue;
      for (const f of s.fighters) {
        if (!f.alive) continue;
        const d = Math.hypot(f.pos.x - h.pos.x, f.pos.y - h.pos.y);
        if (d < h.radius + f.radius * 0.3) {
          this.damage(f, null, rule.damage, Math.atan2(f.pos.y - h.pos.y, f.pos.x - h.pos.x), false, 1, ev);
          ev.push({ tick: s.tick, type: 'hazard', hazardId: h.id, victimId: f.id, pos: { ...f.pos } });
          f.buffs.slow = Math.max(f.buffs.slow, 40);
        }
      }
    }
  }

  private stepFighter(f: FighterState, i: number, ev: GameEvent[]): void {
    const s = this.state;
    const br = this.brains[i]!;
    f.hitFlash = Math.max(0, f.hitFlash - 1);
    f.eyePop = Math.max(0, f.eyePop - 1);
    f.stunTicks = Math.max(0, f.stunTicks - 1);
    f.parryTicks = Math.max(0, f.parryTicks - 1);
    f.attackCd = Math.max(0, f.attackCd - 1);
    f.skillCd = Math.max(0, f.skillCd - 1);
    f.buffs.haste = Math.max(0, f.buffs.haste - 1);
    f.buffs.berserk = Math.max(0, f.buffs.berserk - 1);
    f.buffs.slow = Math.max(0, f.buffs.slow - 1);
    const w = WEAPONS[f.weapon];

    // Think every 6 ticks: pick the nearest living enemy.
    if (br.think-- <= 0) {
      br.think = 6;
      let best = -1;
      let bestD = Infinity;
      s.fighters.forEach((o, j) => {
        if (j === i || !o.alive) return;
        const d = Math.hypot(o.pos.x - f.pos.x, o.pos.y - f.pos.y);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      });
      br.targetIdx = best;
      f.targetId = best >= 0 ? s.fighters[best]!.id : null;
      if (Math.random() < 0.03) f.stance = f.stance === 'normal' ? (w.shield ? 'guard' : 'creep') : 'normal';
      if (Math.random() < 0.01 && f.skillCd === 0) {
        const skill: SkillId = f.skill;
        ev.push({ tick: this.state.tick, type: 'skill', fighterId: f.id, skill, pos: { ...f.pos } });
        f.skillCd = 260;
        if (skill === 'BLOODRAGE') f.buffs.berserk = 145;
        if (skill === 'DASH') f.buffs.haste = 65;
        if (skill === 'SHOCKWAVE') f.parryTicks = 48;
      }
    }
    const target = br.targetIdx >= 0 ? s.fighters[br.targetIdx] : undefined;

    // Animation phases.
    const a = f.anim;
    a.t++;
    if (a.phase !== 'idle' && a.t >= a.dur) {
      if (a.phase === 'windup') {
        f.anim = { phase: 'strike', t: 0, dur: w.strike };
        this.resolveStrike(f, target, ev);
      } else if (a.phase === 'strike') {
        f.anim = { phase: 'recovery', t: 0, dur: w.recovery };
      } else {
        f.anim = { phase: 'idle', t: 0, dur: 0 };
      }
    }

    let desired = br.heading;
    let throttle = 0.6;
    if (target) {
      const dx = target.pos.x - f.pos.x;
      const dy = target.pos.y - f.pos.y;
      const d = Math.hypot(dx, dy);
      const toT = Math.atan2(dy, dx);
      const reach = w.family === 'melee' ? w.range + target.radius - 6 : w.range * 0.8;
      if (w.family === 'ranged' && d < w.range * 0.4) {
        desired = toT + Math.PI + Math.sin(s.tick * 0.02 + i) * 0.6;
        throttle = 1;
      } else if (d > reach) {
        desired = toT + Math.sin(s.tick * 0.015 + i) * 0.35;
        throttle = 1;
      } else {
        desired = toT + Math.PI / 2;
        throttle = 0.25;
        const canShoot = w.family === 'melee' || f.ammo > 0 || f.weapon === 'ARCANE_STAFF';
        if (f.anim.phase === 'idle' && f.attackCd === 0 && f.stunTicks === 0 && canShoot) {
          f.anim = { phase: 'windup', t: 0, dur: w.windup };
          f.attackCd = attackCooldown(f.attributes, f.weapon) + w.windup;
          ev.push({ tick: this.state.tick, type: 'swing', fighterId: f.id, weapon: f.weapon });
        }
      }
      // Face the target while fighting, else the way we walk.
      const faceTo = d < w.range * 1.4 ? toT : desired;
      f.facing = stepToward(f.facing, faceTo, turnPerTick(f.attributes, f.weapon) * 1.5);
      f.headAngle = stepToward(f.headAngle, toT + Math.sin(s.tick * 0.05 + i) * 0.25, 0.12);
    } else {
      br.wander += (Math.random() - 0.5) * 0.2;
      desired = br.wander;
      f.facing = stepToward(f.facing, desired, 0.08);
      f.headAngle = stepToward(f.headAngle, f.facing + Math.sin(s.tick * 0.04 + i) * 0.9, 0.1);
    }
    br.heading = stepToward(br.heading, desired, 0.15);
    if (f.weapon === 'ARCANE_STAFF' && f.ammo < f.maxAmmo && s.tick % 90 === 0) f.ammo++;

    let speed = moveSpeed(f.attributes, f.weapon) * throttle;
    if (f.stance === 'creep') speed *= 0.55;
    if (f.stance === 'guard') speed *= 0.7;
    if (f.buffs.haste > 0) speed *= 1.45;
    if (f.buffs.slow > 0) speed *= 0.6;
    if (!f.limbs.legL || !f.limbs.legR) speed *= 0.55;
    if (f.stunTicks > 0) speed = 0;
    // Knockback decays into the walking velocity.
    const kx = f.vel.x * 0.82 + Math.cos(br.heading) * speed * 0.18;
    const ky = f.vel.y * 0.82 + Math.sin(br.heading) * speed * 0.18;
    f.vel.x = kx;
    f.vel.y = ky;
    this.moveBody(f);
    const moved = Math.hypot(f.vel.x, f.vel.y);
    const before = f.walkPhase;
    f.walkPhase += moved * 0.22;
    if (Math.floor(f.walkPhase / Math.PI) !== Math.floor(before / Math.PI)) {
      ev.push({ tick: this.state.tick, type: 'footstep', fighterId: f.id, pos: { ...f.pos }, bloody: f.hp < f.maxHp * 0.5 });
    }
    f.inShadow = this.lightAt(f.pos.x, f.pos.y) < 0.35;
    f.behaviour = target ? (f.anim.phase === 'idle' ? 'stalk' : 'brawl') : 'wander';

    // Fake decision for the steering ring overlay.
    const ring: number[] = [];
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * Math.PI * 2;
      ring.push(Math.cos(wrapAngle(ang - br.heading)) * 0.9 - (this.wallNear(f, ang) ? 0.8 : 0));
    }
    this.decisions.set(f.id, {
      behaviour: f.behaviour, scores: { brawl: 0.7, stalk: 0.5, wander: 0.1 }, targetId: f.targetId, heading: br.heading,
      speed: throttle, ring, terms: [], attack: true, parry: true, useSkill: false, stance: f.stance, sensors: {}, guardTrips: [],
    });

    // Shrines and pickups.
    for (const sh of s.shrines) {
      if (sh.cooldown === 0 && f.hp < f.maxHp * 0.6 && Math.hypot(sh.pos.x - f.pos.x, sh.pos.y - f.pos.y) < 34 + f.radius) {
        const amount = Math.round(f.maxHp * 0.42);
        f.hp = Math.min(f.maxHp, f.hp + amount);
        sh.cooldown = 320;
        ev.push({ tick: this.state.tick, type: 'heal', fighterId: f.id, amount, pos: { ...sh.pos }, shrineId: sh.id });
      }
    }
    for (const p of s.pickups) {
      if (p.cooldown === 0 && Math.hypot(p.pos.x - f.pos.x, p.pos.y - f.pos.y) < 30 + f.radius) {
        p.cooldown = PICKUP_RULES[p.kind].cooldownTicks;
        if (p.kind === 'haste') f.buffs.haste = 200;
        else f.buffs.berserk = 200;
        ev.push({ tick: this.state.tick, type: 'pickup', fighterId: f.id, kind: p.kind, pos: { ...p.pos } });
      }
    }
    // Pick spent ammo back up.
    s.floor = s.floor.filter((it) => {
      const mine = (it.kind === 'arrow' && f.weapon === 'LONGBOW') || (it.kind === 'axe' && f.weapon === 'THROWING_AXES');
      if (mine && f.ammo < f.maxAmmo && Math.hypot(it.pos.x - f.pos.x, it.pos.y - f.pos.y) < f.radius + 10) {
        f.ammo++;
        return false;
      }
      return true;
    });
  }

  private resolveStrike(f: FighterState, target: FighterState | undefined, ev: GameEvent[]): void {
    const w = WEAPONS[f.weapon];
    if (w.family === 'ranged') {
      if (f.weapon !== 'ARCANE_STAFF' && f.ammo <= 0) return;
      f.ammo = Math.max(0, f.ammo - 1);
      const dir = target ? Math.atan2(target.pos.y - f.pos.y, target.pos.x - f.pos.x) : f.facing;
      const sp = projectileSpeed(f.weapon);
      const p: ProjectileState = {
        id: `p${this.nextId++}`, ownerId: f.id, weapon: f.weapon,
        pos: { x: f.pos.x + Math.cos(dir) * (f.radius + 8), y: f.pos.y + Math.sin(dir) * (f.radius + 8) },
        vel: { x: Math.cos(dir) * sp, y: Math.sin(dir) * sp }, ttl: projectileTtl(f.weapon),
        origin: { x: f.pos.x + Math.cos(dir) * (f.radius + 8), y: f.pos.y + Math.sin(dir) * (f.radius + 8) },
      };
      this.state.projectiles.push(p);
      ev.push({ tick: this.state.tick, type: 'projectile', projectileId: p.id, ownerId: f.id, weapon: f.weapon, pos: { ...p.pos }, dir });
      return;
    }
    if (!target || !target.alive) return;
    const d = Math.hypot(target.pos.x - f.pos.x, target.pos.y - f.pos.y);
    if (d - target.radius > w.range) return;
    if (target.parryTicks > 0 || (Math.random() < 0.12 && target.parryCd === 0)) {
      target.parryTicks = Math.max(target.parryTicks, 20);
      target.parryCd = 135;
      f.stunTicks = 40;
      ev.push({ tick: this.state.tick, type: 'parry', fighterId: target.id, attackerId: f.id, pos: { x: (f.pos.x + target.pos.x) / 2, y: (f.pos.y + target.pos.y) / 2 } });
      return;
    }
    const crit = Math.random() < 0.2;
    const amount = Math.round(w.damage * (crit ? 1.35 : 1) * (f.buffs.berserk > 0 ? 1.35 : 1) * (0.8 + Math.random() * 0.4));
    this.damage(target, f, amount, Math.atan2(target.pos.y - f.pos.y, target.pos.x - f.pos.x), crit, w.knockback, ev);
    if (w.stunTicks > 0) target.stunTicks = w.stunTicks;
  }

  private damage(v: FighterState, by: FighterState | null, amount: number, dir: number, crit: boolean, knockback: number, ev: GameEvent[]): void {
    if (!v.alive) return;
    v.hp -= amount;
    v.hitFlash = 6;
    if (crit || amount > 26) v.eyePop = 18;
    v.vel.x += Math.cos(dir) * knockback * 0.55;
    v.vel.y += Math.sin(dir) * knockback * 0.55;
    v.lastHitBy = by?.id ?? null;
    v.lastHitTick = this.state.tick;
    if (by) by.damageDealt += amount;
    v.damageTaken += amount;
    if (crit && v.helmet && Math.random() < 0.5) {
      v.helmet = false;
      this.state.floor.push({ id: `i${this.nextId++}`, kind: 'helmet', pos: { x: v.pos.x + Math.cos(dir) * 30, y: v.pos.y + Math.sin(dir) * 30 }, ownerId: v.id });
    }
    ev.push({
      tick: this.state.tick, type: 'hit', attackerId: by?.id ?? null, victimId: v.id, amount, pos: { ...v.pos }, dir, crit, backstab: false,
      weapon: by?.weapon ?? null, knockback, source: by ? 'weapon' : 'hazard',
    });
    if (v.hp > 0 && amount >= 18 && v.hp < v.maxHp * 0.5 && Math.random() < 0.35) {
      const attached = LIMBS.filter((l) => v.limbs[l]);
      const limb = attached[Math.floor(Math.random() * attached.length)];
      if (limb) {
        v.limbs[limb] = false;
        ev.push({ tick: this.state.tick, type: 'dismember', attackerId: by?.id ?? null, victimId: v.id, limb, pos: { ...v.pos }, vel: { x: Math.cos(dir) * 5, y: Math.sin(dir) * 5 } });
      }
    }
    if (v.hp <= 0) {
      v.hp = 0;
      v.alive = false;
      v.diedAtTick = this.state.tick;
      if (by) by.kills++;
      const titles = crit ? ['SPLIT', 'CRUNCH'] : ['FLATTENED', 'DONE', 'OUCH'];
      ev.push({
        tick: this.state.tick, type: 'kill', killerId: by?.id ?? null, victimId: v.id, cause: by ? 'weapon' : 'hazard', pos: { ...v.pos }, dir,
        title: titles[Math.floor(Math.random() * titles.length)]!, killerBehaviour: by?.behaviour ?? null, victimBehaviour: v.behaviour,
        weapon: by?.weapon ?? null, flags: crit ? ['crit'] : [], hazard: by ? null : 'spike',
        final: this.state.fighters.filter((x) => x.alive).length === 1,
      });
      this.state.floor.push({ id: `i${this.nextId++}`, kind: 'weapon', pos: { x: v.pos.x + 12, y: v.pos.y + 6 }, ownerId: v.id });
    }
  }

  private stepProjectiles(ev: GameEvent[]): void {
    const s = this.state;
    const keep: ProjectileState[] = [];
    for (const p of s.projectiles) {
      p.pos.x += p.vel.x;
      p.pos.y += p.vel.y;
      p.ttl--;
      let hitId: string | null = null;
      for (const f of s.fighters) {
        if (!f.alive || f.id === p.ownerId) continue;
        if (Math.hypot(f.pos.x - p.pos.x, f.pos.y - p.pos.y) < f.radius + 4) {
          hitId = f.id;
          const owner = s.fighters.find((o) => o.id === p.ownerId) ?? null;
          const w = WEAPONS[p.weapon];
          this.damage(f, owner, w.damage, Math.atan2(p.vel.y, p.vel.x), Math.random() < 0.15, w.knockback, ev);
          if (p.weapon === 'LONGBOW') f.buffs.slow = 75;
          break;
        }
      }
      const blocked = this.blockers.some((r) => circleHitsRect(p.pos, 3, r));
      const prop = hitId || blocked ? undefined : s.props.find((o) => o.alive && Math.hypot(o.pos.x - p.pos.x, o.pos.y - p.pos.y) < o.radius + 2);
      if (hitId || blocked || prop || p.ttl <= 0) {
        ev.push({ tick: this.state.tick, type: 'projectile_end', projectileId: p.id, pos: { ...p.pos }, hitId });
        if (p.weapon === 'ARCANE_STAFF') ev.push({ tick: this.state.tick, type: 'explosion', pos: { ...p.pos }, radius: 72 });
        else this.stick(p, hitId, blocked, prop?.id ?? null, ev);
        continue;
      }
      keep.push(p);
    }
    s.projectiles = keep;
  }

  /** An arrow or axe ends its flight: it sticks in what it hit (or lies on the floor), like the sim. */
  private stick(p: ProjectileState, hitId: string | null, wall: boolean, propId: string | null, ev: GameEvent[]): void {
    const s = this.state;
    const kind: AmmoKind = p.weapon === 'LONGBOW' ? 'arrow' : 'axe';
    const angle = Math.atan2(p.vel.y, p.vel.x);
    const c = Math.cos(angle);
    const n = Math.sin(angle);
    const tip = { x: p.pos.x, y: p.pos.y };
    let into: StuckIn;
    let pickupPos: { x: number; y: number } | null = null;
    const victim = hitId ? s.fighters.find((f) => f.id === hitId) : undefined;
    if (victim) {
      if (s.stuck.filter((x) => x.in.kind === 'fighter' && x.in.fighterId === victim.id).length >= STUCK_AMMO.maxPerBody) {
        this.toFloor(kind, p.ownerId, { x: victim.pos.x - c * 10, y: victim.pos.y - n * 10 });
        return;
      }
      // Tip on the body's edge where the shot came in, kept in the body frame.
      const rx = p.pos.x - p.vel.x - victim.pos.x;
      const ry = p.pos.y - p.vel.y - victim.pos.y;
      const d = Math.hypot(rx, ry) || 1;
      const ex = (rx / d) * victim.radius * 0.8;
      const ey = (ry / d) * victim.radius * 0.8;
      const fc = Math.cos(victim.facing);
      const fs = Math.sin(victim.facing);
      tip.x = victim.pos.x + ex;
      tip.y = victim.pos.y + ey;
      into = { kind: 'fighter', fighterId: victim.id, u: ex * fc + ey * fs, v: -ex * fs + ey * fc, turn: wrapAngle(angle - victim.facing) };
    } else if (wall || propId) {
      // Back out of the wall or prop to its surface.
      for (let k = 0; k < 12; k++) {
        const inside = propId
          ? s.props.some((o) => o.id === propId && Math.hypot(o.pos.x - tip.x, o.pos.y - tip.y) < o.radius)
          : this.blockers.some((r) => circleHitsRect(tip, 0.5, r));
        if (!inside) break;
        tip.x -= c * 2;
        tip.y -= n * 2;
      }
      into = propId ? { kind: 'prop', propId } : { kind: 'wall' };
      pickupPos = { x: tip.x - c * STUCK_AMMO.pickupOffset, y: tip.y - n * STUCK_AMMO.pickupOffset };
    } else if (Math.random() < 0.35) {
      into = { kind: 'floor' };
      pickupPos = { ...tip };
    } else {
      this.toFloor(kind, p.ownerId, { x: p.pos.x - p.vel.x, y: p.pos.y - p.vel.y });
      return;
    }
    const st: StuckAmmo = { id: `s${this.nextId++}`, kind, ownerId: p.ownerId, pos: tip, angle, in: into, pickupPos, tick: s.tick };
    s.stuck.push(st);
    ev.push({ tick: s.tick, type: 'ammo_stick', stuckId: st.id, projectileId: p.id, kind, ownerId: p.ownerId, pos: { ...tip }, angle, in: { ...into } });
  }

  private toFloor(kind: AmmoKind, ownerId: string | null, pos: { x: number; y: number }): string {
    const id = `i${this.nextId++}`;
    this.state.floor.push({ id, kind, pos, ownerId });
    return id;
  }

  /** Ammo in bodies follows them; a dead body or a broken prop drops its ammo; fighters pull ammo out. */
  private stepStuck(ev: GameEvent[]): void {
    const s = this.state;
    const keep: StuckAmmo[] = [];
    for (const a of s.stuck) {
      const holder = a.in.kind === 'fighter' ? s.fighters.find((f) => f.id === (a.in as { fighterId: string }).fighterId) : undefined;
      const prop = a.in.kind === 'prop' ? s.props.find((o) => o.id === (a.in as { propId: string }).propId) : undefined;
      if (a.in.kind === 'fighter' && holder) {
        const fc = Math.cos(holder.facing);
        const fs = Math.sin(holder.facing);
        a.pos.x = holder.pos.x + a.in.u * fc - a.in.v * fs;
        a.pos.y = holder.pos.y + a.in.u * fs + a.in.v * fc;
        a.angle = holder.facing + a.in.turn;
      }
      if ((holder && !holder.alive) || (prop && !prop.alive)) {
        const r = Math.random() * STUCK_AMMO.bodyDropScatter;
        const t = Math.random() * Math.PI * 2;
        const at = { x: a.pos.x + Math.cos(t) * r, y: a.pos.y + Math.sin(t) * r };
        const itemId = this.toFloor(a.kind, a.ownerId, at);
        ev.push({ tick: s.tick, type: 'ammo_unstick', stuckId: a.id, kind: a.kind, pos: { ...at }, reason: 'drop', fighterId: null, floorItemId: itemId });
        continue;
      }
      if (a.pickupPos) {
        const taker = s.fighters.find((f) => f.alive && f.ammo < f.maxAmmo && (a.kind === 'arrow' ? f.weapon === 'LONGBOW' : f.weapon === 'THROWING_AXES')
          && Math.hypot(f.pos.x - a.pickupPos!.x, f.pos.y - a.pickupPos!.y) < f.radius + STUCK_AMMO.pickupSlack);
        if (taker) {
          taker.ammo++;
          ev.push({ tick: s.tick, type: 'ammo_unstick', stuckId: a.id, kind: a.kind, pos: { ...a.pos }, reason: 'pickup', fighterId: taker.id, floorItemId: null });
          ev.push({ tick: s.tick, type: 'pickup', fighterId: taker.id, kind: a.kind, pos: { ...a.pos } });
          continue;
        }
      }
      keep.push(a);
    }
    s.stuck = keep;
  }

  private moveBody(f: FighterState): void {
    const nx = f.pos.x + f.vel.x;
    const ny = f.pos.y + f.vel.y;
    if (!this.blocked(nx, ny, f.radius)) {
      f.pos.x = nx;
      f.pos.y = ny;
    } else if (!this.blocked(nx, f.pos.y, f.radius)) {
      f.pos.x = nx;
      f.vel.y = 0;
    } else if (!this.blocked(f.pos.x, ny, f.radius)) {
      f.pos.y = ny;
      f.vel.x = 0;
    } else {
      f.vel.x = 0;
      f.vel.y = 0;
      this.brains[this.state.fighters.indexOf(f)]!.wander += 1.5;
    }
  }

  private blocked(x: number, y: number, r: number): boolean {
    const c = { x, y };
    return this.blockers.some((b) => circleHitsRect(c, r, b));
  }

  private wallNear(f: FighterState, ang: number): boolean {
    return this.blocked(f.pos.x + Math.cos(ang) * 40, f.pos.y + Math.sin(ang) * 40, f.radius * 0.6);
  }

  /** Rough light estimate (no occlusion) for the fake `inShadow` flag. */
  private lightAt(x: number, y: number): number {
    let sum = this.map.ambient;
    for (const l of this.map.lights) {
      const d = Math.hypot(x - l.pos.x, y - l.pos.y);
      if (d < l.radius) {
        const t = 1 - d / l.radius;
        sum += l.intensity * t * t * (3 - 2 * t);
      }
    }
    return sum;
  }

  // ------------------------------------------------------------------------------------------
  // Harness actions
  // ------------------------------------------------------------------------------------------

  /** Kill a random living fighter (tests the kill punch and fx gore). */
  killRandom(): GameEvent[] {
    const living = this.state.fighters.filter((f) => f.alive);
    const v = living[Math.floor(Math.random() * living.length)];
    if (!v) return [];
    const by = living.find((f) => f !== v) ?? null;
    const ev: GameEvent[] = [];
    this.damage(v, by, v.hp + 10, Math.random() * Math.PI * 2, true, 12, ev);
    for (const e of ev) e.tick = this.state.tick;
    return ev;
  }

  /** Blow up a random keg. */
  explodeKeg(): GameEvent[] {
    const kegs = this.state.props.filter((p) => p.alive && p.kind === 'keg');
    const k = kegs[Math.floor(Math.random() * kegs.length)];
    if (!k) return [];
    k.alive = false;
    const ev: GameEvent[] = [
      { tick: this.state.tick, type: 'prop_break', propId: k.id, kind: 'keg', pos: { ...k.pos } },
      { tick: this.state.tick, type: 'explosion', pos: { ...k.pos }, radius: 106 },
    ];
    for (const f of this.state.fighters) {
      if (!f.alive) continue;
      const d = Math.hypot(f.pos.x - k.pos.x, f.pos.y - k.pos.y);
      if (d < 106) this.damage(f, null, 38, Math.atan2(f.pos.y - k.pos.y, f.pos.x - k.pos.x), false, 20, ev);
    }
    for (const e of ev) e.tick = this.state.tick;
    return ev;
  }

  /** Shatter a random amphora into an acid pool (or pour one at a random fighter when none are left). */
  spillAcid(): GameEvent[] {
    const s = this.state;
    const amphoras = s.props.filter((p) => p.alive && p.kind === 'amphora');
    const a = amphoras[Math.floor(Math.random() * amphoras.length)];
    const living = s.fighters.filter((f) => f.alive);
    const at = a ? { ...a.pos } : living.length ? { ...living[Math.floor(Math.random() * living.length)]!.pos } : { x: 680, y: 430 };
    const ev: GameEvent[] = [];
    if (a) {
      a.alive = false;
      ev.push({ tick: s.tick, type: 'prop_break', propId: a.id, kind: 'amphora', pos: { ...a.pos } });
    }
    const rule = HAZARD_RULES.acid;
    s.hazards.push({ id: `acid-${this.nextId++}`, kind: 'acid', pos: at, radius: rule.radius, phase: 0, active: true, ttl: rule.durationTicks });
    return ev;
  }

  /** Shove up to `n` living fighters into the newest acid pool (to judge the soaked look). */
  dunk(n = 2): void {
    const pool = [...this.state.hazards].reverse().find((h) => h.kind === 'acid');
    if (!pool) return;
    const living = this.state.fighters.filter((f) => f.alive).slice(0, n);
    living.forEach((f, k) => {
      const a = (k / Math.max(1, living.length)) * Math.PI * 2;
      f.pos.x = pool.pos.x + Math.cos(a) * pool.radius * 0.35;
      f.pos.y = pool.pos.y + Math.sin(a) * pool.radius * 0.35;
      f.vel.x = 0;
      f.vel.y = 0;
    });
  }

  /** The fighter nearest the shrine drinks from it (heal event with the shrine's id, cooldown starts). */
  shrineHeal(): GameEvent[] {
    const s = this.state;
    const sh = s.shrines[0];
    const living = s.fighters.filter((f) => f.alive);
    if (!sh || living.length === 0) return [];
    const f = living.reduce((a, b) => (Math.hypot(a.pos.x - sh.pos.x, a.pos.y - sh.pos.y) < Math.hypot(b.pos.x - sh.pos.x, b.pos.y - sh.pos.y) ? a : b));
    const amount = Math.round(f.maxHp * 0.42);
    f.hp = Math.min(f.maxHp, f.hp + amount);
    sh.cooldown = PICKUP_RULES.shrine.cooldownTicks;
    return [{ tick: s.tick, type: 'heal', fighterId: f.id, amount, pos: { ...sh.pos }, shrineId: sh.id }];
  }

  /** The wall closes like the sim's: inset per tick, clamped per axis at `final`, then escalation. */
  private stepWall(ev: GameEvent[]): void {
    const sd = this.state.suddenDeath;
    if (!sd.active) return;
    const tick = this.state.tick;
    if (sd.closedAtTick < 0) {
      sd.inset += MATCH_RULES.suddenDeathInsetPerTick;
      const f = sd.final;
      const b = sd.bounds;
      b.x = Math.min(f.x, sd.inset);
      b.y = Math.min(f.y, sd.inset);
      b.w = Math.max(f.x + f.w, this.map.width - sd.inset) - b.x;
      b.h = Math.max(f.y + f.h, this.map.height - sd.inset) - b.y;
      if (b.x >= f.x && b.y >= f.y) sd.closedAtTick = tick;
    }
    zoneBoundsAfter(sd, MATCH_RULES.warningTicks, sd.warning);
    if (sd.closedAtTick >= 0 && (tick - sd.closedAtTick) % MATCH_RULES.escalationStepTicks === 0) {
      sd.escalation++;
      sd.everywhere = tick - sd.closedAtTick >= MATCH_RULES.escalationEverywhereTicks;
      const damage = MATCH_RULES.suddenDeathDamage + MATCH_RULES.escalationDamage * sd.escalation;
      ev.push({ tick, type: 'escalation', level: sd.escalation, damage, everywhere: sd.everywhere });
    }
  }

  /** Start sudden death (or switch it off again). `fast` jumps the wall most of the way in. */
  toggleSuddenDeath(fast = false): GameEvent[] {
    const s = this.state;
    if (s.suddenDeath.active) {
      s.suddenDeath = initialSuddenDeathState(this.map);
      return [];
    }
    const sd = s.suddenDeath;
    sd.active = true;
    sd.reason = 'time';
    sd.startedAtTick = s.tick;
    sd.inset = fast ? Math.min(sd.final.x, sd.final.y) * 0.6 : 0;
    return [{ tick: s.tick, type: 'sudden_death', reason: 'time' }];
  }

  /** Rough perception for every fighter: sight in the cone with line of sight, fuzzy hearing, memory. */
  private perceive(): void {
    const s = this.state;
    for (const o of s.fighters) {
      if (!o.alive) continue;
      let mem = this.known.get(o.id);
      if (!mem) {
        mem = new Map();
        this.known.set(o.id, mem);
      }
      const range = visionRange(o.attributes, o.weapon);
      const fov = visionFov(o.attributes, o.weapon);
      const hearing = hearingRadius(o.attributes);
      for (const t of s.fighters) {
        if (t === o) continue;
        const rec = mem.get(t.id);
        if (!t.alive) {
          mem.delete(t.id);
          continue;
        }
        const d = Math.hypot(t.pos.x - o.pos.x, t.pos.y - o.pos.y);
        const blocked = this.blockers.some((r) => segmentHitsRect(o.pos, t.pos, r));
        const inCone = Math.abs(wrapAngle(Math.atan2(t.pos.y - o.pos.y, t.pos.x - o.pos.x) - o.headAngle)) <= fov / 2;
        const seen = !blocked && inCone && d <= range;
        const heard = !seen && d <= hearing * (blocked ? PERCEPTION.hearingWallMul : 1);
        if (seen) {
          mem.set(t.id, {
            id: t.id, squad: t.squad, pos: { ...t.pos }, vel: { ...t.vel }, facing: t.facing, hp: t.hp, maxHp: t.maxHp, weapon: t.weapon,
            family: WEAPONS[t.weapon].family, seen: true, heard: false, estimateError: 0, lastSeenTick: s.tick, lastSeenPos: { ...t.pos },
            fighting: false, ammo: t.ammo, kills: t.kills, windingUp: t.anim.phase === 'windup',
          });
        } else if (heard) {
          const err = PERCEPTION.hearingErrorBase + PERCEPTION.hearingErrorPerPx * d;
          const r = rec ?? {
            id: t.id, squad: t.squad, pos: { ...t.pos }, vel: { x: 0, y: 0 }, facing: 0, hp: t.maxHp, maxHp: t.maxHp, weapon: t.weapon,
            family: WEAPONS[t.weapon].family, seen: false, heard: true, estimateError: err, lastSeenTick: -1, lastSeenPos: { ...t.pos },
            fighting: false, ammo: 0, kills: 0, windingUp: false,
          };
          if (!r.heard || s.tick % PERCEPTION.hearingRefreshTicks === 0) {
            const a = Math.random() * Math.PI * 2;
            const m = err * (0.5 + 0.5 * Math.random());
            r.pos = { x: t.pos.x + Math.cos(a) * m, y: t.pos.y + Math.sin(a) * m };
          }
          r.seen = false;
          r.heard = true;
          r.windingUp = false;
          r.estimateError = err;
          mem.set(t.id, r);
        } else if (rec) {
          rec.seen = false;
          rec.heard = false;
          rec.windingUp = false;
          const last = rec.lastSeenTick >= 0 ? rec.lastSeenTick : s.tick - 1;
          if (s.tick - last > PERCEPTION.memoryTicks) mem.delete(t.id);
        }
      }
    }
  }
}

function stepToward(cur: number, target: number, maxStep: number): number {
  const d = wrapAngle(target - cur);
  if (Math.abs(d) <= maxStep) return target;
  return cur + Math.sign(d) * maxStep;
}
