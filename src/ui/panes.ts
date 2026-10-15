// Owned by: ui
// Resizable, collapsible side panes (scoreboard, inspector, gym library). Pure model: widths are
// clamped to a per-pane range so nothing wraps badly, and a stored value from an older build or a
// hand edit can never produce a pane that is unusable.
import { clamp } from '../core';

export type PaneId = 'watch.scoreboard' | 'watch.inspector' | 'gym.library';

/**
 * `side`: which edge of the screen the pane hugs. Its drag handle sits on the inner edge, so
 * dragging toward the middle of the screen widens it.
 */
export type PaneSpec = { side: 'left' | 'right'; min: number; max: number; initial: number };

export const PANES: Readonly<Record<PaneId, PaneSpec>> = {
  // Names, weapon icon and kills on one line need about 200 px.
  'watch.scoreboard': { side: 'left', min: 200, max: 380, initial: 252 },
  // Below 290 px the steering ring and its term rings stop fitting side by side.
  'watch.inspector': { side: 'right', min: 290, max: 520, initial: 316 },
  'gym.library': { side: 'left', min: 180, max: 380, initial: 248 },
};

/** Width of a collapsed pane: a thin rail with the expand button. */
export const RAIL_PX = 30;

export type PaneState = { width: number; collapsed: boolean };

export function initialPane(id: PaneId): PaneState {
  return { width: PANES[id].initial, collapsed: false };
}

export function clampPaneWidth(id: PaneId, width: number): number {
  const s = PANES[id];
  return Number.isFinite(width) ? Math.round(clamp(width, s.min, s.max)) : s.initial;
}

/**
 * Width while dragging the handle: the press recorded the width and pointer x; the pane grows by
 * however far the pointer moved toward the middle of the screen.
 */
export function dragPaneWidth(id: PaneId, startWidth: number, startX: number, x: number): number {
  const dx = x - startX;
  return clampPaneWidth(id, PANES[id].side === 'left' ? startWidth + dx : startWidth - dx);
}

/** Space the pane takes from the screen edge (the rail when collapsed). */
export function paneExtent(state: PaneState): number {
  return state.collapsed ? RAIL_PX : state.width;
}

/** Read a stored pane back: anything malformed falls back field by field, widths are re-clamped. */
export function sanitizePane(id: PaneId) {
  return (value: unknown, fallback: PaneState): PaneState => {
    if (typeof value !== 'object' || value === null) return fallback;
    const v = value as Partial<PaneState>;
    return {
      width: typeof v.width === 'number' ? clampPaneWidth(id, v.width) : fallback.width,
      collapsed: typeof v.collapsed === 'boolean' ? v.collapsed : fallback.collapsed,
    };
  };
}

export function paneStorageKey(id: PaneId): string {
  return `poc.pane.${id}`;
}
