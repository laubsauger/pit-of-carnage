// Owned by: ui
// Watch-screen keyboard map as a pure function, so the bindings are testable without a DOM.
import { THINK_EVERY_TICKS, TICK_HZ } from '../core';

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
  | { type: 'deselect' };

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
  }
  const digit = e.key.length === 1 ? e.key.charCodeAt(0) - 48 : -1;
  if (digit >= 1 && digit <= SPEED_PRESETS.length) return { type: 'speed', speed: SPEED_PRESETS[digit - 1] };
  return null;
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
