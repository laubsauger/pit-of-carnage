// Owned by: render-fx
/**
 * Where kill stamps go and how big they are, as pure logic (popups.ts draws them). A stamp is a
 * readable punchline, not a banner: it appears a little above the kill spot (never on the body),
 * at a size tied to the screen rather than the world, so zooming in never makes it huge, and
 * several stamps stack upward instead of covering each other or anyone's name tag.
 */

import { liftClear } from './barks';
import type { Box } from './barks';
import { dropClear } from './numberLayout';

export const STAMP = {
  /** Stamp quad height as a fraction of the view height (CSS px)... */
  viewFraction: 0.08,
  /** ...kept between these (CSS px; the lettering is about 70% of the quad). */
  minPx: 40,
  maxPx: 60,
  /** Gap between the kill spot and the stamp's bottom edge (CSS px): above the body, not on it. */
  offsetPx: 26,
  /** How far it floats up while it fades (CSS px). */
  risePx: 34,
  /** Gap between stacked stamps (CSS px). */
  gapPx: 2,
};

/** Stamp quad height in CSS px for a view `viewHeightPx` tall. Independent of zoom. */
export function stampHeightPx(viewHeightPx: number): number {
  const h = viewHeightPx * STAMP.viewFraction;
  return h < STAMP.minPx ? STAMP.minPx : h > STAMP.maxPx ? STAMP.maxPx : h;
}

/**
 * Stack stamps: `boxes[0..fixed)` are things stamps must not cover (fighters' name tags and HP
 * bars), `boxes[fixed..count)` the stamps, oldest first, each at its own spot. Every stamp steps up
 * above any tag or older stamp it overlaps; a stamp marked in `below` sits under its kill spot
 * instead (there was no room above it) and steps down. Returns how many stamps moved.
 */
export function stackStamps(boxes: readonly Box[], fixed: number, count: number, pad: number, below?: readonly boolean[]): number {
  let moved = 0;
  for (let i = fixed; i < count; i++) {
    const down = below !== undefined && below[i - fixed] === true;
    if ((down ? dropClear(boxes[i], boxes, i, pad) : liftClear(boxes[i], boxes, i, pad)) > 0) moved++;
  }
  return moved;
}
