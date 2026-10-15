import { describe, expect, it } from 'vitest';
import { DAMAGE_NUMBERS, damageText, mergesInto, numberEnvelope, numberOffsetY } from './numberLayout';

describe('damage number text', () => {
  it('shows whole damage and never 0 for a hit', () => {
    expect(damageText(23.6)).toBe('24');
    expect(damageText(0.2)).toBe('1');
    expect(damageText(140)).toBe('140');
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
