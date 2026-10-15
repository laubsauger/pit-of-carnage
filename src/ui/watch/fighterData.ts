// Owned by: ui
// Copies of live sim data for the HUD, and the plain-English lines the inspector shows. The sim
// mutates its state in place, so the HUD keeps its own copies, taken at controller notifications
// (about 10 Hz).
import { PICKUP_RULES, TICK_HZ } from '../../core';
import type {
  Attributes,
  Decision,
  FighterState,
  GameController,
  GuardTrip,
  GuardTripKind,
  KnownFighter,
  Limb,
  PickupKind,
  SkillId,
  Stance,
  UiFighter,
  Vec2,
  WeaponId,
} from '../../core';

export type FighterCopy = {
  pos: Vec2;
  hp: number;
  maxHp: number;
  alive: boolean;
  facing: number;
  stance: Stance;
  stunTicks: number;
  parryTicks: number;
  buffs: { haste: number; berserk: number; slow: number };
  inShadow: boolean;
  seen: boolean;
  ammo: number;
  maxAmmo: number;
  attackCd: number;
  skillCd: number;
  damageDealt: number;
  damageTaken: number;
  kills: number;
  attributes: Attributes;
  weapon: WeaponId;
  skill: SkillId;
  limbs: Record<Limb, boolean>;
};

export type DecisionCopy = Pick<Decision, 'behaviour' | 'targetId' | 'heading' | 'speed' | 'attack' | 'parry' | 'useSkill' | 'stance'> & {
  scores: Record<string, number>;
  ring: number[];
  terms: { label: string; ratings: number[] }[];
  sensors: Record<string, number>;
  guardTrips: GuardTrip[];
};

/** What the inspector keeps of one knowledge record (the sim's records are live). */
export type KnownCopy = Pick<KnownFighter, 'id' | 'seen' | 'heard' | 'estimateError' | 'lastSeenTick'> & { pos: Vec2 };

export function copyFighter(f: FighterState | null): FighterCopy | null {
  if (!f) return null;
  return {
    pos: { x: f.pos.x, y: f.pos.y },
    hp: f.hp, maxHp: f.maxHp, alive: f.alive, facing: f.facing, stance: f.stance,
    stunTicks: f.stunTicks, parryTicks: f.parryTicks, buffs: { ...f.buffs },
    inShadow: f.inShadow, seen: f.seen, ammo: f.ammo, maxAmmo: f.maxAmmo,
    attackCd: f.attackCd, skillCd: f.skillCd,
    damageDealt: f.damageDealt, damageTaken: f.damageTaken, kills: f.kills,
    attributes: { ...f.attributes }, weapon: f.weapon, skill: f.skill, limbs: { ...f.limbs },
  };
}

export function copyDecision(d: Decision | null): DecisionCopy | null {
  if (!d) return null;
  return {
    behaviour: d.behaviour, targetId: d.targetId, heading: d.heading, speed: d.speed,
    attack: d.attack, parry: d.parry, useSkill: d.useSkill, stance: d.stance,
    scores: { ...d.scores },
    ring: [...d.ring],
    terms: d.terms.map((t) => ({ label: t.label, ratings: [...t.ratings] })),
    sensors: { ...(d.sensors ?? {}) },
    guardTrips: (d.guardTrips ?? []).map((t) => ({ ...t })),
  };
}

export function copyKnowledge(list: readonly KnownFighter[]): KnownCopy[] {
  return list.map((k) => ({ id: k.id, seen: k.seen, heard: k.heard, estimateError: k.estimateError, lastSeenTick: k.lastSeenTick, pos: { x: k.pos.x, y: k.pos.y } }));
}

export type LiveCopy = { f: FighterCopy | null; d: DecisionCopy | null; known: KnownCopy[] };

export function readLive(controller: GameController, id: string): LiveCopy {
  return { f: copyFighter(controller.fighter(id)), d: copyDecision(controller.decision(id)), known: copyKnowledge(controller.knowledge(id)) };
}

