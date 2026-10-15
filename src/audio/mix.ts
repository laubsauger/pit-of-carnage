// Owned by: audio
/**
 * Pure mixing rules, kept apart from WebAudio so they can be tested headless: voice limiting,
 * ducking, per-sound throttling, how the game's time scale bends pitch and tempo, the volume curve
 * and the master soft clipper.
 */

/** Voice groups. Each has its own cap so one kind of sound (footsteps, say) never crowds out the rest. */
export type VoiceGroup = 'step' | 'swing' | 'impact' | 'big' | 'crowd' | 'signal' | 'misc';

/** Most voices sounding at once. 16 fighters in a brawl must never pile up past this. */
export const MAX_VOICES = 32;

export const GROUP_CAPS: Readonly<Record<VoiceGroup, number>> = {
  step: 3,
  swing: 6,
  impact: 10,
  big: 6,
  crowd: 2,
  signal: 3,
  misc: 8,
};

type Slot = { id: number; group: VoiceGroup; priority: number; start: number; end: number };

/** Outcome of a voice request: the new voice id and the id of a voice to cut (0 = none). */
export type VoiceGrant = { id: number; stolen: number };

/**
 * Decides which sounds may play. A request fails when its group (or the whole mix) is full of
 * voices that matter more; otherwise it takes the place of the weakest voice (lowest priority, then
 * oldest), which the caller fades out. Equal priority steals the oldest: the newest hit is the one
 * on screen.
 */
export class VoiceLimiter {
  private slots: Slot[] = [];
  private nextId = 1;

  constructor(
    readonly maxVoices = MAX_VOICES,
    readonly caps: Readonly<Record<VoiceGroup, number>> = GROUP_CAPS,
  ) {}

  get active(): number {
    return this.slots.length;
  }

  countIn(group: VoiceGroup): number {
    let n = 0;
    for (const s of this.slots) if (s.group === group) n++;
    return n;
  }

  /** Ask for a voice that will sound until `end` (context seconds). Null = do not play it. */
  request(group: VoiceGroup, priority: number, now: number, end: number): VoiceGrant | null {
    this.prune(now);
    let stolen = 0;
    if (this.countIn(group) >= this.caps[group]) {
      const victim = this.weakest(group);
      if (!victim || victim.priority > priority) return null;
      this.remove(victim.id);
      stolen = victim.id;
    }
    if (this.slots.length >= this.maxVoices) {
      const victim = this.weakest(null);
      if (!victim || victim.priority > priority) return null;
      this.remove(victim.id);
      stolen = victim.id;
    }
    const id = this.nextId++;
    this.slots.push({ id, group, priority, start: now, end });
    return { id, stolen };
  }

  /** Correct a voice's end once its sound is built (the request only had an estimate). */
  setEnd(id: number, end: number): void {
    for (const s of this.slots) if (s.id === id) s.end = end;
  }

  release(id: number): void {
    this.remove(id);
  }

  clear(): void {
    this.slots.length = 0;
  }

  private prune(now: number): void {
    this.slots = this.slots.filter((s) => s.end > now);
  }

  private remove(id: number): void {
    const i = this.slots.findIndex((s) => s.id === id);
    if (i >= 0) this.slots.splice(i, 1);
  }

  private weakest(group: VoiceGroup | null): Slot | null {
    let best: Slot | null = null;
    for (const s of this.slots) {
      if (group && s.group !== group) continue;
      if (!best || s.priority < best.priority || (s.priority === best.priority && s.start < best.start)) best = s;
    }
    return best;
  }
}

/**
 * Ducking: a big moment (kill sting, sudden-death horn) pushes busy buses down so it reads. The
 * deepest active request wins; requests never compound, so ten kills at once duck no deeper than one.
 * The level drops fast and recovers slowly.
 */
export class Ducker {
  /** Current gain multiplier, 1 = untouched. */
  level = 1;
  private requests: { depth: number; left: number }[] = [];

  constructor(
    /** Seconds (time constant) to fall toward a deeper target. */
    readonly attack = 0.02,
    /** Seconds (time constant) to recover once the requests end. */
    readonly release = 0.35,
  ) {}

  /** Lower the level by `depth` (0..1) for at least `hold` seconds. */
  duck(depth: number, hold: number): void {
    const d = Math.min(Math.max(depth, 0), 1);
    if (d <= 0 || !(hold > 0)) return;
    if (this.requests.length >= 8) this.requests.sort((a, b) => a.left - b.left).shift();
    this.requests.push({ depth: d, left: hold });
  }

  /** Lowest level the active requests ask for. */
  get target(): number {
    let depth = 0;
    for (const r of this.requests) depth = Math.max(depth, r.depth);
    return 1 - depth;
  }

