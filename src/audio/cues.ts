// Owned by: audio
/**
 * Which sounds a game event makes. Pure: takes an event and the state it arrived with and appends
 * cues (sound, gain, pan, pitch, intensity, delay). The engine turns cues into voices; nothing here
 * touches WebAudio, so the mapping is tested headless.
 */

import { LIVE_EVENT_TICKS, MATCH_RULES, TICK_HZ, WEAPONS } from '../core';
import type { GameEvent, HazardKind, MatchSignal, PickupKind, PropKind, SkillId, WeaponId, WorldState } from '../core';
import type { VoiceGroup } from './mix';

export type SoundId =
  // Melee swings (the whoosh lands on the strike) and ranged windups.
  | 'swing_greatsword' | 'swing_warhammer' | 'swing_daggers' | 'swing_punch'
  | 'swing_axe' | 'draw_bow' | 'charge_staff'
  // Projectiles leaving.
  | 'release_bow' | 'release_axe' | 'release_staff'
  // Blows landing on a fighter, one per kind of impact.
  | 'hit_blade' | 'hit_hammer' | 'hit_dagger' | 'hit_arrow' | 'hit_axe' | 'hit_arcane' | 'hit_punch' | 'hit_flesh'
  | 'crit_crunch' | 'backstab_shink'
  // Projectiles stopped by a wall, pillar, prop or shield.
  | 'thunk_arrow' | 'clang_axe' | 'burst_orb'
  | 'parry' | 'dismember' | 'death_splat' | 'crush' | 'kill_sting' | 'final_sting' | 'crowd_roar' | 'explosion'
  // Sparse crowd reactions (crowd.ts decides when).
  | 'crowd_gasp' | 'crowd_whistle' | 'crowd_boo' | 'crowd_chant'
  | 'skill_whirlwind' | 'skill_shadowstep' | 'skill_dash' | 'skill_shockwave' | 'skill_bloodrage' | 'skill_hook' | 'skill_second_wind'
  | 'footstep' | 'footstep_wet'
  | 'pickup_haste' | 'pickup_berserk' | 'pickup_ammo' | 'spawn_haste' | 'spawn_berserk' | 'heal'
  // Stuck arrows and axes: pulled out of a wall or prop, and clattering to the floor when what held them goes.
  | 'ammo_yank' | 'ammo_clatter'
  | 'hazard_spike' | 'hazard_saw' | 'hazard_acid' | 'hazard_fire'
  | 'break_keg' | 'break_amphora' | 'break_crate'
  | 'wall_grind' | 'zone_burn' | 'horn' | 'escalation' | 'gong' | 'bell'
  // Match signals from the controller: the round-start countdown and FIGHT.
  | 'countdown' | 'fight';

/** Which bus a sound feeds and how much it ducks the others. */
export type DuckSpec = { sfx: number; amb: number; hold: number };

export type SoundSpec = {
  group: VoiceGroup;
  /** Higher survives voice stealing. Footsteps are the first to go, the kill sting the last. */
  priority: number;
  /** Nominal length in seconds at normal speed (the limiter's estimate before the voice is built). */
  dur: number;
  /** Repeats of this sound closer than this (seconds) are dropped. */
  minGap: number;
  /** Seconds from the voice start to its main moment (a swing's whoosh peak), so it can land on time. */
  lead: number;
  duck: DuckSpec | null;
};

function spec(group: VoiceGroup, priority: number, dur: number, minGap = 0, lead = 0, duck: DuckSpec | null = null): SoundSpec {
  return { group, priority, dur, minGap, lead, duck };
}

