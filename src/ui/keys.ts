// Owned by: ui
// Watch-screen keyboard map as a pure function, so the bindings are testable without a DOM.
import { THINK_EVERY_TICKS, TICK_HZ } from '../core';
import { VIEW_GROUPS, viewKeyForShortcut } from './view';
import type { ViewKey } from './view';

/** Playback presets bound to keys 1-5 and shown in the clock. */
export const SPEED_PRESETS: readonly number[] = [0.25, 0.5, 1, 2, 4];

/** Arrow step: one brain think (what the inspector updates on). Shift: one second. */
export const STEP_TICKS = THINK_EVERY_TICKS;
export const STEP_TICKS_LARGE = TICK_HZ;

export type KeyAction =
  | { type: 'cycle'; dir: 1 | -1 }
  | { type: 'follow' }
  | { type: 'pause' }
  | { type: 'step'; ticks: number }
  | { type: 'speed'; speed: number }
  | { type: 'deselect' }
  /** End: back to the live edge after replaying. */
  | { type: 'live' }
  /** C: give the camera back to the director after wheel zoom or drag pan. */
  | { type: 'camera' }
  /** I: open (or close) the full-screen overview of the selected fighter. */
  | { type: 'overview' }
  /** A View setting's shortcut (see VIEW_GROUPS). */
  | { type: 'view'; key: ViewKey };

export type KeyInput = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** True when focus is in a text field, select or contenteditable element. */
  editable: boolean;
};

/**
 * Map a keydown to a watch action, or null to let the browser have it.
 * Never steals keys from text fields or from browser shortcuts (ctrl/cmd/alt combinations).
 */
export function keyToAction(e: KeyInput): KeyAction | null {
  if (e.editable || e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case 'Tab':
      return { type: 'cycle', dir: e.shiftKey ? -1 : 1 };
    case 'f':
    case 'F':
      return { type: 'follow' };
    case ' ':
    case 'Spacebar':
      return { type: 'pause' };
    case 'ArrowRight':
      return { type: 'step', ticks: e.shiftKey ? STEP_TICKS_LARGE : STEP_TICKS };
    case 'ArrowLeft':
      return { type: 'step', ticks: -(e.shiftKey ? STEP_TICKS_LARGE : STEP_TICKS) };
    case 'Escape':
      return { type: 'deselect' };
    case 'End':
      return { type: 'live' };
    case 'c':
    case 'C':
      return { type: 'camera' };
    case 'i':
    case 'I':
      return { type: 'overview' };
  }
  const digit = e.key.length === 1 ? e.key.charCodeAt(0) - 48 : -1;
  if (digit >= 1 && digit <= SPEED_PRESETS.length) return { type: 'speed', speed: SPEED_PRESETS[digit - 1] };
  const view = viewKeyForShortcut(e.key);
  if (view) return { type: 'view', key: view };
  return null;
}

/**
 * The Watch keys that are not View settings, for the shortcut list in the View popover (the View
 * rows show their own letters). `sample` is the key event value one of them sends.
 */
export const WATCH_KEYS: readonly { keys: string; label: string; sample: string }[] = [
  { keys: 'Space', label: 'Pause, play, skip the countdown', sample: ' ' },
  { keys: 'Tab', label: 'Next fighter (Shift: previous)', sample: 'Tab' },
  { keys: 'F', label: 'Follow the selected fighter', sample: 'f' },
  { keys: 'I', label: 'Full view of the selected fighter', sample: 'i' },
  { keys: '← →', label: 'Step one think (Shift: a second)', sample: 'ArrowRight' },
  { keys: '1-5', label: 'Speed 0.25x to 4x', sample: '1' },
  { keys: 'End', label: 'Back to live', sample: 'End' },
  { keys: 'C', label: 'Reset camera', sample: 'c' },
  { keys: 'Esc', label: 'Close, deselect, unfollow', sample: 'Escape' },
];

/**
 * Keys that leave cinematic view: they ask for a panel the cinematic view folds away (the next
 * fighter's inspector, the full overview). The spec: any HUD key brings the HUD back.
 */
export function exitsCinematic(action: KeyAction): boolean {
  return action.type === 'cycle' || action.type === 'overview';
}

export type KeyHelpGroup = { title: string; rows: readonly { keys: string; label: string }[] };

/**
 * Every shortcut for the keyboard card, grouped the way a viewer looks for them. Built from the same
 * tables the key map reads (WATCH_KEYS, VIEW_GROUPS), so the card cannot list a key that does nothing.
 */
export function keyHelp(): KeyHelpGroup[] {
  const watch = new Map(WATCH_KEYS.map((k) => [k.keys, k.label]));
  const pick = (...keys: string[]) => keys.map((k) => ({ keys: k, label: watch.get(k) ?? k }));
  return [
    { title: 'Playback', rows: pick('Space', '← →', '1-5', 'End') },
    { title: 'Fighters and camera', rows: pick('Tab', 'F', 'I', 'C', 'Esc') },
    ...VIEW_GROUPS.map((g) => ({ title: g.title, rows: g.items.flatMap((i) => (i.shortcut ? [{ keys: i.shortcut, label: i.label }] : [])) })),
    { title: 'Anywhere', rows: [{ keys: '?', label: 'Open the Codex' }] },
  ];
}

/**
 * Whether a dialog that owns the keyboard is showing (the Codex, Quick matchup, the Gym's import
 * dialog). A dialog inside a hidden screen does not count: the Gym's import dialog stays mounted
 * while the Gym tab is hidden, and must not swallow the Watch keys.
 */
export function modalOpen(root: { querySelectorAll(selector: string): Iterable<{ closest(selector: string): unknown }> }): boolean {
  for (const el of root.querySelectorAll('[aria-modal="true"]')) if (!el.closest('[hidden]')) return true;
  return false;
}

/** Whether a DOM event target is somewhere the user is typing. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
  const el = target as HTMLElement;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    // Range sliders and checkboxes do not take text; arrow keys on them should still adjust them.
    return type !== 'checkbox' && type !== 'radio' && type !== 'button';
  }
  return el.isContentEditable === true;
}
