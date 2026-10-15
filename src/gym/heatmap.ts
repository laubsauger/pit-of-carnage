/**
 * Heatmaps in words, for `reportToText` (the LLM paste) and any caption the UI wants. A heatmap
 * (`Heatmap`, src/core) counts ticks alive per 80 px cell; here it becomes shares of time in three
 * regions of the grid, the busiest spot and how much of the map was visited:
 * "corners 62%, sides 30%, centre 8%; busiest spot: the north-west corner, 45% of its time in one
 * 240 px square; visited 23% of the map".
 *
 * Regions come from the grid alone, so the words mean the same on every map: a cell's centre is
 * placed relative to the grid's centre on each axis (0 = middle, 1 = edge). Centre: within the
 * middle half on both axes. Corners: in the outer quarters on both axes. Sides: the rest. On a
 * 1360 x 860 map that is 24%, 26% and 50% of the area; `regionAreas` gives the exact split.
 */

import type { Heatmap } from '../core';
import { listing } from './format';

export type HeatRegion = 'centre' | 'sides' | 'corners';

export const HEAT_REGIONS: readonly HeatRegion[] = ['corners', 'sides', 'centre'];

/** Cells per side of the busiest-spot square (3 x 80 px = 240 px). */
export const HOTSPOT_CELLS = 3;

export type HeatmapSummary = {
  /** Share of the time (0..1) spent in each region. */
  regions: Record<HeatRegion, number>;
  /** The square of `HOTSPOT_CELLS` x `HOTSPOT_CELLS` cells with the most time: its top-left cell, where it is, its share. */
  hotspot: { col: number; row: number; label: string; share: number };
  /** Share of the grid's cells with any time at all (0..1): low for a camper, high for a roamer. */
  coverage: number;
};

type Grid = Pick<Heatmap, 'cell' | 'cols' | 'rows'>;

/** Where cell (col, row) lies relative to the grid's centre: -1 west/north edge .. 1 east/south edge. */
function offset(h: Grid, col: number, row: number): { nx: number; ny: number } {
  const halfW = (h.cols * h.cell) / 2;
  const halfH = (h.rows * h.cell) / 2;
  return { nx: ((col + 0.5) * h.cell - halfW) / halfW, ny: ((row + 0.5) * h.cell - halfH) / halfH };
}

function regionOf(nx: number, ny: number): HeatRegion {
  const x = Math.abs(nx);
  const y = Math.abs(ny);
  if (x < 0.5 && y < 0.5) return 'centre';
  return x >= 0.5 && y >= 0.5 ? 'corners' : 'sides';
}

/** "the north-west corner", "the east side", "the centre" for a point given as grid offsets. */
function placeLabel(nx: number, ny: number): string {
  const region = regionOf(nx, ny);
  const ns = ny < 0 ? 'north' : 'south';
  const ew = nx < 0 ? 'west' : 'east';
  if (region === 'corners') return `the ${ns}-${ew} corner`;
  if (region === 'sides') return Math.abs(nx) >= 0.5 ? `the ${ew} side` : `the ${ns} side`;
  return 'the centre';
}

/** Share of the grid's cells in each region (the time shares a fighter wandering at random would show). */
export function regionAreas(h: Grid): Record<HeatRegion, number> {
  const counts: Record<HeatRegion, number> = { centre: 0, sides: 0, corners: 0 };
  for (let row = 0; row < h.rows; row++) {
    for (let col = 0; col < h.cols; col++) {
      const { nx, ny } = offset(h, col, row);
      counts[regionOf(nx, ny)]++;
    }
  }
  const n = h.cols * h.rows;
  return { centre: counts.centre / n, sides: counts.sides / n, corners: counts.corners / n };
}

/** Shares of time per region, the busiest spot and the coverage; null for an empty heatmap. */
export function summarizeHeatmap(h: Heatmap): HeatmapSummary | null {
  if (h.total <= 0) return null;
  const regions: Record<HeatRegion, number> = { centre: 0, sides: 0, corners: 0 };
  let visited = 0;
  for (let row = 0; row < h.rows; row++) {
    for (let col = 0; col < h.cols; col++) {
      const n = h.counts[row * h.cols + col]!;
      if (n <= 0) continue;
      visited++;
      const { nx, ny } = offset(h, col, row);
      regions[regionOf(nx, ny)] += n;
    }
  }
  for (const r of HEAT_REGIONS) regions[r] /= h.total;

  // Busiest square: every placement of the square inside the grid (smaller grids use the whole grid).
  const size = Math.min(HOTSPOT_CELLS, h.cols, h.rows);
  let best = { col: 0, row: 0, ticks: -1 };
  for (let row = 0; row + size <= h.rows; row++) {
    for (let col = 0; col + size <= h.cols; col++) {
      let ticks = 0;
      for (let r = row; r < row + size; r++) for (let c = col; c < col + size; c++) ticks += h.counts[r * h.cols + c]!;
      if (ticks > best.ticks) best = { col, row, ticks };
    }
  }
  const mid = offset(h, best.col + (size - 1) / 2, best.row + (size - 1) / 2);
  return {
    regions,
    hotspot: { col: best.col, row: best.row, label: placeLabel(mid.nx, mid.ny), share: best.ticks / h.total },
    coverage: visited / (h.cols * h.rows),
  };
}

function percent(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/**
 * The heatmap in one line: "corners 62%, sides 30%, centre 8%; busiest spot: the north-west corner,
 * 45% of its time in one 240 px square; visited 23% of the map". "no time recorded" when empty.
 */
export function heatmapPhrase(h: Heatmap): string {
  const s = summarizeHeatmap(h);
  if (!s) return 'no time recorded';
  const regions = [...HEAT_REGIONS].sort((a, b) => s.regions[b] - s.regions[a]).map((r) => `${r} ${percent(s.regions[r])}`);
  const side = Math.min(HOTSPOT_CELLS, h.cols, h.rows) * h.cell;
  return (
    `${regions.join(', ')}; busiest spot: ${s.hotspot.label}, ${percent(s.hotspot.share)} of its time in one ${side} px square; ` +
    `visited ${percent(s.coverage)} of the map`
  );
}

/** One sentence explaining the regions of `heatmapPhrase`, with their share of the area. */
export function heatmapLegend(h: Grid): string {
  const a = regionAreas(h);
  const side = Math.min(HOTSPOT_CELLS, h.cols, h.rows) * h.cell;
  return (
    `"Where" splits each fighter's time alive between ${listing([
      `the centre (the middle half of the map on both axes, ${percent(a.centre)} of its area)`,
      `the corners (the outer quarters on both axes, ${percent(a.corners)})`,
      `the sides (the rest, ${percent(a.sides)})`,
    ])}; the busiest spot is the ${side} px square it spent the most time in.`
  );
}

/** A heatmap reduced for an LLM: the grid shape, the total and only its busiest cells. */
export type TrimmedHeatmap = { cell: number; cols: number; rows: number; total: number; top: { col: number; row: number; ticks: number }[] };

/** Keep the `keep` busiest cells (most ticks first; ties in row-major order) of a heatmap. */
export function trimHeatmap(h: Heatmap, keep = 5): TrimmedHeatmap {
  const top = h.counts
    .map((ticks, i) => ({ col: i % h.cols, row: Math.floor(i / h.cols), ticks, i }))
    .filter((c) => c.ticks > 0)
    .sort((a, b) => b.ticks - a.ticks || a.i - b.i)
    .slice(0, keep)
    .map(({ col, row, ticks }) => ({ col, row, ticks }));
  return { cell: h.cell, cols: h.cols, rows: h.rows, total: h.total, top };
}