export const SOUND_SPECS: Readonly<Record<SoundId, SoundSpec>> = {
  swing_greatsword: spec('swing', 35, 0.4, 0.025, 0.19),
  swing_warhammer: spec('swing', 35, 0.48, 0.025, 0.24),
  swing_daggers: spec('swing', 34, 0.24, 0.025, 0.07),
  swing_punch: spec('swing', 30, 0.16, 0.025, 0.07),
  swing_axe: spec('swing', 30, 0.2, 0.025),
  draw_bow: spec('swing', 30, 0.36, 0.025),
  charge_staff: spec('swing', 30, 0.36, 0.025),
  release_bow: spec('misc', 42, 0.3, 0.02),
  release_axe: spec('misc', 42, 0.42, 0.02),
  release_staff: spec('misc', 42, 0.34, 0.02),
  hit_blade: spec('impact', 60, 0.36, 0.03),
  hit_hammer: spec('impact', 62, 0.45, 0.03),
  hit_dagger: spec('impact', 60, 0.3, 0.03),
  hit_arrow: spec('impact', 60, 0.3, 0.03),
  hit_axe: spec('impact', 60, 0.4, 0.03),
  hit_arcane: spec('impact', 60, 0.5, 0.03),
  hit_punch: spec('impact', 55, 0.22, 0.03),
  hit_flesh: spec('impact', 50, 0.3, 0.04),
  crit_crunch: spec('impact', 58, 0.25, 0.05),
  backstab_shink: spec('impact', 58, 0.35, 0.05),
  thunk_arrow: spec('impact', 45, 0.32, 0.03),
  clang_axe: spec('impact', 45, 0.6, 0.03),
  burst_orb: spec('impact', 48, 0.5, 0.04),
  parry: spec('big', 70, 0.85, 0.04),
  dismember: spec('big', 80, 0.6, 0.04),
  death_splat: spec('big', 90, 1.1),
  crush: spec('big', 92, 1, 0.1),
  kill_sting: spec('big', 95, 0.95, 0.08, 0, { sfx: 0.45, amb: 0.6, hold: 0.3 }),
  final_sting: spec('signal', 100, 4.4, 1, 0, { sfx: 0.5, amb: 0.7, hold: 1.4 }),
  crowd_roar: spec('crowd', 88, 4.6, 0.25, 0, { sfx: 0, amb: 0.75, hold: 1.5 }),
  crowd_gasp: spec('crowd', 60, 1.4, 0.5),
  crowd_whistle: spec('crowd', 50, 1.1, 0.5),
  crowd_boo: spec('crowd', 55, 2.8, 0.5),
  crowd_chant: spec('crowd', 70, 5, 1),
  explosion: spec('big', 85, 2.1, 0.05, 0, { sfx: 0.2, amb: 0.55, hold: 0.5 }),
  skill_whirlwind: spec('misc', 55, 0.85, 0.05),
  skill_shadowstep: spec('misc', 55, 0.7, 0.05, 0.22),
  skill_dash: spec('misc', 55, 0.4, 0.05),
  skill_shockwave: spec('misc', 58, 0.9, 0.05),
  skill_bloodrage: spec('misc', 58, 1.1, 0.05),
  skill_hook: spec('misc', 56, 0.6, 0.05),
  skill_second_wind: spec('misc', 52, 1.2, 0.05),
  footstep: spec('step', 5, 0.09, 0.07),
  footstep_wet: spec('step', 6, 0.12, 0.07),
  pickup_haste: spec('misc', 65, 0.7),
  pickup_berserk: spec('misc', 65, 0.9),
  pickup_ammo: spec('misc', 25, 0.14, 0.12),
  ammo_yank: spec('misc', 26, 0.2, 0.1),
  ammo_clatter: spec('misc', 22, 0.4, 0.07),
  spawn_haste: spec('signal', 70, 1.5, 0.1),
  spawn_berserk: spec('signal', 70, 1.6, 0.1),
  heal: spec('misc', 45, 1.1, 0.1),
  hazard_spike: spec('misc', 30, 0.32, 0.08),
  hazard_saw: spec('misc', 30, 0.28, 0.16),
  hazard_acid: spec('misc', 30, 0.5, 0.15),
  hazard_fire: spec('misc', 30, 0.5, 0.15),
  break_keg: spec('misc', 50, 0.4),
  break_amphora: spec('misc', 50, 0.45),
  break_crate: spec('misc', 50, 0.4),
  wall_grind: spec('misc', 20, 0.32, 0.28),
  zone_burn: spec('misc', 18, 0.4, 0.3),
  horn: spec('signal', 100, 3.2, 0.5, 0, { sfx: 0.5, amb: 0.7, hold: 1.6 }),
  escalation: spec('signal', 75, 0.55, 0.2),
  gong: spec('signal', 100, 4.6, 0.5, 0, { sfx: 0.35, amb: 0.6, hold: 1.2 }),
  bell: spec('signal', 100, 1.8, 0.5, 0, { sfx: 0.3, amb: 0.3, hold: 0.8 }),
  countdown: spec('signal', 100, 1.1, 0.2),
  fight: spec('signal', 100, 2.6, 0.5, 0, { sfx: 0.3, amb: 0.5, hold: 0.6 }),
};

