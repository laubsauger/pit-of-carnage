/**
 * Words the sim puts on screen: kill stamps (1-3 words, set on every `kill` event), the broadcast
 * feed line for a kill (`killLine`) and for the arena's own moments (`announcements`: sudden
 * death, escalation, the judges, power-ups coming back), and bark line normalisation.
 *
 * Voice: a dry sports broadcast. Specific beats loud: name the weapon, the hazard, the mistake.
 * No emoji, no "obliterated". Fighters are named by their strategy name, so lines read
 * "Gary opened Brenda like a letter."
 */

import { BARK_RULES, MATCH_RULES, hashString } from '../core';
import type { BarkKind, FeedItem, GameEvent, HazardKind, KillCause, KillFlag, PickupKind, Rng, SkillId, Strategy, WeaponId, WorldState } from '../core';
import type { BarkLines } from './context';

type KillEvent = Extract<GameEvent, { type: 'kill' }>;

// ---------------------------------------------------------------------------------------------
// Kill stamps
// ---------------------------------------------------------------------------------------------

const WEAPON_STAMPS: Readonly<Record<WeaponId, readonly string[]>> = {
  GREATSWORD: ['SPLIT', 'HALVED', 'CLEAVED'],
  WARHAMMER: ['FLATTENED', 'TENDERIZED', 'BONK'],
  TWIN_DAGGERS: ['PERFORATED', 'SHANKED', 'STITCHED UP'],
  THROWING_AXES: ['AXED', 'CHOPPED', 'HEADS UP'],
  LONGBOW: ['PINNED', 'BULLSEYE', 'PINCUSHION'],
  ARCANE_STAFF: ['VAPORIZED', 'FIZZLED', 'DISINTEGRATED'],
};

const HAZARD_STAMPS: Readonly<Record<HazardKind, readonly string[]>> = {
  saw: ['SAWED', 'SLICED THIN'],
  spike: ['SKEWERED', 'KEBABBED'],
  acid: ['DISSOLVED', 'MELTED'],
  fire: ['TOASTED', 'WELL DONE'],
};

const SKILL_STAMPS: Readonly<Partial<Record<SkillId, readonly string[]>>> = {
  WHIRLWIND: ['BLENDED', 'SPUN OUT'],
  SHOCKWAVE: ['SLAMMED', 'PANCAKED'],
};

const STAMPS = {
  punch: ['KNOCKOUT', 'BARE HANDS'],
  keg: ['KABOOM', 'BLOWN UP'],
  friendly: ['FRIENDLY FIRE', 'TEAM KILL'],
  suddenDeath: ['CLOSED IN', 'NO ROOM'],
  reflect: ['PARRIED', 'RETURN TO SENDER'],
  revenge: ['PAYBACK', 'REVENGE'],
  clutch: ['CLUTCH', 'BY A HAIR'],
  skill: ['WRECKED'],
} as const;

export type StampInput = {
  cause: KillCause;
  weapon: WeaponId | null;
  skill: SkillId | null;
  hazard: HazardKind | null;
  flags: readonly KillFlag[];
  /** The victim killed themselves (their own keg). */
  self: boolean;
  /** Killer's kills inside the multi-kill window, including this one. */
  streak: number;
  /** The victim had killed one of the killer's squad: a revenge worth stamping (the `revenge` flag alone is common in duels). */
  avenged: boolean;
  /** The killer finished it nearly dead. */
  clutch: boolean;
};

/**
 * Kill stamp for the screen (1-3 words). The most specific fact wins: a multi-kill, then an own
 * goal, then what did it (hazard, keg, the wall), then how (parry, backstab, splash), then the weapon.
 */
