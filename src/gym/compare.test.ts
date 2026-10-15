import { describe, expect, it } from 'vitest';
import { strategyKey } from '../core';
import { buildBatch } from './batch';
import { compareBatches, compareReports, runCompare, type CompareRequest } from './compare';
import { fakeRunner, makeStrategy } from './testkit';

const field = [makeStrategy('Gary'), makeStrategy('Brenda', { weapon: 'LONGBOW' }), makeStrategy('Doug'), makeStrategy('Mabel', { weapon: 'ARCANE_STAFF' })];
const v2 = makeStrategy('Lurking Daggers', { weapon: 'TWIN_DAGGERS', version: 2 });
const v3 = makeStrategy('Lurking Daggers', { weapon: 'TWIN_DAGGERS', version: 3 });
const req: CompareRequest = { a: v3, b: v2, field, mapIds: ['pit', 'catacombs'], matches: 12, fighters: 4, seed: 5 };

describe('compare', () => {
  // A side-by-side comparison only means something if both sides fought the same fights: same
  // seeds, maps, opponents and seat, with only the strategy under test swapped.
  it('plays both sides on exactly the same matches, never against each other', () => {
    const [ba, bb] = compareBatches({ ...req, field: [...field, v2, v3] });
    const ca = buildBatch(ba);
    const cb = buildBatch(bb);
    expect(ca).toHaveLength(12);
    ca.forEach((c, i) => {
      const d = cb[i]!;
      expect([d.seed, d.mapId]).toEqual([c.seed, c.mapId]);
      const keysA = c.entrants.map((e) => strategyKey(e.strategy));
      const keysB = d.entrants.map((e) => strategyKey(e.strategy));
      expect(keysA.indexOf('Lurking Daggers@v3')).toBe(keysB.indexOf('Lurking Daggers@v2'));
      expect(keysA.map((k) => (k === 'Lurking Daggers@v3' ? 'X' : k))).toEqual(keysB.map((k) => (k === 'Lurking Daggers@v2' ? 'X' : k)));
      expect(keysA).not.toContain('Lurking Daggers@v2');
      expect(keysB).not.toContain('Lurking Daggers@v3');
    });
  });

  it('refuses to compare a strategy with itself or without a field', () => {
    expect(() => compareBatches({ ...req, b: v3 })).toThrow(/two different strategies or versions/);
    expect(() => compareBatches({ ...req, field: [v2, v3] })).toThrow(/at least one field strategy/);
    expect(() => compareBatches({ ...req, matches: 0 })).toThrow(/at least one match/);
  });

  // The headline is per seed (who finished ahead on the same fight), then the averages side by side
  // with the better side marked only where "better" has a direction.
  it('counts who finished ahead on each shared seed and marks the better side of each row', () => {
    const strong = runCompare(req, fakeRunner((s) => (s.version === 3 ? 3 : 0), 0.5));
    expect(strong.matches).toHaveLength(12);
    expect(strong.aAhead + strong.bAhead + strong.level).toBe(12);
    expect(strong.aAhead).toBeGreaterThan(strong.bAhead);
    for (const [i, m] of strong.matches.entries()) {
      expect(m.placeA).toBe(strong.reportsA[i]!.fighters.find((f) => strong.reportsA[i]!.roster.find((e) => e.fighterId === f.fighterId)!.strategyKey === 'Lurking Daggers@v3')!.place);
    }
    expect(strong.findings[0]).toBe(`Lurking Daggers v3 finished ahead of v2 on ${strong.aAhead} of 12 shared seeds (${strong.bAhead} behind, ${strong.level} level).`);
    const rows = Object.fromEntries(strong.rows.map((r) => [r.label, r]));
    expect(rows['Win rate']!.better).toBe('a');
    expect(rows['Average place']!.better).toBe('a');
    expect(rows['Average place']!.a).toBeLessThan(rows['Average place']!.b!);
    // Style, not quality: no side is "better" at standing near walls.
    expect(rows['Near walls']!.better).toBeNull();
    // Heatmaps per map on both sides, for the side-by-side maps.
    expect(Object.keys(strong.a.heatmaps).sort()).toEqual(['catacombs', 'pit']);
    expect(Object.keys(strong.b.heatmaps).sort()).toEqual(['catacombs', 'pit']);
  });

  it('reports progress over both sides', () => {
    const progress: [number, number][] = [];
    runCompare({ ...req, matches: 3 }, fakeRunner(() => 0), { onProgress: (d, t) => progress.push([d, t]) });
    expect(progress).toEqual([1, 2, 3, 4, 5, 6].map((d) => [d, 6]));
  });

  it('refuses reports that are not paired seed by seed', () => {
    const run = fakeRunner(() => 0);
    const [ba, bb] = compareBatches(req);
    const ra = buildBatch(ba).map(run);
    const rb = buildBatch(bb).map(run);
    expect(() => compareReports(req, ra, rb.slice(1))).toThrow(/12 matches for A but 11 for B/);
    expect(() => compareReports(req, ra, [...rb].reverse())).toThrow(/not paired/);
  });
});
