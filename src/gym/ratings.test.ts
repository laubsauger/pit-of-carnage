import { describe, expect, it } from 'vitest';
import { Rng, displayRating } from '../core';
import { DEFAULT_RATING, RatingBook } from './ratings';
import { placedReport } from './testkit';

const KEYS = ['A@v1', 'B@v1', 'C@v1', 'D@v1'];

describe('RatingBook', () => {
  // The leaderboard is only worth reading if finishing order moves numbers in the right direction.
  it("raises the winner's rating and lowers the last-placed fighter's after one FFA match", () => {
    const book = new RatingBook();
    book.rate(placedReport(KEYS, [0, 1, 2, 3]));
    expect(book.get('A@v1').mu).toBeGreaterThan(DEFAULT_RATING.mu);
    expect(book.get('D@v1').mu).toBeLessThan(DEFAULT_RATING.mu);
    expect(displayRating(book.get('A@v1'))).toBeGreaterThan(displayRating(book.get('D@v1')));
    // Placement order is preserved in between, not just at the ends.
    expect(book.get('B@v1').mu).toBeGreaterThan(book.get('C@v1').mu);
  });

  // The prototypes' ratings stalled at one value; every rated match must move every participant.
  it('moves every participant after every match', () => {
    const book = new RatingBook();
    const rng = new Rng(3);
    for (let m = 0; m < 40; m++) {
      const before = KEYS.map((k) => book.get(k));
      book.rate(placedReport(KEYS, rng.shuffle([0, 1, 2, 3])));
      KEYS.forEach((k, i) => {
        const after = book.get(k);
        expect(after.mu !== before[i]!.mu || after.sigma !== before[i]!.sigma).toBe(true);
      });
    }
  });

  // Ratings exist to tell good strategies from bad ones despite noisy single matches.
  it('separates a strong strategy from a weak one over many noisy matches, and settles', () => {
    const strength: Record<string, number> = { 'Strong@v1': 2, 'Mid@v1': 1, 'Weak@v1': 0, 'Other@v1': 1 };
    const keys = Object.keys(strength);
    const book = new RatingBook();
    const rng = new Rng(11);
    const muSwing = (from: number, to: number, history: number[]) => Math.abs(history[to]! - history[from]!);
    const strongMu: number[] = [];
    for (let m = 0; m < 300; m++) {
      const order = keys
        .map((k, i) => ({ i, s: strength[k]! + rng.normal(0, 1.2) }))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.i);
      book.rate(placedReport(keys, order));
      strongMu.push(book.get('Strong@v1').mu);
    }
    const strong = book.get('Strong@v1');
    const mid = book.get('Mid@v1');
    const weak = book.get('Weak@v1');
    expect(strong.ordinal).toBeGreaterThan(mid.ordinal);
    expect(mid.ordinal).toBeGreaterThan(weak.ordinal);
    // Converges: uncertainty shrank well below the prior and late matches move the mean less than early ones.
    expect(strong.sigma).toBeLessThan(DEFAULT_RATING.sigma / 3);
    expect(muSwing(250, 299, strongMu)).toBeLessThan(muSwing(0, 49, strongMu) + 1e-9);
  });

  // In squads the team result is what counts: every member of the winning squad gains.
  it('rates squads as teams ranked by their best-placed member', () => {
    const book = new RatingBook();
    // Squad 0 = A, B; squad 1 = C, D. C survives longest, so squad 1 wins.
    book.rate(placedReport(KEYS, [2, 0, 3, 1], 'squads', [0, 0, 1, 1]));
    expect(book.get('C@v1').mu).toBeGreaterThan(DEFAULT_RATING.mu);
    expect(book.get('D@v1').mu).toBeGreaterThan(DEFAULT_RATING.mu);
    expect(book.get('A@v1').mu).toBeLessThan(DEFAULT_RATING.mu);
    expect(book.record('D@v1')!.wins).toBe(1);
  });

  // A mirror match is one match for the strategy, but both seats are evidence.
  it('counts a mirror match once and keeps evidence from both seats', () => {
    const book = new RatingBook();
    book.rate(placedReport(['A@v1', 'A@v1', 'B@v1', 'C@v1'], [0, 1, 2, 3]));
    const a = book.record('A@v1')!;
    expect(a.matches).toBe(1);
    expect(a.wins).toBe(1);
    expect(a.placeSum).toBe(1.5);
    const single = new RatingBook();
    single.rate(placedReport(['A@v1', 'X@v1', 'B@v1', 'C@v1'], [0, 1, 2, 3]));
    expect(a.mu).toBeGreaterThan(single.get('A@v1').mu);
  });

  // Ratings persist between sessions as plain JSON and keep updating from where they left off.
  it('round-trips through JSON and continues from the stored rating', () => {
    const book = new RatingBook();
    for (let m = 0; m < 5; m++) book.rate(placedReport(KEYS, [0, 1, 2, 3]), 1000 + m);
    const restored = RatingBook.fromJSON(JSON.parse(JSON.stringify(book.toJSON())));
    expect(restored.leaderboard()).toEqual(book.leaderboard());
    expect(restored.leaderboard()[0]!.key).toBe('A@v1');
    expect(restored.record('A@v1')!.lastPlayedAt).toBe(1004);
    restored.rate(placedReport(KEYS, [3, 2, 1, 0]));
    expect(restored.get('D@v1').mu).toBeGreaterThan(book.get('D@v1').mu);
    expect(restored.record('D@v1')!.matches).toBe(6);
  });

  it('skips malformed stored records instead of inventing ratings', () => {
    const book = RatingBook.fromJSON({ records: [{ key: 'ok@v1', mu: 30, sigma: 4 }, { key: 'bad@v1', mu: 'x', sigma: 4 }, { mu: 1, sigma: 1 }] });
    expect(book.size).toBe(1);
    expect(book.get('ok@v1').mu).toBe(30);
    expect(RatingBook.fromJSON(null).size).toBe(0);
  });
});
