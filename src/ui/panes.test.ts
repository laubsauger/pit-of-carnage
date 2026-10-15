import { describe, expect, it } from 'vitest';
import { PANES, RAIL_PX, clampPaneWidth, dragPaneWidth, initialPane, paneExtent, sanitizePane } from './panes';

describe('dragPaneWidth', () => {
  it('widens a left pane when its right-edge handle moves right, and a right pane when its handle moves left', () => {
    // The handle is on the inner edge: toward the middle of the screen always means wider.
    expect(dragPaneWidth('watch.scoreboard', 252, 300, 340)).toBe(292);
    expect(dragPaneWidth('watch.inspector', 316, 1000, 960)).toBe(356);
    expect(dragPaneWidth('watch.inspector', 316, 1000, 1040)).toBe(PANES['watch.inspector'].min);
  });

  it('never lets a pane get so narrow that its rows wrap, or so wide it swallows the arena', () => {
    const s = PANES['watch.scoreboard'];
    expect(dragPaneWidth('watch.scoreboard', 252, 300, -2000)).toBe(s.min);
    expect(dragPaneWidth('watch.scoreboard', 252, 300, 5000)).toBe(s.max);
  });
});

describe('sanitizePane', () => {
  const read = sanitizePane('gym.library');
  const fallback = initialPane('gym.library');

  it('keeps a valid stored pane', () => {
    expect(read({ width: 300, collapsed: true }, fallback)).toEqual({ width: 300, collapsed: true });
  });

  it('re-clamps a width stored by an older build with other limits', () => {
    expect(read({ width: 20, collapsed: false }, fallback).width).toBe(PANES['gym.library'].min);
  });

  it('falls back field by field on garbage instead of breaking the screen', () => {
    expect(read('wide', fallback)).toEqual(fallback);
    expect(read({ width: 'x', collapsed: 1 }, fallback)).toEqual(fallback);
    expect(clampPaneWidth('gym.library', Number.NaN)).toBe(PANES['gym.library'].initial);
  });
});

describe('paneExtent', () => {
  it('is the rail when collapsed, so the arena framing gets the space back', () => {
    expect(paneExtent({ width: 300, collapsed: true })).toBe(RAIL_PX);
    expect(paneExtent({ width: 300, collapsed: false })).toBe(300);
  });
});
