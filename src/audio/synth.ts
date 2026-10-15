// Owned by: audio
/**
 * Procedural sound recipes. No sample files: every sound is layered from shared noise textures,
 * oscillators, filters, saturation and envelopes, built fresh per voice:
 *
 * - impacts = a transient (short filtered noise) + a body (pitch-dropping sine) + a texture
 *   (wet squelch, metal partials, crackle), so they read as punchy rather than beepy;
 * - whooshes = band-passed noise whose band and level swell together;
 * - metal (parry, clang, bells, gong) = inharmonic sine partials with their own decays;
 * - crowd = a pre-rendered babble of formant-filtered voices plus a swelling "ohh" choir.
 *
 * A `VoiceBuilder` applies the voice's rate: frequencies x rate and durations / rate, so slow
 * motion lowers pitch and stretches tempo together, like tape.
 */

import type { Cue, SoundId } from './cues';
import { crossfadeLoop } from './mix';

export type NoiseKind = 'white' | 'pink' | 'brown' | 'crackle' | 'applause';

/** Shared textures, rendered once per AudioContext. */
export type Banks = Record<NoiseKind, AudioBuffer> & {
  /** Crowd babble, rendered offline after start-up; null until it is ready. */
  babble: AudioBuffer | null;
  /** tanh saturation curve for punch and grit. */
  drive: Float32Array<ArrayBuffer>;
};

// ---------------------------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------------------------

function normalize<T extends Float32Array>(d: T, peak: number): T {
  let m = 0;
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]!));
  if (m > 0) for (let i = 0; i < d.length; i++) d[i] = (d[i]! / m) * peak;
  return d;
}

function whiteNoise(n: number): Float32Array<ArrayBuffer> {
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return d;
}

/** Pink noise (Paul Kellet's economy filter): softer, fuller, the base of most bodies. */
function pinkNoise(n: number): Float32Array<ArrayBuffer> {
  const d = new Float32Array(n);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    d[i] = b0 + b1 + b2 + w * 0.1848;
  }
  return d;
}

/** Brown noise: a rumble for thuds, blasts and the wall. */
function brownNoise(n: number): Float32Array<ArrayBuffer> {
  const d = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    d[i] = last;
  }
  return d;
}

/** Sparse random pops: torch fire, debris, sizzles, wet tearing. */
function crackleNoise(n: number, sr: number): Float32Array<ArrayBuffer> {
  const d = new Float32Array(n);
  const rate = 26 / sr;
  for (let i = 0; i < n; i++) {
    if (Math.random() >= rate) continue;
    const amp = 0.15 + 0.85 * Math.pow(Math.random(), 3);
    const len = Math.floor(sr * (0.0006 + Math.random() * 0.006));
    for (let k = 0; k < len && i + k < n; k++) d[i + k]! += (Math.random() * 2 - 1) * amp * Math.exp((-5 * k) / len);
  }
  return d;
}

/** Many hands clapping: short decaying noise bursts at a dense random rate. */
function applauseNoise(n: number, sr: number): Float32Array<ArrayBuffer> {
  const d = new Float32Array(n);
  const rate = 75 / sr;
  for (let i = 0; i < n; i++) {
    if (Math.random() >= rate) continue;
    const amp = 0.3 + 0.7 * Math.random();
    const len = Math.floor(sr * (0.004 + Math.random() * 0.008));
    for (let k = 0; k < len && i + k < n; k++) d[i + k]! += (Math.random() * 2 - 1) * amp * Math.exp((-4 * k) / len);
  }
  return d;
}

function monoBuffer(ctx: BaseAudioContext, data: Float32Array<ArrayBuffer>): AudioBuffer {
  const b = ctx.createBuffer(1, data.length, ctx.sampleRate);
  b.copyToChannel(data, 0);
  return b;
}

function driveCurve(k: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const c = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) c[i] = Math.tanh(k * ((i / (n - 1)) * 2 - 1)) / norm;
  return c;
}

export function makeBanks(ctx: BaseAudioContext): Banks {
  const sr = ctx.sampleRate;
  const loop = (d: Float32Array) => crossfadeLoop(d, sr * 0.05);
  return {
    white: monoBuffer(ctx, normalize(whiteNoise(sr * 2), 0.9)),
    pink: monoBuffer(ctx, normalize(loop(pinkNoise(sr * 3)), 0.9)),
    brown: monoBuffer(ctx, normalize(loop(brownNoise(sr * 3)), 0.9)),
    crackle: monoBuffer(ctx, normalize(crackleNoise(sr * 3, sr), 0.95)),
    applause: monoBuffer(ctx, normalize(applauseNoise(sr * 3, sr), 0.8)),
    babble: null,
    drive: driveCurve(2.2),
  };
}

/**
 * Impulse response of a stone pit: a few early reflections off the walls, then a dense tail that
 * darkens as it decays (stone swallows the highs first).
 */
export function makeImpulse(ctx: BaseAudioContext, seconds = 1.9): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const pre = Math.floor(sr * 0.012);
  const b = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = new Float32Array(n);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / (n - pre);
      const k = 0.65 - 0.57 * t;
      lp += k * ((Math.random() * 2 - 1) - lp);
      d[i] = lp * Math.exp(-6.2 * t) * (0.6 + 0.4 * Math.random());
    }
    for (const [ms, g] of [[19, 0.5], [31, 0.35], [47, 0.3], [63, 0.22]] as const) {
      const j = pre + Math.floor((sr * (ms + ch * 3)) / 1000);
      if (j < n) d[j]! += g * (ch === 0 ? 1 : -1);
    }
    b.copyToChannel(normalize(d, 0.6), ch);
  }
  return b;
}

/** Vowel formants (F1, F2) in Hz: a, e, i, o, u, schwa. */
const VOWELS: readonly (readonly [number, number])[] = [[800, 1200], [480, 1950], [320, 2300], [520, 900], [360, 800], [560, 1500]];

/**
 * Render a loopable crowd babble offline: two dozen formant-filtered voices saying nothing in
 * particular at their own pace, with consonant hiss, spread across the stereo field. Used for the
 * murmur bed and as the body of every crowd roar.
 */
