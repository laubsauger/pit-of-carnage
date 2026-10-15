// Owned by: audio
/**
 * Signal measurements for checking the mix without ears: the dev page (src/audio/dev) renders
 * sounds and scenes offline and reads levels, dynamics and spectra from these. Pure and
 * dependency-free, so the measurements themselves are tested.
 */

export type Band = 'sub' | 'low' | 'lowMid' | 'mid' | 'high' | 'air';

/** Upper edge (Hz) of each band; `air` runs to Nyquist. */
export const BAND_EDGES: Readonly<Record<Band, number>> = { sub: 80, low: 300, lowMid: 1000, mid: 3000, high: 8000, air: Infinity };
const BANDS = Object.keys(BAND_EDGES) as Band[];

/** Floor for dB values of silence. */
export const SILENT_DB = -120;

export function toDb(x: number): number {
  return x > 0 ? Math.max(SILENT_DB, 20 * Math.log10(x)) : SILENT_DB;
}

export type SignalStats = {
  /** Highest |sample| over all channels, dBFS. */
  peakDb: number;
  /** RMS of the loudest `window` (300 ms): how loud the sound plays, dBFS. */
  loudDb: number;
  /** Peak over loud RMS (dB): punch. Under ~6 dB is squashed, over ~20 is spiky. */
  crestDb: number;
  /** Mean sample value (DC offset). */
  dc: number;
  /** Milliseconds from the first sample above peak -40 dB to the peak. */
  attackMs: number;
  /** Milliseconds until the signal stays under peak -60 dB. */
  lengthMs: number;
  /** Spectral centroid (Hz) of the audible part: how bright it sounds. */
  centroidHz: number;
  /** Share of spectral energy per band (sums to 1 for a non-silent signal). */
  bands: Record<Band, number>;
  /** The first or last sample is far from zero: a click at the start or a cut at the end. */
  edgeJump: boolean;
};

/** In-place iterative radix-2 FFT. `re` and `im` have the same power-of-two length. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) throw new Error(`fft: length ${n} is not a power of two`);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Average power spectrum (Welch: Hann-windowed frames, half overlap) of `data[from..to)`.
 * Returns power per bin 0..size/2; bin k is k x sampleRate / size Hz.
 */
export function powerSpectrum(data: Float32Array, from = 0, to = data.length, size = 2048): Float64Array {
  const out = new Float64Array(size / 2 + 1);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const hop = size / 2;
  let frames = 0;
  for (let start = from; start + size <= Math.max(to, from + size) && start < to; start += hop) {
    for (let i = 0; i < size; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
      re[i] = (data[start + i] ?? 0) * w;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= size / 2; k++) out[k]! += re[k]! * re[k]! + im[k]! * im[k]!;
    frames++;
  }
  if (frames > 0) for (let k = 0; k < out.length; k++) out[k]! /= frames;
  return out;
}

/** RMS (dBFS) of consecutive windows of `windowSec`: loudness over time. */
export function windowedRmsDb(data: Float32Array, sampleRate: number, windowSec: number): number[] {
  const w = Math.max(1, Math.round(sampleRate * windowSec));
  const out: number[] = [];
  for (let start = 0; start < data.length; start += w) {
    let sum = 0;
    const end = Math.min(data.length, start + w);
    for (let i = start; i < end; i++) sum += data[i]! * data[i]!;
    out.push(toDb(Math.sqrt(sum / Math.max(1, end - start))));
  }
  return out;
}

/** Highest |sample| (linear). */
export function peakOf(...channels: Float32Array[]): number {
  let p = 0;
  for (const d of channels) for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i]!));
  return p;
}

/** Measure a rendered sound. `channels` are the output channels (stereo or mono). */
export function analyze(channels: readonly Float32Array[], sampleRate: number, window = 0.3): SignalStats {
  const n = channels[0]?.length ?? 0;
  const mono = new Float32Array(n);
  for (const d of channels) for (let i = 0; i < n; i++) mono[i]! += d[i]! / channels.length;
  const peak = peakOf(...channels);
  let peakAt = 0;
  for (let i = 0; i < n; i++) {
    let a = 0;
    for (const d of channels) a = Math.max(a, Math.abs(d[i]!));
    if (a >= peak) {
      peakAt = i;
      break;
    }
  }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += mono[i]!;
  const dc = n > 0 ? sum / n : 0;

  // Loudest window by RMS of the louder channel.
  const w = Math.max(1, Math.min(n, Math.round(sampleRate * window)));
  let loud = 0;
  for (const d of channels) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += d[i]! * d[i]!;
      if (i >= w) acc -= d[i - w]! * d[i - w]!;
      if (i >= w - 1) loud = Math.max(loud, acc / w);
    }
    if (n < w) loud = Math.max(loud, acc / Math.max(1, n));
  }
  const loudDb = toDb(Math.sqrt(Math.max(loud, 0)));

  const above = (x: number, db: number) => toDb(x) > toDb(peak) + db;
  let first = 0;
  while (first < n && !above(maxAbs(channels, first), -40)) first++;
  let last = n - 1;
  while (last > 0 && !above(maxAbs(channels, last), -60)) last--;

  // Spectrum of the audible part only (so a short hit is not averaged with silence).
  let s0 = 0;
  while (s0 < n && !above(Math.abs(mono[s0]!), -30)) s0++;
  let s1 = n - 1;
  while (s1 > s0 && !above(Math.abs(mono[s1]!), -30)) s1--;
  const size = 2048;
  const spec = powerSpectrum(mono, Math.max(0, Math.min(s0, n - size)), Math.max(s1 + 1, Math.min(n, s0 + size)), size);
  const bands = Object.fromEntries(BANDS.map((b) => [b, 0])) as Record<Band, number>;
  let total = 0;
  let weighted = 0;
  for (let k = 1; k < spec.length; k++) {
    const hz = (k * sampleRate) / size;
    const p = spec[k]!;
    total += p;
    weighted += p * hz;
    bands[BANDS.find((b) => hz < BAND_EDGES[b]) ?? 'air'] += p;
  }
  if (total > 0) for (const b of BANDS) bands[b] /= total;

  const edge = 0.02 * Math.max(peak, 1e-9);
  return {
    peakDb: toDb(peak),
    loudDb,
    crestDb: toDb(peak) - loudDb,
    dc,
    attackMs: (Math.max(0, peakAt - first) / sampleRate) * 1000,
    lengthMs: (Math.max(0, last + 1) / sampleRate) * 1000,
    centroidHz: total > 0 ? weighted / total : 0,
    bands,
    edgeJump: n > 0 && channels.some((d) => Math.abs(d[0]!) > edge || Math.abs(d[n - 1]!) > edge),
  };
}

function maxAbs(channels: readonly Float32Array[], i: number): number {
  let a = 0;
  for (const d of channels) a = Math.max(a, Math.abs(d[i]!));
  return a;
}
