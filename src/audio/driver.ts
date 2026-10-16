// Owned by: audio
/**
 * Everything between the game and one running engine: events and signals to cues, the round's
 * crowd (profile, director, babble), the final-sting gate, wall contact to the grind loop, the
 * per-frame slow-motion bend, and the hush under the end card (combat sounds and the crowd stop,
 * only a low ambience and announcer beats remain). `createAudio` (index.ts) owns the AudioContext's life around it; the
 * offline checks (dev/) drive the same class on an OfflineAudioContext, so what they measure is what
 * the game plays.
 */

import type { GameEvent, MatchSignal, WorldState } from '../core';
import { CrowdDirector, crowdProfile } from './crowd';
import type { CrowdProfile } from './crowd';
import { FinalGate, SOUND_SPECS, createCueMemory, cuesForEvent, cuesForSignal, finalKillIndex, isLive, rememberContacts, wallContact } from './cues';
import type { Cue } from './cues';
import type { AudioEngine } from './engine';
import { approach, pitchForTimeScale } from './mix';
import { renderBabble } from './synth';

/** Seconds (time constant) for pitch to follow the time scale. */
const RATE_TAU = 0.07;

export type BabbleLoader = (profile: CrowdProfile) => Promise<AudioBuffer>;

export class SoundDriver {
  readonly crowd: CrowdDirector;
  profile: CrowdProfile;
  private seed: number;
  private memory = createCueMemory();
  private readonly cues: Cue[] = [];
  private readonly finalGate = new FinalGate();
  private rate = 1;
  /** The end card is up: the arena is hushed. */
  private hushed = false;
  /** Bumped per babble request, so a slow render for an old round never replaces a newer one. */
  private babbleRequest = 0;
  private stopped = false;

  constructor(
    readonly engine: AudioEngine,
    seed = 0,
    private readonly loadBabble: BabbleLoader = (p) => renderBabble(engine.ctx.sampleRate, p),
  ) {
    this.seed = seed >>> 0;
    this.profile = crowdProfile(this.seed);
    this.crowd = new CrowdDirector(this.profile);
    engine.startAmbience(this.profile);
    this.requestBabble();
  }

  /** A new round: reset what the cues remember and the crowd; a new seed brings a new crowd. */
  startRound(seed: number): void {
    const next = Number.isFinite(seed) ? seed >>> 0 : 0;
    this.memory = createCueMemory();
    this.finalGate.reset();
    const fresh = next !== this.seed;
    this.seed = next;
    if (fresh) this.profile = crowdProfile(next);
    this.crowd.reset(this.profile);
    this.engine.setWallMoving(false);
    this.setHush(false);
    this.engine.setProfile(this.profile);
    // A restart of the same match keeps its crowd.
    if (fresh) this.requestBabble();
  }

  onSignal(signal: MatchSignal): void {
    this.crowd.onSignal(signal);
    if (signal.type === 'end_card') this.setHush(signal.shown);
    const cues = this.cues;
    cues.length = 0;
    cuesForSignal(signal, cues);
    const victim = signal.type === 'final_kill' ? signal.victimId : null;
    for (const cue of cues) this.play(cue, victim);
  }

  onEvents(events: readonly GameEvent[], state: WorldState): void {
    const cues = this.cues;
    const finalIdx = finalKillIndex(events);
    rememberContacts(events, this.memory);
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      cues.length = 0;
      cuesForEvent(ev, state, this.memory, i === finalIdx, cues);
      if (isLive(ev, state)) this.crowd.onEvent(ev, state, cues);
      const victim = ev.type === 'kill' ? ev.victimId : null;
      for (const cue of cues) this.play(cue, victim);
    }
    cues.length = 0;
    this.crowd.observe(state, cues);
    for (const cue of cues) this.play(cue, null);
    const contact = wallContact(events, state);
    this.engine.setGrind(contact.fighters, contact.pan);
    const zone = state.suddenDeath;
    this.engine.setWallMoving(zone.active && zone.closedAtTick < 0 && !state.finished);
  }

  /** Per frame: `dt` real seconds, `timeScale` the game's time factor (0 = stopped). */
  frame(dt: number, timeScale: number): void {
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    if (timeScale > 0) {
      this.rate = approach(this.rate, pitchForTimeScale(timeScale), step, RATE_TAU);
      this.engine.setRate(this.rate, timeScale);
      // The crowd lives in real time while the game runs; it holds its breath through a pause.
      this.crowd.update(step);
    }
    this.engine.setCrowd(this.crowd.intensity);
    this.engine.tick(step);
  }

  stop(): void {
    this.stopped = true;
    this.engine.stopAll();
  }

  /** Whether the arena is hushed (the end card is up). */
  get isHushed(): boolean {
    return this.hushed;
  }

  private setHush(on: boolean): void {
    if (on === this.hushed) return;
    this.hushed = on;
    this.engine.setHush(on);
  }

  /**
   * Play one cue, after the round's crowd colours its roars and the final sting passes its gate.
   * Hushed, only announcer beats (signals) play.
   */
  private play(cue: Cue, finalVictim: string | null): void {
    if (this.hushed && SOUND_SPECS[cue.sound].group !== 'signal') return;
    if (cue.sound === 'final_sting' && finalVictim !== null && !this.finalGate.take(finalVictim, this.engine.ctx.currentTime)) return;
    if (cue.sound === 'crowd_roar') {
      cue.pitch *= this.profile.pitch;
      cue.gain *= 0.85 + 0.15 * this.profile.rowdiness;
    }
    this.engine.play(cue);
  }

  private requestBabble(): void {
    const request = ++this.babbleRequest;
    this.loadBabble(this.profile).then(
      (buf) => {
        if (!this.stopped && request === this.babbleRequest) this.engine.setBabble(buf);
      },
      // Without OfflineAudioContext the murmur keeps its noise bed: still a crowd, just vaguer.
      () => undefined,
    );
  }
}