export async function renderBabble(sampleRate: number, seconds = 8, voices = 26): Promise<AudioBuffer> {
  const off = new OfflineAudioContext(2, Math.floor(sampleRate * seconds), sampleRate);
  const banks = { white: monoBuffer(off, whiteNoise(sampleRate)) };
  const bus = off.createGain();
  bus.gain.value = 1 / Math.sqrt(voices);
  bus.connect(off.destination);
  for (let v = 0; v < voices; v++) {
    const low = Math.random() < 0.6;
    const f0 = low ? 95 + Math.random() * 55 : 170 + Math.random() * 90;
    const pan = off.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    pan.connect(bus);
    const amp = off.createGain();
    amp.gain.value = 0;
    amp.connect(pan);
    const osc = off.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = f0;
    const f1 = off.createBiquadFilter();
    f1.type = 'bandpass';
    f1.Q.value = 5;
    const f2 = off.createBiquadFilter();
    f2.type = 'bandpass';
    f2.Q.value = 7;
    const f2g = off.createGain();
    f2g.gain.value = 0.55;
    osc.connect(f1).connect(amp);
    osc.connect(f2).connect(f2g).connect(amp);
    const hiss = off.createBufferSource();
    hiss.buffer = banks.white;
    hiss.loop = true;
    const hissHp = off.createBiquadFilter();
    hissHp.type = 'highpass';
    hissHp.frequency.value = 3200;
    const hissG = off.createGain();
    hissG.gain.value = 0;
    hiss.connect(hissHp).connect(hissG).connect(pan);
    const level = 0.35 + 0.65 * Math.random();
    let t = Math.random() * 0.6;
    while (t < seconds - 0.1) {
      const syl = 0.08 + Math.random() * 0.2;
      const [a, b] = VOWELS[Math.floor(Math.random() * VOWELS.length)]!;
      f1.frequency.setTargetAtTime(a * (0.9 + Math.random() * 0.2), t, 0.025);
      f2.frequency.setTargetAtTime(b * (0.9 + Math.random() * 0.2), t, 0.025);
      osc.frequency.setTargetAtTime(f0 * (0.85 + Math.random() * 0.35), t, 0.06);
      amp.gain.setTargetAtTime(level, t, 0.018);
      amp.gain.setTargetAtTime(0, t + syl, 0.03);
      if (Math.random() < 0.4) {
        hissG.gain.setTargetAtTime(level * 0.12, Math.max(0, t - 0.03), 0.005);
        hissG.gain.setTargetAtTime(0, t + 0.01, 0.012);
      }
      // Words, then the odd breath between sentences.
      t += syl + (Math.random() < 0.22 ? 0.25 + Math.random() * 0.7 : 0.02 + Math.random() * 0.07);
    }
    osc.start(0);
    hiss.start(0, Math.random());
  }
  const rendered = await off.startRendering();
  const fade = Math.floor(sampleRate * 0.4);
  const n = rendered.length - Math.min(fade, Math.floor(rendered.length / 2));
  const out = new AudioBuffer({ numberOfChannels: 2, length: n, sampleRate });
  for (let ch = 0; ch < 2; ch++) out.copyToChannel(normalize(crossfadeLoop(rendered.getChannelData(ch), fade), 0.9), ch);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Voice builder
// ---------------------------------------------------------------------------------------------

type Dest = AudioNode | AudioParam;

function connect(node: AudioNode, dest: Dest): void {
  if (dest instanceof AudioParam) node.connect(dest);
  else node.connect(dest);
}

/**
 * Builds one voice's node graph. Times are seconds after the voice start at normal speed; the
 * builder stretches them by 1/rate and scales frequencies by rate. It records every source so the
 * engine can bend their pitch later (slow motion arriving mid-sound) or cut them when stolen.
 */
export class VoiceBuilder {
  /** Buffer sources and their own speed factor (live playback rate = speed x voice pitch x engine rate). */
  readonly buffers: { node: AudioBufferSourceNode; speed: number }[] = [];
  /** Oscillators and their own detune in cents (a live bend adds to it). */
  readonly oscs: { node: OscillatorNode; detune: number }[] = [];
  /** Context time the last source stops. */
  stopAt: number;

  constructor(
    readonly ctx: BaseAudioContext,
    readonly banks: Banks,
    /** The voice input: every layer ends here. */
    readonly out: AudioNode,
    /** Context time the voice starts. */
    readonly t0: number,
    /** Pitch and tempo factor. */
    readonly rate: number,
  ) {
    this.stopAt = t0;
  }

  at(sec: number): number {
    return this.t0 + Math.max(0, sec) / this.rate;
  }

  f(hz: number): number {
    return hz * this.rate;
  }

  private stop(src: AudioScheduledSourceNode, sec: number): void {
    const end = this.at(sec);
    src.stop(end);
    if (end > this.stopAt) this.stopAt = end;
  }

  noise(kind: NoiseKind | 'babble', sec: number, dur: number, dest: Dest, speed = 1): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    const buf = kind === 'babble' ? (this.banks.babble ?? this.banks.pink) : this.banks[kind];
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = speed * this.rate;
    connect(src, dest);
    src.start(this.at(sec), Math.random() * buf.duration);
    this.stop(src, sec + dur);
    this.buffers.push({ node: src, speed });
    return src;
  }

  osc(type: OscillatorType, hz: number, sec: number, dur: number, dest: Dest, detune = 0): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = this.f(hz);
    o.detune.value = detune;
    connect(o, dest);
    o.start(this.at(sec));
    this.stop(o, sec + dur);
    this.oscs.push({ node: o, detune });
    return o;
  }

  filter(type: BiquadFilterType, hz: number, q: number, dest: Dest): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = Math.min(this.f(hz), this.ctx.sampleRate * 0.45);
    f.Q.value = q;
    connect(f, dest);
    return f;
  }

  gain(value: number, dest: Dest): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = value;
    connect(g, dest);
    return g;
  }

  /**
   * Saturation: rounds peaks off and adds weight. `amount` scales the input into the curve; the
   * curve's output reaches full scale, so `level` sets what comes out.
   */
  drive(dest: Dest, amount = 1, level = 1): AudioNode {
    const pre = this.ctx.createGain();
    pre.gain.value = amount;
    const ws = this.ctx.createWaveShaper();
    ws.curve = this.banks.drive;
    ws.oversample = '2x';
    pre.connect(ws);
    connect(ws, this.gain(level, dest));
    return pre;
  }

  /** Linear rise to `peak`, exponential fall over `decay` (to -60 dB). */
  ad(param: AudioParam, sec: number, attack: number, peak: number, decay: number): void {
    if (!(peak > 0)) return;
    param.setValueAtTime(0, this.at(sec));
    param.linearRampToValueAtTime(peak, this.at(sec + attack));
    param.exponentialRampToValueAtTime(peak * 1e-3, this.at(sec + attack + decay));
  }

  /** Rise, hold, then fall over `release`. */
  ahr(param: AudioParam, sec: number, attack: number, peak: number, hold: number, release: number): void {
    if (!(peak > 0)) return;
    param.setValueAtTime(0, this.at(sec));
    param.linearRampToValueAtTime(peak, this.at(sec + attack));
    param.setValueAtTime(peak, this.at(sec + attack + hold));
    param.exponentialRampToValueAtTime(peak * 1e-3, this.at(sec + attack + hold + release));
  }

  /** Exponential glide of a frequency param (rate applied). */
  glide(param: AudioParam, sec: number, from: number, to: number, dur: number): void {
    const nyq = this.ctx.sampleRate * 0.45;
    param.setValueAtTime(Math.min(this.f(from), nyq), this.at(sec));
    param.exponentialRampToValueAtTime(Math.min(this.f(to), nyq), this.at(sec + dur));
  }
}