export function killStamp(k: StampInput, rng: Rng): string {
  if (k.streak >= 4) return 'RAMPAGE';
  if (k.streak === 3) return 'TRIPLE KILL';
  if (k.streak === 2) return 'DOUBLE KILL';
  if (k.self) return 'OWN GOAL';
  if (k.cause === 'friendly') return rng.pick(STAMPS.friendly);
  if (k.cause === 'sudden_death') return k.flags.includes('crushed') ? 'CRUSHED' : rng.pick(STAMPS.suddenDeath);
  if (k.cause === 'hazard' && k.hazard) return rng.pick(HAZARD_STAMPS[k.hazard]);
  if (k.cause === 'keg') return rng.pick(STAMPS.keg);
  const has = (f: KillFlag) => k.flags.includes(f);
  if (has('reflect')) return rng.pick(STAMPS.reflect);
  if (has('backstab')) return 'BACKSTAB';
  if (has('splash')) return 'COLLATERAL';
  if (k.avenged) return rng.pick(STAMPS.revenge);
  if (k.clutch) return rng.pick(STAMPS.clutch);
  if (has('unseen') && rng.chance(0.4)) return 'NEVER SAW IT';
  if (has('overkill') && rng.chance(0.35)) return 'OVERKILL';
  if (k.cause === 'skill') return rng.pick((k.skill && SKILL_STAMPS[k.skill]) || STAMPS.skill);
  if (!k.weapon) return rng.pick(STAMPS.punch);
  return rng.pick(WEAPON_STAMPS[k.weapon]);
}

// ---------------------------------------------------------------------------------------------
// Feed lines
// ---------------------------------------------------------------------------------------------

const WEAPON_LINES: Readonly<Record<WeaponId, readonly string[]>> = {
  GREATSWORD: ['{k} opened {v} like a letter.', '{k} split {v} down the middle.', '{k} cleaved {v} into two smaller problems.'],
  WARHAMMER: ['{k} flattened {v} into a rug.', '{k} hammered {v} into the floor.', "{v} met {k}'s hammer at full speed."],
  TWIN_DAGGERS: ['{k} perforated {v}.', "{k} found every gap in {v}'s armour.", '{k} stabbed {v} faster than {v} could object.'],
  THROWING_AXES: ["{k} put an axe in {v}'s plans.", "{v} caught {k}'s axe. With their face.", '{k} threw. {v} stopped it the hard way.'],
  LONGBOW: ['{k} pinned {v} from across the pit.', "{v} took one of {k}'s arrows personally.", '{k} turned {v} into a pincushion.'],
  ARCANE_STAFF: ['{k} turned {v} into a small cloud.', '{v} absorbed one orb too many from {k}.', '{k} fizzled {v} out of existence.'],
};

const HAZARD_LINES: Readonly<Record<HazardKind, { credit: readonly string[]; solo: readonly string[] }>> = {
  saw: { credit: ['{k} fed {v} to the saw.', '{k} helped {v} into the saw.'], solo: ['{v} tripped into the saw.', '{v} lost an argument with the saw.'] },
  spike: { credit: ['{k} pushed {v} onto the spikes.'], solo: ['{v} found the spikes on the beat.', '{v} stepped on the spikes. Once.'] },
  acid: { credit: ['{k} shoved {v} into the acid.'], solo: ['{v} went for a swim in the acid.', '{v} stood in the acid a little too long.'] },
  fire: { credit: ['{k} cooked {v}.', '{k} knocked {v} into the fire.'], solo: ['{v} got too close to the fire.', '{v} is well done.'] },
};