/**
 * Level trim per sound (dB), calibrated from offline renders (src/audio/dev, "Run offline checks"):
 * recipes come out at very different levels, so this lines each one up with its target before the
 * cue's own gain adds the dynamics. Targets, as peak dBFS at the default volume: ordinary hits
 * -14..-9, swings and releases -20..-15, kills, stings and announcer beats -6..-3, crowd reactions
 * about -11, footsteps about -35. Re-measure after changing a recipe.
 */
export const TRIM_DB: Readonly<Partial<Record<SoundId, number>>> = {
  swing_greatsword: -4,
  swing_warhammer: -2.5,
  swing_daggers: 0.5,
  swing_axe: 5.5,
  draw_bow: 4,
  swing_punch: 8,
  release_bow: 6.5,
  release_axe: 2,
  release_staff: 7.5,
  hit_blade: 7,
  hit_hammer: 8.5,
  hit_dagger: 11.5,
  hit_arrow: 10,
  hit_axe: 8.5,
  hit_arcane: 12,
  hit_punch: 10,
  hit_flesh: 10,
  crit_crunch: 10.5,
  backstab_shink: 15.5,
  thunk_arrow: 13,
  clang_axe: 6.5,
  burst_orb: 9,
  parry: 4.5,
  crowd_roar: -2.5,
  skill_whirlwind: -1.5,
  skill_shadowstep: -4,
  skill_dash: -2.5,
  skill_bloodrage: -6,
  footstep: 8.5,
  footstep_wet: 10,
  pickup_haste: -3.5,
  pickup_berserk: -4.5,
  pickup_ammo: 16.5,
  spawn_berserk: -1,
  hazard_spike: 13.5,
  hazard_saw: -2,
  hazard_fire: 1,
  break_keg: 9,
  break_amphora: 6.5,
  break_crate: 1.5,
  wall_grind: 15,
  zone_burn: 8,
  escalation: 7,
  bell: -1.5,
  countdown: 3,
  crowd_gasp: -10.5,
  crowd_whistle: 3,
  crowd_boo: -8,
  crowd_chant: -7,
};

/** Linear gain of a sound's trim. */
export function trimGain(sound: SoundId): number {
  return Math.pow(10, (TRIM_DB[sound] ?? 0) / 20);
}

/** One sound to play. */
export type Cue = {
  sound: SoundId;
  /** Linear gain on the voice (about 0..1). */
  gain: number;
  /** Stereo position -1 (left) .. 1 (right). */
  pan: number;
  /** Pitch (and tempo) multiplier on top of the slow-motion bend: variation, or a musical step. */
  pitch: number;
  /** Sound-specific size 0..1: damage dealt, crowd drama, blast size, escalation level. */
  intensity: number;
  /** Game seconds to wait before playing (a swing's whoosh lands on the strike, not the windup). */
  delay: number;
  /** Sound-specific choice (the chant's style); 0 when absent. */
  variant?: number;
};

