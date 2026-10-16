// Owned by: audio
/**
 * The crowd that breathes. Pure: nothing here touches WebAudio, so it is tested headless.
 *
 * - `crowdProfile(seed)`: the round's crowd. How many voices, their pitch and pace, how bright and
 *   rowdy they are, how fast they cool down, what they chant. Same seed, same crowd; every round
 *   differs.
 * - `CrowdDirector`: how worked up the crowd is (`intensity` 0..1) and the sparse reactions it makes
 *   (gasps, whistles, boos at campers, chants on a streak). Intensity joins action energy (hits,
 *   kills, gore; it cools in a couple of seconds) with tension read from the state (close fights,
 *   low-HP fighters in them, a thinning field, sudden death). A lull takes it to almost nothing.
 * - `bedLevel` / `bedCutoff`: how loud and how bright the murmur bed is at an intensity.
 *
 * Kills and the final kill get their roars from the event mapping (cues.ts); reactions here are the
 * sparse extras between them, never a loop.
 */

import { Rng, TICK_HZ } from '../core';
import type { FighterState, GameEvent, MatchSignal, WorldState } from '../core';
import { excitementBump, panForX } from './cues';
import type { Cue, SoundId } from './cues';
import { approach } from './mix';

export type ChantStyle = 'hey' | 'clap' | 'stomp';

/** The round's crowd, drawn from the match seed. */
export type CrowdProfile = {
  seed: number;
  /** Babble voices: how dense the crowd sounds. */
  voices: number;
  /** Share of low voices in the babble. */
  lowShare: number;
  /** Playback rate of the crowd (bed and reactions): its overall pitch. */
  pitch: number;
  /** Syllable pace of the babble: chattier or slower crowds. */
  pace: number;
  /** Shift of the murmur's vowel bands. */
  formant: number;
  /** Scale of the bed's low-pass: a dull or a bright crowd. */
  brightness: number;
  /** Two slow breathing rates (Hz) for the bed's swells. */
  breath: readonly [number, number];
  /** Bed level in a dead lull, as a fraction of a full swell: nearly silent. */
  rest: number;
  /** How readily the crowd reacts and how big it roars (1 = average). */
  rowdiness: number;
  /** Least real seconds between two sparse reactions. */
  reactionGap: number;
  /** Seconds for action energy to cool to 1/e. */
  cool: number;
  chant: ChantStyle;
  /** Chant beats per second. */
  chantTempo: number;
  /** Pitch (Hz) of the crowd's whistlers. */
  whistle: number;
};

/** Ranges every profile stays inside (tests hold the generator to them). */
export const PROFILE_RANGES = {
  voices: [14, 34],
  lowShare: [0.35, 0.8],
  pitch: [0.92, 1.1],
  pace: [0.8, 1.25],
  formant: [0.9, 1.12],
  brightness: [0.8, 1.25],
  breath: [0.06, 0.22],
  rest: [0.02, 0.05],
  rowdiness: [0.7, 1.3],
  reactionGap: [4, 8],
  cool: [1.6, 2.8],
  chantTempo: [1.7, 2.4],
  whistle: [1700, 2600],
} as const;

const CHANTS: readonly ChantStyle[] = ['hey', 'clap', 'stomp'];

export function crowdProfile(seed: number): CrowdProfile {
  const rng = new Rng(seed).fork('crowd');
  const r = (k: Exclude<keyof typeof PROFILE_RANGES, 'voices'>) => rng.range(PROFILE_RANGES[k][0], PROFILE_RANGES[k][1]);
  return {
    seed: seed >>> 0,
    voices: rng.int(PROFILE_RANGES.voices[0], PROFILE_RANGES.voices[1]),
    lowShare: r('lowShare'),
    pitch: r('pitch'),
    pace: r('pace'),
    formant: r('formant'),
    brightness: r('brightness'),
    breath: [r('breath'), r('breath')],
    rest: r('rest'),
    rowdiness: r('rowdiness'),
    reactionGap: r('reactionGap'),
    cool: r('cool'),
    chant: rng.pick(CHANTS),
    chantTempo: r('chantTempo'),
    whistle: r('whistle'),
  };
}

/** Bed level 0..1 (fraction of a full swell) at an intensity: the profile's rest in a lull, 1 when the pit goes wild. */
export function bedLevel(intensity: number, profile: CrowdProfile): number {
  const i = Number.isFinite(intensity) ? Math.min(Math.max(intensity, 0), 1) : 0;
  return profile.rest + (1 - profile.rest) * Math.pow(i, 1.5);
}

