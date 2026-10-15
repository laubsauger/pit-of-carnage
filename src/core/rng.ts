/**
 * Deterministic random numbers for the simulation, brains, strategies and gym.
 *
 * Algorithm: sfc32 (Chris Doty-Humphrey's Small Fast Chaotic PRNG, 128-bit state, period >= 2^32
 * guaranteed by its counter word, ~2^127 typical), seeded through splitmix32. It uses only 32-bit
 * integer ops (`| 0`, `>>>`, `Math.imul`), so every JS engine produces identical streams.
 *
 * Rules:
 * - `src/sim`, `src/brain` and `src/strategy` must take all randomness from an `Rng`. Never
 *   `Math.random`, `Date` or `performance.now` there.
 * - Give each independent consumer its own stream with `fork(label)` at setup time (e.g. one per
 *   fighter brain, one for combat rolls). A consumer drawing more or fewer numbers then cannot
 *   shift another consumer's results, which keeps replays stable while code evolves.
 */

const UINT32 = 4294967296;

/** FNV-1a 32-bit hash of a string. Stable across engines; use it to turn labels or ids into seeds. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Murmur3 finalizer: a strong 32-bit bit mixer. */
function mix32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

export class Rng {
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;

  /** `seed` is reduced to an unsigned 32-bit integer (`seed >>> 0`); equal seeds give equal streams. */
  constructor(seed: number) {
    // splitmix32 expands one 32-bit seed into four well-mixed state words.
    let s = seed >>> 0;
    const words: number[] = [];
    for (let i = 0; i < 4; i++) {
      s = (s + 0x9e3779b9) | 0;
      words.push(mix32(s));
    }
    this.load(words);
    this.warmUp();
  }

  /** Recreate a generator from a saved `state` (e.g. a replay snapshot). Continues the exact stream. */
  static fromState(state: readonly number[]): Rng {
    if (state.length !== 4) throw new Error(`Rng.fromState: expected 4 words, got ${state.length}`);
    const r = new Rng(0);
    r.load(state);
    return r;
  }

  /** Raw unsigned 32-bit output. */
  nextU32(): number {
    // Reference sfc32: tmp = a + b + counter++; a = b ^ (b >> 9); b = c + (c << 3); c = rotl(c, 21) + tmp.
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (((this.c << 21) | (this.c >>> 11)) + t) | 0;
    return t >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextU32() / UINT32;
  }

  /** Uniform float in [a, b). */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** Uniform integer in [a, b], both ends inclusive. Expects integers with a <= b. */
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }

  /** true with probability p (p <= 0 never, p >= 1 always). */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniformly chosen element. Throws on an empty array (a silent `undefined` would hide bugs). */
  pick<T>(xs: readonly T[]): T {
    if (xs.length === 0) throw new Error('Rng.pick: empty array');
    return xs[Math.floor(this.next() * xs.length)] as T;
  }

  /** Fisher-Yates shuffle in place; returns the same array. */
  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = xs[i] as T;
      xs[i] = xs[j] as T;
      xs[j] = tmp;
    }
    return xs;
  }

  /** Normal (Gaussian) sample via Box-Muller. Uses two draws and caches nothing, so `state` stays complete. */
  normal(mean = 0, sd = 1): number {
    const u1 = 1 - this.next(); // (0, 1], keeps log finite
    const u2 = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /**
   * Independent child stream derived from this generator's current state and `label`.
   * Does not advance this generator, so adding a fork never changes the parent's sequence.
   * Same state + same label = same child; different labels = unrelated streams.
   */
  fork(label: string): Rng {
    const h = hashString(label);
    const words = [
      mix32(this.a ^ h),
      mix32(this.b ^ Math.imul(h, 0x9e3779b1)),
      mix32(this.c ^ ((h << 13) | (h >>> 19))),
      mix32(this.d ^ ~h),
    ];
    const child = Rng.fromState(words);
    child.warmUp();
    return child;
  }

  /** Copy of the four 32-bit state words. Restore with `Rng.fromState`. */
  get state(): number[] {
    return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0];
  }

  private load(words: readonly number[]): void {
    this.a = (words[0] ?? 0) | 0;
    this.b = (words[1] ?? 0) | 0;
    this.c = (words[2] ?? 0) | 0;
    this.d = (words[3] ?? 0) | 0;
  }

  /** Discard early outputs so nearby seeds diverge fully. */
  private warmUp(): void {
    for (let i = 0; i < 12; i++) this.nextU32();
  }
}
