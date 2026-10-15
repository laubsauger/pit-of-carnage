import { describe, expect, it } from 'vitest';
import { HEATMAP_CELL_PX, addToHeatmap, createHeatmap, emptyFighterStats, mergeHeatmap } from './report-types';

describe('heatmaps', () => {
  // The gym records them, the UI draws them and the LLM text summarises them: all three must agree
  // on which cell a point falls in, so the layout is fixed here once.
  it('covers the whole map in fixed cells, row-major from the top-left corner', () => {
    const h = createHeatmap(1360, 860);
    expect(h.cell).toBe(HEATMAP_CELL_PX);
    expect([h.cols, h.rows]).toEqual([17, 11]);
    expect(h.counts).toHaveLength(17 * 11);
    addToHeatmap(h, 0, 0);
    addToHeatmap(h, HEATMAP_CELL_PX * 2 + 1, HEATMAP_CELL_PX * 3 + 1, 5);
    expect(h.counts[0]).toBe(1);
    expect(h.counts[3 * h.cols + 2]).toBe(5);
    expect(h.total).toBe(6);
  });

  // A knockback or a rounding error can put a centre a hair outside the map; that time still
  // happened and must not vanish from the shares (or crash the recorder).
  it('counts points off the map in the nearest edge cell and ignores non-finite points', () => {
    const h = createHeatmap(1360, 860);
    addToHeatmap(h, -5, -5);
    addToHeatmap(h, 1360, 860);
    addToHeatmap(h, 99999, 10);
    addToHeatmap(h, Number.NaN, 10);
    addToHeatmap(h, 10, Number.POSITIVE_INFINITY);
    expect(h.counts[0]).toBe(1);
    expect(h.counts[h.counts.length - 1]).toBe(1);
    expect(h.counts[h.cols - 1]).toBe(1);
    expect(h.total).toBe(3);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(h.total);
  });

  // Aggregates sum a strategy's matches per map; mixing maps or cell sizes would draw nonsense.
  it('merges same-shaped heatmaps and refuses different shapes', () => {
    const a = createHeatmap(1360, 860);
    const b = createHeatmap(1360, 860);
    addToHeatmap(a, 100, 100, 2);
    addToHeatmap(b, 100, 100, 3);
    addToHeatmap(b, 1000, 700);
    mergeHeatmap(a, b);
    expect(a.total).toBe(6);
    expect(a.counts[1 * a.cols + 1]).toBe(5);
    expect(b.total).toBe(4);
    expect(() => mergeHeatmap(a, createHeatmap(800, 600))).toThrow(/shapes differ/);
    expect(() => mergeHeatmap(a, createHeatmap(1360, 860, 40))).toThrow(/shapes differ/);
  });

  // Plain JSON: reports cross the worker boundary and get pasted into an LLM.
  it('survives a JSON round trip unchanged', () => {
    const h = createHeatmap(1360, 860);
    addToHeatmap(h, 500, 500, 7);
    expect(JSON.parse(JSON.stringify(h))).toEqual(h);
  });
});

describe('emptyFighterStats', () => {
  // "Never engaged" must read as no contact at all, not as contact at tick 0.
  it('is all zero with no first contact, and a fresh object each time', () => {
    const a = emptyFighterStats();
    expect(a.ticksToFirstContact).toBeNull();
    expect(Object.entries(a).filter(([k]) => k !== 'ticksToFirstContact').every(([, v]) => v === 0)).toBe(true);
    a.assists = 3;
    expect(emptyFighterStats().assists).toBe(0);
  });
});
