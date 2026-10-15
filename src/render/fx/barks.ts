// Owned by: render-fx
/**
 * What barks are shown and where, as pure logic (popups.ts draws them). The sim already limits how
 * often a fighter talks (`BARK_RULES.cooldownTicks`); the view decides the rest:
 *
 * - the View setting: off, key moments only (`BARK_RULES.keyKinds`) or everything,
 * - at most `BARK_RULES.maxVisible` bubbles on screen; a new line only displaces a bubble that has
 *   been readable for a moment, otherwise it is dropped,
 * - about five words (`BARK_RULES.maxWords`), small, gone after `BARK_RULES.visibleSeconds`,
 * - bubbles sit above their speaker's name tag and step up out of the way of other bubbles and of
 *   other fighters' name tags and HP bars.
 */

import { BARK_RULES } from '../../core';
import type { BarkKind, BarkMode } from '../../core';

export function barkShown(mode: BarkMode, kind: BarkKind): boolean {
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  return BARK_RULES.keyKinds.includes(kind);
}

/** Longest bubble text in characters, a backstop for very long words. */
export const BARK_MAX_CHARS = 34;

/** Cut a line to `maxWords` words (and `BARK_MAX_CHARS`), ending in an ellipsis when cut. */
export function truncateBark(text: string, maxWords: number = BARK_RULES.maxWords): string {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  let out = words.slice(0, maxWords).join(' ');
  let cut = words.length > maxWords;
  if (out.length > BARK_MAX_CHARS) {
    out = out.slice(0, BARK_MAX_CHARS - 1).trimEnd();
    cut = true;
  }
  if (!cut) return out;
  return `${out.replace(/[\s.,;:!?…-]+$/, '')}…`;
}

/** Seconds a bubble must have been up before a newer line may replace it. */
export const BARK_MIN_SHOW = 0.6;

export type BarkSlot = { active: boolean; serial: number; t: number; fighterId: string };

/**
 * Where a new line from `fighterId` goes: that fighter's own bubble, a free slot, or the oldest
 * bubble that has been readable for `BARK_MIN_SHOW`. Null means drop the line (the screen already
 * holds `maxVisible` fresh bubbles). `slots` has exactly `maxVisible` entries.
 */
export function pickBarkSlot<T extends BarkSlot>(slots: readonly T[], fighterId: string): T | null {
  for (const s of slots) if (s.active && s.fighterId === fighterId) return s;
  let oldest: T | null = null;
  for (const s of slots) {
    if (!s.active) return s;
    if (!oldest || s.serial < oldest.serial) oldest = s;
  }
  return oldest && oldest.t >= BARK_MIN_SHOW ? oldest : null;
}

/** Axis-aligned box: centre and half extents (world units, +y down). */
export type Box = { cx: number; cy: number; hw: number; hh: number };

export function overlaps(a: Box, b: Box, pad = 0): boolean {
  return Math.abs(a.cx - b.cx) < a.hw + b.hw + pad && Math.abs(a.cy - b.cy) < a.hh + b.hh + pad;
}

/**
 * Move `box` straight up until it overlaps none of the first `count` obstacles (with `pad` between).
 * Up is away from its speaker (the bubble starts above its own tag), so this always terminates.
 * Returns the number of moves.
 */
export function liftClear(box: Box, obstacles: readonly Box[], count: number, pad: number): number {
  let moves = 0;
  for (let guard = 0; guard < count + 1; guard++) {
    let hit = -1;
    for (let i = 0; i < count; i++) {
      if (!overlaps(box, obstacles[i], pad)) continue;
      // Of all overlapped obstacles, clear the one reaching highest first.
      if (hit < 0 || obstacles[i].cy - obstacles[i].hh < obstacles[hit].cy - obstacles[hit].hh) hit = i;
    }
    if (hit < 0) return moves;
    const o = obstacles[hit];
    box.cy = o.cy - o.hh - pad - box.hh;
    moves++;
  }
  return moves;
}

/**
 * Screen-space size of a fighter's name tag and HP bar stack above its body (CSS px), mirroring
 * the world renderer's tag layout (render/tags.ts): the bar starts 10 px above the body, the tag
 * sits 3 px above the bar. Used to keep bubbles and damage numbers off them.
 */
export const TAG_LAYOUT = {
  /** Gap between the body's top edge and the HP bar. */
  gap: 10,
  /** HP bar height including ammo pips (ranged builds). */
  bar: 11,
  barW: 46,
  tagGap: 3,
  tagH: 18,
  /** Approximate tag text width per character (Inter 600 13 px) plus the colour stripe padding. */
  charW: 7.4,
  tagPad: 18,
  maxChars: 22,
};

/** Height (CSS px) of the bar + tag stack above a fighter's body edge. */
export function tagStackPx(nameTags: boolean): number {
  const t = TAG_LAYOUT;
  return t.gap + t.bar + (nameTags ? t.tagGap + t.tagH : 0);
}

/**
 * The box a fighter's HP bar and name tag occupy (world units). `px` is world units per CSS px.
 */
export function tagBox(out: Box, x: number, y: number, radius: number, name: string, nameTags: boolean, px: number): Box {
  const t = TAG_LAYOUT;
  const h = tagStackPx(nameTags) - t.gap;
  const chars = Math.min(t.maxChars, name.length);
  const w = nameTags ? Math.max(t.barW, chars * t.charW + t.tagPad) : t.barW;
  out.cx = x;
  out.hw = (w / 2) * px;
  out.hh = (h / 2) * px;
  out.cy = y - radius - (t.gap + h / 2) * px;
  return out;
}
