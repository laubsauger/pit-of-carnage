// Owned by: audio
/**
 * The mixer: buses, reverb, ducking, the master compressor and limiter, the ambience beds and the
 * live voices.
 *
 *   voices, grind ► sfx bus ─► sfx duck ──┐
 *   beds ─────────► amb bus ─► amb duck ──┴► slow-mo low-pass ─┬──────────► master ─► glue comp ─► limiter ─► soft clip ─► out
 *   crowd voices ► crowd bus ──────────────────────────────────┤              ▲
 *   horn, stings, countdown ► signal bus ──────────────────────┴► pit reverb ─┘
 *
 * The crowd bed (babble and murmur) breathes with `setCrowd(intensity)`: nearly silent in a lull,
 * swelling and brightening with the action. Its texture comes from the round's `CrowdProfile`.
 * Works on any BaseAudioContext, so the same graph can be rendered offline for checks.
 */

import { SOUND_SPECS, trimGain } from './cues';
import type { Cue } from './cues';
import { bedCutoff, bedLevel, crowdProfile } from './crowd';
import type { CrowdProfile } from './crowd';
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
/**
 * Longest real-time wait for a delayed cue: a swing waiting out its windup in slow motion, or a
 * chant waiting for the kill's roar to peak.
 */
const MAX_DELAY = 1.5;
/** Seconds a voice keeps its nodes after its last source stopped (reverb tails live on the buses). */
const CLEANUP_AFTER = 0.05;
/**
 * Crowd bed gain at a full swell (`bedLevel` 1); a lull plays the profile's small fraction of it.
 * Measured offline (src/audio/dev): a full swell sits near -31 dBFS RMS, well under a brawl
 * (about -17); a lull, torches included, near -49.
 */
const BED_HOT = 0.3;
/** Seconds (time constants) for the bed to swell up and to settle back down. */
const BED_RISE = 0.3;
const BED_FALL = 0.9;
/** Gain of the wall-contact grind loop with one fighter on the spikes. */
const GRIND_GAIN = 0.18;
/** Seconds the grind keeps going after the last contact batch (contact arrives every tick). */
const GRIND_HOLD = 0.15;
/** Seconds for one round's babble to crossfade into the next. */
const BABBLE_FADE = 1.2;
/** Bus gains: effects, crowd voices, beds (low: about -30 dB at rest, -24 dB with a hot crowd and the wall). */
const BUS_SFX = 0.9;
const BUS_CROWD = 0.7;
const BUS_AMB = 0.18;
/**
 * Under the end card (`setHush`): the crowd bus keeps this share (the roar's tail fades into near
 * silence) and the beds this share (a low murmur of torches, about -18 dB under their rest level).
 */
export const HUSH_CROWD = 0.04;
export const HUSH_AMB = 0.13;