// ---------------------------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------------------------

type BurstOpts = {
  at?: number;
  noise?: NoiseKind;
  type?: BiquadFilterType;
  freq: number;
  /** Glide the filter to this frequency over the burst. */
  to?: number;
  q?: number;
  attack?: number;
  decay: number;
  gain: number;
  speed?: number;
  dest?: Dest;
};

/** Filtered noise burst: transients, splats, hiss, crunch. */
function burst(v: VoiceBuilder, o: BurstOpts): void {
  const at = o.at ?? 0;
  const attack = o.attack ?? 0.002;
  const g = v.gain(0, o.dest ?? v.out);
  const flt = v.filter(o.type ?? 'bandpass', o.freq, o.q ?? 1, g);
  if (o.to !== undefined) v.glide(flt.frequency, at, o.freq, o.to, attack + o.decay);
  v.noise(o.noise ?? 'white', at, attack + o.decay + 0.02, flt, o.speed ?? 1);
  v.ad(g.gain, at, attack, o.gain, o.decay);
}

/** Pitch-dropping tone: the body of a thud, a kick, a plop. */
function thump(v: VoiceBuilder, at: number, from: number, to: number, dur: number, gain: number, dest: Dest = v.out, type: OscillatorType = 'sine'): void {
  const g = v.gain(0, dest);
  const o = v.osc(type, from, at, dur + 0.02, g);
  v.glide(o.frequency, at, from, to, dur);
  v.ad(g.gain, at, 0.002, gain, dur);
}

/** Inharmonic partials with their own decays: metal, bells, ceramic. */
function ring(v: VoiceBuilder, at: number, base: number, ratios: readonly number[], decays: readonly number[], gain: number, dest: Dest = v.out): void {
  for (let i = 0; i < ratios.length; i++) {
    const d = decays[i] ?? decays[decays.length - 1]!;
    const g = v.gain(0, dest);
    v.osc('sine', base * ratios[i]!, at, d + 0.03, g);
    v.ad(g.gain, at, 0.001, gain / (1 + i * 0.6), d);
  }
}

/** Air rushing past: level and band swell together to the peak, then fall away. */
function whoosh(v: VoiceBuilder, at: number, dur: number, from: number, peak: number, q: number, gain: number, noise: NoiseKind = 'white', dest: Dest = v.out): void {
  const g = v.gain(0, dest);
  const flt = v.filter('bandpass', from, q, g);
  flt.frequency.setValueAtTime(v.f(from), v.at(at));
  flt.frequency.exponentialRampToValueAtTime(v.f(peak), v.at(at + dur * 0.55));
  flt.frequency.exponentialRampToValueAtTime(v.f(from * 0.8), v.at(at + dur));
  v.noise(noise, at, dur + 0.02, flt);
  g.gain.setValueAtTime(0, v.at(at));
  g.gain.linearRampToValueAtTime(gain, v.at(at + dur * 0.55));
  g.gain.exponentialRampToValueAtTime(gain * 1e-3, v.at(at + dur));
}

/** A gain stage wobbled by an LFO (spin, growl, chunky wet tearing). Returns its input. */
function tremolo(v: VoiceBuilder, at: number, dur: number, hz: number, depth: number, dest: Dest, type: OscillatorType = 'sine'): GainNode {
  const g = v.gain(1 - depth / 2, dest);
  const lfoG = v.gain(depth / 2, g.gain);
  v.osc(type, hz, at, dur, lfoG);
  return g;
}

/** FM bell: bright metallic attack that settles into a pure tone. */
function bell(v: VoiceBuilder, at: number, freq: number, ratio: number, index: number, dur: number, gain: number, dest: Dest = v.out): void {
  const g = v.gain(0, dest);
  const car = v.osc('sine', freq, at, dur + 0.03, g);
  const modG = v.gain(0, car.frequency);
  v.osc('sine', freq * ratio, at, dur + 0.03, modG);
  modG.gain.setValueAtTime(v.f(freq * index), v.at(at));
  modG.gain.exponentialRampToValueAtTime(v.f(freq * index * 0.04), v.at(at + dur * 0.6));
  v.ad(g.gain, at, 0.002, gain, dur);
}

/** Meat: the wet smack and low body under every blow that lands on a fighter. */
function flesh(v: VoiceBuilder, size: number, gain = 1): void {
  burst(v, { noise: 'pink', freq: 1600, to: 480, q: 1.3, decay: 0.07 + 0.06 * size, gain: 0.55 * gain });
  thump(v, 0, 130, 52, 0.1 + 0.08 * size, (0.2 + 0.45 * size) * gain);
  burst(v, { noise: 'crackle', freq: 1300, q: 0.9, attack: 0.003, decay: 0.1, gain: 0.3 * size * gain });
}

