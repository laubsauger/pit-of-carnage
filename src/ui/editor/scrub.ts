// Owned by: ui
// Scrubbing numbers in the code view: which number is under the pointer (a JSON number, or a number
// inside an expression string), how far it may go, and its text after a drag. The visual builder
// scrubs the same fields with the same ranges, so dragging a weight feels the same in both views.
import { ATTRIBUTE_MAX, ATTRIBUTE_MIN } from '../../core';
import { LIMITS } from '../../strategy';
import { decimalsOf, scrubbed } from './exprtext';
import { stringContent, tokenAt } from './jsontext';
import type { JsonToken, PathSeg } from './jsontext';
import { lexExpr, slotOf } from './language';

/** Pixels of drag per step; Shift moves ten steps at a time, Alt a tenth. */
export const PX_PER_STEP = 4;

export function dragSteps(e: { clientX: number; shiftKey: boolean; altKey: boolean }, startX: number): number {
  const raw = (e.clientX - startX) / PX_PER_STEP;
  const mul = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
  return Math.round(raw * mul);
}

/**
 * A number that can be dragged: where it is, its text when the drag began, and its range. `step`
 * null means "the smallest unit it is written with" (0.25 moves by 0.01, 200 by 1).
 */
export type ScrubTarget = { from: number; to: number; text: string; min: number; max: number; step: number | null };

/** Range and step of a JSON number by where it sits; null for numbers that are not the player's to drag. */
function jsonRange(path: readonly PathSeg[]): Omit<ScrubTarget, 'from' | 'to' | 'text'> | null {
  const [a, b, c, d, e, f] = path;
  if (a === 'version') return null; // the library's number, overwritten on save
  if (a === 'build' && b === 'attributes' && path.length === 3) return { min: ATTRIBUTE_MIN, max: ATTRIBUTE_MAX, step: 1 };
  if (a === 'commit' && path.length === 1) return { min: 0, max: LIMITS.commitMax, step: 1 };
  if (a === 'memory' && path.length === 2) return { min: -1e6, max: 1e6, step: null };
  if (a === 'behaviours' && c === 'move' && typeof d === 'number') {
    if (e === 'weight' && path.length === 5) return { min: 0, max: LIMITS.weightMax, step: 0.05 };
    if (e === 'keep_range' && (f === 1 || f === 2) && path.length === 6) return { min: 0, max: LIMITS.rangeMax, step: 5 };
  }
  return { min: -1e6, max: 1e6, step: null };
}

/** The draggable number at `offset` in the strategy text, or null when there is none there. */
export function scrubTargetAt(text: string, tokens: readonly JsonToken[], offset: number): ScrubTarget | null {
  const t = tokenAt(tokens, offset);
  if (!t) return null;
  if (t.kind === 'number') {
    const range = jsonRange(t.path);
    return range ? { from: t.from, to: t.to, text: text.slice(t.from, t.to), ...range } : null;
  }
  if (t.kind !== 'string') return null;
  const slot = slotOf(t.path);
  if (slot.kind !== 'expr' && slot.kind !== 'attack') return null;
  const c = stringContent(t);
  const src = text.slice(c.from, c.to);
  if (src.includes('\\')) return null;
  const at = offset - c.from;
  // A minus sign is its own token in expressions, so a number here is never negative.
  const num = lexExpr(src).find((x) => x.kind === 'num' && at >= x.from && at <= x.to);
  return num ? { from: c.from + num.from, to: c.from + num.to, text: num.text, min: 0, max: Infinity, step: null } : null;
}

/** The number's text after `steps` drag steps, kept in range and written as tidily as the start. */
export function scrubValue(t: ScrubTarget, steps: number): string {
  if (t.step === null) return scrubbed(t.text, steps, t.min, t.max);
  const start = Number(t.text);
  const base = Number.isFinite(start) ? start : 0;
  const decimals = Math.max(decimalsOf(String(t.step)), decimalsOf(t.text));
  const v = Math.min(t.max, Math.max(t.min, base + steps * t.step));
  return String(Number(v.toFixed(decimals)));
}