const LINES = {
  punch: ['{k} punched {v} out with the arm they had left.', '{k} finished {v} bare-handed. Rude.'],
  backstab: ['{k} stabbed {v} in the back. {v} never turned around.', '{v} turned around too late. {k} was already done.'],
  reflect: ['{v} swung at {k} and lost the argument.', '{k} parried. {v} paid.'],
  splash: ["{v} stood too close to someone else's problem.", '{k} hit the floor near {v}. Close enough.'],
  WHIRLWIND: ['{k} spun through {v} like a blender.', "{v} got caught in {k}'s spin cycle."],
  SHOCKWAVE: ['{k} slammed {v} flat.', "{k}'s shield met all of {v} at once."],
  skill: ['{k} used a skill on {v}. It worked.'],
  kegSelf: ['{v} was hit by their own keg. Classic {v}.', '{v} lit the keg and forgot to leave.'],
  kegCredit: ['{k} lit the keg. {v} was standing next to it.', '{k} blew {v} across the pit.'],
  kegSolo: ['{v} found the keg the hard way.'],
  suddenDeath: ['The walls closed on {v}.', '{v} ran out of arena.'],
  crushed: ['The wall pressed {v} flat against the furniture.', '{v} got caught between a wall and a harder wall.', 'The walls folded {v} like a deckchair.'],
  friendly: ['{k} dropped teammate {v}. Awkward.', '{k} killed {v}. They were on the same side.'],
} as const;

function fill(template: string, k: string, v: string): string {
  return template.replaceAll('{k}', k).replaceAll('{v}', v);
}

/**
 * Broadcast line for a kill event, e.g. "Gary opened Brenda like a letter." Deterministic (the
 * variant comes from the victim and tick), so replays and seeks print the same feed.
 * `state` is any state of the same match (names, the killer's skill and hazards are read from it).
 */
export function killLine(ev: KillEvent, state: WorldState): string {
  const name = (id: string | null) => (id ? (state.fighters.find((f) => f.id === id)?.name ?? id) : '');
  const k = name(ev.killerId);
  const v = name(ev.victimId);
  const pick = (xs: readonly string[]) => xs[hashString(`${ev.victimId}:${ev.tick}`) % xs.length]!;
  const say = (xs: readonly string[]) => fill(pick(xs), k, v);
  const has = (f: KillFlag) => ev.flags.includes(f);

  if (ev.cause === 'sudden_death') return say(has('crushed') ? LINES.crushed : LINES.suddenDeath);
  if (ev.cause === 'hazard') {
    const lines = HAZARD_LINES[ev.hazard ?? 'spike'];
    return say(ev.killerId ? lines.credit : lines.solo);
  }
  if (ev.cause === 'keg') return say(ev.killerId === ev.victimId ? LINES.kegSelf : ev.killerId ? LINES.kegCredit : LINES.kegSolo);
  if (ev.cause === 'friendly') return say(LINES.friendly);
  if (has('reflect')) return say(LINES.reflect);
  if (has('backstab')) return say(LINES.backstab);
  if (has('splash')) return say(LINES.splash);
  if (ev.cause === 'skill') {
    const skill = state.fighters.find((f) => f.id === ev.killerId)?.skill;
    return say(skill === 'WHIRLWIND' || skill === 'SHOCKWAVE' ? LINES[skill] : LINES.skill);
  }
  if (!ev.weapon) return say(LINES.punch);
  return say(WEAPON_LINES[ev.weapon]);
}

// ---------------------------------------------------------------------------------------------
// Announcer
// ---------------------------------------------------------------------------------------------

const ANNOUNCE = {
  time: ['The walls are closing. Somebody do something.', 'Time. The walls are coming in.', 'Out of time. The walls are moving in to help.'],
  stalemate: [
    'Fifteen seconds without a scratch. The walls are coming in to help.',
    'Nobody has hit anybody in fifteen seconds. The walls are closing.',
    'All this politeness. The walls will settle it.',
  ],
  closed: ['The walls have stopped. Outside them it gets worse every second.', 'That is as small as it gets. The wall bites harder every second now.'],
  everywhere: ['Nowhere is safe now. The whole floor bites.', 'The floor itself is hurting people now. Finish it.'],
  judges: ['The judges give it to {w}, {hp}% health left.', 'Time. The judges have it for {w}, still on {hp}% health.'],
} as const;