type Loop = { node: AudioBufferSourceNode; speed: number };

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
  private readonly ambient: { buffers: Loop[]; oscs: OscillatorNode[] } = { buffers: [], oscs: [] };
  private profile: CrowdProfile = crowdProfile(0);
  private bed: GainNode | null = null;
  private bedFilter: BiquadFilterNode | null = null;
  /** The hot layer: a brighter, denser second pass of the babble that only comes up when the crowd does. */
  private bedHot: GainNode | null = null;
  private murmurBands: BiquadFilterNode[] = [];
  private breaths: OscillatorNode[] = [];
  /** The babble now playing in the bed (two loops: body and hot layer) and their fade gains. */
  private babble: { loops: Loop[]; fades: GainNode[] } | null = null;
  private appliedBed = -1;
  private wall: GainNode | null = null;
  private wallOn = false;
  private grind: GainNode | null = null;
  private grindPan: StereoPannerNode | null = null;
  private grindLevel = 0;
  private grindUntil = -1;
  private appliedGrind = 0;
  private rate = 1;
  private timeScale = 1;
  private hushOn = false;

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
    // Glue: a gentle compressor that pulls a brawl's hits and the crowd into one mix before the
    // limiter catches the peaks; the makeup gain gives back what it takes from ordinary hits.
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -20;
    glue.knee.value = 8;
    glue.ratio.value = 3;
    glue.attack.value = 0.006;
    glue.release.value = 0.22;
    const makeup = ctx.createGain();
    makeup.gain.value = 1.3;
    glue.connect(makeup).connect(limiter);
    this.master = ctx.createGain();
    this.master.gain.value = volumeGain(0.7);
    this.master.connect(glue);

    // The convolver normalizes the impulse (equal power), which measures -8.7 dB on steady sound;
    // each send below is set for its wet level against the dry signal.
    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(ctx);
    reverb.connect(this.master);
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
    // Effects and beds about -19 dB wet: the pit is stone, but hits stay tight.
    send(this.slowFilter, 0.3);

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
    this.ambBus = bus(BUS_AMB, this.ambDuckGain);
    this.buses = {
      sfx: bus(BUS_SFX, this.sfxDuckGain),
      crowd: bus(BUS_CROWD, this.master),
      signal: bus(0.75, this.master),
    };
    // The crowd fills the space (about -14 dB wet); announcer beats ring off the walls (about -16 dB).
    send(this.buses.crowd, 0.55);
    send(this.buses.signal, 0.45);
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
    out.gain.value = cue.gain * trimGain(cue.sound);
    const pan = ctx.createStereoPanner();
    pan.pan.value = cue.pan;
    out.connect(pan).connect(this.buses[BUS_OF[spec.group]]);
    const b = new VoiceBuilder(ctx, this.banks, out, t0, rate, rand);
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
    for (const b of this.babble?.loops ?? []) b.node.playbackRate.setTargetAtTime(b.speed * this.profile.pitch * rate, now, 0.08);
    for (const o of this.ambient.oscs) o.detune.setTargetAtTime(1200 * Math.log2(rate), now, 0.08);
    this.slowFilter.frequency.setTargetAtTime(slowmoCutoff(rate), now, 0.05);
  }

  setVolume(volume: number): void {
    this.master.gain.setTargetAtTime(volumeGain(volume), this.ctx.currentTime, 0.03);
  }

  /**
   * How worked up the crowd is (0..1, from the CrowdDirector): the bed's level, brightness and hot
   * layer follow it, swelling fast and settling slowly.
   */
  setCrowd(intensity: number): void {
    if (!this.bed || !this.bedFilter || !this.bedHot) return;
    const level = BED_HOT * bedLevel(intensity, this.profile);
    if (Math.abs(level - this.appliedBed) < 0.003 + 0.02 * level) return;
    const now = this.ctx.currentTime;
    const tau = level > this.appliedBed ? BED_RISE : BED_FALL;
    this.appliedBed = level;
    const i = Math.min(Math.max(intensity, 0), 1);
    this.bed.gain.setTargetAtTime(level, now, tau);
    this.bedFilter.frequency.setTargetAtTime(bedCutoff(i, this.profile), now, tau);
    this.bedHot.gain.setTargetAtTime(0.75 * i * i, now, tau);
  }

  /** The round's crowd: retune the murmur's vowels, breathing and pitch (the babble follows via setBabble). */
  setProfile(profile: CrowdProfile): void {
    this.profile = profile;
    if (!this.bed) return;
    const now = this.ctx.currentTime;
    const bands = [480, 1250];
    this.murmurBands.forEach((f, i) => f.frequency.setTargetAtTime(bands[i]! * profile.formant, now, 0.5));
    this.breaths.forEach((o, i) => o.frequency.setTargetAtTime(profile.breath[i]!, now, 0.5));
    for (const b of this.babble?.loops ?? []) b.node.playbackRate.setTargetAtTime(b.speed * profile.pitch * this.rate, now, 0.5);
    this.appliedBed = -1;
  }

  /**
   * Someone is scraping along the closing wall: `fighters` on it this batch (0 = none) and their
   * average pan. Contact arrives every tick, so one continuous grind loop follows it instead of a
   * retriggered sound; it fades out a beat after the last contact.
   */
  setGrind(fighters: number, pan: number): void {
    if (!this.grindPan || fighters <= 0) return;
    const now = this.ctx.currentTime;
    this.grindUntil = now + GRIND_HOLD;
    this.grindLevel = GRIND_GAIN * Math.min(1.6, 1 + 0.3 * (fighters - 1));
    this.grindPan.pan.setTargetAtTime(Math.min(Math.max(pan, -1), 1), now, 0.05);
  }

  /**
   * The end card is up (`on`): combat sounds stop, the crowd's last roar fades out and the beds sink
   * to a low ambience; announcer beats still play. Off brings everything back.
   */
  setHush(on: boolean): void {
    if (on === this.hushOn) return;
    this.hushOn = on;
    const now = this.ctx.currentTime;
    this.buses.sfx.gain.setTargetAtTime(on ? 0 : BUS_SFX, now, on ? 0.25 : 0.05);
    this.buses.crowd.gain.setTargetAtTime(on ? BUS_CROWD * HUSH_CROWD : BUS_CROWD, now, on ? 0.9 : 0.05);
    this.ambBus.gain.setTargetAtTime(on ? BUS_AMB * HUSH_AMB : BUS_AMB, now, on ? 1.2 : 0.3);
  }

  /** The grinding wall drone runs while the sudden-death wall is moving. */
  setWallMoving(on: boolean): void {
    if (on === this.wallOn || !this.wall) return;
    this.wallOn = on;
    this.wall.gain.setTargetAtTime(on ? 0.3 : 0, this.ctx.currentTime, on ? 0.5 : 0.9);
  }

  /** Per frame (real seconds): ducking, crowd excitement, cleanup of finished voices. */
  tick(dt: number): void {
    const now = this.ctx.currentTime;
    const sfx = this.duckSfx.update(dt);
    const amb = this.duckAmb.update(dt);
    if (Math.abs(this.sfxDuckGain.gain.value - sfx) > 0.002) this.sfxDuckGain.gain.setTargetAtTime(sfx, now, 0.012);
    if (Math.abs(this.ambDuckGain.gain.value - amb) > 0.002) this.ambDuckGain.gain.setTargetAtTime(amb, now, 0.03);

    if (this.grind) {
      const target = now < this.grindUntil ? this.grindLevel : 0;
      if (target !== this.appliedGrind) {
        this.grind.gain.setTargetAtTime(target, now, target > this.appliedGrind ? 0.03 : 0.12);
        this.appliedGrind = target;
      }
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
    this.grindUntil = -1;
  }

  /**
   * Start the beds: the crowd (formant-filtered pink noise until the babble is rendered, then the
   * babble on top), torch crackle and fire rumble, the (silent until sudden death) wall drone and
   * the (silent until someone touches the wall) grind loop.
   */
  startAmbience(profile: CrowdProfile = this.profile): void {
    if (this.bed) return;
    this.profile = profile;
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
    const lfo = (hz: number, depth: number, target: AudioParam, type: OscillatorType = 'sine'): OscillatorNode => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = hz;
      o.connect(gain(depth, target));
      o.start(now);
      return o;
    };

    // The crowd bed: nearly silent until setCrowd brings it up. Two vowel-ish bands of pink noise
    // breathe at the round's slow rates; the babble joins them once rendered.
    this.bed = gain(BED_HOT * bedLevel(0, profile), this.ambBus);
    this.bedFilter = filter('lowpass', bedCutoff(0, profile), 0.5, this.bed);
    this.bedHot = gain(0, this.bedFilter);
    const bandA = gain(0.5, this.bedFilter);
    const bandB = gain(0.22, this.bedFilter);
    const fA = filter('bandpass', 480 * profile.formant, 1.1, bandA);
    const fB = filter('bandpass', 1250 * profile.formant, 1.4, bandB);
    this.murmurBands = [fA, fB];
    loop(this.banks.pink, fA);
    loop(this.banks.pink, fB);
    this.breaths = [lfo(profile.breath[0], 0.18, bandA.gain), lfo(profile.breath[1], 0.1, bandB.gain)];

    // Torches: crackle and a low fire rumble, just under hearing so a lull is nearly silent.
    const crackle = gain(0.06, this.ambBus);
    loop(this.banks.crackle, filter('highpass', 900, 0.7, crackle), 0.9);
    lfo(0.23, 0.025, crackle.gain);
    loop(this.banks.brown, filter('lowpass', 140, 0.7, gain(0.05, this.ambBus)));

    // The closing wall: grinding stone, a low saw and the spikes scraping round the arena (narrow
    // metal resonances and sparks), pulsing as it scrapes forward.
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
    const scrape = gain(0.5, pulse);
    lfo(0.6, 0.3, scrape.gain);
    lfo(1.7, 0.15, scrape.gain);
    for (const [hz, q] of [[1250, 18], [2330, 18], [3710, 20]] as const) loop(this.banks.white, filter('bandpass', hz, q, gain(2.2, scrape)), 0.97);
    loop(this.banks.crackle, filter('highpass', 3000, 0.7, gain(0.25, pulse)), 1.3);

    // Fighters on the spikes: a stick-slip metal screech, a low grind and sparks (setGrind).
    this.grindPan = ctx.createStereoPanner();
    this.grindPan.connect(this.buses.sfx);
    this.grind = gain(0, this.grindPan);
    const stick = gain(0.7, this.grind);
    lfo(19, 0.3, stick.gain, 'triangle');
    loop(this.banks.white, filter('bandpass', 2600, 12, gain(3, stick)), 1);
    loop(this.banks.white, filter('bandpass', 4100, 14, gain(2.2, stick)), 1.03);
    loop(this.banks.brown, filter('bandpass', 220, 1, gain(1.4, stick)), 0.9);
    loop(this.banks.crackle, filter('highpass', 2500, 0.7, gain(0.5, this.grind)), 1.2);
  }

  /**
   * A rendered babble for the round fades into the bed (and becomes the body of every roar); the
   * previous round's babble fades out under it.
   */
  setBabble(buf: AudioBuffer): void {
    this.banks.babble = buf;
    if (!this.bedFilter || !this.bedHot) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const old = this.babble;
    if (old) {
      for (const f of old.fades) {
        f.gain.cancelScheduledValues(now);
        f.gain.setValueAtTime(f.gain.value, now);
        f.gain.linearRampToValueAtTime(0, now + BABBLE_FADE);
      }
      for (const l of old.loops) stopSafely(l.node, now + BABBLE_FADE + 0.05);
    }
    const loops: Loop[] = [];
    const fades: GainNode[] = [];
    const add = (speed: number, hpHz: number, level: number, dest: AudioNode, offset: number) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.playbackRate.value = speed * this.profile.pitch * this.rate;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = hpHz;
      const fade = ctx.createGain();
      fade.gain.setValueAtTime(0, now);
      fade.gain.linearRampToValueAtTime(level, now + BABBLE_FADE);
      s.connect(hp).connect(fade).connect(dest);
      s.start(now, offset);
      loops.push({ node: s, speed });
      fades.push(fade);
    };
    const start = Math.random() * buf.duration;
    add(1, 140, 0.9, this.bedFilter, start);
    // The hot layer: the same crowd a little higher and brighter, half a loop away, so it thickens.
    add(1.07, 380, 0.8, this.bedHot, (start + buf.duration / 2) % buf.duration);
    this.babble = { loops, fades };
  }
}

function stopSafely(node: AudioScheduledSourceNode, when: number): void {
  try {
    node.stop(when);
  } catch {
    // Already stopped or never started: nothing to cut.
  }
}