  update(dt: number): number {
    const step = Math.max(0, dt);
    for (const r of this.requests) r.left -= step;
    this.requests = this.requests.filter((r) => r.left > 0);
    const target = this.target;
    this.level = approach(this.level, target, step, target < this.level ? this.attack : this.release);
    // Never below what is asked for (the approach can only overshoot through rounding).
    this.level = Math.min(1, Math.max(this.level, target));
    return this.level;
  }

  reset(): void {
    this.requests.length = 0;
    this.level = 1;
  }
}

/** Drops repeats of the same sound closer together than its minimum gap (a cleave hitting five at once). */
export class Throttle {
  private last = new Map<string, number>();

  allow(key: string, now: number, minGap: number): boolean {
    if (!(minGap > 0)) return true;
    const t = this.last.get(key);
    if (t !== undefined && now >= t && now - t < minGap) return false;
    this.last.set(key, now);
    return true;
  }

  clear(): void {
    this.last.clear();
  }
}

/** A time scale of 0 longer than this (real seconds) is a pause, not a hit-stop. */
export const PAUSE_AFTER_SECONDS = 0.2;

/**
 * Tells a pause from a hit-stop. Both report a time scale of 0, but a hit-stop lasts a beat and its
 * kill sound must ring through it; a pause (or the arena gone) should silence everything.
 */
export class PauseDetector {
  paused = false;
  private zeroFor = 0;

  update(dt: number, timeScale: number): boolean {
    if (timeScale > 0) {
      this.zeroFor = 0;
      this.paused = false;
    } else {
      this.zeroFor += Number.isFinite(dt) ? Math.max(0, dt) : 0;
      this.paused = this.zeroFor >= PAUSE_AFTER_SECONDS;
    }
    return this.paused;
  }
}

/** Exponential smoothing toward `target` over a frame of `dt` seconds with time constant `tau`. */
export function approach(current: number, target: number, dt: number, tau: number): number {
  if (!(tau > 0)) return target;
  return target + (current - target) * Math.exp(-Math.max(0, dt) / tau);
}

/** Slowest pitch/tempo factor (the final kill runs the game at 0.2x). */
export const MIN_RATE = 0.42;
/** Fast forward only brightens a little: chipmunk fights are not the joke we want. */
export const MAX_RATE = 1.12;

/**
 * Pitch and tempo factor for a game time scale (speed x slow motion). Slow motion pitches down like
 * a tape slowing (square root, so 0.3x sounds deep but still readable); fast forward lifts it a
 * touch. Non-positive or broken scales (pause, hit-stop) return 1: callers keep their last rate then.
 */
export function pitchForTimeScale(timeScale: number): number {
  if (!(timeScale > 0) || !Number.isFinite(timeScale)) return 1;
  if (timeScale <= 1) return Math.max(MIN_RATE, Math.sqrt(timeScale));
  return Math.min(MAX_RATE, 1 + 0.06 * Math.log2(timeScale));
}

/** Cutoff (Hz) of the low-pass on effects and ambience: open at normal speed, muffled in slow motion. */
export function slowmoCutoff(rate: number): number {
  const open = 20000;
  const closed = 2400;
  const t = Math.min(Math.max((1 - rate) / (1 - MIN_RATE), 0), 1);
  return open * Math.pow(closed / open, t);
}

/** Master gain for a 0..1 volume setting: squared, so the slider feels even to the ear. */
export function volumeGain(volume: number): number {
  if (!Number.isFinite(volume)) return 0;
  const v = Math.min(Math.max(volume, 0), 1);
  return v * v;
}

/** Below this level the master soft clipper passes the signal untouched. */
export const CLIP_KNEE = 0.6;

/** Master soft clipper: linear under the knee, then a tanh shoulder that never reaches full scale. */
export function softClip(x: number): number {
  const a = Math.abs(x);
  if (a <= CLIP_KNEE) return x;
  const room = 1 - CLIP_KNEE;
  return Math.sign(x) * (CLIP_KNEE + room * Math.tanh((a - CLIP_KNEE) / room));
}

/**
 * Make a noise texture loop without a click: the last `fade` samples are blended into the first
 * ones (equal power) and dropped from the end, so the sample after the loop end is the first sample.
 */
export function crossfadeLoop(data: Float32Array, fade: number): Float32Array<ArrayBuffer> {
  const x = Math.max(0, Math.min(Math.floor(fade), Math.floor(data.length / 2)));
  const n = data.length - x;
  const out = new Float32Array(n);
  out.set(data.subarray(0, n));
  for (let i = 0; i < x; i++) {
    const t = i / x;
    out[i] = data[i]! * Math.sqrt(t) + data[n + i]! * Math.sqrt(1 - t);
  }
  return out;
}