/** Snarl: a saw through a throat formant, saturated and wobbled. */
function growl(v: VoiceBuilder, at: number, dur: number, from: number, to: number, gain: number): void {
  const env = v.gain(0, v.out);
  const am = tremolo(v, at, dur, 23, 0.7, env, 'triangle');
  const drv = v.drive(am, 3, 0.7);
  const bp = v.filter('bandpass', 560, 2.4, drv);
  const o = v.osc('sawtooth', from, at, dur + 0.02, bp);
  v.glide(o.frequency, at, from, to, dur);
  v.ahr(env.gain, at, 0.06, gain, dur * 0.45, dur * 0.5);
}

/** Two quick low beats. */
function heartbeat(v: VoiceBuilder, at: number, beats: number, gain: number): void {
  for (let i = 0; i < beats; i++) {
    thump(v, at + i * 0.42, 72, 44, 0.12, gain);
    thump(v, at + i * 0.42 + 0.17, 66, 42, 0.1, gain * 0.7);
  }
}

// ---------------------------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------------------------

type Recipe = (v: VoiceBuilder, cue: Cue, rand: () => number) => void;

const R = (a: number, b: number, rand: () => number) => a + (b - a) * rand();

export const RECIPES: Readonly<Record<SoundId, Recipe>> = {
  // --- swings -------------------------------------------------------------------------------
  swing_greatsword(v) {
    whoosh(v, 0, 0.36, 330, 1700, 1.3, 0.55);
    whoosh(v, 0.02, 0.32, 170, 520, 0.8, 0.4, 'pink');
    ring(v, 0, 2350, [1, 1.62], [0.1, 0.07], 0.03);
  },
  swing_warhammer(v) {
    whoosh(v, 0, 0.44, 160, 720, 0.9, 0.55, 'pink');
    whoosh(v, 0.03, 0.4, 90, 260, 0.7, 0.45, 'brown');
  },
  swing_daggers(v) {
    whoosh(v, 0, 0.13, 1200, 3800, 1.8, 0.38);
    whoosh(v, 0.08, 0.12, 1400, 4300, 1.8, 0.32);
  },
  swing_punch(v) {
    whoosh(v, 0, 0.14, 500, 1500, 1.2, 0.35, 'pink');
  },
  swing_axe(v) {
    whoosh(v, 0, 0.18, 700, 2200, 1.2, 0.22);
    burst(v, { noise: 'pink', type: 'lowpass', freq: 600, attack: 0.04, decay: 0.12, gain: 0.12 });
  },
  draw_bow(v) {
    // Creaking limbs and string tension rising through the draw.
    const g = v.gain(0, v.out);
    const am = tremolo(v, 0, 0.36, 31, 0.8, g, 'square');
    const bp = v.filter('bandpass', 1100, 5, am);
    const o = v.osc('sawtooth', 58, 0, 0.36, bp);
    v.glide(o.frequency, 0, 58, 82, 0.32);
    v.ahr(g.gain, 0, 0.12, 0.4, 0.1, 0.12);
    burst(v, { noise: 'pink', freq: 2600, q: 3, attack: 0.1, decay: 0.15, gain: 0.1 });
  },
  charge_staff(v) {
    const g = v.gain(0, v.out);
    const lp = v.filter('lowpass', 2400, 2, g);
    const car = v.osc('sine', 180, 0, 0.36, lp);
    v.glide(car.frequency, 0, 180, 740, 0.32);
    const modG = v.gain(v.f(70), car.frequency);
    v.osc('square', 37, 0, 0.36, modG);
    v.ahr(g.gain, 0, 0.26, 0.16, 0.02, 0.07);
    burst(v, { type: 'highpass', freq: 5500, attack: 0.25, decay: 0.1, gain: 0.05 });
  },

  // --- projectiles leaving ------------------------------------------------------------------
  release_bow(v) {
    // A low "thwong" from the string, a click, and the arrow whipping away.
    const g = v.gain(0, v.out);
    const lp = v.filter('lowpass', 900, 3, g);
    const o = v.osc('sawtooth', 132, 0, 0.22, lp);
    v.glide(o.frequency, 0, 132, 96, 0.18);
    v.ad(g.gain, 0, 0.002, 0.24, 0.2);
    thump(v, 0, 95, 60, 0.08, 0.22);
    burst(v, { type: 'highpass', freq: 2600, attack: 0.001, decay: 0.015, gain: 0.22 });
    whoosh(v, 0.01, 0.14, 2600, 6200, 1.5, 0.14);
  },
  release_axe(v) {
    // The axe spinning away: a whirring band of noise chopped by the rotation.
    const env = v.gain(0, v.out);
    const am = tremolo(v, 0, 0.42, 17, 0.9, env);
    burst(v, { freq: 1500, q: 2.2, attack: 0.001, decay: 0.4, gain: 1, dest: am });
    v.ahr(env.gain, 0, 0.03, 1, 0.06, 0.3);
    whoosh(v, 0, 0.16, 800, 2600, 1.2, 0.32);
  },
  release_staff(v) {
    const g = v.gain(0, v.out);
    const drv = v.drive(g, 1.8, 0.8);
    const lp = v.filter('lowpass', 3200, 1.5, drv);
    const car = v.osc('sawtooth', 900, 0, 0.2, lp);
    v.glide(car.frequency, 0, 900, 170, 0.17);
    const modG = v.gain(v.f(280), car.frequency);
    v.osc('square', 63, 0, 0.2, modG);
    v.ad(g.gain, 0, 0.003, 0.24, 0.18);
    burst(v, { noise: 'crackle', freq: 3500, q: 1.5, decay: 0.09, gain: 0.3 });
    whoosh(v, 0.02, 0.22, 1000, 3000, 1, 0.12);
  },

  // --- blows on fighters --------------------------------------------------------------------
  hit_blade(v, cue) {
    // Steel slicing through: a bright shhk, a short metal tick, then meat.
    burst(v, { freq: 2800, to: 5200, q: 0.9, attack: 0.002, decay: 0.09, gain: 0.5 });
    ring(v, 0, 2900, [1, 1.47], [0.07, 0.05], 0.08);
    flesh(v, cue.intensity);
  },
  hit_hammer(v, cue) {
    // A heavy, saturated thud with a bone crack on top.
    const drv = v.drive(v.out, 2, 0.26);
    thump(v, 0, 150, 42, 0.3, 0.75, drv);
    burst(v, { noise: 'brown', type: 'lowpass', freq: 520, decay: 0.22, gain: 0.45 });
    burst(v, { at: 0.004, freq: 3200, q: 2, attack: 0.0005, decay: 0.012, gain: 0.45 });
    burst(v, { at: 0.024, freq: 2600, q: 2, attack: 0.0005, decay: 0.015, gain: 0.35 });
    flesh(v, cue.intensity, 0.85);
  },
  hit_dagger(v, cue) {
    burst(v, { freq: 2200, to: 900, q: 2, attack: 0.001, decay: 0.05, gain: 0.5 });
    thump(v, 0, 240, 110, 0.06, 0.3);
    burst(v, { at: 0.018, noise: 'pink', freq: 1800, to: 600, q: 3, decay: 0.09, gain: 0.4 });
    flesh(v, cue.intensity * 0.6, 0.7);
  },
  hit_arrow(v, cue) {
    thump(v, 0, 280, 130, 0.06, 0.5);
    burst(v, { noise: 'pink', freq: 1300, q: 1.5, attack: 0.001, decay: 0.035, gain: 0.5 });
    flesh(v, cue.intensity * 0.7);
  },
  hit_axe(v, cue) {
    burst(v, { noise: 'pink', freq: 1100, q: 1, attack: 0.001, decay: 0.07, gain: 0.55 });
    ring(v, 0, 760, [1, 2.4, 4.1], [0.18, 0.12, 0.08], 0.13);
    thump(v, 0, 170, 60, 0.12, 0.45);
    flesh(v, cue.intensity);
  },
  hit_arcane(v, cue) {
    // An electric zap: buzzy FM through a closing resonant filter, crackle and sizzle.
    const g = v.gain(0, v.out);
    const drv = v.drive(g, 2, 0.7);
    const lp = v.filter('lowpass', 4000, 6, drv);
    v.glide(lp.frequency, 0, 4000, 380, 0.25);
    const car = v.osc('sawtooth', 112, 0, 0.3, lp);
    const modG = v.gain(v.f(75), car.frequency);
    v.osc('square', 47, 0, 0.3, modG);
    v.ad(g.gain, 0, 0.002, 0.4, 0.27);
    burst(v, { noise: 'crackle', freq: 3000, q: 1, decay: 0.25, gain: 0.45 });
    burst(v, { type: 'highpass', freq: 7000, attack: 0.005, decay: 0.38, gain: 0.1 });
    flesh(v, cue.intensity * 0.5, 0.6);
  },
  hit_punch(v) {
    burst(v, { noise: 'pink', freq: 1500, q: 0.8, attack: 0.001, decay: 0.05, gain: 0.7 });
    thump(v, 0, 170, 68, 0.09, 0.55);
  },
  hit_flesh(v, cue) {
    flesh(v, cue.intensity);
  },
  crit_crunch(v) {
    const drv = v.drive(v.out, 2, 0.4);
    burst(v, { noise: 'crackle', freq: 2500, q: 1, attack: 0.001, decay: 0.07, gain: 0.45 });
    burst(v, { at: 0.012, freq: 1800, q: 1.5, attack: 0.0005, decay: 0.02, gain: 0.4 });
    thump(v, 0, 92, 38, 0.13, 0.55, drv);
  },
  backstab_shink(v) {
    burst(v, { freq: 3000, to: 7000, q: 4, attack: 0.01, decay: 0.2, gain: 0.28 });
    ring(v, 0.01, 3600, [1, 1.33], [0.26, 0.2], 0.07);
  },

  // --- projectiles stopped ------------------------------------------------------------------
  thunk_arrow(v) {
    thump(v, 0, 210, 120, 0.07, 0.5);
    burst(v, { noise: 'pink', freq: 1400, q: 1.2, attack: 0.001, decay: 0.05, gain: 0.45 });
    // The shaft wobbling in the wood.
    const g = v.gain(0, v.out);
    const lp = v.filter('lowpass', 620, 2, g);
    v.osc('square', 71, 0.01, 0.26, lp);
    v.ad(g.gain, 0.01, 0.002, 0.09, 0.24);
  },
  clang_axe(v) {
    ring(v, 0, 540, [1, 2.76, 5.4, 8.93], [0.5, 0.35, 0.2, 0.12], 0.32);
    burst(v, { type: 'highpass', freq: 3500, attack: 0.0005, decay: 0.02, gain: 0.4 });
    thump(v, 0, 180, 90, 0.06, 0.3);
  },
  burst_orb(v, _cue, rand) {
    burst(v, { noise: 'crackle', freq: 2400, to: 900, q: 2, decay: 0.22, gain: 0.55 });
    thump(v, 0, 520, 70, 0.18, 0.4);
    burst(v, { type: 'highpass', freq: 6000, attack: 0.004, decay: 0.3, gain: 0.12 });
    ring(v, 0, R(600, 720, rand), [1, 1.5, 2.01], [0.26, 0.2, 0.15], 0.08);
  },

  // --- big moments --------------------------------------------------------------------------
  parry(v, _cue, rand) {
    // Steel on steel: a ringing cluster of inharmonic partials over a hard transient.
    ring(v, 0, R(470, 560, rand), [1, 2.32, 3.87, 5.13, 6.8, 8.3], [0.7, 0.5, 0.36, 0.26, 0.18, 0.12], 0.36);
    burst(v, { type: 'highpass', freq: 4000, attack: 0.0005, decay: 0.02, gain: 0.6 });
    thump(v, 0, 300, 150, 0.05, 0.3);
    burst(v, { freq: 5200, q: 1, attack: 0.01, decay: 0.3, gain: 0.05 });
  },
  dismember(v) {
    // Wet tearing, a bone snap, a plop and the slurp of what came loose.
    const am = tremolo(v, 0, 0.36, 32, 0.75, v.out);
    burst(v, { noise: 'pink', freq: 2600, to: 380, q: 3.5, attack: 0.004, decay: 0.32, gain: 0.85, dest: am });
    burst(v, { type: 'highpass', freq: 2500, attack: 0.0005, decay: 0.01, gain: 0.7 });
    thump(v, 0, 900, 250, 0.03, 0.3);
    thump(v, 0.05, 190, 70, 0.16, 0.6);
    const g = v.gain(0, v.out);
    const lp = v.filter('lowpass', 1200, 1, g);
    const o = v.osc('sine', 700, 0.08, 0.24, lp);
    v.glide(o.frequency, 0.08, 700, 180, 0.22);
    v.ad(g.gain, 0.08, 0.02, 0.12, 0.18);
    burst(v, { at: 0.03, freq: 4000, q: 0.7, attack: 0.02, decay: 0.4, gain: 0.1 });
  },
  death_splat(v, cue, rand) {
    // A comic body burst: saturated thump, brown blast, wet sweep, spray, then gibs landing.
    const drv = v.drive(v.out, 2.4, 0.6);
    thump(v, 0, 100, 34, 0.45, 0.85, drv);
    burst(v, { noise: 'brown', type: 'lowpass', freq: 1100, decay: 0.55, gain: 0.6 });
    const am = tremolo(v, 0, 0.5, 26, 0.6, v.out);
    burst(v, { noise: 'pink', freq: 1900, to: 280, q: 1.8, attack: 0.003, decay: 0.45, gain: 0.6, dest: am });
    burst(v, { at: 0.02, freq: 3500, q: 0.6, attack: 0.03, decay: 0.6, gain: 0.15 });
    const gibs = 4 + Math.round(3 * cue.intensity);
    for (let i = 0; i < gibs; i++) {
      const at = 0.12 + rand() * 0.65;
      const f = R(320, 650, rand);
      thump(v, at, f, f * 0.45, 0.06, R(0.15, 0.3, rand));
      burst(v, { at, noise: 'pink', freq: 1400, q: 1.2, decay: 0.03, gain: 0.18 });
    }
  },
  kill_sting(v) {
    // A broadcast stinger: a minor orchestra stab (detuned saws through a closing low-pass), kick and snare.
    const env = v.gain(0, v.out);
    const drv = v.drive(env, 1.4, 0.8);
    const lp = v.filter('lowpass', 6000, 1.5, drv);
    v.glide(lp.frequency, 0, 6000, 700, 0.42);
    const root = 146.83;
    const notes = [0.5, 1, 1.5, 2, 2.378, 3];
    const each = v.gain(0.42 / Math.sqrt(notes.length * 2), lp);
    for (const n of notes) for (const cents of [-8, 8]) v.osc('sawtooth', root * n, 0, 0.9, each, cents);
    v.ahr(env.gain, 0, 0.004, 1, 0.05, 0.6);
    thump(v, 0, 170, 40, 0.4, 0.85, v.drive(v.out, 2, 0.6));
    burst(v, { freq: 1900, q: 0.8, attack: 0.001, decay: 0.18, gain: 0.45 });
    burst(v, { type: 'highpass', freq: 6000, attack: 0.002, decay: 0.28, gain: 0.14 });
  },
  crowd_roar(v, cue, rand) {
    // The crowd erupts: babble pushed up and brighter, an "ohh" choir swelling, breath, claps, whistles.
    const d = cue.intensity;
    const attack = 0.12 + 0.12 * d;
    const hold = 0.5 + 0.9 * d;
    const release = 1 + 1.6 * d;
    const total = attack + hold + release;
    const env = v.gain(0, v.out);
    v.ahr(env.gain, 0, attack, 0.7 + 0.3 * d, hold, release);

    const hp = v.filter('highpass', 220, 0.7, env);
    const babble = v.gain(0.55 + 0.35 * d, hp);
    v.noise('babble', 0, total + 0.05, babble, 1.1 + 0.14 * d);

    const formants = v.gain(1, env);
    const f1 = v.filter('bandpass', 720, 3, formants);
    const f2 = v.filter('bandpass', 1180, 4, v.gain(0.6, formants));
    const f3 = v.filter('bandpass', 2550, 6, v.gain(0.25, formants));
    const voices = 5 + Math.round(9 * d);
    const choir = v.gain(1.1 / Math.sqrt(voices), f1);
    choir.connect(f2);
    choir.connect(f3);
    for (let i = 0; i < voices; i++) {
      const f0 = R(125, 330, rand);
      const o = v.osc('sawtooth', f0 * 0.92, R(0, 0.08, rand), total, choir, R(-20, 20, rand));
      o.frequency.setValueAtTime(v.f(f0 * 0.92), v.at(0));
      o.frequency.exponentialRampToValueAtTime(v.f(f0 * (1.05 + 0.12 * d)), v.at(attack + 0.1));
      o.frequency.exponentialRampToValueAtTime(v.f(f0 * 0.94), v.at(total));
    }

    burst(v, { noise: 'pink', freq: 1000, q: 0.6, attack, decay: hold + release, gain: 0.28 + 0.2 * d, dest: env });
    burst(v, { noise: 'pink', freq: 2600, q: 1, attack, decay: hold + release * 0.6, gain: 0.1 + 0.08 * d, dest: env });
    if (d > 0.45) burst(v, { noise: 'applause', freq: 2200, q: 0.7, attack: attack + 0.25, decay: hold + release, gain: 0.35 * d, dest: env });
    if (d > 0.7) {
      for (let i = 0; i < 2; i++) {
        const at = R(0.15, 0.7, rand);
        const f = R(1900, 2300, rand);
        const g = v.gain(0, v.out);
        const o = v.osc('sine', f, at, 0.5, g);
        o.frequency.setValueAtTime(v.f(f), v.at(at));
        o.frequency.exponentialRampToValueAtTime(v.f(f * 1.28), v.at(at + 0.14));
        o.frequency.exponentialRampToValueAtTime(v.f(f * 1.1), v.at(at + 0.45));
        v.ahr(g.gain, at, 0.03, 0.035, 0.25, 0.15);
      }
    }
  },
  explosion(v, cue) {
    const s = cue.intensity;
    const drv = v.drive(v.out, 2.5, 0.75);
    thump(v, 0, 95, 26, 0.9, 0.9, drv);
    burst(v, { noise: 'brown', type: 'lowpass', freq: 3000, to: 150, q: 0.7, attack: 0.002, decay: 1.2 + 0.4 * s, gain: 0.9 });
    burst(v, { freq: 1500, q: 0.5, attack: 0.0005, decay: 0.04, gain: 0.7 });
    burst(v, { at: 0.05, noise: 'crackle', freq: 2200, q: 0.8, attack: 0.05, decay: 0.9, gain: 0.4 });
    burst(v, { noise: 'brown', type: 'lowpass', freq: 120, attack: 0.1, decay: 1.8, gain: 0.45 + 0.2 * s });
  },

  // --- skills -------------------------------------------------------------------------------
  skill_whirlwind(v) {
    const am = tremolo(v, 0, 0.8, 9, 0.85, v.out);
    whoosh(v, 0, 0.78, 500, 2400, 1.1, 0.55, 'white', am);
    whoosh(v, 0, 0.7, 150, 420, 0.8, 0.3, 'pink');
  },
  skill_shadowstep(v) {
    // A reversed whoosh sucking in, a pop, and smoke.
    const g = v.gain(0, v.out);
    const bp = v.filter('bandpass', 3000, 1.2, g);
    v.glide(bp.frequency, 0, 3000, 800, 0.22);
    v.noise('white', 0, 0.26, bp);
    g.gain.setValueAtTime(0.001, v.at(0));
    g.gain.exponentialRampToValueAtTime(0.4, v.at(0.22));
    g.gain.linearRampToValueAtTime(0, v.at(0.25));
    thump(v, 0.22, 1100, 250, 0.06, 0.35);
    burst(v, { at: 0.22, type: 'highpass', freq: 5000, attack: 0.01, decay: 0.4, gain: 0.08 });
  },
  skill_dash(v) {
    whoosh(v, 0, 0.3, 300, 3200, 1.2, 0.5);
    burst(v, { noise: 'pink', type: 'lowpass', freq: 600, decay: 0.08, gain: 0.35 });
  },
  skill_shockwave(v) {
    const drv = v.drive(v.out, 2.4, 0.3);
    thump(v, 0, 75, 28, 0.7, 0.9, drv);
    burst(v, { noise: 'brown', type: 'lowpass', freq: 700, decay: 0.5, gain: 0.4 });
    burst(v, { freq: 1600, q: 0.6, attack: 0.0005, decay: 0.025, gain: 0.5 });
    whoosh(v, 0.02, 0.5, 400, 1600, 0.8, 0.2);
  },
  skill_bloodrage(v) {
    growl(v, 0, 0.9, 82, 112, 0.5);
    heartbeat(v, 0.05, 2, 0.6);
    burst(v, { noise: 'pink', freq: 700, q: 1.2, attack: 0.08, decay: 0.6, gain: 0.25 });
  },

  // --- footsteps ------------------------------------------------------------------------------
  footstep(v) {
    burst(v, { noise: 'pink', type: 'lowpass', freq: 420, q: 0.7, decay: 0.045, gain: 0.6 });
    thump(v, 0, 85, 60, 0.04, 0.3);
  },
  footstep_wet(v) {
    burst(v, { noise: 'pink', type: 'lowpass', freq: 420, q: 0.7, decay: 0.045, gain: 0.5 });
    burst(v, { noise: 'pink', freq: 1300, to: 650, q: 2, attack: 0.003, decay: 0.07, gain: 0.45 });
    thump(v, 0, 85, 60, 0.04, 0.25);
  },

  // --- power-ups and healing ------------------------------------------------------------------
  pickup_haste(v) {
    burst(v, { freq: 500, to: 5000, q: 1.5, attack: 0.24, decay: 0.12, gain: 0.45 });
    const notes = [1046.5, 1318.5, 1568, 2093];
    for (let i = 0; i < notes.length; i++) bell(v, 0.04 + i * 0.05, notes[i]!, 2, 1.2, 0.4, 0.2);
    burst(v, { at: 0.2, type: 'highpass', freq: 7000, attack: 0.01, decay: 0.4, gain: 0.06 });
  },
  pickup_berserk(v) {
    growl(v, 0, 0.75, 62, 94, 0.5);
    heartbeat(v, 0, 1, 0.65);
    burst(v, { noise: 'pink', freq: 700, q: 1.2, attack: 0.08, decay: 0.5, gain: 0.22 });
  },
  pickup_ammo(v) {
    ring(v, 0, 2300, [1, 1.52, 2.7], [0.06, 0.05, 0.03], 0.14);
    burst(v, { type: 'highpass', freq: 3000, attack: 0.0005, decay: 0.015, gain: 0.15 });
    burst(v, { at: 0.04, freq: 1800, q: 2, attack: 0.0005, decay: 0.02, gain: 0.12 });
  },
  spawn_haste(v) {
    // Bright rising chime: the power-up is back.
    const notes = [783.99, 1174.66, 1567.98];
    for (let i = 0; i < notes.length; i++) bell(v, i * 0.08, notes[i]!, 3.5, 1.6, 1.1, 0.2);
    burst(v, { at: 0.1, type: 'highpass', freq: 7000, attack: 0.05, decay: 0.7, gain: 0.05 });
  },
  spawn_berserk(v) {
    // Darker, gong-ish chime with a growl under it.
    const notes = [293.66, 349.23, 440];
    for (let i = 0; i < notes.length; i++) bell(v, i * 0.09, notes[i]!, 1.41, 2.2, 1.2, 0.22);
    thump(v, 0, 72, 52, 0.5, 0.3);
    burst(v, { noise: 'brown', type: 'lowpass', freq: 300, attack: 0.05, decay: 0.6, gain: 0.2 });
  },
  heal(v) {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    for (let i = 0; i < notes.length; i++) bell(v, i * 0.04, notes[i]!, 2, 0.6, 0.9, 0.09);
    burst(v, { noise: 'pink', freq: 1500, q: 0.7, attack: 0.15, decay: 0.5, gain: 0.06 });
  },

  // --- hazards, props, the wall ---------------------------------------------------------------
  hazard_spike(v) {
    burst(v, { freq: 2500, to: 6000, q: 3, attack: 0.005, decay: 0.12, gain: 0.4 });
    ring(v, 0, 1500, [1, 1.72, 2.9], [0.2, 0.15, 0.1], 0.12);
    thump(v, 0, 200, 120, 0.05, 0.3);
  },
  hazard_saw(v) {
    const env = v.gain(0, v.out);
    const am = tremolo(v, 0, 0.28, 30, 0.7, env, 'square');
    const bp = v.filter('bandpass', 1800, 1.5, am);
    v.osc('sawtooth', 140, 0, 0.28, bp);
    v.osc('sawtooth', 283, 0, 0.28, bp);
    v.ahr(env.gain, 0, 0.01, 0.6, 0.06, 0.18);
    burst(v, { freq: 3500, q: 1, attack: 0.005, decay: 0.15, gain: 0.35 });
  },
  hazard_acid(v) {
    burst(v, { type: 'highpass', freq: 3500, attack: 0.02, decay: 0.45, gain: 0.3 });
    burst(v, { noise: 'crackle', type: 'highpass', freq: 2000, attack: 0.01, decay: 0.4, gain: 0.3 });
  },
  hazard_fire(v) {
    whoosh(v, 0, 0.42, 300, 900, 0.8, 0.8, 'pink');
    burst(v, { noise: 'crackle', freq: 3000, q: 0.8, attack: 0.02, decay: 0.4, gain: 0.5 });
  },
  break_keg(v) {
    burst(v, { noise: 'crackle', freq: 1200, q: 0.9, attack: 0.001, decay: 0.15, gain: 0.6 });
    burst(v, { noise: 'pink', freq: 600, decay: 0.1, gain: 0.5 });
    thump(v, 0, 130, 70, 0.1, 0.4);
  },
  break_amphora(v, _cue, rand) {
    // Ceramic shattering: scattered bright partials, a hiss of shards, then the splash.
    for (let i = 0; i < 7; i++) ring(v, rand() * 0.05, R(2200, 7000, rand), [1], [R(0.05, 0.2, rand)], 0.07);
    burst(v, { type: 'highpass', freq: 3000, attack: 0.001, decay: 0.12, gain: 0.45 });
    thump(v, 0, 300, 150, 0.04, 0.2);
    burst(v, { at: 0.02, noise: 'pink', freq: 900, q: 0.8, attack: 0.01, decay: 0.25, gain: 0.25 });
  },
  break_crate(v) {
    burst(v, { noise: 'crackle', freq: 900, q: 0.9, attack: 0.001, decay: 0.12, gain: 0.9 });
    burst(v, { noise: 'brown', type: 'lowpass', freq: 800, decay: 0.15, gain: 0.7 });
    for (const at of [0, 0.03, 0.07]) burst(v, { at, freq: 2000, q: 1.5, attack: 0.0005, decay: 0.012, gain: 0.3 });
  },
  wall_grind(v) {
    // Stone and spikes scraping a fighter along: a gritty low grind with sparks.
    burst(v, { noise: 'brown', freq: 260, q: 1.3, attack: 0.03, decay: 0.22, gain: 0.55 });
    const env = v.gain(0, v.out);
    const am = tremolo(v, 0, 0.3, 13, 0.8, env);
    const lp = v.filter('lowpass', 300, 1, am);
    v.osc('sawtooth', 46, 0, 0.3, lp);
    v.ahr(env.gain, 0, 0.03, 0.25, 0.05, 0.2);
    burst(v, { noise: 'crackle', freq: 1800, q: 1, attack: 0.01, decay: 0.2, gain: 0.18 });
  },

  // --- announcements --------------------------------------------------------------------------
  horn(v) {
    // A long, low arena horn (cornu): detuned saw stacks opening up, a vibrato, a fall at the end.
    const env = v.gain(0, v.out);
    const drv = v.drive(env, 1.6, 0.75);
    const lp = v.filter('lowpass', 260, 2, drv);
    lp.frequency.setValueAtTime(v.f(260), v.at(0));
    lp.frequency.exponentialRampToValueAtTime(v.f(1400), v.at(0.5));
    lp.frequency.exponentialRampToValueAtTime(v.f(850), v.at(2.6));
    // Vibrato: an LFO summed into every saw's detune (cents).
    const vib = v.ctx.createGain();
    vib.gain.value = 9;
    v.osc('sine', 5.2, 0, 3.1, vib);
    const notes = [55, 82.41, 110];
    const each = v.gain(0.55 / Math.sqrt(notes.length * 3), lp);
    for (const n of notes) {
      for (const cents of [-7, 0, 7]) {
        const o = v.osc('sawtooth', n, 0, 3.1, each, cents);
        vib.connect(o.detune);
        o.frequency.setValueAtTime(v.f(n), v.at(2.2));
        o.frequency.exponentialRampToValueAtTime(v.f(n * 0.94), v.at(3));
      }
    }
    v.ahr(env.gain, 0, 0.35, 1, 1.5, 0.95);
    burst(v, { noise: 'pink', freq: 500, q: 1, attack: 0.35, decay: 2.2, gain: 0.08 });
    thump(v, 0, 90, 40, 0.6, 0.7, v.drive(v.out, 2, 0.5));
    burst(v, { noise: 'brown', type: 'lowpass', freq: 300, decay: 0.5, gain: 0.35 });
  },
  escalation(v, cue) {
    // A war drum: the pit gets meaner every beat.
    const drv = v.drive(v.out, 2, 0.3);
    thump(v, 0, 110 + 20 * cue.intensity, 48, 0.4, 0.85, drv);
    burst(v, { noise: 'brown', type: 'lowpass', freq: 350, attack: 0.002, decay: 0.3, gain: 0.3 });
    burst(v, { noise: 'pink', freq: 900, q: 1, attack: 0.001, decay: 0.05, gain: 0.3 });
  },
  gong(v) {
    ring(v, 0.005, 98, [1, 1.47, 2.09, 2.56, 3.18, 4.08, 5.31], [4, 3.2, 2.5, 2, 1.5, 1.1, 0.8], 0.36);
    thump(v, 0, 120, 60, 0.15, 0.5);
    burst(v, { noise: 'pink', freq: 1800, q: 1, attack: 0.2, decay: 2.5, gain: 0.05 });
  },
  bell(v) {
    // Boxing bell: three strikes.
    for (const at of [0, 0.3, 0.6]) {
      ring(v, at, 880, [1, 2.13, 3.48, 4.88, 6.3], [1.1, 0.8, 0.55, 0.35, 0.25], 0.34);
      burst(v, { at, type: 'highpass', freq: 4000, attack: 0.0005, decay: 0.01, gain: 0.3 });
    }
  },
};