/** Line for a shrine heal: who, and how much it gave back ({n} name, {a} HP gained). */
const SHRINE_LINES: readonly string[] = [
  '{n} patched up at the shrine, {a} health back.',
  '{n} stopped at the shrine for {a} health.',
  'The shrine put {a} health back into {n}.',
];

/** Line for a power-up coming back, per kind ("Berserk is up."). */
const PICKUP_LINES: Readonly<Record<PickupKind, readonly string[]>> = {
  berserk: ['Berserk is up.', 'Berserk is back on the pedestal.'],
  haste: ['Haste is up.', 'Haste is back on the pedestal.'],
};

/**
 * Broadcast lines for the arena's own moments in one tick's events, in the feed's voice: sudden
 * death (time or stalemate), the wall stopping and the damage reaching everywhere, a judges'
 * decision, power-ups coming back (several pedestals of one kind in the same tick make one
 * line) and shrine heals. Kills have `killLine`. Deterministic like `killLine`: the same events
 * give the same lines. Kinds: 'sudden_death' (sudden death, escalation, judges), 'pickup' and 'heal'.
 */
export function announcements(events: readonly GameEvent[], state: WorldState): FeedItem[] {
  const out: FeedItem[] = [];
  const pick = (xs: readonly string[], tick: number, salt: string) => xs[hashString(`${salt}:${tick}`) % xs.length]!;
  let pickupsSaid = 0;
  for (const e of events) {
    switch (e.type) {
      case 'sudden_death':
        out.push({ tick: e.tick, text: pick(ANNOUNCE[e.reason], e.tick, 'sd'), kind: 'sudden_death', ids: [] });
        break;
      case 'escalation':
        if (e.level === 1) out.push({ tick: e.tick, text: pick(ANNOUNCE.closed, e.tick, 'esc'), kind: 'sudden_death', ids: [] });
        // Only the first level that reaches inside the zone (the one before it did not).
        else if (e.everywhere && (e.level - 2) * MATCH_RULES.escalationStepTicks < MATCH_RULES.escalationEverywhereTicks) {
          out.push({ tick: e.tick, text: pick(ANNOUNCE.everywhere, e.tick, 'esc'), kind: 'sudden_death', ids: [] });
        }
        break;
      case 'judges_decision': {
        const w = e.survivors[0];
        if (!w) break;
        const name = state.fighters.find((f) => f.id === w.id)?.name ?? w.id;
        const text = pick(ANNOUNCE.judges, e.tick, 'judges').replace('{w}', name).replace('{hp}', String(Math.round(w.hpFraction * 100)));
        out.push({ tick: e.tick, text, kind: 'sudden_death', ids: e.survivors.map((s) => s.id) });
        break;
      }
      case 'pickup_spawn': {
        const bit = e.kind === 'berserk' ? 1 : 2;
        if (pickupsSaid & bit) break;
        pickupsSaid |= bit;
        out.push({ tick: e.tick, text: pick(PICKUP_LINES[e.kind], e.tick, e.kind), kind: 'pickup', ids: [] });
        break;
      }
      case 'heal': {
        if (e.shrineId === null) break;
        const name = state.fighters.find((f) => f.id === e.fighterId)?.name ?? e.fighterId;
        const text = pick(SHRINE_LINES, e.tick, e.fighterId).replace('{n}', name).replace('{a}', String(Math.round(e.amount)));
        out.push({ tick: e.tick, text, kind: 'heal', ids: [e.fighterId] });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** A strategy's barks as arrays, trimmed to BARK_RULES.maxLength, empty lines dropped. */
export function barkLines(strategy: Strategy): BarkLines {
  const out: BarkLines = {};
  const src = strategy.barks ?? {};
  for (const kind of Object.keys(src) as BarkKind[]) {
    const raw = src[kind];
    const list = (typeof raw === 'string' ? [raw] : (raw ?? []))
      .map((s) => s.trim().slice(0, BARK_RULES.maxLength))
      .filter((s) => s.length > 0);
    if (list.length > 0) out[kind] = list;
  }
  return out;
}