const LIMB_NAMES: Record<Limb, string> = { armL: 'left arm', armR: 'right arm', legL: 'left leg', legR: 'right leg' };

/** Short status chips for the inspector; `hot` ones get the accent. */
export function statusChips(f: FighterCopy): { text: string; hot?: boolean }[] {
  const out: { text: string; hot?: boolean }[] = [];
  if (!f.alive) return [{ text: 'Dead' }];
  if (f.stunTicks > 0) out.push({ text: 'Stunned', hot: true });
  if (f.buffs.berserk > 0) out.push({ text: 'Berserk', hot: true });
  if (f.buffs.haste > 0) out.push({ text: 'Hasted' });
  if (f.buffs.slow > 0) out.push({ text: 'Slowed' });
  if (f.parryTicks > 0) out.push({ text: 'Parrying' });
  if (f.stance === 'creep') out.push({ text: 'Creeping' });
  if (f.stance === 'guard') out.push({ text: 'Shield up' });
  out.push({ text: f.inShadow ? 'In shadow' : 'In light' });
  if (f.seen) out.push({ text: 'Seen' });
  if (f.maxAmmo > 0 && f.ammo === 0) out.push({ text: 'Out of ammo', hot: true });
  for (const limb of Object.keys(f.limbs) as Limb[]) if (!f.limbs[limb]) out.push({ text: `No ${LIMB_NAMES[limb]}`, hot: true });
  return out;
}

const seconds = (ticks: number) => `${(Math.max(0, ticks) / TICK_HZ).toFixed(1)} s`;

// ---------------------------------------------------------------------------------------------
// Guard trips
// ---------------------------------------------------------------------------------------------

export const GUARD_TRIP_TEXT: Readonly<Record<GuardTripKind, string>> = {
  nan: 'NaN or infinity (read as 0)',
  div_zero: 'division by zero (read as 0)',
  clamped: 'a value out of bounds (clamped)',
  cost: 'the think cost budget (cut short)',
};

/** Guard trips, most first, with the total for the badge. Every trip in a valid strategy is a validator bug worth seeing. */
export function guardTripSummary(trips: readonly GuardTrip[]): { total: number; lines: { path: string; what: string; count: number }[] } {
  const lines = [...trips]
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .map((t) => ({ path: t.path, what: GUARD_TRIP_TEXT[t.kind] ?? t.kind, count: t.count }));
  return { total: trips.reduce((n, t) => n + t.count, 0), lines };
}

// ---------------------------------------------------------------------------------------------
// Knowledge (fog of war)
// ---------------------------------------------------------------------------------------------

export type KnowledgeRow = {
  id: string;
  name: string;
  color: string;
  state: 'seen' | 'heard' | 'remembered';
  /** "Seen", "Heard (±40 px)", "Lost sight 2.3 s ago". Never an exact spot for anything not seen. */
  text: string;
  /** Distance to the record's position: exact when seen, "~" when only an estimate. */
  distance: string;
};

const STATE_ORDER = { seen: 0, heard: 1, remembered: 2 } as const;

/**
 * What the selected fighter knows about each enemy, nearest sightings first. The lines come from the
 * fighter's own records, never from the live state, so the inspector cannot leak what the fog hides.
 */
