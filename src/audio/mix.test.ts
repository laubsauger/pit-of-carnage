import { describe, expect, it } from 'vitest';
import {
  CLIP_KNEE,
  Ducker,
  GROUP_CAPS,
  MAX_RATE,
  MAX_VOICES,
  MIN_RATE,
  PAUSE_AFTER_SECONDS,
  PauseDetector,
  Throttle,
  VoiceLimiter,
  crossfadeLoop,
  pitchForTimeScale,
  slowmoCutoff,
  softClip,
  volumeGain,
} from './mix';
import type { VoiceGroup } from './mix';
import { DISMEMBER_MOMENT, FINAL_MOMENT, KILL_MOMENT, PARRY_MOMENT } from '../app/time';

describe('VoiceLimiter', () => {
  // The quality bar: 16 fighters brawling must never pile up into a wall of clipping noise.
  it('never exceeds the voice budget or a group cap, however many sounds a brawl asks for', () => {
    const lim = new VoiceLimiter();
    const groups: VoiceGroup[] = ['step', 'swing', 'impact', 'big', 'crowd', 'signal', 'misc'];
    for (let i = 0; i < 400; i++) {
      const g = groups[i % groups.length]!;
      lim.request(g, 10 + (i % 90), 0, 5);
      expect(lim.active).toBeLessThanOrEqual(MAX_VOICES);
      for (const k of groups) expect(lim.countIn(k)).toBeLessThanOrEqual(GROUP_CAPS[k]);
    }
  });

  // A kill must always be heard, even in the middle of a stampede of footsteps and hits.
  it('lets a kill steal the weakest voice when the mix is full', () => {
    const lim = new VoiceLimiter(4, { ...GROUP_CAPS, impact: 4 });
    const step = lim.request('step', 5, 0, 10)!;
    for (let i = 0; i < 3; i++) lim.request('impact', 60, 0.01 * (i + 1), 10);
    const kill = lim.request('big', 95, 0.1, 10);
    expect(kill).not.toBeNull();
    expect(kill!.stolen).toBe(step.id);
    expect(lim.active).toBe(4);
  });

  it('refuses a sound when everything playing matters more', () => {
    const lim = new VoiceLimiter(2, GROUP_CAPS);
    lim.request('big', 95, 0, 10);
    lim.request('signal', 100, 0, 10);
    expect(lim.request('step', 5, 0.1, 10)).toBeNull();
    expect(lim.request('impact', 60, 0.1, 10)).toBeNull();
  });

  // Within a full group of equal sounds the newest blow is the one on screen; the oldest is decaying.
  it('steals the oldest voice among equals', () => {
    const lim = new VoiceLimiter(MAX_VOICES, { ...GROUP_CAPS, impact: 2 });
    const first = lim.request('impact', 60, 0, 10)!;
    lim.request('impact', 60, 0.1, 10);
    const third = lim.request('impact', 60, 0.2, 10);
    expect(third!.stolen).toBe(first.id);
    expect(lim.countIn('impact')).toBe(2);
  });

  it('frees a voice once its sound has ended', () => {
    const lim = new VoiceLimiter(1, GROUP_CAPS);
    lim.request('impact', 60, 0, 0.5);
    expect(lim.request('step', 5, 0.2, 1)).toBeNull();
    const later = lim.request('step', 5, 0.6, 1);
    expect(later).not.toBeNull();
    expect(later!.stolen).toBe(0);
  });

  it('uses the corrected end time of a built voice', () => {
    const lim = new VoiceLimiter(1, GROUP_CAPS);
    const g = lim.request('impact', 60, 0, 0.1)!;
    lim.setEnd(g.id, 2);
    expect(lim.request('step', 5, 1, 1.5)).toBeNull();
  });
});

describe('Ducker', () => {
  function run(d: Ducker, seconds: number): number {
    for (let i = 0; i < Math.round(seconds * 60); i++) d.update(1 / 60);
    return d.level;
  }

  // Ten kills in one frame must not silence the arena: ducks never compound.
  it('ducks to the deepest request, never deeper', () => {
    const d = new Ducker();
    d.duck(0.5, 1);
    d.duck(0.5, 1);
    d.duck(0.3, 1);
    const level = run(d, 0.3);
    expect(level).toBeGreaterThanOrEqual(0.5 - 1e-9);
    expect(level).toBeLessThan(0.52);
  });

  it('recovers fully after the hold and release', () => {
    const d = new Ducker(0.02, 0.35);
    d.duck(0.6, 0.3);
    run(d, 0.2);
    expect(d.level).toBeLessThan(0.45);
    expect(run(d, 3)).toBeGreaterThan(0.99);
  });

  it('keeps a long shallow duck after a short deep one ends', () => {
    const d = new Ducker(0.02, 0.1);
    d.duck(0.8, 0.2);
    d.duck(0.3, 2);
    run(d, 1);
    expect(d.level).toBeCloseTo(0.7, 2);
  });
});

describe('Throttle', () => {
  // A cleave hitting five fighters on one tick should sound like one big hit, not a phasey stack.
  it('drops repeats of a sound inside its minimum gap and lets others through', () => {
    const t = new Throttle();
    expect(t.allow('hit_blade', 1, 0.03)).toBe(true);
    expect(t.allow('hit_blade', 1.01, 0.03)).toBe(false);
    expect(t.allow('hit_hammer', 1.01, 0.03)).toBe(true);
    expect(t.allow('hit_blade', 1.05, 0.03)).toBe(true);
    expect(t.allow('kill_sting', 1.05, 0)).toBe(true);
    expect(t.allow('kill_sting', 1.05, 0)).toBe(true);
  });
});