/** Low-pass cutoff (Hz) of the bed: a dull murmur at rest, open and bright when the crowd is hot. */
export function bedCutoff(intensity: number, profile: CrowdProfile): number {
  const i = Number.isFinite(intensity) ? Math.min(Math.max(intensity, 0), 1) : 0;
  return (700 + 3800 * i) * profile.brightness;
}

export type ReactionKind = 'gasp' | 'whistle' | 'boo' | 'chant';

export const REACTION_SOUND: Readonly<Record<ReactionKind, SoundId>> = {
  gasp: 'crowd_gasp',
  whistle: 'crowd_whistle',
  boo: 'crowd_boo',
  chant: 'crowd_chant',
};

/** Seconds before the same kind of reaction may come again. */
export const REACTION_COOLDOWN: Readonly<Record<ReactionKind, number>> = { gasp: 6, whistle: 9, boo: 18, chant: 9 };

/** Enemies closer than this (px, centre to centre) count as a close fight. */
export const CLOSE_FIGHT_PX = 150;
/** A fighter that strays less than this (px) from one spot... */
export const CAMP_PX = 70;
/** ...for this long without dealing damage is camping. */
export const CAMP_TICKS = 8 * TICK_HZ;
/** No fighter has hurt another for this long: the crowd gets restless. */
export const LULL_TICKS = 9 * TICK_HZ;
/** Nobody gets booed in the first seconds of a match (everyone is still walking in). */
export const BOO_GRACE_TICKS = 12 * TICK_HZ;
/** Kills by one fighter that start a chant (and every kill after). */
export const CHANT_KILLS = 3;
/** HP fraction under which a fighter that survives a blow makes the crowd gasp (once each). */
export const NEAR_DEATH = 0.15;
/** Ticks between tension and camper readings (10 Hz). */
const SAMPLE_TICKS = 6;
/** Seconds (time constant) for the crowd's tension to follow the state. */
const TENSION_TAU = 0.9;

type CampWatch = { x: number; y: number; dealt: number; since: number };

/** True for damage one fighter did to another (not hazards, not the wall). */
function fighterDamage(ev: Extract<GameEvent, { type: 'hit' }>): boolean {
  return ev.attackerId !== null && ev.source !== 'hazard' && ev.source !== 'sudden_death';
}

function byId(state: WorldState, id: string | null): FighterState | null {
  if (id === null) return null;
  for (const f of state.fighters) if (f.id === id) return f;
  return null;
}

/**
 * Tension 0..1 the state shows right now: close fights (more of them, hotter), a low-HP fighter in
 * one, a thinning field, sudden death. Zero for a spread-out field that is just walking around.
 * Measured on real matches: eight fighters are in close pairs most of the time, so pairs alone
 * only warm the crowd; the hot end needs blood (action energy) or a fighter about to die.
 */
export function stateTension(state: WorldState): number {
  if (state.finished) return 0;
  let alive = 0;
  for (const f of state.fighters) if (f.alive) alive++;
  let pairs = 0;
  let lowInFight = false;
  const fs = state.fighters;
  const close2 = CLOSE_FIGHT_PX * CLOSE_FIGHT_PX;
  for (let i = 0; i < fs.length; i++) {
    const a = fs[i]!;
    if (!a.alive) continue;
    for (let j = i + 1; j < fs.length; j++) {
      const b = fs[j]!;
      if (!b.alive || a.squad === b.squad) continue;
      const dx = a.pos.x - b.pos.x;
      const dy = a.pos.y - b.pos.y;
      if (dx * dx + dy * dy > close2) continue;
      pairs++;
      if (a.hp < a.maxHp * 0.3 || b.hp < b.maxHp * 0.3) lowInFight = true;
    }
  }
  let t = Math.min(1, pairs / 4) * 0.3;
  if (lowInFight) t += 0.2;
  const n = fs.length;
  if (n >= 3 && alive >= 2) t += alive === 2 ? 0.15 : 0.1 * (1 - (alive - 2) / (n - 2));
  if (state.suddenDeath.active) t += 0.08;
  return Math.min(1, t);
}

export class CrowdDirector {
  profile: CrowdProfile;
  /** Action energy 0..1: bumps from events, cools over `profile.cool` seconds. */
  energy = 0;
  /** Tension 0..1 read from the state, smoothed. */
  tension = 0;
  private tensionTarget = 0;
  /** Real seconds since the last sparse reaction. */
  private sinceReaction = Infinity;
  private cooldown: Record<ReactionKind, number> = { gasp: 0, whistle: 0, boo: 0, chant: 0 };
  /** Tick of the last damage one fighter did to another (lulls are measured from it). */
  private lastFightTick = 0;
  private lastSample = -Infinity;
  private camp = new Map<string, CampWatch>();
  /** Kill count each fighter was last chanted at. */
  private chanted = new Map<string, number>();
  private nearDeath = new Set<string>();
  /** The end card is up: no bed swell, no reactions. */
  hushed = false;