/** What the mapping remembers between events (a projectile's weapon, the escalation stage, wall contact). */
export type CueMemory = {
  projectiles: Map<string, WeaponId>;
  everywhereSeen: boolean;
  /** Fighter id -> last tick it touched the closing wall. */
  contacts: Map<string, number>;
};

export function createCueMemory(): CueMemory {
  return { projectiles: new Map(), everywhereSeen: false, contacts: new Map() };
}

/**
 * Note every wall contact in a batch before mapping it, so a fighter's wall damage sounds as
 * spikes whether its `hit` comes before or after its `wall_contact` in the batch.
 */
export function rememberContacts(events: readonly GameEvent[], memory: CueMemory): void {
  for (const ev of events) if (ev.type === 'wall_contact') memory.contacts.set(ev.fighterId, ev.tick);
}

/**
 * The grinding at the closing wall in one batch: how many fighters scrape along it (0 = none) and
 * where they are on average. The engine holds a continuous grind loop open while this is non-zero;
 * contact arrives every tick, so retriggering a sound per contact would machine-gun.
 */
export function wallContact(events: readonly GameEvent[], state: WorldState): { fighters: number; pan: number } {
  const seen = new Set<string>();
  let pan = 0;
  for (const ev of events) {
    if (ev.type !== 'wall_contact' || !isLive(ev, state) || seen.has(ev.fighterId)) continue;
    seen.add(ev.fighterId);
    pan += panForX(ev.pos.x, state);
  }
  return { fighters: seen.size, pan: seen.size > 0 ? pan / seen.size : 0 };
}

/** Events older than this relative to their state are catch-up from a seek: they make no sound. */
export function isLive(ev: GameEvent, state: WorldState): boolean {
  return state.tick - ev.tick <= LIVE_EVENT_TICKS;
}

/** How far the stereo image spreads (1 = hard left/right at the walls). */
export const PAN_WIDTH = 0.65;

/**
 * Stereo position for a world x. The arena's final zone is centred on the map, so its centre is
 * half the map width (this works before and during sudden death without the map itself).
 */
export function panForX(x: number, state: WorldState): number {
  const f = state.suddenDeath.final;
  const cx = f.x + f.w / 2;
  if (!(cx > 0) || !Number.isFinite(x)) return 0;
  return Math.min(Math.max((x - cx) / cx, -1), 1) * PAN_WIDTH;
}

type KillEvent = Extract<GameEvent, { type: 'kill' }>;

/**
 * How loud the crowd goes for a kill, 0..1: the last kill of the match is the loudest; multi-kills,
 * style (backstab, overkill, revenge, unseen) and a thinning field push it up.
 */
export function killDrama(ev: KillEvent, state: WorldState, finalKill: boolean): number {
  if (finalKill) return 1;
  let d = 0.35;
  if (ev.flags.includes('multi')) d += 0.3;
  for (const flag of ['backstab', 'overkill', 'revenge', 'unseen'] as const) if (ev.flags.includes(flag)) d += 0.07;
  const n = state.fighters.length;
  if (n > 2) {
    let alive = 0;
    for (const f of state.fighters) if (f.alive) alive++;
    d += 0.25 * (1 - Math.max(0, alive - 1) / (n - 1));
  }
  return Math.min(Math.max(d, 0), 1);
}

/**
 * How much action energy an event gives the crowd (0 = none). The crowd director adds it with a
 * soft ceiling and lets it cool within seconds, so a steady exchange of blows keeps the crowd up
 * and a lull lets it fall nearly silent. Wall damage arrives every tick of contact: almost nothing
 * each, or the crowd would boil over from one fighter leaning on the spikes.
 */
