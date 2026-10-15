import { describe, expect, it } from 'vitest';
import { addToHeatmap, createHeatmap } from '../core';
import { heatmapPhrase, regionAreas, summarizeHeatmap, trimHeatmap } from './heatmap';

/** A 1360 x 860 heatmap with `ticks` at each point. */
function heat(points: readonly [number, number, number][]) {
  const h = createHeatmap(1360, 860);
  for (const [x, y, ticks] of points) addToHeatmap(h, x, y, ticks);
  return h;
}

describe('heatmaps in words', () => {
  // The LLM reads "corners 62%" against the legend's area shares; a camper only stands out if the
  // regions are fixed, symmetric and add up to the whole map.
  it('splits the map into centre, sides and corners that cover it once', () => {
    const areas = regionAreas(createHeatmap(1360, 860));
    expect(areas.centre + areas.sides + areas.corners).toBeCloseTo(1, 10);
    expect([Math.round(areas.centre * 100), Math.round(areas.corners * 100), Math.round(areas.sides * 100)]).toEqual([24, 26, 50]);
  });

  it('gives the share of time per region, the busiest spot and how much of the map was visited', () => {
    const s = summarizeHeatmap(heat([[60, 60, 240], [150, 140, 60], [680, 430, 100], [40, 430, 100]]))!;
    expect(s.regions.corners).toBeCloseTo(0.6, 10);
    expect(s.regions.centre).toBeCloseTo(0.2, 10);
    expect(s.regions.sides).toBeCloseTo(0.2, 10);
    // Both corner cells fall in one 240 px square in the top-left.
    expect(s.hotspot).toEqual({ col: 0, row: 0, label: 'the north-west corner', share: 0.6 });
    expect(s.coverage).toBeCloseTo(4 / 187, 10);
    expect(heatmapPhrase(heat([[60, 60, 240], [150, 140, 60], [680, 430, 100], [40, 430, 100]]))).toBe(
      'corners 60%, sides 20%, centre 20%; busiest spot: the north-west corner, 60% of its time in one 240 px square; visited 2% of the map',
    );
  });

  // Every map is mirrored on both axes, so the same habit in the opposite quadrant must read as the
  // opposite place, never as the same one.
  it('names places symmetrically on both axes', () => {
    const label = (x: number, y: number) => summarizeHeatmap(heat([[x, y, 10]]))!.hotspot.label;
    expect(label(60, 60)).toBe('the north-west corner');
    expect(label(1300, 800)).toBe('the south-east corner');
    expect(label(1300, 60)).toBe('the north-east corner');
    expect(label(60, 430)).toBe('the west side');
    expect(label(1300, 430)).toBe('the east side');
    expect(label(680, 60)).toBe('the north side');
    expect(label(680, 800)).toBe('the south side');
    expect(label(680, 430)).toBe('the centre');
  });

  it('says so when there is nothing to describe', () => {
    expect(summarizeHeatmap(createHeatmap(1360, 860))).toBeNull();
    expect(heatmapPhrase(createHeatmap(1360, 860))).toBe('no time recorded');
  });

  // The LLM paste keeps the grid shape and total, so the busiest cells still mean something.
  it('trims a heatmap to its busiest cells, most first, ties in row-major order', () => {
    const h = heat([[60, 60, 5], [700, 60, 9], [60, 700, 5], [700, 700, 1]]);
    expect(trimHeatmap(h, 3)).toEqual({
      cell: 80, cols: 17, rows: 11, total: 20,
      top: [{ col: 8, row: 0, ticks: 9 }, { col: 0, row: 0, ticks: 5 }, { col: 0, row: 8, ticks: 5 }],
    });
    expect(trimHeatmap(createHeatmap(1360, 860)).top).toEqual([]);
  });
});
