import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VIEW_SETTINGS } from '../core';
import type { ViewSettings } from '../core';
import type { KeyValueStore } from './store';
import { VIEW_STORAGE_KEY, loadView, sanitizeView, saveView } from './view';

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

afterEach(() => vi.restoreAllMocks());

describe('view settings persistence', () => {
  // The View popover promises settings that stick: a reload must bring back exactly what was chosen.
  it('brings back every saved setting after a reload', () => {
    const storage = memory();
    const chosen: ViewSettings = {
      ...DEFAULT_VIEW_SETTINGS, damageNumbers: false, barks: 'off', cones: 'all', fog: false, hearing: false, shake: 'off', blood: 'light', volume: 0.25,
    };
    saveView(storage, chosen);
    expect(loadView(storage)).toEqual(chosen);
  });

  it('starts from the defaults when nothing was saved (fog on and carnage, as the user asked)', () => {
    const v = loadView(memory());
    expect(v).toEqual(DEFAULT_VIEW_SETTINGS);
    expect(v.fog).toBe(true);
    expect(v.blood).toBe('carnage');
  });

  // A stale or hand-edited entry must not reach the renderer: an unknown cone mode or a NaN volume
  // would break drawing or audio. Only the bad field falls back; the viewer keeps the rest.
  it('replaces only the invalid fields with defaults and drops unknown ones', () => {
    const storage = memory();
    storage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ cones: 'everyone', volume: 'loud', fog: 'yes', hpBars: false, blood: 'normal', extra: 1 }));
    const v = loadView(storage);
    expect(v.cones).toBe(DEFAULT_VIEW_SETTINGS.cones);
    expect(v.volume).toBe(DEFAULT_VIEW_SETTINGS.volume);
    expect(v.fog).toBe(DEFAULT_VIEW_SETTINGS.fog);
    expect(v.hpBars).toBe(false);
    expect(v.blood).toBe('normal');
    expect(Object.keys(v).sort()).toEqual(Object.keys(DEFAULT_VIEW_SETTINGS).sort());
  });

  it('clamps the volume into 0..1 and refuses non-finite numbers', () => {
    expect(sanitizeView({ volume: 3 }).volume).toBe(1);
    expect(sanitizeView({ volume: -1 }).volume).toBe(0);
    expect(sanitizeView({ volume: Number.NaN }).volume).toBe(DEFAULT_VIEW_SETTINGS.volume);
    expect(sanitizeView({ volume: Infinity }).volume).toBe(DEFAULT_VIEW_SETTINGS.volume);
  });

  // Private modes and sandboxes throw on storage access; the Watch screen must still start.
  it('falls back to the defaults when storage throws or holds broken JSON', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const throwing: KeyValueStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadView(throwing)).toEqual(DEFAULT_VIEW_SETTINGS);
    expect(() => saveView(throwing, { ...DEFAULT_VIEW_SETTINGS })).not.toThrow();
    const broken = memory();
    broken.setItem(VIEW_STORAGE_KEY, '{"fog": fal');
    expect(loadView(broken)).toEqual(DEFAULT_VIEW_SETTINGS);
    expect(loadView(null)).toEqual(DEFAULT_VIEW_SETTINGS);
  });
});