describe('pitchForTimeScale', () => {
  it('leaves normal speed untouched', () => {
    expect(pitchForTimeScale(1)).toBe(1);
  });

  // Slow motion around a kill must sound slowed: deeper and longer, like tape.
  it('lowers pitch in slow motion, deeper the slower it runs', () => {
    expect(pitchForTimeScale(0.3)).toBeCloseTo(Math.sqrt(0.3), 6);
    expect(pitchForTimeScale(0.2)).toBeLessThan(pitchForTimeScale(0.3));
    expect(pitchForTimeScale(0.5)).toBeLessThan(1);
    expect(pitchForTimeScale(0.01)).toBe(MIN_RATE);
  });

  it('never decreases as time runs faster and caps fast forward', () => {
    let last = 0;
    for (let s = 0.05; s <= 8; s += 0.05) {
      const p = pitchForTimeScale(s);
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
    expect(pitchForTimeScale(4)).toBeLessThanOrEqual(MAX_RATE);
    expect(pitchForTimeScale(4)).toBeGreaterThan(1);
  });

  // Pause and hit-stop report 0: the module keeps its last pitch instead of dropping to nothing.
  it('returns 1 for a stopped or broken scale', () => {
    expect(pitchForTimeScale(0)).toBe(1);
    expect(pitchForTimeScale(-1)).toBe(1);
    expect(pitchForTimeScale(Number.NaN)).toBe(1);
    expect(pitchForTimeScale(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('slowmoCutoff', () => {
  it('is open at normal speed and closes as slow motion deepens', () => {
    expect(slowmoCutoff(1)).toBe(20000);
    expect(slowmoCutoff(1.1)).toBe(20000);
    expect(slowmoCutoff(0.7)).toBeLessThan(slowmoCutoff(0.9));
    expect(slowmoCutoff(MIN_RATE)).toBeCloseTo(2400, 0);
  });
});

describe('volumeGain', () => {
  it('maps the 0..1 setting to a gain that starts silent and ends at unity', () => {
    expect(volumeGain(0)).toBe(0);
    expect(volumeGain(1)).toBe(1);
    expect(volumeGain(0.5)).toBeCloseTo(0.25, 6);
    expect(volumeGain(2)).toBe(1);
    expect(volumeGain(-1)).toBe(0);
    expect(volumeGain(Number.NaN)).toBe(0);
  });
});

describe('softClip', () => {
  it('passes quiet signals untouched', () => {
    for (const x of [-CLIP_KNEE, -0.3, 0, 0.25, CLIP_KNEE]) expect(softClip(x)).toBe(x);
  });

  // The last line of defence: whatever the mix does, the output never reaches full scale.
  it('never reaches full scale and stays monotonic and symmetric', () => {
    let last = -Infinity;
    for (let x = -4; x <= 4; x += 0.01) {
      const y = softClip(x);
      expect(Math.abs(y)).toBeLessThan(1);
      expect(y).toBeGreaterThanOrEqual(last);
      expect(softClip(-x)).toBeCloseTo(-y, 12);
      last = y;
    }
  });
});

describe('crossfadeLoop', () => {
  // A click at the loop point of the ambience would tick every few seconds, forever.
  it('makes the sample after the loop end the first sample, so the seam is continuous', () => {
    const data = new Float32Array(1000).map((_, i) => Math.sin(i * 0.37) + i * 0.001);
    const out = crossfadeLoop(data, 100);
    expect(out.length).toBe(900);
    expect(out[0]).toBeCloseTo(data[900]!, 6);
    expect(out[899]).toBe(data[899]);
    expect(out[500]).toBe(data[500]);
  });
});

describe('PauseDetector', () => {
  function run(d: PauseDetector, seconds: number, scale: number): boolean {
    for (let i = 0; i < Math.round(seconds * 60); i++) d.update(1 / 60, scale);
    return d.paused;
  }

  // The director freezes time for a beat on every kill; the kill's own sound must ring through it.
  it('never mistakes the director\'s hit-stops for a pause', () => {
    for (const m of [KILL_MOMENT, FINAL_MOMENT, DISMEMBER_MOMENT, PARRY_MOMENT]) {
      expect(m.stop).toBeLessThan(PAUSE_AFTER_SECONDS);
      const d = new PauseDetector();
      run(d, 1, 1);
      expect(run(d, m.stop, 0)).toBe(false);
    }
  });

  // The countdown holds the sim at tick 0; its beats must sound even if the time factor reads 0.
  it('stays unpaused through a hold, then pauses once time keeps standing still', () => {
    const d = new PauseDetector();
    expect(run(d, 1, 0)).toBe(true);
    d.hold(1.5);
    expect(d.paused).toBe(false);
    expect(run(d, 1.4, 0)).toBe(false);
    expect(run(d, 0.2, 0)).toBe(true);
  });

  it('pauses when time stays stopped and resumes on the first running frame', () => {
    const d = new PauseDetector();
    expect(run(d, 0.5, 0)).toBe(true);
    expect(d.update(1 / 60, 0.3)).toBe(false);
    expect(run(d, 0.1, 0)).toBe(false);
  });
});
