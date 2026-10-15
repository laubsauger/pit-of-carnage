// Owned by: audio
/**
 * The mixer: buses, reverb, ducking, the master limiter and the ambience beds, plus the live voices.
 *
 *   voices ──► sfx bus ─► sfx duck ──┐
 *   ambience ► amb bus ─► amb duck ──┴► slow-mo low-pass ─┬──────────────► master ─► limiter ─► soft clip ─► out
 *   crowd voices ► crowd bus ─────────────────────────────┤                  ▲
 *   horn, bell, chimes ► signal bus ──────────────────────┴─► pit reverb ────┘
 *
 * Works on any BaseAudioContext, so the same graph can be rendered offline for checks.
 */

import { SOUND_SPECS } from './cues';
import type { Cue } from './cues';
import { Ducker, Throttle, VoiceLimiter, slowmoCutoff, softClip, volumeGain } from './mix';
import type { VoiceGroup } from './mix';
import { RECIPES, VoiceBuilder, makeBanks, makeImpulse } from './synth';
import type { Banks } from './synth';

type Bus = 'sfx' | 'crowd' | 'signal';

const BUS_OF: Readonly<Record<VoiceGroup, Bus>> = {
  step: 'sfx',
  swing: 'sfx',
  impact: 'sfx',
  big: 'sfx',
  misc: 'sfx',
  crowd: 'crowd',
  signal: 'signal',
};

/** Seconds ahead of "now" a voice starts, so its first automation never lands in the past. */
const START_LEAD = 0.005;
/** Longest real-time wait for a delayed cue (a swing waiting out its windup). */
const MAX_DELAY = 0.6;
/** Seconds a voice keeps its nodes after its last source stopped (reverb tails live on the buses). */
const CLEANUP_AFTER = 0.05;
/** Murmur level at rest and at full excitement. */
const MURMUR_REST = 0.3;
const MURMUR_HOT = 0.85;
/** Seconds for crowd excitement to fall to 1/e. */
const EXCITEMENT_TAU = 5;

type LiveVoice = {
  id: number;
  out: GainNode;
  pan: StereoPannerNode;
  buffers: { node: AudioBufferSourceNode; speed: number }[];
  oscs: { node: OscillatorNode; detune: number }[];
  /** Cue pitch (variation or musical step); the engine rate is applied on top. */
  pitch: number;
  /** Engine rate when the voice was built (oscillator frequencies already include it). */
  rate0: number;
  /** Follows slow motion (everything but the announcer signals). */
  bend: boolean;
  end: number;
};

export class AudioEngine {
  readonly banks: Banks;
  private readonly master: GainNode;
  private readonly buses: Record<Bus, GainNode>;
  private readonly ambBus: GainNode;
  private readonly sfxDuckGain: GainNode;
  private readonly ambDuckGain: GainNode;
  private readonly slowFilter: BiquadFilterNode;
  private readonly duckSfx = new Ducker(0.02, 0.35);
  private readonly duckAmb = new Ducker(0.05, 0.8);
  private readonly limiter = new VoiceLimiter();
  private readonly throttle = new Throttle();
  private voices: LiveVoice[] = [];
  /** Sources of the ambience beds (bent with slow motion like the voices). */
  private readonly ambient: { buffers: { node: AudioBufferSourceNode; speed: number }[]; oscs: OscillatorNode[] } = { buffers: [], oscs: [] };
  private murmur: GainNode | null = null;
  private murmurFilter: BiquadFilterNode | null = null;
  private wall: GainNode | null = null;
  private wallOn = false;
  private babbleOn = false;
  private rate = 1;
  private timeScale = 1;
  private excitement = 0;
  private appliedExcitement = -1;

  constructor(readonly ctx: BaseAudioContext, banks?: Banks) {
    this.banks = banks ?? makeBanks(ctx);

    // Output: limiter then a soft clipper that can never reach full scale (input range +-2).
    const clipIn = ctx.createGain();
    clipIn.gain.value = 0.5;
    const clip = ctx.createWaveShaper();
    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) curve[i] = softClip(((i / (n - 1)) * 2 - 1) * 2);
    clip.curve = curve;
    clip.oversample = '2x';
    clipIn.connect(clip).connect(ctx.destination);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -9;
    limiter.knee.value = 4;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    limiter.connect(clipIn);
    this.master = ctx.createGain();
    this.master.gain.value = volumeGain(0.7);
    this.master.connect(limiter);

    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(ctx);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.5;
    reverb.connect(reverbReturn).connect(this.master);
    const send = (from: AudioNode, amount: number) => {
      const g = ctx.createGain();
      g.gain.value = amount;
      from.connect(g).connect(reverb);
    };

    this.slowFilter = ctx.createBiquadFilter();
    this.slowFilter.type = 'lowpass';
    this.slowFilter.frequency.value = slowmoCutoff(1);
    this.slowFilter.Q.value = 0.6;
    this.slowFilter.connect(this.master);
    send(this.slowFilter, 0.16);

