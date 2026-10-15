import { describe, expect, it } from 'vitest';
import { BARK_RULES } from '../../core';
import type { BarkKind } from '../../core';
import { BARK_MAX_CHARS, BARK_MIN_SHOW, liftClear, overlaps, pickBarkSlot, tagBox, tagStackPx, truncateBark } from './barks';
import type { BarkSlot, Box } from './barks';
import { barkShown } from './barks';

const KINDS: readonly BarkKind[] = ['spawn', 'kill', 'hit', 'low_hp', 'death', 'skill', 'taunt'];

describe('which barks are shown', () => {
  it('shows nothing when barks are off', () => {
    for (const k of KINDS) expect(barkShown('off', k)).toBe(false);
  });

  // Default "key moments": spawn, kill, low HP, skill, death. Chatter (hits, taunts) stays quiet.
  it('shows only key moments by default', () => {
    expect(KINDS.filter((k) => barkShown('key', k))).toEqual(['spawn', 'kill', 'low_hp', 'death', 'skill']);
  });

  it('shows everything in "all"', () => {
    for (const k of KINDS) expect(barkShown('all', k)).toBe(true);
  });
});

describe('bark text', () => {
  it('keeps short lines as they are', () => {
    expect(truncateBark('Unpaid. Unmourned.')).toBe('Unpaid. Unmourned.');
  });

  // Barks are about five words: a speech is unreadable at 1.5 s and covers the fight.
  it('cuts long lines to about five words with an ellipsis', () => {
    const cut = truncateBark('I told you I would come back for you, Brenda');
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.replace('…', '').trim().split(/\s+/).length).toBeLessThanOrEqual(BARK_RULES.maxWords);
    expect(truncateBark('one two three four five, six')).toBe('one two three four five…');
  });

  it('caps a run of very long words', () => {
    const cut = truncateBark('Supercalifragilisticexpialidocious antidisestablishmentarianism');
    expect(cut.length).toBeLessThanOrEqual(BARK_MAX_CHARS);
    expect(cut.endsWith('…')).toBe(true);
  });
});

describe('bark slots', () => {
  const slot = (active: boolean, serial: number, t: number, fighterId: string): BarkSlot => ({ active, serial, t, fighterId });

  it('reuses the speaker’s own bubble', () => {
    const slots = [slot(true, 1, 0.1, 'a'), slot(true, 2, 0.1, 'b')];
    expect(pickBarkSlot(slots, 'b')).toBe(slots[1]);
  });

  it('takes a free slot first', () => {
    const slots = [slot(true, 1, 1, 'a'), slot(false, 0, 0, '')];
    expect(pickBarkSlot(slots, 'c')).toBe(slots[1]);
  });

  // At most two bubbles: a new line never adds a third. It replaces the oldest only once that one
  // has been readable for a moment; otherwise the line is dropped (no flicker).
  it('never exceeds the visible limit: drops a line while all bubbles are fresh', () => {
    const slots = Array.from({ length: BARK_RULES.maxVisible }, (_, i) => slot(true, i + 1, BARK_MIN_SHOW / 2, `f${i}`));
    expect(pickBarkSlot(slots, 'new')).toBeNull();
  });

  it('replaces the oldest bubble once it has been read', () => {
    const slots = [slot(true, 5, BARK_MIN_SHOW + 0.1, 'a'), slot(true, 3, BARK_MIN_SHOW + 0.2, 'b')];
    expect(pickBarkSlot(slots, 'new')).toBe(slots[1]);
  });
});

describe('bubble placement', () => {
  const px = 1;

  // Bubbles dodge name tags and each other; moving up (away from the speaker) always ends clear.
  it('lifts a bubble clear of every obstacle and never moves it down', () => {
    const obstacles: Box[] = [
      { cx: 100, cy: 80, hw: 40, hh: 10 },
      { cx: 120, cy: 50, hw: 40, hh: 12 },
      { cx: 300, cy: 50, hw: 40, hh: 12 },
    ];
    const box: Box = { cx: 110, cy: 85, hw: 50, hh: 14 };
    const start = box.cy;
    liftClear(box, obstacles, obstacles.length, 3);
    expect(box.cy).toBeLessThanOrEqual(start);
    for (const o of obstacles) expect(overlaps(box, o, 3)).toBe(false);
  });

  it('leaves a bubble alone when nothing is in the way', () => {
    const box: Box = { cx: 0, cy: 0, hw: 10, hh: 10 };
    expect(liftClear(box, [{ cx: 100, cy: 0, hw: 10, hh: 10 }], 1, 2)).toBe(0);
    expect(box.cy).toBe(0);
  });

  // A bubble sitting on top of its speaker's tag stack must not cover the tag or the HP bar.
  it('puts a bubble above its own speaker’s tag stack without touching it', () => {
    for (const names of [true, false]) {
      const tag = tagBox({ cx: 0, cy: 0, hw: 0, hh: 0 }, 200, 300, 18, 'Apologetic Gary', names, px);
      const hh = 20;
      const bubble: Box = { cx: 200, cy: 300 - 18 - tagStackPx(names) * px - 3 - hh, hw: 60, hh };
      expect(overlaps(bubble, tag)).toBe(false);
      // The tag box starts above the body: nothing sits on the fighter itself.
      expect(tag.cy + tag.hh).toBeLessThanOrEqual(300 - 18);
    }
  });
});
