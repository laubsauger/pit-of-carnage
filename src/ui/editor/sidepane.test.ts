import { describe, expect, it } from 'vitest';
import { EDITOR_SIDE, dragSideWidth, sanitizeSideWidth } from './sidepane';

describe('the editor side panel width', () => {
  // The panel is on the right: dragging its handle toward the code makes it wider.
  it('widens when the handle moves left and stops at its limits', () => {
    expect(dragSideWidth(300, 500, 440)).toBe(360);
    expect(dragSideWidth(300, 500, 0)).toBe(EDITOR_SIDE.max);
    expect(dragSideWidth(300, 500, 2000)).toBe(EDITOR_SIDE.min);
  });

  // A width stored by an older build or edited by hand must never make the panel unusable.
  it('re-clamps a stored width and ignores garbage', () => {
    expect(sanitizeSideWidth(9000, 300)).toBe(EDITOR_SIDE.max);
    expect(sanitizeSideWidth('wide', 300)).toBe(300);
    expect(sanitizeSideWidth(Number.NaN, 300)).toBe(EDITOR_SIDE.initial);
  });
});