export function excitementBump(ev: GameEvent): number {
  switch (ev.type) {
    case 'hit':
      if (ev.source === 'sudden_death') return 0.004;
      if (ev.source === 'hazard') return 0.03;
      return Math.min(0.15, ev.amount / 180);
    case 'kill':
      return 0.45;
    case 'dismember':
      return 0.25;
    case 'explosion':
      return 0.25;
    case 'sudden_death':
      return 0.3;
    case 'parry':
      return 0.08;
    case 'escalation':
      return 0.05;
    default:
      return 0;
  }
}

const SWING: Readonly<Record<WeaponId, SoundId>> = {
  GREATSWORD: 'swing_greatsword',
  WARHAMMER: 'swing_warhammer',
  TWIN_DAGGERS: 'swing_daggers',
  THROWING_AXES: 'swing_axe',
  LONGBOW: 'draw_bow',
  ARCANE_STAFF: 'charge_staff',
};

const IMPACT: Readonly<Record<WeaponId, SoundId>> = {
  GREATSWORD: 'hit_blade',
  WARHAMMER: 'hit_hammer',
  TWIN_DAGGERS: 'hit_dagger',
  THROWING_AXES: 'hit_axe',
  LONGBOW: 'hit_arrow',
  ARCANE_STAFF: 'hit_arcane',
};

const RELEASE: Partial<Record<WeaponId, SoundId>> = {
  LONGBOW: 'release_bow',
  THROWING_AXES: 'release_axe',
  ARCANE_STAFF: 'release_staff',
};

/** A projectile that hit nothing alive: an arrow in the wall, an axe on stone, an orb bursting. */
const SURFACE: Partial<Record<WeaponId, SoundId>> = {
  LONGBOW: 'thunk_arrow',
  THROWING_AXES: 'clang_axe',
  ARCANE_STAFF: 'burst_orb',
};

const SKILL: Readonly<Record<SkillId, SoundId>> = {
  WHIRLWIND: 'skill_whirlwind',
  SHADOWSTEP: 'skill_shadowstep',
  DASH: 'skill_dash',
  SHOCKWAVE: 'skill_shockwave',
  BLOODRAGE: 'skill_bloodrage',
  HOOK: 'skill_hook',
  SECOND_WIND: 'skill_second_wind',
};

const HAZARD: Readonly<Record<HazardKind, SoundId>> = {
  spike: 'hazard_spike',
  saw: 'hazard_saw',
  acid: 'hazard_acid',
  fire: 'hazard_fire',
};

const BREAK: Readonly<Record<PropKind, SoundId>> = {
  keg: 'break_keg',
  amphora: 'break_amphora',
  crate: 'break_crate',
};

const SPAWN: Readonly<Record<PickupKind, SoundId>> = { haste: 'spawn_haste', berserk: 'spawn_berserk' };

/** Punch windup in ticks (the sim's punch is not in the rule tables). */
const PUNCH_WINDUP_TICKS = 7;

/** Escalation level at which the escalated damage starts hitting everyone. */
const EVERYWHERE_LEVEL = 1 + Math.floor(MATCH_RULES.escalationEverywhereTicks / MATCH_RULES.escalationStepTicks);

/** Semitone step for the kill sting: multi-kills climb. The final kill has its own sting. */
const STING_MULTI = Math.pow(2, 3 / 12);

function fighterById(state: WorldState, id: string | null): WorldState['fighters'][number] | null {
  if (id === null) return null;
  for (const f of state.fighters) if (f.id === id) return f;
  return null;
}

/** Small random pitch spread so repeated sounds never machine-gun. `rand` returns 0..1. */
function vary(rand: () => number, spread: number): number {
  return 1 + (rand() * 2 - 1) * spread;
}

/**
 * Append the cues for one event. `finalKill`: this kill ends the match (also read from the kill's
 * own `final`): it gets the final sting and the loudest roar. Stale events (catch-up after a seek)
 * only update memory. `rand` is cosmetic randomness.
 */