export function knowledgeRows(known: readonly KnownCopy[], self: Vec2 | null, tick: number, fighters: readonly Pick<UiFighter, 'id' | 'name' | 'color'>[]): KnowledgeRow[] {
  const rows = known.map((k) => {
    const f = fighters.find((x) => x.id === k.id);
    const state: KnowledgeRow['state'] = k.seen ? 'seen' : k.heard ? 'heard' : 'remembered';
    const err = Math.round(k.estimateError);
    let text: string;
    if (state === 'seen') text = 'Seen';
    else if (state === 'heard') text = k.lastSeenTick < 0 ? `Heard, never seen (±${err} px)` : `Heard (±${err} px)`;
    else text = k.lastSeenTick < 0 ? 'Heard earlier, never seen' : `Lost sight ${seconds(tick - k.lastSeenTick)} ago`;
    const d = self ? Math.hypot(k.pos.x - self.x, k.pos.y - self.y) : NaN;
    return {
      row: { id: k.id, name: f?.name ?? k.id, color: f?.color ?? 'var(--text-dim)', state, text, distance: Number.isFinite(d) ? `${state === 'seen' ? '' : '~'}${Math.round(d)} px` : '' },
      d,
      age: k.lastSeenTick < 0 ? Infinity : tick - k.lastSeenTick,
    };
  });
  rows.sort((a, b) => STATE_ORDER[a.row.state] - STATE_ORDER[b.row.state] || (a.row.state === 'remembered' ? a.age - b.age : a.d - b.d));
  return rows.map((r) => r.row);
}

// ---------------------------------------------------------------------------------------------
// Power-ups and the closing zone (from the fighter and its sensors)
// ---------------------------------------------------------------------------------------------

/** Distance sensors read at least this when there is nothing to measure (`STEERING.far` in the brain). */
const NOTHING_PX = 9999;
/**
 * `zone.time_to_reach` above this means the wall will never get here: at 15 px/s it crosses the
 * biggest map's half-width in under 50 s, so only the sensor's "never" value is this large.
 */
const ZONE_NEVER_S = 60;

export type InfoLine = { label: string; value: string; hot?: boolean };

/**
 * Power-up lines: buffs running now, then each pedestal as the brain sees it. A sensor this build of
 * the brain does not provide is simply left out, never guessed.
 */
export function powerupLines(f: Pick<FighterCopy, 'buffs'> | null, sensors: Record<string, number>): InfoLine[] {
  const out: InfoLine[] = [];
  if (f?.buffs.berserk) out.push({ label: 'Berserk', value: `${seconds(f.buffs.berserk)} left`, hot: true });
  if (f?.buffs.haste) out.push({ label: 'Hasted', value: `${seconds(f.buffs.haste)} left`, hot: true });
  for (const kind of ['haste', 'berserk'] as PickupKind[]) {
    const dist = sensors[`pickup.${kind}.distance`];
    if (dist === undefined || dist >= NOTHING_PX) continue;
    const ready = sensors[`pickup.${kind}.ready`];
    const state = ready === undefined ? '' : ready > 0 ? 'up, ' : 'not up, ';
    out.push({ label: PICKUP_RULES[kind].name, value: `${state}${Math.round(dist)} px` });
  }
  const back = sensors['pickup.respawn_in'];
  if (back !== undefined && back > 0) out.push({ label: 'Next one back in', value: `${back.toFixed(1)} s` });
  return out;
}

/** Zone lines once sudden death runs: inside or out, how far from the wall, how long until it arrives. */
export function zoneLines(suddenDeath: boolean, sensors: Record<string, number>): InfoLine[] {
  if (!suddenDeath && !(sensors['sudden_death'] > 0)) return [];
  const dist = sensors['zone.distance'];
  const reach = sensors['zone.time_to_reach'];
  if (dist === undefined && reach === undefined) return [{ label: 'Sudden death', value: 'walls closing' }];
  if ((dist !== undefined && dist < 0) || reach === 0) return [{ label: 'Zone', value: 'outside the wall, taking damage', hot: true }];
  const out: InfoLine[] = [];
  if (dist !== undefined) out.push({ label: 'Wall', value: `${Math.round(dist)} px away` });
  if (reach !== undefined) {
    out.push(reach >= ZONE_NEVER_S ? { label: 'Zone', value: 'safe here, the wall stops short' } : { label: 'Wall reaches here', value: `in ${reach.toFixed(1)} s`, hot: reach < 3 });
  }
  return out;
}
