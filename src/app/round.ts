// Owned by: integrator
/**
 * A round's framing on the Watch screen, in real seconds: the splash, "3, 2, 1, FIGHT!", the live
 * match, the final moment (ultra slow motion, the camera on the kill, the WINNER stamp), then the
 * end card. The controller asks it whether the sim may step, which phase the UI shows and which
 * match signals (`MatchSignal`) to send this frame.
 *
 * Signals are queued and sent once per frame, after that frame's events. A seek drops what is
 * queued, so jumping into a match (Watch at a kill from the gym) never sounds a FIGHT hit.
 */

import type { MatchPhase, MatchSignal } from '../core';

type VictorySignal = Extract<MatchSignal, { type: 'victory' }>;

/** One countdown beat (3, 2, 1): the countdown lasts COUNTDOWN_BEATS x this, about 2.5 s. */
export const COUNTDOWN_BEAT_SECONDS = 0.8;
export const COUNTDOWN_BEATS = 3;
/** "FIGHT!" stays up this long after the countdown while the match already runs. */
export const FIGHT_FLASH_SECONDS = 0.6;
/** The final moment before the end card: long enough to admire the kill (about 3 s). */
export const FINAL_SECONDS = 3;

export class RoundFlow {
  private _entered = false;
  /** A match is loaded (its countdown waits for "Enter the pit" if needed). */
  private loaded = false;
  private countdownLeft = 0;
  private lastBeat = 0;
  private fightLeft = 0;
  private finalLeft = 0;
  /** This match's final moment was shown: reaching its end again goes straight to the end card. */
  private admired = false;
  private queue: MatchSignal[] = [];

  /** "Enter the pit" was pressed: the splash is gone for good. */
  get entered(): boolean {
    return this._entered;
  }

  /** The sim must not step: behind the splash, and while the countdown runs. */
  get holds(): boolean {
    return !this._entered || this.countdownLeft > 0;
  }

  /** A timed beat is running (countdown, FIGHT!, final moment): the UI needs updates while it lasts. */
  get beating(): boolean {
    return this.countdownLeft > 0 || this.fightLeft > 0 || this.finalLeft > 0;
  }

  /** "Enter the pit". Returns false when it was already entered. The loaded match starts its countdown. */
  enter(): boolean {
    if (this._entered) return false;
    this._entered = true;
    if (this.loaded) this.startCountdown();
    return true;
  }

  /** A new match (new, restart, a gym match): it opens with the countdown once the splash is entered. */
  begin(): void {
    this.loaded = true;
    this.admired = false;
    this.finalLeft = 0;
    this.fightLeft = 0;
    this.countdownLeft = 0;
    this.queue.length = 0;
    if (this._entered) this.startCountdown();
  }

  /**
   * Advance real time. While `paused` (leaving the Watch screen pauses) the countdown waits with the
   * game; the final moment runs on in real time, so a match stepped to its end while paused still
   * reaches the end card.
   */
  update(realDt: number, paused = false): void {
    const dt = Math.max(0, realDt);
    if (this.countdownLeft > 0) {
      if (paused) return;
      this.countdownLeft = Math.max(0, this.countdownLeft - dt);
      if (this.countdownLeft === 0) this.fight();
      else {
        const beat = this.beat();
        if (beat < this.lastBeat) {
          this.lastBeat = beat;
          this.queue.push({ type: 'countdown', value: beat });
        }
      }
      return;
    }
    if (this.fightLeft > 0) this.fightLeft = Math.max(0, this.fightLeft - dt);
    if (this.finalLeft > 0) this.finalLeft = Math.max(0, this.finalLeft - dt);
  }

  /** Space or a click: the countdown ends now (FIGHT!), or the final moment gives way to the end card. */
  skip(): void {
    if (this.countdownLeft > 0) {
      this.countdownLeft = 0;
      this.fight();
    } else this.finalLeft = 0;
  }

  /**
   * The match was decided live (stepped or played to its end): the final moment starts, once per
   * match, and `victory` (the winner's pose, spotlight and roar) goes out with it. A match replayed
   * to its end again goes straight to the end card, without a second victory.
   */
  decided(victory: VictorySignal | null = null): void {
    if (this.admired) return;
    this.admired = true;
    this.finalLeft = FINAL_SECONDS;
    if (victory) this.queue.push(victory);
  }

  /**
   * The viewer jumped (seek, step during the countdown): the countdown ends without FIGHT!, queued
   * signals are dropped, and a jump onto the decided end counts as having admired it.
   */
  jumped(finished: boolean): void {
    this.countdownLeft = 0;
    this.fightLeft = 0;
    this.finalLeft = 0;
    this.queue.length = 0;
    if (finished) this.admired = true;
  }

  /** Queue a signal for this frame (the final kill, sent with the kill event). */
  signal(s: MatchSignal): void {
    this.queue.push(s);
  }

  /** Signals to send this frame, in order; the queue is empty afterwards. */
  takeSignals(): MatchSignal[] {
    if (this.queue.length === 0) return NO_SIGNALS;
    const out = this.queue;
    this.queue = [];
    return out;
  }

  /** The phase for the UI. `ready`: every loading stage is done; `finished`: the match has ended. */
  phase(ready: boolean, finished: boolean): MatchPhase {
    if (!ready) return 'loading';
    if (!this._entered) return 'splash';
    if (this.countdownLeft > 0) return 'countdown';
    if (finished) return this.finalLeft > 0 ? 'final' : 'ended';
    return 'live';
  }

  /** The beat to show: 3, 2, 1 during the countdown, 0 for FIGHT!, null otherwise. */
  countdown(): number | null {
    if (this.countdownLeft > 0) return this.beat();
    return this.fightLeft > 0 ? 0 : null;
  }

  /** The countdown beat now running, 3 down to 1 (float residue never makes a beat 0). */
  private beat(): number {
    return Math.min(COUNTDOWN_BEATS, Math.max(1, Math.ceil(this.countdownLeft / COUNTDOWN_BEAT_SECONDS - 1e-9)));
  }

  private startCountdown(): void {
    this.countdownLeft = COUNTDOWN_BEATS * COUNTDOWN_BEAT_SECONDS;
    this.lastBeat = COUNTDOWN_BEATS;
    this.queue.push({ type: 'countdown', value: COUNTDOWN_BEATS });
  }

  private fight(): void {
    this.fightLeft = FIGHT_FLASH_SECONDS;
    this.queue.push({ type: 'fight' });
  }
}

const NO_SIGNALS: MatchSignal[] = [];
