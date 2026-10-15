/**
 * The vocabulary of pit-strategy/2. Every sensor, fighter reference, place, zone, move term and
 * attack policy is defined here exactly once, with its doc, unit, range and implementation.
 * The compiler resolves names against these tables, and the strategy module generates the
 * validator vocabulary, the JSON Schema and the rulebook from them, so documentation and
 * behaviour cannot drift apart.
 */

import {
  COMBAT,
  PERCEPTION,
  PICKUP_RULES,
  TICK_HZ,
  WEAPONS,
  angleDiff,
  angleTo,
  clamp01,
  maxHp,
  v2Dist,
  zoneEdgeDistance,
  zoneTicksToReach,
} from '../core';
import type { Attributes, KnownFighter, PickupKind, Rect, WeaponId } from '../core';
import type { PickedPickup, ThinkCtx } from './ctx';
import { darkSpots } from './mapinfo';
import { AMMO_KINDS, STEERING, UNLIMITED_AMMO, weaponReach } from './tuning';

const FAR: number = STEERING.far;
const NEVER: number = STEERING.farSeconds;
const DEG = Math.PI / 180;
const PICKUP_KINDS: readonly PickupKind[] = ['haste', 'berserk'];

function bit(v: boolean): number {
  return v ? 1 : 0;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Signed distance from (x, y) to the edge of r: positive inside, negative outside. */
function rectEdgeDistance(r: Rect, x: number, y: number): number {
  const left = x - r.x;
  const right = r.x + r.w - x;
  const top = y - r.y;
  const bottom = r.y + r.h - y;
  if (left >= 0 && right >= 0 && top >= 0 && bottom >= 0) return Math.min(left, right, top, bottom);
  const ox = Math.max(0, -left, -right);
  const oy = Math.max(0, -top, -bottom);
  return -Math.sqrt(ox * ox + oy * oy);
}

// ---------------------------------------------------------------------------------------------
// Sensors
// ---------------------------------------------------------------------------------------------

/**
 * `self` sensors read you and the world. `target` sensors read the target chosen this think and
 * are not available in the target expression. `it` sensors read the candidate being rated and are
 * only available in the target expression.
 */
export type SensorScope = 'self' | 'target' | 'it';

export type SensorDef = {
  name: string;
  unit: string;
  range: string;
  doc: string;
  scope: SensorScope;
  get: (c: ThinkCtx) => number;
};

/** One fact about another fighter, exposed as both `target.<key>` and `it.<key>`. */
export type FighterSensorDef = {
  key: string;
  unit: string;
  range: string;
  doc: string;
  /** Value when there is no such fighter (no target). */
  none: number;
  of: (c: ThinkCtx, f: KnownFighter) => number;
};

function nearestHazardDistance(c: ThinkCtx, x: number, y: number): number {
  c.tmp.x = x;
  c.tmp.y = y;
  const h = c.world.nearestHazard(c.tmp);
  return h ? Math.hypot(h.pos.x - x, h.pos.y - y) : FAR;
}

/**
 * Is f within your current reach? Shots also need f in sight right now and a clear line: the sim
 * never releases a shot at a target it cannot see. A melee swing may go at a target you only hear,
 * by its estimated position.
 */
export function inReach(c: ThinkCtx, f: KnownFighter): boolean {
  if (v2Dist(c.self.pos, f.pos) > c.reach) return false;
  return !c.shooting || (f.seen && !c.world.losBlocked(c.self.pos, f.pos));
}

/** Seconds since you last saw f: 0 while you see it, STEERING.farSeconds if never. */
function lastSeenAge(c: ThinkCtx, f: KnownFighter): number {
  if (f.seen) return 0;
  return f.lastSeenTick < 0 ? NEVER : Math.max(0, c.tick - f.lastSeenTick) / TICK_HZ;
}

/**
 * The power-up `nearest_pickup` means, worked out once per think: of the nearest pedestal of each
 * kind, the nearest one whose power-up is there; if neither is, the one that is back soonest
 * (nearer on a tie).
 */
function pickPickup(c: ThinkCtx): PickedPickup {
  const p = c.pick;
  if (p.at === c.stamp) return p;
  p.at = c.stamp;
  p.found = false;
  let bestD = Infinity;
  for (const kind of PICKUP_KINDS) {
    const q = c.world.nearestPickup(c.self.pos, kind);
    if (!q) continue;
    const d = Math.hypot(q.pos.x - c.self.pos.x, q.pos.y - c.self.pos.y);
    const better = !p.found
      || (q.ready && !p.ready)
      || (q.ready === p.ready && (q.ready ? d < bestD : q.respawnIn < p.respawnIn || (q.respawnIn === p.respawnIn && d < bestD)));
    if (!better) continue;
    p.found = true;
    p.x = q.pos.x;
    p.y = q.pos.y;
    p.ready = q.ready;
    p.respawnIn = q.ready ? 0 : q.respawnIn;
    bestD = d;
  }
  return p;
}

function pickupDistance(c: ThinkCtx, kind: PickupKind): number {
  const q = c.world.nearestPickup(c.self.pos, kind);
  return q ? Math.hypot(q.pos.x - c.self.pos.x, q.pos.y - c.self.pos.y) : FAR;
}

function pickupReady(c: ThinkCtx, kind: PickupKind): number {
  return bit(c.world.nearestPickup(c.self.pos, kind)?.ready ?? false);
}

const PICKUP_EFFECT = `Haste: move speed x${PICKUP_RULES.haste.amount} for ${PICKUP_RULES.haste.durationTicks} ticks. Berserk: +${PICKUP_RULES.berserk.amount * 100}% weapon damage for ${PICKUP_RULES.berserk.durationTicks} ticks.`;

/** You stand within COMBAT.backstabArc of f's back. */
export function behindOf(c: ThinkCtx, f: KnownFighter): boolean {
  return Math.abs(angleDiff(f.facing + Math.PI, angleTo(f.pos, c.self.pos))) <= COMBAT.backstabArc;
}

export const FIGHTER_SENSORS: readonly FighterSensorDef[] = [
  { key: 'distance', unit: 'px', range: `0..${FAR}`, none: FAR, doc: `Distance from you to where you think it is, centre to centre: exact while you see it, a rough estimate while you only hear it, its last known spot otherwise. ${FAR} when there is none.`, of: (c, f) => v2Dist(c.self.pos, f.pos) },
  { key: 'visible', unit: '0/1', range: '0 or 1', none: 0, doc: '1 when you see it right now. Everything you know about an enemy you cannot see is from the last time you saw it, except a rough position while you hear it.', of: (_c, f) => bit(f.seen) },
  { key: 'heard', unit: '0/1', range: '0 or 1', none: 0, doc: `1 when you hear it but cannot see it: you know roughly where it is (off by ${PERCEPTION.hearingErrorBase} px + ${PERCEPTION.hearingErrorPerPx} x distance at most, and by at least half that), nothing else.`, of: (_c, f) => bit(f.heard && !f.seen) },
  { key: 'last_seen_age', unit: 's', range: `0..${NEVER}`, none: NEVER, doc: `Seconds since you last saw it: 0 while you see it. ${NEVER} if you have only ever heard it, and when there is none.`, of: lastSeenAge },
  { key: 'hp', unit: 'fraction', range: '0..1', none: 0, doc: 'Its HP as a fraction of its max HP (as of the last time you saw it).', of: (_c, f) => (f.maxHp > 0 ? f.hp / f.maxHp : 0) },
  { key: 'hp_abs', unit: 'hp', range: '0..490', none: 0, doc: 'Its HP in points (as of the last time you saw it).', of: (_c, f) => f.hp },
  { key: 'facing_away', unit: '0/1', range: '0 or 1', none: 0, doc: `1 when you stand in its back arc (within ${COMBAT.backstabArc} rad of straight behind it, by its facing when you last saw it): a hit from here would be a backstab.`, of: (c, f) => bit(behindOf(c, f)) },
  { key: 'sees_me', unit: '0/1', range: '0 or 1', none: 0, doc: '1 when it could see you as far as you know: you are inside its vision cone and range (by where you think it is and its facing when you last saw it), not blocked by walls, and close enough if you stand in shadow.', of: (c, f) => bit(c.world.inVisionOf(f, c.self.pos)) },
  { key: 'ranged', unit: '0/1', range: '0 or 1', none: 0, doc: '1 when it carries a ranged weapon (throwing axes, longbow, arcane staff).', of: (_c, f) => bit(f.family === 'ranged') },
  { key: 'family_ranged', unit: '0/1', range: '0 or 1', none: 0, doc: 'Same as ranged.', of: (_c, f) => bit(f.family === 'ranged') },
  { key: 'winding_up', unit: '0/1', range: '0 or 1', none: 0, doc: '1 while you see it in the windup of an attack (the telegraph before the blow lands).', of: (_c, f) => bit(f.windingUp) },
  { key: 'ammo', unit: 'count', range: `0..${UNLIMITED_AMMO}`, none: 0, doc: `Its projectiles or charges left (as of the last time you saw it). Melee weapons read ${UNLIMITED_AMMO}.`, of: (_c, f) => (WEAPONS[f.weapon].ammo === 0 ? UNLIMITED_AMMO : f.ammo) },
  { key: 'fighting', unit: '0/1', range: '0 or 1', none: 0, doc: `1 when it attacked or was hit in the last ${PERCEPTION.fightingWindowTicks} ticks, as of the last time you saw or heard it.`, of: (_c, f) => bit(f.fighting) },
  { key: 'last_attacker', unit: '0/1', range: '0 or 1', none: 0, doc: '1 when it is the fighter that hit you last.', of: (c, f) => bit(f.id === c.view.lastAttackerId) },
  { key: 'kills', unit: 'count', range: '0..15', none: 0, doc: 'Kills it has made this match (as of the last time you saw it).', of: (_c, f) => f.kills },
  { key: 'seen', unit: '0/1', range: '0 or 1', none: 0, doc: 'Same as visible.', of: (_c, f) => bit(f.seen) },
  { key: 'since_seen', unit: 'ticks', range: `0..${FAR}`, none: FAR, doc: `last_seen_age in ticks: 0 while you see it, else ticks since you last saw it. ${FAR} if never, and when there is none.`, of: (c, f) => (f.seen ? 0 : f.lastSeenTick < 0 ? FAR : Math.max(0, c.tick - f.lastSeenTick)) },
  { key: 'in_reach', unit: '0/1', range: '0 or 1', none: 0, doc: '1 when it is within your reach (self.reach). A shot also needs it in sight right now and the line to it clear of walls and pillars; a melee swing may go at one you only hear, aimed at its estimated spot.', of: (c, f) => bit(inReach(c, f)) },
  { key: 'in_shadow', unit: '0/1', range: '0 or 1', none: 0, doc: `1 when it stands in shadow (light below ${PERCEPTION.shadowLight}).`, of: (c, f) => bit(c.world.lightAt(f.pos) < PERCEPTION.shadowLight) },
  { key: 'hazard_distance', unit: 'px', range: `0..${FAR}`, none: FAR, doc: `Distance from it to the centre of the nearest active hazard. ${FAR} when there is none.`, of: (c, f) => nearestHazardDistance(c, f.pos.x, f.pos.y) },
  { key: 'is_target', unit: '0/1', range: '0 or 1', none: 0, doc: '1 when it was your target on your previous think. Add it to the target expression to stay on one enemy instead of switching back and forth.', of: (c, f) => bit(f.id === c.prevTargetId) },
];

function knownCount(c: ThinkCtx, pred: (f: KnownFighter) => boolean): number {
  let n = 0;
  for (const f of c.view.known) if (pred(f)) n++;
  return n;
}

function nearestAllyDistance(c: ThinkCtx): number {
  let best = FAR;
  for (const a of c.view.allies) if (a.hp > 0) best = Math.min(best, v2Dist(c.self.pos, a.pos));
  return best;
}

function ownAmmoKinds(c: ThinkCtx): string[] {
  return AMMO_LISTS[c.self.weapon];
}

/** Mutable copies for WorldQuery.nearestFloorItem. */
const AMMO_LISTS = Object.fromEntries(Object.entries(AMMO_KINDS).map(([k, v]) => [k, [...v]])) as Record<keyof typeof AMMO_KINDS, string[]>;

const SELF_SENSORS: readonly Omit<SensorDef, 'scope'>[] = [
  { name: 'self.hp', unit: 'fraction', range: '0..1', doc: 'Your HP as a fraction of your max HP.', get: (c) => (c.self.maxHp > 0 ? c.self.hp / c.self.maxHp : 0) },
  { name: 'self.hp_abs', unit: 'hp', range: '0..490', doc: 'Your HP in points.', get: (c) => c.self.hp },
  { name: 'self.ammo', unit: 'count', range: `0..${UNLIMITED_AMMO}`, doc: `Projectiles or charges left. Melee weapons read ${UNLIMITED_AMMO}.`, get: (c) => (WEAPONS[c.self.weapon].ammo === 0 ? UNLIMITED_AMMO : c.self.ammo) },
  { name: 'self.ranged', unit: '0/1', range: '0 or 1', doc: '1 when your weapon is ranged. Lets one behaviour serve melee and ranged builds.', get: (c) => bit(WEAPONS[c.self.weapon].family === 'ranged') },
  { name: 'self.reach', unit: 'px', range: '52..430', doc: `How far your attack reaches right now: melee range + ${STEERING.bodyAllowance} px of body, or ranged range; punch reach (${COMBAT.punchRange} + ${STEERING.bodyAllowance}) without a weapon arm or ammo.`, get: (c) => c.reach },
  { name: 'self.in_shadow', unit: '0/1', range: '0 or 1', doc: `1 when you stand in shadow (light below ${PERCEPTION.shadowLight}): enemies only see you within ${PERCEPTION.shadowVisionMul * 100}% of their range.`, get: (c) => bit(c.self.inShadow) },
  { name: 'self.light', unit: 'level', range: '0..1', doc: 'Light level where you stand (0 dark, 1 fully lit).', get: (c) => c.world.lightAt(c.self.pos) },
  { name: 'self.speed', unit: 'px/tick', range: '0..20', doc: 'Your current speed (a dash or a big knockback can briefly push it far above walking speed).', get: (c) => Math.hypot(c.self.vel.x, c.self.vel.y) },
  { name: 'self.stunned', unit: '0/1', range: '0 or 1', doc: '1 while you are stunned.', get: (c) => bit(c.self.stunTicks > 0) },
  { name: 'self.seen', unit: '0/1', range: '0 or 1', doc: '1 when at least one enemy can see you right now.', get: (c) => bit(c.self.seen) },
  { name: 'self.limbs', unit: 'count', range: '0..4', doc: 'Limbs still attached.', get: (c) => bit(c.self.limbs.armL) + bit(c.self.limbs.armR) + bit(c.self.limbs.legL) + bit(c.self.limbs.legR) },
  { name: 'self.kills', unit: 'count', range: '0..15', doc: 'Kills you have made this match.', get: (c) => c.self.kills },
  { name: 'self.berserk', unit: '0/1', range: '0 or 1', doc: '1 while berserk (Bloodrage or the berserk draught): +35% weapon damage.', get: (c) => bit(c.self.buffs.berserk > 0) },
  { name: 'self.hasted', unit: '0/1', range: '0 or 1', doc: '1 while hasted (Dash, Bloodrage or the haste charm).', get: (c) => bit(c.self.buffs.haste > 0) },
  { name: 'skill.ready', unit: '0/1', range: '0 or 1', doc: 'Your skill is off cooldown and you are not stunned.', get: (c) => bit(c.self.skillCd <= 0 && c.self.stunTicks <= 0) },
  { name: 'attack.ready', unit: '0/1', range: '0 or 1', doc: 'You can start an attack now: cooldown done, not mid-swing, not stunned.', get: (c) => bit(c.self.attackCd <= 0 && c.self.anim.phase === 'idle' && c.self.stunTicks <= 0) },
  { name: 'parry.ready', unit: '0/1', range: '0 or 1', doc: 'Your parry is off cooldown.', get: (c) => bit(c.self.parryCd <= 0) },
  { name: 'enemies_seen', unit: 'count', range: '0..15', doc: 'Enemies you see right now.', get: (c) => knownCount(c, (f) => f.seen) },
  { name: 'enemies_known', unit: 'count', range: '0..15', doc: `Enemies you see, hear, or remember (forgotten after ${PERCEPTION.memoryTicks} ticks without news).`, get: (c) => c.view.known.length },
  { name: 'enemies_near', unit: 'count', range: '0..15', doc: `Known enemies within ${PERCEPTION.enemiesNearRadius} px.`, get: (c) => knownCount(c, (f) => v2Dist(c.self.pos, f.pos) <= PERCEPTION.enemiesNearRadius) },
  { name: 'fights_nearby', unit: 'count', range: '0..15', doc: `Known enemies within ${STEERING.fightsRadius} px that are fighting (attacked or were hit in the last ${PERCEPTION.fightingWindowTicks} ticks).`, get: (c) => knownCount(c, (f) => f.fighting && v2Dist(c.self.pos, f.pos) <= STEERING.fightsRadius) },
  { name: 'allies_alive', unit: 'count', range: '0..15', doc: 'Squadmates still alive (always 0 in free-for-all).', get: (c) => c.view.allies.reduce((n, a) => n + bit(a.hp > 0), 0) },
  { name: 'ally.distance', unit: 'px', range: `0..${FAR}`, doc: `Distance to your nearest living squadmate. ${FAR} when there is none.`, get: nearestAllyDistance },
  { name: 'shrine.ready', unit: '0/1', range: '0 or 1', doc: 'The nearest shrine can heal right now.', get: (c) => bit(c.world.nearestShrine(c.self.pos)?.ready ?? false) },
  { name: 'shrine.distance', unit: 'px', range: `0..${FAR}`, doc: `Distance to the nearest shrine (ready or not). ${FAR} when the map has none.`, get: (c) => { const s = c.world.nearestShrine(c.self.pos); return s ? v2Dist(c.self.pos, s.pos) : FAR; } },
  { name: 'ammo.distance', unit: 'px', range: `0..${FAR}`, doc: `Distance to the nearest arrow or axe you can pick up (bow and axes only). ${FAR} when there is none.`, get: (c) => { const kinds = ownAmmoKinds(c); if (kinds.length === 0) return FAR; const p = c.world.nearestFloorItem(c.self.pos, kinds); return p ? v2Dist(c.self.pos, p) : FAR; } },
  { name: 'hazard.distance', unit: 'px', range: `0..${FAR}`, doc: `Distance from you to the centre of the nearest active hazard. ${FAR} when there is none.`, get: (c) => nearestHazardDistance(c, c.self.pos.x, c.self.pos.y) },
  { name: 'pickup.haste.ready', unit: '0/1', range: '0 or 1', doc: 'The nearest haste pedestal has its power-up on it right now.', get: (c) => pickupReady(c, 'haste') },
  { name: 'pickup.haste.distance', unit: 'px', range: `0..${FAR}`, doc: `Distance to the nearest haste pedestal, ready or not. ${FAR} when the map has none. ${PICKUP_EFFECT}`, get: (c) => pickupDistance(c, 'haste') },
  { name: 'pickup.berserk.ready', unit: '0/1', range: '0 or 1', doc: 'The nearest berserk pedestal has its power-up on it right now.', get: (c) => pickupReady(c, 'berserk') },
  { name: 'pickup.berserk.distance', unit: 'px', range: `0..${FAR}`, doc: `Distance to the nearest berserk pedestal, ready or not. ${FAR} when the map has none.`, get: (c) => pickupDistance(c, 'berserk') },
  { name: 'pickup.any.ready', unit: '0/1', range: '0 or 1', doc: 'The power-up at nearest_pickup is on its pedestal right now.', get: (c) => bit(pickPickup(c).ready) },
  { name: 'pickup.any.distance', unit: 'px', range: `0..${FAR}`, doc: `Distance to nearest_pickup (a power-up that is there if one is, else the one back soonest). ${FAR} when the map has none.`, get: (c) => { const p = pickPickup(c); return p.found ? Math.hypot(p.x - c.self.pos.x, p.y - c.self.pos.y) : FAR; } },
  { name: 'pickup.respawn_in', unit: 's', range: `0..${NEVER}`, doc: `Seconds until the power-up at nearest_pickup is back on its pedestal: 0 when it is there. ${NEVER} when the map has none.`, get: (c) => { const p = pickPickup(c); return p.found ? p.respawnIn : NEVER; } },
  { name: 'time', unit: 's', range: '0..600', doc: 'Seconds since the match started.', get: (c) => c.tick / TICK_HZ },
  { name: 'sudden_death', unit: '0/1', range: '0 or 1', doc: '1 once sudden death has started (the walls close in).', get: (c) => bit(c.view.suddenDeath) },
  { name: 'zone.distance', unit: 'px', range: `-2000..${FAR}`, doc: `In sudden death: signed distance from you to the closing wall, positive inside the playable area, negative outside it (where the wall hurts). ${FAR} before sudden death.`, get: (c) => (c.view.zone.active ? zoneEdgeDistance(c.view.zone, c.self.pos) : FAR) },
  { name: 'zone.time_to_reach', unit: 's', range: `0..${NEVER}`, doc: `Seconds until the closing wall reaches where you stand: 0 if you are already outside it. ${NEVER} before sudden death, once the wall has stopped, and inside the square where it will stop.`, get: (c) => { const t = zoneTicksToReach(c.view.zone, c.self.pos); return Number.isFinite(t) ? t / TICK_HZ : NEVER; } },
  { name: 'since_hit', unit: 'ticks', range: `0..${FAR}`, doc: `Ticks since you last took damage. ${FAR} if you have not been hit yet.`, get: (c) => (c.self.lastHitTick === null ? FAR : c.tick - c.self.lastHitTick) },
  { name: 'random', unit: 'number', range: '0..1', doc: 'A fresh random number each think (the same value everywhere within one think).', get: (c) => c.random },
];

function fighterSensor(scope: 'target' | 'it', d: FighterSensorDef): SensorDef {
  const pick = scope === 'target' ? (c: ThinkCtx) => c.target : (c: ThinkCtx) => c.it;
  return {
    name: `${scope}.${d.key}`,
    unit: d.unit,
    range: d.range,
    doc: d.doc,
    scope,
    get: (c) => {
      const f = pick(c);
      return f ? d.of(c, f) : d.none;
    },
  };
}

export const SENSORS: readonly SensorDef[] = [
  ...SELF_SENSORS.map((s) => ({ ...s, scope: 'self' as const })),
  ...FIGHTER_SENSORS.map((d) => fighterSensor('target', d)),
  ...FIGHTER_SENSORS.map((d) => fighterSensor('it', d)),
];

export const SENSOR_INDEX: ReadonlyMap<string, number> = new Map(SENSORS.map((s, i) => [s.name, i]));

export type ValueRange = { lo: number; hi: number };

/** A declared range as numbers: "a..b" or "0 or 1"; null if the text is neither. */
export function parseRange(range: string): ValueRange | null {
  if (range === '0 or 1') return { lo: 0, hi: 1 };
  const m = /^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/.exec(range);
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  return lo <= hi ? { lo, hi } : null;
}

/**
 * Every sensor's declared range, by index. A sensor always reads inside its range (the brain
 * clamps the rare value outside it), which is what makes the validator's interval analysis sound.
 */
const DECLARED: readonly ValueRange[] = SENSORS.map((s) => {
  const r = parseRange(s.range);
  if (!r) throw new Error(`Sensor ${s.name} declares an unreadable range "${s.range}".`);
  return r;
});

/** What a build fixes about a fighter. */
export type BuildFacts = { weapon: WeaponId; attributes: Attributes };

const PUNCH_REACH = COMBAT.punchRange + STEERING.bodyAllowance;

/**
 * The range sensor `idx` reads for a fighter with this build. Tighter than the declared range for
 * the few sensors the build decides (a melee build's `self.ranged` is always 0), so the validator
 * can tell that `kite` never runs for a greatsword.
 */
export function sensorRange(idx: number, build: BuildFacts | null): ValueRange {
  const declared = DECLARED[idx]!;
  if (!build) return declared;
  const w = WEAPONS[build.weapon];
  const ranged = w.family === 'ranged';
  switch (SENSORS[idx]!.name) {
    case 'self.ranged':
      return ranged ? { lo: 1, hi: 1 } : { lo: 0, hi: 0 };
    case 'self.ammo':
      return w.ammo === 0 ? { lo: UNLIMITED_AMMO, hi: UNLIMITED_AMMO } : { lo: 0, hi: w.ammo };
    case 'self.reach':
      return { lo: PUNCH_REACH, hi: weaponReach(build.weapon) };
    case 'self.hp_abs':
      return { lo: 0, hi: maxHp(build.attributes) };
    default:
      return declared;
  }
}

// ---------------------------------------------------------------------------------------------
// Fighter references (usable as places and as arguments of places and zones)
// ---------------------------------------------------------------------------------------------

export type FighterGetter = (c: ThinkCtx) => KnownFighter | null;

export type FighterRefDef = { name: string; doc: string; get: FighterGetter };

function nearestKnown(c: ThinkCtx, pred: (f: KnownFighter) => boolean): KnownFighter | null {
  let best: KnownFighter | null = null;
  let bestD = Infinity;
  for (const f of c.view.known) {
    if (!pred(f)) continue;
    const d = v2Dist(c.self.pos, f.pos);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

export const FIGHTER_REFS: readonly FighterRefDef[] = [
  { name: 'target', doc: 'Your current target (chosen by the target expression).', get: (c) => c.target },
  { name: 'nearest_enemy', doc: 'The nearest known enemy.', get: (c) => nearestKnown(c, () => true) },
  { name: 'last_attacker', doc: 'The enemy that hit you last, if you still know where it is.', get: (c) => c.lastAttacker },
  {
    name: 'weakest', doc: 'The known enemy with the lowest HP fraction (the nearer one on a tie).',
    get: (c) => {
      let best: KnownFighter | null = null;
      let bestHp = Infinity;
      let bestD = Infinity;
      for (const f of c.view.known) {
        const hp = f.maxHp > 0 ? f.hp / f.maxHp : 0;
        const d = v2Dist(c.self.pos, f.pos);
        if (hp < bestHp || (hp === bestHp && d < bestD)) {
          best = f;
          bestHp = hp;
          bestD = d;
        }
      }
      return best;
    },
  },
  { name: 'nearest_fight', doc: 'The nearest known enemy that is fighting someone (attacked or was hit recently).', get: (c) => nearestKnown(c, (f) => f.fighting) },
  {
    name: 'ally', doc: 'Your nearest living squadmate (squads only).',
    get: (c) => {
      let best: KnownFighter | null = null;
      let bestD = Infinity;
      for (const a of c.view.allies) {
        if (a.hp <= 0) continue;
        const d = v2Dist(c.self.pos, a.pos);
        if (d < bestD) {
          bestD = d;
          best = a;
        }
      }
      return best;
    },
  },
];

export const FIGHTER_REF_INDEX: ReadonlyMap<string, FighterRefDef> = new Map(FIGHTER_REFS.map((r) => [r.name, r]));

/** Argument word meaning "every enemy you saw or heard recently" (zones and cover_from only). */
export const ENEMIES_WORD = 'enemies';

// ---------------------------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------------------------

/** A resolved place. `fighter` is set when the place is a fighter (seek then stops at touching distance and leads it). */
export type PlaceOut = { x: number; y: number; fighter: KnownFighter | null };
/** Writes the place into `out`; false when it does not exist right now (the term then rates nothing). */
export type PlaceFn = (c: ThinkCtx, out: PlaceOut) => boolean;

export type ArgKind = 'fighter' | 'fighters' | 'place' | 'number' | 'pickup';
export type ArgSpec = { name: string; kind: ArgKind; min?: number; max?: number };

/** Words a `pickup` argument takes. */
export const PICKUP_ARG_WORDS: readonly (PickupKind | 'any')[] = ['haste', 'berserk', 'any'];

export type CompiledArg =
  | { kind: 'fighter'; get: FighterGetter }
  /** `get` null = every enemy seen or heard now, or seen recently (ThinkCtx.fresh). */
  | { kind: 'fighters'; get: FighterGetter | null }
  | { kind: 'place'; get: PlaceFn }
  | { kind: 'number'; value: number }
  | { kind: 'pickup'; value: PickupKind | 'any' };

export type PlaceDef = {
  name: string;
  args: readonly ArgSpec[];
  doc: string;
  build: (args: readonly CompiledArg[]) => PlaceFn;
};

function argFighter(a: CompiledArg | undefined): FighterGetter {
  if (!a || a.kind !== 'fighter') throw new Error('place argument mismatch');
  return a.get;
}

function argNumber(a: CompiledArg | undefined): number {
  if (!a || a.kind !== 'number') throw new Error('place argument mismatch');
  return a.value;
}

function argPlace(a: CompiledArg | undefined): PlaceFn {
  if (!a || a.kind !== 'place') throw new Error('place argument mismatch');
  return a.get;
}

function argFighters(a: CompiledArg | undefined): FighterGetter | null {
  if (!a || a.kind !== 'fighters') throw new Error('place argument mismatch');
  return a.get;
}

function argPickup(a: CompiledArg | undefined): PickupKind | 'any' {
  if (!a || a.kind !== 'pickup') throw new Error('place argument mismatch');
  return a.value;
}

function setPoint(out: PlaceOut, x: number, y: number): true {
  out.x = x;
  out.y = y;
  out.fighter = null;
  return true;
}

/** The nearest enemy seen or heard now, or seen within STEERING.freshTicks. */
function nearestFresh(c: ThinkCtx): KnownFighter | null {
  let best: KnownFighter | null = null;
  let bestD = Infinity;
  for (const f of c.fresh) {
    const d = v2Dist(c.self.pos, f.pos);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

/**
 * Nearest point of a precomputed list. In sudden death, points the closing wall reaches within
 * MATCH_RULES.warningTicks are skipped (`zone.warning` is the playable area that far ahead).
 */
function nearestSpot(c: ThinkCtx, spots: readonly { x: number; y: number }[], out: PlaceOut): boolean {
  let best = -1;
  let bestD = Infinity;
  const sx = c.self.pos.x;
  const sy = c.self.pos.y;
  const a = c.view.zone.warning;
  for (let i = 0; i < spots.length; i++) {
    const p = spots[i]!;
    const d = (p.x - sx) * (p.x - sx) + (p.y - sy) * (p.y - sy);
    if (d >= bestD) continue;
    if (p.x < a.x || p.x > a.x + a.w || p.y < a.y || p.y > a.y + a.h) continue;
    best = i;
    bestD = d;
  }
  if (best < 0) return false;
  return setPoint(out, spots[best]!.x, spots[best]!.y);
}

export const PLACES: readonly PlaceDef[] = [
  {
    name: 'behind', args: [{ name: 'X', kind: 'fighter' }, { name: 'd', kind: 'number', min: 0, max: 400 }],
    doc: `The spot d px straight behind fighter X (opposite its facing). If you are more than ${STEERING.behindSwingDeg}° around from its back, the point is instead ${STEERING.behindSwingDeg}° further around X from where you stand, at least ${STEERING.behindClearance} px out, so you circle round it instead of walking through its front.`,
    build: (args) => {
      const fx = argFighter(args[0]);
      const d = argNumber(args[1]);
      const swing = STEERING.behindSwingDeg * DEG;
      return (c, out) => {
        const f = fx(c);
        if (!f) return false;
        const back = f.facing + Math.PI;
        const mine = angleTo(f.pos, c.self.pos);
        const off = angleDiff(back, mine);
        if (Math.abs(off) <= swing) return setPoint(out, f.pos.x + Math.cos(back) * d, f.pos.y + Math.sin(back) * d);
        const a = mine - Math.sign(off) * swing;
        const r = Math.max(d, STEERING.behindClearance);
        return setPoint(out, f.pos.x + Math.cos(a) * r, f.pos.y + Math.sin(a) * r);
      };
    },
  },
  {
    name: 'side', args: [{ name: 'X', kind: 'fighter' }, { name: 'deg', kind: 'number', min: -180, max: 180 }, { name: 'd', kind: 'number', min: 0, max: 400 }],
    doc: 'The spot d px from fighter X at deg degrees from its facing: 0 in front of it, 90 its right (clockwise on screen), -90 its left, 180 behind it.',
    build: (args) => {
      const fx = argFighter(args[0]);
      const deg = argNumber(args[1]) * DEG;
      const d = argNumber(args[2]);
      return (c, out) => {
        const f = fx(c);
        if (!f) return false;
        return setPoint(out, f.pos.x + Math.cos(f.facing + deg) * d, f.pos.y + Math.sin(f.facing + deg) * d);
      };
    },
  },
  {
    name: 'cover_from', args: [{ name: 'X', kind: 'fighters' }],
    doc: `The nearest spot within ${STEERING.coverSearch} px of you where a wall or pillar hides you from X. With "enemies", hides from the nearest enemy you see or hear now or saw in the last ${STEERING.freshTicks} ticks.`,
    build: (args) => {
      const fx = argFighters(args[0]);
      return (c, out) => {
        const threat = fx ? fx(c) : nearestFresh(c);
        if (!threat) return false;
        const p = c.world.coverFrom(c.self.pos, threat.pos, STEERING.coverSearch);
        return p ? setPoint(out, p.x, p.y) : false;
      };
    },
  },
  {
    name: 'last_seen', args: [{ name: 'X', kind: 'fighter' }],
    doc: 'Where you last saw fighter X (where you think it is, if you have only ever heard it).',
    build: (args) => {
      const fx = argFighter(args[0]);
      return (c, out) => {
        const f = fx(c);
        if (!f) return false;
        const p = f.lastSeenTick >= 0 ? f.lastSeenPos : f.pos;
        return setPoint(out, p.x, p.y);
      };
    },
  },
  {
    name: 'search_point', args: [],
    doc: `Where to look for your target. While you see it: the target itself. While you only hear it: the rough position you hear it at. Otherwise a point sweeping round where you last knew it to be: the sweep starts on that spot, widens by ${STEERING.searchGrowth} px per second since you last saw it up to ${STEERING.searchMax} px, and turns ${STEERING.searchSpin} rad per second, starting on the side it was heading. Nothing without a target.`,
    build: () => (c, out) => {
      const f = c.target;
      if (!f) return false;
      if (f.seen) {
        out.x = f.pos.x;
        out.y = f.pos.y;
        out.fighter = f;
        return true;
      }
      // Heard: the estimate is the best lead (it moves with the real fighter, roughly).
      if (f.heard) return setPoint(out, f.pos.x, f.pos.y);
      const age = f.lastSeenTick < 0 ? 0 : Math.max(0, c.tick - f.lastSeenTick) / TICK_HZ;
      const r = Math.min(STEERING.searchMax, STEERING.searchGrowth * age);
      const moving = Math.hypot(f.vel.x, f.vel.y) > 0.05;
      const a0 = moving ? Math.atan2(f.vel.y, f.vel.x) : angleTo(c.self.pos, f.pos);
      const a = a0 + STEERING.searchSpin * age;
      const z = c.view.zone.bounds;
      const m = STEERING.searchMargin;
      const x = Math.min(Math.max(f.pos.x + Math.cos(a) * r, z.x + m), z.x + z.w - m);
      const y = Math.min(Math.max(f.pos.y + Math.sin(a) * r, z.y + m), z.y + z.h - m);
      return setPoint(out, x, y);
    },
  },
  {
    name: 'hazard_near', args: [{ name: 'P', kind: 'place' }],
    doc: 'The current position of the active hazard nearest to place P (saws move, so this follows them).',
    build: (args) => {
      const pf = argPlace(args[0]);
      const scratch: PlaceOut = { x: 0, y: 0, fighter: null };
      return (c, out) => {
        if (!pf(c, scratch)) return false;
        c.tmp.x = scratch.x;
        c.tmp.y = scratch.y;
        const h = c.world.nearestHazard(c.tmp);
        return h ? setPoint(out, h.pos.x, h.pos.y) : false;
      };
    },
  },
  {
    name: 'beyond', args: [{ name: 'P', kind: 'place' }, { name: 'Q', kind: 'place' }, { name: 'd', kind: 'number', min: 0, max: 400 }],
    doc: 'The spot d px past place P, on the far side from place Q. "beyond(hazard_near(target), target, 85)" stands you across a trap from your target, so it walks through the trap to reach you.',
    build: (args) => {
      const pf = argPlace(args[0]);
      const qf = argPlace(args[1]);
      const d = argNumber(args[2]);
      const scratch: PlaceOut = { x: 0, y: 0, fighter: null };
      return (c, out) => {
        if (!pf(c, scratch)) return false;
        const px = scratch.x;
        const py = scratch.y;
        if (!qf(c, scratch)) return false;
        const dx = px - scratch.x;
        const dy = py - scratch.y;
        const len = Math.hypot(dx, dy);
        if (len < 1) return false;
        return setPoint(out, px + (dx / len) * d, py + (dy / len) * d);
      };
    },
  },
  {
    name: 'shrine', args: [],
    doc: 'The nearest shrine, ready or not (check shrine.ready).',
    build: () => (c, out) => {
      const s = c.world.nearestShrine(c.self.pos);
      return s ? setPoint(out, s.pos.x, s.pos.y) : false;
    },
  },
  {
    name: 'ammo', args: [],
    doc: 'The nearest of your own kind of spent projectile on the floor (arrows for the bow, axes for throwing axes). Nothing for other weapons.',
    build: () => (c, out) => {
      const kinds = ownAmmoKinds(c);
      if (kinds.length === 0) return false;
      const p = c.world.nearestFloorItem(c.self.pos, kinds);
      return p ? setPoint(out, p.x, p.y) : false;
    },
  },
  {
    name: 'pickup', args: [{ name: 'K', kind: 'pickup' }],
    doc: `The nearest power-up pedestal of kind K (haste or berserk), ready or not (check pickup.haste.ready, pickup.berserk.ready). pickup(any) is nearest_pickup. ${PICKUP_EFFECT}`,
    build: (args) => {
      const kind = argPickup(args[0]);
      return (c, out) => {
        if (kind === 'any') {
          const p = pickPickup(c);
          return p.found ? setPoint(out, p.x, p.y) : false;
        }
        const q = c.world.nearestPickup(c.self.pos, kind);
        return q ? setPoint(out, q.pos.x, q.pos.y) : false;
      };
    },
  },
  {
    name: 'nearest_pickup', args: [],
    doc: 'The power-up to go for: of the nearest pedestal of each kind, the nearest one that has its power-up on it; if neither has, the one that is back soonest. The pickup.any.* sensors describe this one.',
    build: () => (c, out) => {
      const p = pickPickup(c);
      return p.found ? setPoint(out, p.x, p.y) : false;
    },
  },
  {
    name: 'centre', args: [],
    doc: 'The centre of the map.',
    build: () => (c, out) => setPoint(out, c.info.centre.x, c.info.centre.y),
  },
  {
    name: 'zone_centre', args: [],
    doc: 'The centre of the square where the sudden-death wall stops: the last safe ground.',
    build: () => (c, out) => {
      const f = c.view.zone.final;
      return setPoint(out, f.x + f.w / 2, f.y + f.h / 2);
    },
  },
  {
    name: 'nearest_keg', args: [],
    doc: 'The nearest unbroken powder keg.',
    build: () => (c, out) => {
      const p = c.world.nearestProp(c.self.pos, 'keg');
      return p ? setPoint(out, p.x, p.y) : false;
    },
  },
  {
    name: 'corner', args: [],
    doc: `The nearest corner spot: free ground with a wall or pillar within ${STEERING.cornerReach} px both along x and along y, so attackers can only come from the open side. In sudden death, corners the closing wall reaches within 3 s are skipped.`,
    build: () => (c, out) => nearestSpot(c, c.info.corners, out),
  },
  {
    name: 'dark_spot', args: [],
    doc: `The nearest free spot in shadow (light below ${PERCEPTION.shadowLight}), on a ${STEERING.spotGrid} px grid. In sudden death, spots the closing wall reaches within 3 s are skipped.`,
    build: () => (c, out) => nearestSpot(c, darkSpots(c.world, c.info), out),
  },
];

export const PLACE_INDEX: ReadonlyMap<string, PlaceDef> = new Map(PLACES.map((p) => [p.name, p]));

// ---------------------------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------------------------

/** How much of the zone covers point (x, y), 0..1. */
export type ZoneFn = (c: ThinkCtx, x: number, y: number) => number;

export type ZoneDef = {
  name: string;
  args: readonly ArgSpec[];
  doc: string;
  build: (args: readonly CompiledArg[]) => ZoneFn;
};

function shadowAt(c: ThinkCtx, x: number, y: number): number {
  c.tmp.x = x;
  c.tmp.y = y;
  const light = c.world.lightAt(c.tmp);
  return clamp01((PERCEPTION.shadowLight + STEERING.shadowSoft - light) / (2 * STEERING.shadowSoft));
}

function wallsAt(c: ThinkCtx, x: number, y: number): number {
  let sum = 0;
  const R = STEERING.wallsRadius;
  for (const r of c.info.blockers) {
    const qx = (x < r.x ? r.x : x > r.x + r.w ? r.x + r.w : x) - x;
    const qy = (y < r.y ? r.y : y > r.y + r.h ? r.y + r.h : y) - y;
    const d = Math.sqrt(qx * qx + qy * qy);
    if (d >= R) continue;
    if (d === 0) return 1;
    sum += STEERING.wallsGain * (1 - d / R);
    if (sum >= 1) return 1;
  }
  return sum;
}

export const ZONES: readonly ZoneDef[] = [
  {
    name: 'shadow', args: [],
    doc: `Darkness: 1 where light is ${round2(PERCEPTION.shadowLight - STEERING.shadowSoft)} or less, 0 where it is ${round2(PERCEPTION.shadowLight + STEERING.shadowSoft)} or more, linear between. Enemies see you in shadow only within ${PERCEPTION.shadowVisionMul * 100}% of their range.`,
    build: () => shadowAt,
  },
  {
    name: 'lit', args: [],
    doc: 'The opposite of shadow: 1 - shadow.',
    build: () => (c, x, y) => 1 - shadowAt(c, x, y),
  },
  {
    name: 'seen_by', args: [{ name: 'X', kind: 'fighters' }],
    doc: `1 where fighter X would see you as far as you know (its cone by where you think it is and its facing when you last saw it, its range, walls and the shadow rule), else 0. With "enemies": 1 where any enemy you see or hear now, or saw in the last ${STEERING.freshTicks} ticks, would see you.`,
    build: (args) => {
      const fx = argFighters(args[0]);
      return (c, x, y) => {
        c.tmp.x = x;
        c.tmp.y = y;
        if (fx) {
          const f = fx(c);
          return f && c.world.inVisionOf(f, c.tmp) ? 1 : 0;
        }
        for (const f of c.fresh) if (c.world.inVisionOf(f, c.tmp)) return 1;
        return 0;
      };
    },
  },
  {
    name: 'hazards', args: [],
    doc: `1 inside the nearest active hazard (spikes, saws, acid, fire), fading to 0 at ${STEERING.hazardFade} px outside its edge.`,
    build: () => (c, x, y) => {
      c.tmp.x = x;
      c.tmp.y = y;
      const h = c.world.nearestHazard(c.tmp);
      if (!h) return 0;
      const d = Math.hypot(h.pos.x - x, h.pos.y - y);
      return clamp01(1 - (d - h.radius) / STEERING.hazardFade);
    },
  },
  {
    name: 'walls', args: [],
    doc: `Closeness to walls and pillars: each one within ${STEERING.wallsRadius} px adds ${STEERING.wallsGain} x (1 - distance / ${STEERING.wallsRadius}), capped at 1.`,
    build: () => wallsAt,
  },
  {
    name: 'open', args: [],
    doc: 'Open ground: 1 - walls.',
    build: () => (c, x, y) => 1 - wallsAt(c, x, y),
  },
  {
    name: 'outside_zone', args: [],
    doc: `In sudden death: 1 outside the playable area and in the strip the closing wall reaches within 3 s, fading to 0 at ${STEERING.zoneFade} px inside that strip. 0 everywhere before sudden death.`,
    build: () => (c, x, y) => {
      const z = c.view.zone;
      if (!z.active) return 0;
      return clamp01(1 - rectEdgeDistance(z.warning, x, y) / STEERING.zoneFade);
    },
  },
];

export const ZONE_INDEX: ReadonlyMap<string, ZoneDef> = new Map(ZONES.map((z) => [z.name, z]));

// ---------------------------------------------------------------------------------------------
// Move terms and attack policies (implemented in steering.ts and brain.ts; documented here)
// ---------------------------------------------------------------------------------------------

export type TermKind = 'seek' | 'flee' | 'keep_range' | 'orbit' | 'avoid' | 'prefer';

export type TermDef = { key: TermKind; form: string; doc: string };

export const MOVE_TERMS: readonly TermDef[] = [
  {
    key: 'seek', form: '{ "seek": PLACE, "weight": w }',
    doc: `Each direction rates cos(angle between it and the way to PLACE): +1 straight at it, -1 straight away. Strength eases from 1 to 0 over the last ${STEERING.arriveRamp} px before the stop distance (${STEERING.pointStop} px for a point; your radius + ${STEERING.fighterStop} px for a fighter, i.e. bodies touching). A fighter you can see right now is led: you aim where it will be after min(distance / your speed, ${STEERING.leadMaxTicks}) ticks. One you only hear or remember is not (you do not know how it is moving).`,
  },
  {
    key: 'flee', form: '{ "flee": PLACE, "weight": w }',
    doc: 'The mirror of seek at full strength at any distance: +1 straight away from PLACE, -1 straight at it.',
  },
  {
    key: 'keep_range', form: '{ "keep_range": [PLACE, min, max], "weight": w }',
    doc: `Closer than min: rates like flee, at strength (min - distance) / ${STEERING.rangeRamp} capped at 1. Further than max: like seek, at strength (distance - max) / ${STEERING.rangeRamp} capped at 1. Inside the band: rates nothing (add orbit to keep moving).`,
  },
  {
    key: 'orbit', form: '{ "orbit": [PLACE, "cw" | "ccw"], "weight": w }',
    doc: `Rates cos(angle to the tangent of a circle around PLACE), going clockwise ("cw", as seen on screen) or counter-clockwise ("ccw"). The tangent tilts ${STEERING.orbitTilt} rad toward PLACE so the circle does not drift outward.`,
  },
  {
    key: 'avoid', form: '{ "avoid": ZONE, "weight": w }',
    doc: `Each direction rates -(zone ahead - zone here), where "zone ahead" averages the zone ${STEERING.sampleNear} and ${STEERING.sampleFar} px along that direction and "zone here" is the zone where you stand. Directions into more of the zone go negative; inside the zone, directions out of it go positive. Deep inside a large uniform zone it rates nothing: combine with flee or cover_from.`,
  },
  {
    key: 'prefer', form: '{ "prefer": ZONE, "weight": w }',
    doc: 'The mirror of avoid: rates +(zone ahead - zone here).',
  },
];

export type AttackPolicyName = 'in_range' | 'never' | 'if_blocked';

export const ATTACK_POLICIES: readonly { name: AttackPolicyName; doc: string }[] = [
  { name: 'in_range', doc: 'Attack the target whenever it is within your reach (target.in_reach).' },
  { name: 'never', doc: 'Never attack.' },
  {
    name: 'if_blocked',
    doc: `Attack only an enemy that stands in your way: within ${STEERING.blockedHalfArcDeg}° either side of your heading and within your reach (ranged: also within ${STEERING.blockedReachRanged} px). That enemy becomes your target for the swing. For running away without being pinned.`,
  },
];

export const ATTACK_POLICY_NAMES: readonly string[] = ATTACK_POLICIES.map((p) => p.name);
