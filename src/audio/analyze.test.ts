import { describe, expect, it } from 'vitest';
import { SILENT_DB, analyze, fft, powerSpectrum, toDb, windowedRmsDb } from './analyze';

const SR = 48000;

function sine(hz: number, seconds: number, amp: number): Float32Array {
  return Float32Array.from({ length: Math.round(SR * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));
}

/** A tiny seeded noise so the test is the same every run. */
function noise(seconds: number, amp: number): Float32Array {
  let s = 12345;
  return Float32Array.from({ length: Math.round(SR * seconds) }, () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return amp * ((s / 2 ** 32) * 2 - 1);
  });
}

// Nobody can listen in automation: these numbers are how the mix gets checked, so they must be right.
describe('analyze', () => {
  it('measures a sine: level, crest and where its energy sits', () => {
    const st = analyze([sine(1500, 1, 0.5)], SR);
    expect(st.peakDb).toBeCloseTo(-6.02, 1);
    expect(st.loudDb).toBeCloseTo(-9.03, 1);
    expect(st.crestDb).toBeCloseTo(3.01, 1);
    expect(st.centroidHz).toBeGreaterThan(1450);
    expect(st.centroidHz).toBeLessThan(1550);
    expect(st.bands.mid).toBeGreaterThan(0.95);
    expect(Math.abs(st.dc)).toBeLessThan(1e-3);
  });

  it('tells a dark sound from a bright one', () => {
    const dark = analyze([sine(120, 0.5, 0.5)], SR);
    const bright = analyze([noise(0.5, 0.5)], SR);
    expect(dark.bands.low).toBeGreaterThan(0.9);
    expect(bright.centroidHz).toBeGreaterThan(8000);
    expect(bright.bands.air + bright.bands.high).toBeGreaterThan(0.6);
  });

  it('times a decaying hit: fast attack, length to -60 dB', () => {
    const tau = 0.05;
    const d = Float32Array.from({ length: SR }, (_, i) => Math.exp(-i / SR / tau) * Math.sin((2 * Math.PI * 300 * i) / SR));
    const st = analyze([d], SR);
    expect(st.attackMs).toBeLessThan(2);
    // -60 dB = e^-6.9 -> 6.9 tau = 345 ms.
    expect(st.lengthMs).toBeGreaterThan(300);
    expect(st.lengthMs).toBeLessThan(380);
    expect(st.edgeJump).toBe(false);
  });

  it('flags a sound cut off mid-swing and survives silence', () => {
    expect(analyze([sine(440, 0.1013, 0.5)], SR).edgeJump).toBe(true);
    const silent = analyze([new Float32Array(1000)], SR);
    expect(silent.peakDb).toBe(SILENT_DB);
    expect(silent.centroidHz).toBe(0);
  });

  it('reads the louder channel of a stereo pair', () => {
    const st = analyze([sine(500, 0.5, 0.1), sine(500, 0.5, 0.8)], SR);
    expect(st.peakDb).toBeCloseTo(toDb(0.8), 1);
  });
});

describe('fft and spectra', () => {
  it('puts a bin-centred sine into its bin (Parseval holds)', () => {
    const n = 256;
    const re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 8 * i) / n));
    const im = new Float64Array(n);
    let timeEnergy = 0;
    for (const x of re) timeEnergy += x * x;
    fft(re, im);
    let freqEnergy = 0;
    for (let k = 0; k < n; k++) freqEnergy += re[k]! * re[k]! + im[k]! * im[k]!;
    expect(freqEnergy / n).toBeCloseTo(timeEnergy, 6);
    expect(Math.hypot(re[8]!, im[8]!)).toBeCloseTo(n / 2, 6);
    expect(Math.hypot(re[9]!, im[9]!)).toBeLessThan(1e-6);
    expect(() => fft(new Float64Array(6), new Float64Array(6))).toThrow(/power of two/);
  });

  it('averages a spectrum even for a signal shorter than one frame', () => {
    const spec = powerSpectrum(sine(3000, 0.01, 0.5));
    let best = 0;
    for (let k = 1; k < spec.length; k++) if (spec[k]! > spec[best]!) best = k;
    expect((best * SR) / 2048).toBeCloseTo(3000, -2);
  });

  it('tracks loudness over time', () => {
    const d = new Float32Array(SR);
    d.set(sine(500, 0.5, 0.5), SR / 2);
    const w = windowedRmsDb(d, SR, 0.1);
    expect(w.length).toBe(10);
    expect(w[0]).toBe(SILENT_DB);
    expect(w[9]).toBeCloseTo(-9.03, 0);
  });
});
