import { describe, expect, it } from 'vitest';
import type { Box } from './barks';
import { overlaps } from './barks';
import { STAMP, stackStamps, stampHeightPx } from './stampLayout';

describe('kill stamp size', () => {
  // Stamps were 13% of the view and grew with zoom. They are now tied to the screen in CSS px:
  // readable on a laptop, never a banner on a big screen, and zooming in never enlarges them.
  it('stays small and readable on any screen', () => {
    for (const viewPx of [360, 600, 800, 1080, 1440, 2160]) {
      const h = stampHeightPx(viewPx);
      expect(h).toBeGreaterThanOrEqual(STAMP.minPx);
      expect(h).toBeLessThanOrEqual(STAMP.maxPx);
      expect(h / viewPx).toBeLessThanOrEqual(0.12);
    }
    expect(STAMP.maxPx).toBeLessThanOrEqual(64);
  });

  // Above the body, not on it: the stamp's bottom edge sits a gap above the kill spot.
  it('spawns above the kill spot', () => {
    expect(STAMP.offsetPx).toBeGreaterThan(12);
  });
});

describe('kill stamp stacking', () => {
  // A double kill on one spot shows both stamps, the newer above the older, never on top of it.
  it('stacks newer stamps upward without overlap', () => {
    const boxes: Box[] = [
      { cx: 100, cy: 100, hw: 60, hh: 25 },
      { cx: 110, cy: 104, hw: 50, hh: 25 },
      { cx: 95, cy: 98, hw: 70, hh: 25 },
      { cx: 400, cy: 100, hw: 50, hh: 25 },
    ];
    const before = boxes.map((b) => b.cy);
    stackStamps(boxes, 0, boxes.length, 2);
    for (let i = 0; i < boxes.length; i++) {
      // Only ever up (smaller y), and the oldest never moves.
      expect(boxes[i].cy).toBeLessThanOrEqual(before[i]);
      for (let j = 0; j < i; j++) expect(overlaps(boxes[i], boxes[j], 2 - 1e-6)).toBe(false);
    }
    expect(boxes[0].cy).toBe(100);
    expect(boxes[3].cy).toBe(100);
    expect(boxes[2].cy).toBeLessThan(boxes[1].cy);
  });

  // The killer usually stands right at the kill spot, its name tag just above: the stamp must not
  // cover it (names are how a viewer follows the fight).
  it('steps up above name tags instead of covering them', () => {
    const tag: Box = { cx: 100, cy: 60, hw: 50, hh: 12 };
    const stamp: Box = { cx: 110, cy: 70, hw: 60, hh: 25 };
    const boxes = [tag, stamp];
    stackStamps(boxes, 1, 2, 2);
    expect(overlaps(stamp, tag, 2 - 1e-6)).toBe(false);
    expect(stamp.cy).toBeLessThan(tag.cy);
    expect(tag.cy).toBe(60);
  });

  // Near the top of the map there may be no room above: such a stamp sits under its kill spot and
  // steps down out of the way instead of being pushed back over a tag.
  it('steps down for stamps placed below their kill spot', () => {
    const tag: Box = { cx: 100, cy: 130, hw: 50, hh: 12 };
    const stamp: Box = { cx: 100, cy: 125, hw: 60, hh: 25 };
    const boxes = [tag, stamp];
    stackStamps(boxes, 1, 2, 2, [true]);
    expect(overlaps(stamp, tag, 2 - 1e-6)).toBe(false);
    expect(stamp.cy).toBeGreaterThan(tag.cy);
  });
});
