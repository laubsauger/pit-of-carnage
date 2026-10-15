import { describe, expect, it } from 'vitest';
import type { Box } from './barks';
import { overlaps } from './barks';
import { DAMAGE_NUMBERS, NUMBER_SPOT, damageText, dropClear, mergesInto, numberEnvelope, numberOffsetY, placeNumber } from './numberLayout';

describe('damage number text', () => {
  it('shows whole damage and never 0 for a hit', () => {
    expect(damageText(23.6)).toBe('24');
    expect(damageText(0.2)).toBe('1');
    expect(damageText(140)).toBe('140');
  });

  it('reads heals as "+N"', () => {
    expect(damageText(30.4, true)).toBe('+30');
    expect(damageText(0.3, true)).toBe('+1');
  });
});

describe('damage number envelope', () => {
  const env = { scale: 0, alpha: 0, rise: 0 };

  // Short-lived: gone within a second, so a brawl never fills up with stale numbers.
  it('pops in, then fades out by the end of its short life', () => {
    expect(DAMAGE_NUMBERS.life).toBeLessThanOrEqual(1.2);
    expect(numberEnvelope(env, 0.3, false).alpha).toBe(1);
    expect(numberEnvelope(env, DAMAGE_NUMBERS.life, false).alpha).toBeCloseTo(0, 9);
  });

  it('pops crits in harder than ordinary hits, and both settle at full size', () => {
    const crit = numberEnvelope(env, 0, true).scale;
    const plain = numberEnvelope(env, 0, false).scale;
    expect(crit).toBeGreaterThan(plain);
    expect(numberEnvelope(env, 0.3, true).scale).toBe(1);
    expect(DAMAGE_NUMBERS.critSize).toBeGreaterThan(DAMAGE_NUMBERS.size);
  });
});

describe('damage number layout', () => {
  // The HP bar and name tag sit above the body; numbers stay beside it and must never cover them.
  it('never rises above the top of the body, at any slot, age, size or zoom', () => {
    for (const radiusPx of [8, 14, 20, 40]) {
      for (const h of [DAMAGE_NUMBERS.size, DAMAGE_NUMBERS.critSize * 1.35]) {
        for (let slot = 0; slot < DAMAGE_NUMBERS.perVictim; slot += 0.25) {
          for (let rise = 0; rise <= 1; rise += 0.1) {
            const y = numberOffsetY(slot, rise, h, radiusPx);
            expect(y - h / 2).toBeGreaterThanOrEqual(-radiusPx - 1e-9);
          }
        }
      }
    }
  });

  // A flurry of hits stacks downward; neighbours never overlap, even a crit next to a plain hit.
  it('stacks numbers without overlap, newest on top', () => {
    const sizes = [DAMAGE_NUMBERS.size, DAMAGE_NUMBERS.critSize];
    for (const radiusPx of [10, 20, 30]) {
      for (const h0 of sizes) {
        for (const h1 of sizes) {
          for (const rise0 of [0, 0.5, 1]) {
            const y0 = numberOffsetY(0, rise0, h0, radiusPx);
            const y1 = numberOffsetY(1, 1, h1, radiusPx);
            expect(y1).toBeGreaterThan(y0);
            expect(y1 - h1 / 2).toBeGreaterThanOrEqual(y0 + h0 / 2 - 1e-9);
          }
        }
      }
    }
  });
});

describe('damage number merging', () => {
  // Multi-hits (whirlwind, saw ticks, dagger flurries) would otherwise stack a column of tiny
  // numbers; quick follow-ups from the same source add into one number instead.
  it('adds a quick follow-up from the same attacker into the newest number', () => {
    expect(mergesInto({ attackerId: 'a', t: 0.1 }, 'a')).toBe(true);
  });

  it('keeps hits apart when the attacker differs or the number is no longer fresh', () => {
    expect(mergesInto({ attackerId: 'a', t: 0.1 }, 'b')).toBe(false);
    expect(mergesInto({ attackerId: 'a', t: DAMAGE_NUMBERS.mergeSeconds + 0.01 }, 'a')).toBe(false);
    expect(mergesInto(null, 'a')).toBe(false);
  });
});

describe('numbers of victims standing close together', () => {
  /** Seeded random (cosmetic layout test; deterministic so a failure reproduces). */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // A brawl of up to 16 bodies: two victims side by side used to print their numbers on top of each
  // other. Placing each number (newest first) against those already placed must leave no overlap,
  // and a number may only move sideways to its victim's other flank or down, never up into a tag.
  it('never overlap, and never climb above their own spot', () => {
    const rand = rng(7);
    const pad = 2;
    for (let trial = 0; trial < 300; trial++) {
      const placed: Box[] = [];
      const count = 2 + Math.floor(rand() * 10);
      for (let i = 0; i < count; i++) {
        // Victims crowded into a 120 px square, radius ~18, numbers ~14-40 px wide.
        const vx = rand() * 120;
        const vy = rand() * 120;
        const hw = 7 + rand() * 13;
        const hh = 8 + rand() * 3;
        const box: Box = { cx: vx + 18 + 5 + hw, cy: vy - 6, hw, hh };
        const top = box.cy - box.hh;
        const spot = placeNumber(box, vx - 18 - 5 - hw, placed, placed.length, pad);
        expect(box.cy - box.hh).toBeGreaterThanOrEqual(top - 1e-9);
        if (spot !== NUMBER_SPOT.below) expect(box.cy).toBe(vy - 6);
        for (const o of placed) expect(overlaps(box, o, pad - 1e-6), `trial ${trial}`).toBe(false);
        placed.push(box);
      }
    }
  });

  it('keeps a number on its right flank when nothing is in the way', () => {
    const box: Box = { cx: 50, cy: 0, hw: 10, hh: 8 };
    const far: Box = { cx: 300, cy: 0, hw: 10, hh: 8 };
    expect(placeNumber(box, -50, [far], 1, 2)).toBe(NUMBER_SPOT.right);
    expect(box).toEqual({ cx: 50, cy: 0, hw: 10, hh: 8 });
  });

  it('takes the left flank before stepping down', () => {
    const box: Box = { cx: 50, cy: 0, hw: 10, hh: 8 };
    const neighbour: Box = { cx: 55, cy: 2, hw: 10, hh: 8 };
    expect(placeNumber(box, -50, [neighbour], 1, 2)).toBe(NUMBER_SPOT.left);
    expect(box.cx).toBe(-50);
  });

  it('steps down below a pile of obstacles in a bounded number of moves', () => {
    const pile: Box[] = Array.from({ length: 12 }, (_, i) => ({ cx: 0, cy: i * 15, hw: 30, hh: 8 }));
    const box: Box = { cx: 0, cy: 0, hw: 10, hh: 8 };
    const moves = dropClear(box, pile, pile.length, 2);
    expect(moves).toBeLessThanOrEqual(pile.length);
    for (const o of pile) expect(overlaps(box, o, 2 - 1e-6)).toBe(false);
  });
});
