// Owned by: audio
/**
 * Which sounds a game event makes. Pure: takes an event and the state it arrived with and appends
 * cues (sound, gain, pan, pitch, intensity, delay). The engine turns cues into voices; nothing here
 * touches WebAudio, so the mapping is tested headless.
 */

import { LIVE_EVENT_TICKS, MATCH_RULES, TICK_HZ, WEAPONS } from '../core';
import type { GameEvent, HazardKind, PickupKind, PropKind, SkillId, WeaponId, WorldState } from '../core';
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
  | 'parry' | 'dismember' | 'death_splat' | 'kill_sting' | 'crowd_roar' | 'explosion'
  | 'skill_whirlwind' | 'skill_shadowstep' | 'skill_dash' | 'skill_shockwave' | 'skill_bloodrage'
  | 'footstep' | 'footstep_wet'
  | 'pickup_haste' | 'pickup_berserk' | 'pickup_ammo' | 'spawn_haste' | 'spawn_berserk' | 'heal'
  | 'hazard_spike' | 'hazard_saw' | 'hazard_acid' | 'hazard_fire'
  | 'break_keg' | 'break_amphora' | 'break_crate'
  | 'wall_grind' | 'horn' | 'escalation' | 'gong' | 'bell';

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
  kill_sting: spec('big', 95, 0.95, 0.08, 0, { sfx: 0.45, amb: 0.6, hold: 0.3 }),
  crowd_roar: spec('crowd', 88, 4.6, 0.25, 0, { sfx: 0, amb: 0.75, hold: 1.5 }),
  explosion: spec('big', 85, 2.1, 0.05, 0, { sfx: 0.2, amb: 0.55, hold: 0.5 }),
  skill_whirlwind: spec('misc', 55, 0.85, 0.05),
  skill_shadowstep: spec('misc', 55, 0.7, 0.05, 0.22),
  skill_dash: spec('misc', 55, 0.4, 0.05),
  skill_shockwave: spec('misc', 58, 0.9, 0.05),
  skill_bloodrage: spec('misc', 58, 1.1, 0.05),
  footstep: spec('step', 5, 0.09, 0.07),
  footstep_wet: spec('step', 6, 0.12, 0.07),
  pickup_haste: spec('misc', 65, 0.7),
  pickup_berserk: spec('misc', 65, 0.9),
  pickup_ammo: spec('misc', 25, 0.14, 0.12),
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
  wall_grind: spec('misc', 20, 0.32, 0.2),
  horn: spec('signal', 100, 3.2, 0.5, 0, { sfx: 0.5, amb: 0.7, hold: 1.6 }),
  escalation: spec('signal', 75, 0.55, 0.2),
  gong: spec('signal', 100, 4.6, 0.5, 0, { sfx: 0.35, amb: 0.6, hold: 1.2 }),
  bell: spec('signal', 100, 1.8, 0.5, 0, { sfx: 0.3, amb: 0.3, hold: 0.8 }),
};

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
};

/** What the mapping remembers between events (a projectile's weapon, the escalation stage). */
export type CueMemory = {
  projectiles: Map<string, WeaponId>;
  everywhereSeen: boolean;
};

export function createCueMemory(): CueMemory {
  return { projectiles: new Map(), everywhereSeen: false };
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

/** How much an event warms up the crowd murmur (0 = not at all). Decays in the engine. */
export function excitementBump(ev: GameEvent): number {
  switch (ev.type) {
    case 'hit':
      return ev.source === 'sudden_death' || ev.source === 'hazard' ? 0.01 : Math.min(0.06, ev.amount / 500);
    case 'kill':
      return 0.3;
    case 'dismember':
      return 0.15;
    case 'explosion':
      return 0.15;
    case 'sudden_death':
      return 0.25;
    case 'parry':
      return 0.04;
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

/** Semitone steps for the kill sting: multi-kills climb, the final kill lands lower and grander. */
const STING_MULTI = Math.pow(2, 3 / 12);
const STING_FINAL = Math.pow(2, -2 / 12);

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
 * Append the cues for one event. `finalKill`: this kill ends the match (the crowd goes loudest).
 * Stale events (catch-up after a seek) only update memory. `rand` is cosmetic randomness.
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
        push('wall_grind', 0.5, pan, vary(rand, 0.05));
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
      const drama = killDrama(ev, state, finalKill);
      push('death_splat', 1, pan, vary(rand, 0.05), ev.flags.includes('overkill') ? 1 : 0.6);
      const step = finalKill ? STING_FINAL : ev.flags.includes('multi') ? STING_MULTI : 1;
      push('kill_sting', 0.85, 0, step, drama);
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
      push('heal', 0.5, panForX(ev.pos.x, state));
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
    case 'bark':
      break;
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