    this.sfxDuckGain = ctx.createGain();
    this.sfxDuckGain.connect(this.slowFilter);
    this.ambDuckGain = ctx.createGain();
    this.ambDuckGain.connect(this.slowFilter);

    const bus = (gain: number, dest: AudioNode): GainNode => {
      const g = ctx.createGain();
      g.gain.value = gain;
      g.connect(dest);
      return g;
    };
    // Low: the beds sit well under every hit (about -30 dB at rest, -24 dB with a hot crowd and the wall).
    this.ambBus = bus(0.18, this.ambDuckGain);
    this.buses = {
      sfx: bus(0.9, this.sfxDuckGain),
      crowd: bus(0.7, this.master),
      signal: bus(0.75, this.master),
    };
    send(this.buses.crowd, 0.3);
    send(this.buses.signal, 0.28);
  }

  get activeVoices(): number {
    return this.limiter.active;
  }

  /** Play one cue now (plus its delay). False when throttled or crowded out. */
  play(cue: Cue, rand: () => number = Math.random): boolean {
    const spec = SOUND_SPECS[cue.sound];
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (!this.throttle.allow(cue.sound, now, spec.minGap)) return false;
    const bend = spec.group !== 'signal';
    const pitch = cue.pitch > 0 ? cue.pitch : 1;
    const rate = (bend ? this.rate : 1) * pitch;
    const delay = Math.min(MAX_DELAY, Math.max(0, cue.delay) / Math.max(this.timeScale, 0.25));
    const t0 = now + START_LEAD + delay;
    const grant = this.limiter.request(spec.group, spec.priority, now, t0 + spec.dur / rate);
    if (!grant) return false;
    if (grant.stolen) this.cut(grant.stolen, now);

    const out = ctx.createGain();
    out.gain.value = cue.gain;
    const pan = ctx.createStereoPanner();
    pan.pan.value = cue.pan;
    out.connect(pan).connect(this.buses[BUS_OF[spec.group]]);
    const b = new VoiceBuilder(ctx, this.banks, out, t0, rate);
    RECIPES[cue.sound](b, cue, rand);
    this.limiter.setEnd(grant.id, b.stopAt);
    this.voices.push({ id: grant.id, out, pan, buffers: b.buffers, oscs: b.oscs, pitch, rate0: this.rate, bend, end: b.stopAt });

    if (spec.duck) {
      this.duckSfx.duck(spec.duck.sfx, spec.duck.hold + delay);
      this.duckAmb.duck(spec.duck.amb, spec.duck.hold + delay);
    }
    return true;
  }

  /**
   * Follow the game clock: `rate` is the pitch/tempo factor (see pitchForTimeScale), `timeScale` the
   * game-time factor used to time delayed cues. Live voices and the ambience bend smoothly.
   */
  setRate(rate: number, timeScale: number): void {
    if (timeScale > 0) this.timeScale = timeScale;
    if (!(rate > 0) || Math.abs(rate - this.rate) < 0.002) return;
    this.rate = rate;
    const now = this.ctx.currentTime;
    const tau = 0.04;
    for (const v of this.voices) {
      if (!v.bend || v.end < now) continue;
      for (const b of v.buffers) b.node.playbackRate.setTargetAtTime(b.speed * v.pitch * rate, now, tau);
      const cents = 1200 * Math.log2(rate / v.rate0);
      for (const o of v.oscs) o.node.detune.setTargetAtTime(o.detune + cents, now, tau);
    }
    for (const b of this.ambient.buffers) b.node.playbackRate.setTargetAtTime(b.speed * rate, now, 0.08);
    for (const o of this.ambient.oscs) o.detune.setTargetAtTime(1200 * Math.log2(rate), now, 0.08);
    this.slowFilter.frequency.setTargetAtTime(slowmoCutoff(rate), now, 0.05);
  }

  setVolume(volume: number): void {
    this.master.gain.setTargetAtTime(volumeGain(volume), this.ctx.currentTime, 0.03);
  }

  /** Warm the crowd up (see excitementBump). */
  excite(amount: number): void {
    if (amount > 0) this.excitement = Math.min(1, this.excitement + amount);
  }

  /** The grinding wall drone runs while the sudden-death wall is moving. */
  setWallMoving(on: boolean): void {
    if (on === this.wallOn || !this.wall) return;
    this.wallOn = on;
    this.wall.gain.setTargetAtTime(on ? 0.4 : 0, this.ctx.currentTime, on ? 0.5 : 0.9);
  }

  /** Per frame (real seconds): ducking, crowd excitement, cleanup of finished voices. */
  tick(dt: number): void {
    const now = this.ctx.currentTime;
    const sfx = this.duckSfx.update(dt);
    const amb = this.duckAmb.update(dt);
    if (Math.abs(this.sfxDuckGain.gain.value - sfx) > 0.002) this.sfxDuckGain.gain.setTargetAtTime(sfx, now, 0.012);
    if (Math.abs(this.ambDuckGain.gain.value - amb) > 0.002) this.ambDuckGain.gain.setTargetAtTime(amb, now, 0.03);

    this.excitement *= Math.exp(-Math.max(0, dt) / EXCITEMENT_TAU);
    if (this.murmur && this.murmurFilter && Math.abs(this.excitement - this.appliedExcitement) > 0.01) {
      this.appliedExcitement = this.excitement;
      const e = this.excitement;
      this.murmur.gain.setTargetAtTime(MURMUR_REST + (MURMUR_HOT - MURMUR_REST) * e, now, 0.4);
      this.murmurFilter.frequency.setTargetAtTime(1500 + 2800 * e, now, 0.4);
    }

    if (this.voices.length > 0) {
      const keep: LiveVoice[] = [];
      for (const v of this.voices) {
        if (v.end + CLEANUP_AFTER < now) {
          v.out.disconnect();
          v.pan.disconnect();
          this.limiter.release(v.id);
        } else keep.push(v);
      }
      this.voices = keep;
    }
  }

  /** Fade a voice out fast (stolen by a more important sound, or everything stopping). */
  private cut(id: number, now: number): void {
    const v = this.voices.find((x) => x.id === id);
    if (!v) return;
    const g = v.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.025);
    for (const b of v.buffers) stopSafely(b.node, now + 0.03);
    for (const o of v.oscs) stopSafely(o.node, now + 0.03);
    v.end = now + 0.03;
  }

  stopAll(): void {
    const now = this.ctx.currentTime;
    for (const v of this.voices) this.cut(v.id, now);
    this.limiter.clear();
    this.throttle.clear();
    this.duckSfx.reset();
    this.duckAmb.reset();
  }

  /**
   * Start the beds: crowd murmur (formant-filtered pink noise until the babble is rendered), torch
   * crackle and fire rumble, and the (silent until sudden death) wall drone.
   */
  startAmbience(): void {
    if (this.murmur) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const loop = (buf: AudioBuffer, dest: AudioNode, speed = 1): AudioBufferSourceNode => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.playbackRate.value = speed * this.rate;
      s.connect(dest);
      s.start(now, Math.random() * buf.duration);
      this.ambient.buffers.push({ node: s, speed });
      return s;
    };
    const filter = (type: BiquadFilterType, hz: number, q: number, dest: AudioNode): BiquadFilterNode => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = hz;
      f.Q.value = q;
      f.connect(dest);
      return f;
    };
    const gain = (value: number, dest: AudioNode | AudioParam): GainNode => {
      const g = ctx.createGain();
      g.gain.value = value;
      if (dest instanceof AudioParam) g.connect(dest);
      else g.connect(dest);
      return g;
    };
    const lfo = (hz: number, depth: number, target: AudioParam, type: OscillatorType = 'sine'): void => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = hz;
      o.connect(gain(depth, target));
      o.start(now);
    };

    // Crowd murmur: two vowel-ish bands of pink noise breathing at unrelated slow rates.
    this.murmur = gain(MURMUR_REST, this.ambBus);
    this.murmurFilter = filter('lowpass', 1500, 0.5, this.murmur);
    const bandA = gain(0.5, this.murmurFilter);
    const bandB = gain(0.22, this.murmurFilter);
    loop(this.banks.pink, filter('bandpass', 480, 1.1, bandA));
    loop(this.banks.pink, filter('bandpass', 1250, 1.4, bandB));
    lfo(0.11, 0.18, bandA.gain);
    lfo(0.17, 0.1, bandB.gain);

    // Torches: crackle and a low fire rumble.
    const crackle = gain(0.16, this.ambBus);
    loop(this.banks.crackle, filter('highpass', 900, 0.7, crackle), 0.9);
    lfo(0.23, 0.06, crackle.gain);
    loop(this.banks.brown, filter('lowpass', 140, 0.7, gain(0.3, this.ambBus)));

    // The closing wall: grinding stone and a low saw, pulsing as it scrapes forward.
    this.wall = gain(0, this.ambBus);
    const pulse = gain(0.7, this.wall);
    lfo(0.8, 0.3, pulse.gain, 'triangle');
    loop(this.banks.brown, filter('bandpass', 170, 0.9, gain(1.2, pulse)), 0.8);
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.value = 38;
    saw.detune.value = 1200 * Math.log2(this.rate);
    saw.connect(filter('lowpass', 240, 1, gain(0.35, pulse)));
    saw.start(now);
    this.ambient.oscs.push(saw);
  }

  /** The rendered crowd babble fades in under (and then carries) the murmur. */
  setBabble(buf: AudioBuffer): void {
    this.banks.babble = buf;
    if (this.babbleOn || !this.murmurFilter) return;
    this.babbleOn = true;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = this.rate;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 160;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setTargetAtTime(0.9, now, 1.2);
    s.connect(hp).connect(g).connect(this.murmurFilter);
    s.start(now, Math.random() * buf.duration);
    this.ambient.buffers.push({ node: s, speed: 1 });
  }
}

function stopSafely(node: AudioScheduledSourceNode, when: number): void {
  try {
    node.stop(when);
  } catch {
    // Already stopped or never started: nothing to cut.
  }
}
