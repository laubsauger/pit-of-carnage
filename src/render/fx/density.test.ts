import { describe, expect, it } from 'vitest';
import { BLOOD_GRID, BOOTS, BloodGrid, BootPrints } from './density';

describe('fresh blood grid', () => {
  it('records a puddle where it was painted and nowhere else', () => {
    const g = new BloodGrid(400, 300);
    g.add(100, 100, 30, 1);
    expect(g.sample(100, 100)).toBeGreaterThan(BLOOD_GRID.wetThreshold);
    expect(g.sample(300, 200)).toBe(0);
    expect(g.sample(-5, 100)).toBe(0);
  });

  // A fine mist of tiny drops should not count as a puddle you can step in.
  it('weights sub-cell drops by their area', () => {
    const g = new BloodGrid(400, 300);
    g.add(50, 50, 2, 1);
    expect(g.sample(50, 50)).toBeLessThan(BLOOD_GRID.wetThreshold);
  });

  it('dries out with the configured half-life', () => {
    const g = new BloodGrid(100, 100);
    g.add(50, 50, 20, 1);
    const before = g.sample(50, 50);
    g.decay(BLOOD_GRID.halfLife);
    expect(g.sample(50, 50)).toBeCloseTo(before / 2, 5);
  });

  it('caps a cell so a huge pool does not stay wet forever', () => {
    const g = new BloodGrid(100, 100);
    for (let i = 0; i < 20; i++) g.add(50, 50, 20, 1);
    expect(g.sample(50, 50)).toBeLessThanOrEqual(BLOOD_GRID.maxPerCell);
  });
});

describe('bloody footprints', () => {
  // Walking through a fresh pool leaves a trail of prints that fades over the next steps and stops.
  it('loads boots in fresh blood and prints a fading, finite trail', () => {
    const g = new BloodGrid(800, 200);
    g.add(40, 100, 30, 1.5);
    const boots = new BootPrints();
    const prints: number[] = [];
    for (let i = 0; i < 40; i++) prints.push(boots.step('a', g, 40 + i * 18, 100, false));
    expect(prints[0]).toBeGreaterThan(0.5);
    const trail = prints.filter((p) => p > 0);
    expect(trail.length).toBeGreaterThan(5);
    expect(trail.length).toBeLessThan(30);
    for (let i = 1; i < trail.length; i++) expect(trail[i]).toBeLessThanOrEqual(trail[i - 1] + 1e-9);
    expect(prints[prints.length - 1]).toBe(0);
  });

  it('leaves no prints on a clean floor', () => {
    const g = new BloodGrid(400, 400);
    const boots = new BootPrints();
    for (let i = 0; i < 10; i++) expect(boots.step('a', g, 50 + i * 15, 50, false)).toBe(0);
  });

  // Old blood has dried: stepping through it should not start a trail.
  it('ignores blood that has dried out', () => {
    const g = new BloodGrid(400, 400);
    g.add(100, 100, 30, 1);
    g.decay(BLOOD_GRID.halfLife * 4);
    expect(new BootPrints().step('a', g, 100, 100, false)).toBe(0);
  });

  it('trusts the sim when it reports a bloody step', () => {
    const g = new BloodGrid(400, 400);
    expect(new BootPrints().step('a', g, 100, 100, true)).toBeCloseTo(BOOTS.hintLoad, 6);
  });

  it('keeps each fighter\'s boots separate and alternates feet', () => {
    const g = new BloodGrid(400, 400);
    g.add(100, 100, 30, 1.5);
    const boots = new BootPrints();
    boots.step('a', g, 100, 100, false);
    expect(boots.loadOf('a')).toBeGreaterThan(0);
    expect(boots.loadOf('b')).toBe(0);
    expect([boots.nextFoot('a'), boots.nextFoot('a'), boots.nextFoot('a')]).toEqual([1, -1, 1]);
  });

  it('soaks some blood out of the cell it steps in', () => {
    const g = new BloodGrid(400, 400);
    g.add(100, 100, 30, 1);
    const before = g.sample(100, 100);
    new BootPrints().step('a', g, 100, 100, false);
    expect(g.sample(100, 100)).toBeLessThan(before);
  });
});