  constructor(profile: CrowdProfile = crowdProfile(0)) {
    this.profile = profile;
  }

  /** A new round: a new crowd that has not seen anything yet. */
  reset(profile: CrowdProfile): void {
    this.profile = profile;
    this.energy = 0;
    this.tension = 0;
    this.tensionTarget = 0;
    this.sinceReaction = Infinity;
    this.cooldown = { gasp: 0, whistle: 0, boo: 0, chant: 0 };
    this.lastFightTick = 0;
    this.lastSample = -Infinity;
    this.camp.clear();
    this.chanted.clear();
    this.nearDeath.clear();
    this.hushed = false;
  }

  /** How worked up the crowd is, 0 (a dead lull, or the end card) .. 1 (the pit goes wild). */
  get intensity(): number {
    if (this.hushed) return 0;
    return 1 - (1 - this.energy) * (1 - this.tension);
  }

  /** Raise action energy by `amount` with a soft ceiling (a hot crowd only gets a little hotter). */
  bump(amount: number): void {
    if (amount > 0) this.energy += Math.min(amount, 1) * (1 - this.energy);
  }

  /**
   * The countdown builds anticipation; FIGHT lets it loose; the final kill and the winner's moment
   * top everything (then the crowd cools); while the end card is up the crowd falls silent.
   */
  onSignal(signal: MatchSignal): void {
    switch (signal.type) {
      case 'countdown':
        this.energy = Math.max(this.energy, 0.2 + 0.1 * (4 - Math.min(Math.max(signal.value, 1), 3)));
        break;
      case 'fight':
        this.energy = Math.max(this.energy, 0.75);
        break;
      case 'final_kill':
      case 'victory':
        this.energy = 1;
        break;
      case 'end_card':
        this.hushed = signal.shown;
        if (signal.shown) {
          this.energy = 0;
          this.tension = 0;
          this.tensionTarget = 0;
        }
        break;
    }
  }

  /** One live event: warm the crowd and maybe react (appends reaction cues). */
  onEvent(ev: GameEvent, state: WorldState, out: Cue[], rand: () => number = Math.random): void {
    this.bump(excitementBump(ev));
    switch (ev.type) {
      case 'hit': {
        if (!fighterDamage(ev)) break;
        this.lastFightTick = Math.max(this.lastFightTick, ev.tick);
        const victim = byId(state, ev.victimId);
        if (ev.backstab) this.react('whistle', 0.3, ev.pos.x, state, out, rand);
        if (!victim) break;
        if (victim.alive && victim.hp < victim.maxHp * NEAR_DEATH && !this.nearDeath.has(victim.id)) {
          this.nearDeath.add(victim.id);
          this.react('gasp', 0.65, ev.pos.x, state, out, rand);
        } else if (ev.amount >= Math.max(24, victim.maxHp * 0.2)) {
          this.react('gasp', 0.35, ev.pos.x, state, out, rand);
        }
        break;
      }
      case 'dismember':
        this.react('gasp', 0.7, ev.pos.x, state, out, rand);
        break;
      case 'parry':
        this.react('whistle', 0.12, ev.pos.x, state, out, rand);
        break;
      case 'kill': {
        if (ev.killerId !== null && ev.cause !== 'hazard' && ev.cause !== 'sudden_death') this.lastFightTick = Math.max(this.lastFightTick, ev.tick);
        if (ev.final) break;
        if (ev.flags.includes('multi')) this.react('whistle', 0.7, ev.pos.x, state, out, rand);
        const killer = byId(state, ev.killerId);
        if (killer && killer.alive && killer.kills >= CHANT_KILLS && (this.chanted.get(killer.id) ?? 0) < killer.kills) {
          // A streak is worth a chant even right after another reaction: only its own cooldown applies.
          if (this.cooldown.chant <= 0 && !this.hushed) {
            this.chanted.set(killer.id, killer.kills);
            this.emit('chant', killer.pos.x, state, out, rand);
          }
        }
        break;
      }
      case 'pickup':
        if (ev.kind === 'berserk') this.react('whistle', 0.25, ev.pos.x, state, out, rand);
        break;
      default:
        break;
    }
  }