export function cuesForEvent(
  ev: GameEvent,
  state: WorldState,
  memory: CueMemory,
  finalKill: boolean,
  out: Cue[],
  rand: () => number = Math.random,
): void {
  // Memory first, live or not: a projectile_end has no weapon of its own.
  if (ev.type === 'projectile') {
    if (memory.projectiles.size > 512) memory.projectiles.clear();
    memory.projectiles.set(ev.projectileId, ev.weapon);
  }
  let projectileWeapon: WeaponId | undefined;
  if (ev.type === 'projectile_end') {
    projectileWeapon = memory.projectiles.get(ev.projectileId);
    memory.projectiles.delete(ev.projectileId);
  }
  if (ev.type === 'sudden_death') memory.everywhereSeen = false;
  if (ev.type === 'wall_contact') memory.contacts.set(ev.fighterId, ev.tick);
  if (!isLive(ev, state)) return;

  const push = (sound: SoundId, gain: number, pan: number, pitch = 1, intensity = 0.5, delay = 0): void => {
    out.push({ sound, gain, pan, pitch, intensity, delay });
  };

  switch (ev.type) {
    case 'swing': {
      const f = fighterById(state, ev.fighterId);
      const w = WEAPONS[ev.weapon];
      const punching = f !== null && (!f.limbs.armR || (w.family === 'ranged' && f.ammo <= 0));
      const sound = punching ? 'swing_punch' : SWING[ev.weapon];
      const pan = f ? panForX(f.pos.x, state) : 0;
      // Melee whooshes peak on the strike tick; ranged windups (draw, charge) start right away.
      const windup = (punching ? PUNCH_WINDUP_TICKS : w.windup) / TICK_HZ;
      const delay = punching || w.family === 'melee' ? Math.max(0, windup - SOUND_SPECS[sound].lead) : 0;
      push(sound, w.family === 'ranged' && !punching ? 0.45 : 0.6, pan, vary(rand, 0.05), 0.5, delay);
      break;
    }
    case 'projectile': {
      const sound = RELEASE[ev.weapon];
      if (sound) push(sound, 0.65, panForX(ev.pos.x, state), vary(rand, 0.04));
      break;
    }
    case 'projectile_end': {
      if (!projectileWeapon) break;
      const pan = panForX(ev.pos.x, state);
      // A hit on a fighter sounds through its `hit` event; only the staff's splash bursts on top.
      if (ev.hitId === null) {
        const sound = SURFACE[projectileWeapon];
        if (sound) push(sound, 0.55, pan, vary(rand, 0.06));
      } else if (projectileWeapon === 'ARCANE_STAFF') {
        push('burst_orb', 0.45, pan, vary(rand, 0.06));
      }
      break;
    }
    case 'hit': {
      const pan = panForX(ev.pos.x, state);
      if (ev.source === 'sudden_death') {
        // Pressed into the spikes (the grind loop carries the scrape), or the floor biting everyone.
        const touching = (memory.contacts.get(ev.victimId) ?? -Infinity) >= ev.tick - 1;
        if (touching) push('wall_grind', 0.45, pan, vary(rand, 0.06));
        else push('zone_burn', 0.4, pan, vary(rand, 0.08));
        break;
      }
      // Bigger blows are louder and a little deeper.
      const size = Math.min(Math.max(ev.amount / 40, 0.15), 1);
      let sound: SoundId = 'hit_flesh';
      if (ev.source === 'punch') sound = 'hit_punch';
      else if ((ev.source === 'weapon' || ev.source === 'reflect') && ev.weapon) sound = IMPACT[ev.weapon];
      else if (ev.source === 'skill') {
        const skill = fighterById(state, ev.attackerId)?.skill;
        sound = skill === 'WHIRLWIND' ? 'hit_blade' : skill === 'SHOCKWAVE' ? 'hit_hammer' : 'hit_flesh';
      }
      const gain = (0.5 + 0.5 * size) * (ev.source === 'hazard' || ev.source === 'keg' ? 0.7 : 1);
      push(sound, gain, pan, (1.06 - 0.12 * size) * vary(rand, 0.04), size);
      if (ev.crit) push('crit_crunch', 0.8, pan, vary(rand, 0.05), size);
      if (ev.backstab) push('backstab_shink', 0.7, pan, vary(rand, 0.04), size);
      break;
    }
    case 'parry':
      push('parry', 0.8, panForX(ev.pos.x, state), vary(rand, 0.08));
      break;
    case 'dismember':
      push('dismember', 0.9, panForX(ev.pos.x, state), vary(rand, 0.06));
      break;
    case 'kill': {
      const pan = panForX(ev.pos.x, state);
      const final = finalKill || ev.final;
      const drama = killDrama(ev, state, final);
      if (ev.flags.includes('crushed')) push('crush', 1, pan, vary(rand, 0.04), 1);
      push('death_splat', 1, pan, vary(rand, 0.05), ev.flags.includes('overkill') ? 1 : 0.6);
      if (final) push('final_sting', 0.9, 0, 1, 1);
      else push('kill_sting', 0.85, 0, ev.flags.includes('multi') ? STING_MULTI : 1, drama);
      push('crowd_roar', 0.5 + 0.5 * drama, 0, vary(rand, 0.03), drama, 0.08);
      break;
    }
    case 'explosion': {
      const size = Math.min(Math.max(ev.radius / 106, 0.4), 1.5) / 1.5;
      push('explosion', 0.65 + 0.35 * size, panForX(ev.pos.x, state), vary(rand, 0.05) * (1.1 - 0.2 * size), size);
      break;
    }
    case 'skill':
      push(SKILL[ev.skill], 0.75, panForX(ev.pos.x, state), vary(rand, 0.04));
      break;
    case 'footstep':
      push(ev.bloody ? 'footstep_wet' : 'footstep', 0.14, panForX(ev.pos.x, state), vary(rand, 0.12), 0.5);
      break;
    case 'pickup': {
      const pan = panForX(ev.pos.x, state);
      if (ev.kind === 'haste') push('pickup_haste', 0.75, pan);
      else if (ev.kind === 'berserk') push('pickup_berserk', 0.8, pan);
      else push('pickup_ammo', 0.35, pan, ev.kind === 'axe' ? 0.8 : 1.15);
      break;
    }
    case 'pickup_spawn':
      push(SPAWN[ev.kind], 0.6, panForX(ev.pos.x, state));
      break;
    case 'heal':
      // A shrine's blessing shimmers fuller (a choir under the bells) than any other heal.
      push('heal', 0.5, panForX(ev.pos.x, state), vary(rand, 0.02), ev.shrineId !== null ? 1 : 0.45);
      break;
    case 'hazard': {
      const kind = state.hazards.find((h) => h.id === ev.hazardId)?.kind;
      if (kind) push(HAZARD[kind], ev.victimId === null ? 0.35 : 0.7, panForX(ev.pos.x, state), vary(rand, 0.05));
      break;
    }
    case 'prop_break':
      push(BREAK[ev.kind], 0.75, panForX(ev.pos.x, state), vary(rand, 0.05));
      break;
    case 'sudden_death':
      push('horn', 0.9, 0);
      push('crowd_roar', 0.45, 0, 0.92, 0.25, 0.6);
      break;
    case 'escalation': {
      const level = Math.max(1, ev.level);
      push('escalation', 0.45 + 0.04 * Math.min(level, 10), 0, 1 + 0.025 * Math.min(level, 12), Math.min(level / 10, 1));
      if (ev.everywhere && !memory.everywhereSeen) push('horn', 0.6, 0, Math.pow(2, 3 / 12), 0.5, 0.15);
      if (ev.everywhere || level >= EVERYWHERE_LEVEL) memory.everywhereSeen = true;
      break;
    }
    case 'judges_decision':
      push('gong', 0.85, 0);
      push('crowd_roar', 0.5, 0, 0.95, 0.4, 0.7);
      break;
    case 'match_end':
      // The bell rings after the final kill's sting.
      push('bell', 0.7, 0, 1, 0.5, 0.35);
      if (ev.ending !== 'elimination') push('crowd_roar', 0.75, 0, 1, 0.6, 0.5);
      break;
    case 'ammo_unstick': {
      const pan = panForX(ev.pos.x, state);
      // A pull out of the wood (the pickup's own chime follows), or the shafts hitting the floor
      // when the body or prop holding them is gone. Axes sound heavier and lower.
      if (ev.reason === 'pickup') push('ammo_yank', 0.4, pan, (ev.kind === 'axe' ? 0.8 : 1) * vary(rand, 0.08));
      else push('ammo_clatter', 0.35, pan, (ev.kind === 'axe' ? 0.75 : 1.1) * vary(rand, 0.1), ev.kind === 'axe' ? 1 : 0);
      break;
    }
    case 'bark':
    case 'wall_contact':
    case 'ammo_stick':
      // A stick sounds through its projectile_end (the thunk with its quiver) or the hit it made.
      break;
  }
}

