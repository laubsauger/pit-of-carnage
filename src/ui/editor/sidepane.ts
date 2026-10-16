// Owned by: ui
// The editor's side panel (checks, budget, stats, history) is resizable like the other side panes
// (SPEC "Resizable panes"): a handle on its inner edge, a min and max so nothing wraps badly,
// double-click to reset, arrow keys to nudge, the width kept per browser under `poc.pane.gym.editor`.
import { clamp } from '../../core';

export const EDITOR_SIDE = { min: 240, max: 560, initial: 300 } as const;
export const EDITOR_SIDE_KEY = 'poc.pane.gym.editor';

export function clampSideWidth(width: number): number {
  return Number.isFinite(width) ? Math.round(clamp(width, EDITOR_SIDE.min, EDITOR_SIDE.max)) : EDITOR_SIDE.initial;
}

/** A stored width read back: anything that is not a number falls back, a number is re-clamped. */
export function sanitizeSideWidth(value: unknown, fallback: number): number {
  return typeof value === 'number' ? clampSideWidth(value) : fallback;
}

/** Width while dragging: the panel hugs the right edge, so moving the handle left widens it. */
export function dragSideWidth(startWidth: number, startX: number, x: number): number {
  return clampSideWidth(startWidth - (x - startX));
}