  /** After a live batch: read the state's tension and look for campers to boo. */
  observe(state: WorldState, out: Cue[], rand: () => number = Math.random): void {
    if (state.tick - this.lastSample < SAMPLE_TICKS && state.tick >= this.lastSample) return;
    this.lastSample = state.tick;
    this.tensionTarget = stateTension(state);
    if (state.finished) return;

    let camper: FighterState | null = null;
    let longest = 0;
    for (const f of state.fighters) {
      if (!f.alive) {
        this.camp.delete(f.id);
        continue;
      }
      const w = this.camp.get(f.id);
      if (!w || Math.hypot(f.pos.x - w.x, f.pos.y - w.y) > CAMP_PX || f.damageDealt > w.dealt || state.tick < w.since) {
        this.camp.set(f.id, { x: f.pos.x, y: f.pos.y, dealt: f.damageDealt, since: state.tick });
        continue;
      }
      const still = state.tick - w.since;
      if (still >= CAMP_TICKS && still > longest) {
        longest = still;
        camper = f;
      }
    }
    if (state.tick < BOO_GRACE_TICKS) return;
    if (camper) {
      if (this.react('boo', 0.8, camper.pos.x, state, out, rand)) {
        // Booed: it has to camp a full window again to earn the next one.
        this.camp.set(camper.id, { x: camper.pos.x, y: camper.pos.y, dealt: camper.damageDealt, since: state.tick });
      }
    } else if (state.tick - this.lastFightTick >= LULL_TICKS) {
      const kind: ReactionKind = rand() < 0.6 ? 'boo' : 'whistle';
      this.react(kind, 0.35, state.suddenDeath.final.x + state.suddenDeath.final.w / 2, state, out, rand);
    }
  }

  /** Real seconds while the game runs: energy cools, tension eases toward what the state shows. */
  update(dt: number): void {
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.energy *= Math.exp(-step / this.profile.cool);
    this.tension = approach(this.tension, this.tensionTarget, step, TENSION_TAU);
    this.sinceReaction += step;
    for (const k of Object.keys(this.cooldown) as ReactionKind[]) this.cooldown[k] = Math.max(0, this.cooldown[k] - step);
  }

  /** Try a sparse reaction: respects the global gap and the kind's cooldown, then rolls `chance` x rowdiness. */
  private react(kind: ReactionKind, chance: number, x: number, state: WorldState, out: Cue[], rand: () => number): boolean {
    if (this.hushed) return false;
    if (this.sinceReaction < this.profile.reactionGap || this.cooldown[kind] > 0) return false;
    if (rand() >= Math.min(1, chance * this.profile.rowdiness)) return false;
    this.emit(kind, x, state, out, rand);
    return true;
  }

  private emit(kind: ReactionKind, x: number, state: WorldState, out: Cue[], rand: () => number): void {
    this.sinceReaction = 0;
    this.cooldown[kind] = REACTION_COOLDOWN[kind];
    const p = this.profile;
    // The crowd surrounds the pit: reactions lean toward the action, never hard to one side.
    const pan = panForX(x, state) * 0.6;
    const v = (s: number) => 1 + (rand() * 2 - 1) * s;
    switch (kind) {
      case 'gasp':
        out.push({ sound: 'crowd_gasp', gain: 0.5 * (0.85 + 0.15 * p.rowdiness), pan, pitch: p.pitch * v(0.05), intensity: Math.min(1, p.rowdiness - 0.3), delay: 0.06 + 0.12 * rand() });
        break;
      case 'whistle':
        out.push({ sound: 'crowd_whistle', gain: 0.32, pan: (rand() * 2 - 1) * 0.55, pitch: (p.whistle / 2100) * v(0.04), intensity: rand(), delay: 0.2 + 0.3 * rand() });
        break;
      case 'boo':
        out.push({ sound: 'crowd_boo', gain: 0.5, pan, pitch: p.pitch * v(0.04), intensity: Math.min(1, p.rowdiness - 0.3), delay: 0.1 + 0.3 * rand() });
        break;
      case 'chant':
        // After the kill's roar has peaked. Tempo rides in `intensity`, the style in `variant`.
        out.push({ sound: 'crowd_chant', gain: 0.5, pan: pan * 0.5, pitch: p.pitch, intensity: chantIntensity(p.chantTempo), delay: 1.1, variant: CHANTS.indexOf(p.chant) });
        break;
    }
  }
}

/** Chant tempo (beats per second) carried in a cue's 0..1 intensity, and back. */
export function chantIntensity(tempo: number): number {
  const [lo, hi] = PROFILE_RANGES.chantTempo;
  return Math.min(Math.max((tempo - lo) / (hi - lo), 0), 1);
}

export function chantTempo(intensity: number): number {
  const [lo, hi] = PROFILE_RANGES.chantTempo;
  return lo + (hi - lo) * Math.min(Math.max(intensity, 0), 1);
}

export function chantStyle(variant: number | undefined): ChantStyle {
  return CHANTS[Math.min(Math.max(Math.round(variant ?? 0), 0), CHANTS.length - 1)]!;
}
