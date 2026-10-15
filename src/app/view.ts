// Owned by: integrator
/**
 * The viewer's display settings (`ViewSettings`), persisted in localStorage. Every field is checked
 * on the way in: a missing, stale or hand-edited entry falls back to its default field by field, so
 * one bad value never resets the rest and never reaches the renderer, fx or audio.
 */

import { DEFAULT_VIEW_SETTINGS } from '../core';
import type { ViewSettings } from '../core';
import type { KeyValueStore } from './store';

export const VIEW_STORAGE_KEY = 'pit-of-carnage/view';

type ChoiceKey = 'barks' | 'cones' | 'shake' | 'blood';

/** Allowed values of each choice setting (the types in core/render-api.ts). */
const CHOICES: { readonly [K in ChoiceKey]: readonly ViewSettings[K][] } = {
  barks: ['off', 'key', 'all'],
  cones: ['off', 'selected', 'all'],
  shake: ['off', 'kills'],
  blood: ['light', 'normal', 'carnage'],
};

/** A complete, valid ViewSettings from anything: known fields that check out, defaults for the rest. */
export function sanitizeView(raw: unknown): ViewSettings {
  const out: ViewSettings = { ...DEFAULT_VIEW_SETTINGS };
  if (typeof raw !== 'object' || raw === null) return out;
  const v = raw as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_VIEW_SETTINGS) as (keyof ViewSettings)[]) {
    const x = v[key];
    if (key === 'volume') {
      if (typeof x === 'number' && Number.isFinite(x)) out.volume = Math.min(Math.max(x, 0), 1);
    } else if (key in CHOICES) {
      const k = key as ChoiceKey;
      if ((CHOICES[k] as readonly unknown[]).includes(x)) (out as Record<ChoiceKey, unknown>)[k] = x;
    } else if (typeof x === 'boolean') {
      (out as Record<string, unknown>)[key] = x;
    }
  }
  return out;
}

/** The saved settings, or the defaults when there are none or storage refuses (private mode). */
export function loadView(storage: KeyValueStore | null): ViewSettings {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(VIEW_STORAGE_KEY) ?? null;
  } catch (err) {
    console.warn('View settings: could not read saved settings.', err);
  }
  if (!raw) return { ...DEFAULT_VIEW_SETTINGS };
  try {
    return sanitizeView(JSON.parse(raw));
  } catch {
    console.warn('View settings: the saved settings are not valid JSON and were ignored.');
    return { ...DEFAULT_VIEW_SETTINGS };
  }
}

export function saveView(storage: KeyValueStore | null, view: ViewSettings): void {
  try {
    storage?.setItem(VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch (err) {
    console.warn('View settings: could not store settings; they last until the page closes.', err);
  }
}