/** Semitones the countdown climbs per beat (3, 2, 1: tension rising into FIGHT). */
const COUNTDOWN_STEP = 2;

/** Cues for a match signal (real time, never bent by slow motion except the crowd's roar). */
export function cuesForSignal(signal: MatchSignal, out: Cue[]): void {
  switch (signal.type) {
    case 'countdown': {
      const v = Math.min(Math.max(Math.round(signal.value), 1), 3);
      out.push({ sound: 'countdown', gain: 0.8, pan: 0, pitch: Math.pow(2, ((3 - v) * COUNTDOWN_STEP) / 12), intensity: (3 - v) / 2, delay: 0 });
      break;
    }
    case 'fight':
      out.push({ sound: 'fight', gain: 0.95, pan: 0, pitch: 1, intensity: 1, delay: 0 });
      out.push({ sound: 'crowd_roar', gain: 0.6, pan: 0, pitch: 1, intensity: 0.55, delay: 0.05 });
      break;
    case 'final_kill':
      out.push({ sound: 'final_sting', gain: 0.9, pan: 0, pitch: 1, intensity: 1, delay: 0 });
      break;
    case 'victory':
      // The winner's moment: one big roar (the kill's own roar in the same frame counts as it: the
      // mixer drops a second roar that close).
      out.push({ sound: 'crowd_roar', gain: 1, pan: 0, pitch: 1, intensity: signal.winnerIds.length > 0 ? 1 : 0.6, delay: 0.05 });
      break;
    case 'end_card':
      // Not a sound: the driver hushes the arena while the card is up.
      break;
  }
}

/**
 * The final sting plays once per final kill. The kill event (with `final`) and the controller's
 * `final_kill` signal arrive in the same frame in either order; whichever comes first plays it.
 * A replay of the same match after `windowSec` may play it again.
 */
export class FinalGate {
  private victim: string | null = null;
  private at = -Infinity;

  constructor(readonly windowSec = 5) {}

  take(victimId: string, now: number): boolean {
    if (this.victim === victimId && now - this.at < this.windowSec) return false;
    this.victim = victimId;
    this.at = now;
    return true;
  }

  reset(): void {
    this.victim = null;
    this.at = -Infinity;
  }
}

/** Index of the kill that ends the match in this batch (the last kill before an elimination), or -1. */
export function finalKillIndex(events: readonly GameEvent[]): number {
  let lastKill = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.type === 'kill') lastKill = i;
    else if (e.type === 'match_end') return e.ending === 'elimination' ? lastKill : -1;
  }
  return -1;
}
