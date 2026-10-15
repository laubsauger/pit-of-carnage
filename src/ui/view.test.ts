import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW_SETTINGS } from '../core';
import type { ViewSettings } from '../core';
import { keyToAction } from './keys';
import { VIEW_ITEMS, describeView, toggleView, viewKeyForShortcut } from './view';

const view = (patch: Partial<ViewSettings> = {}): ViewSettings => ({ ...DEFAULT_VIEW_SETTINGS, ...patch });

describe('View popover model', () => {
  it('has exactly one control for every display setting, so a new setting cannot be left out of the popover', () => {
    const keys = VIEW_ITEMS.map((i) => i.key).sort();
    expect(keys).toEqual(Object.keys(DEFAULT_VIEW_SETTINGS).sort());
  });

  it('offers the default value of every choice, so the popover never opens with nothing selected', () => {
    for (const item of VIEW_ITEMS) {
      if (item.kind === 'choice') expect(item.options.map((o) => o.value)).toContain(DEFAULT_VIEW_SETTINGS[item.key]);
    }
  });

  it('gives every shortcut its own key, clear of the Watch bindings (follow, pause, steps, speeds, End)', () => {
    const shortcuts = VIEW_ITEMS.flatMap((i) => (i.shortcut ? [i.shortcut] : []));
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
    for (const s of shortcuts) {
      expect(s).toMatch(/^[A-Z]$/);
      // C is kept free for "Reset camera".
      expect(['F', 'C']).not.toContain(s);
    }
  });

  // The user asked for these by name: pressing H and getting HP bars instead of hearing read as a bug.
  it('binds the letters the user expects: H hearing, B HP bars, O fog, T name tags', () => {
    expect(viewKeyForShortcut('h')).toBe('hearing');
    expect(viewKeyForShortcut('b')).toBe('hpBars');
    expect(viewKeyForShortcut('o')).toBe('fog');
    expect(viewKeyForShortcut('t')).toBe('nameTags');
  });

  it('routes each shortcut letter to its setting in either case', () => {
    for (const item of VIEW_ITEMS) {
      if (!item.shortcut) continue;
      expect(viewKeyForShortcut(item.shortcut)).toBe(item.key);
      expect(viewKeyForShortcut(item.shortcut.toLowerCase())).toBe(item.key);
      expect(keyToAction({ key: item.shortcut.toLowerCase(), shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, editable: false })).toEqual({
        type: 'view',
        key: item.key,
      });
    }
    expect(viewKeyForShortcut('End')).toBeNull();
  });
});

describe('toggleView', () => {
  it('flips switches', () => {
    expect(toggleView(view({ fog: true }), 'fog')).toEqual({ fog: false });
    expect(toggleView(view({ nameTags: false }), 'nameTags')).toEqual({ nameTags: true });
  });

  it('steps through every choice and wraps round, so one key reaches every mode', () => {
    let v = view({ cones: 'off' });
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      v = { ...v, ...toggleView(v, 'cones') };
      seen.push(v.cones);
    }
    expect(seen).toEqual(['selected', 'all', 'off']);
    expect(toggleView(view({ shake: 'kills' }), 'shake')).toEqual({ shake: 'off' });
  });

  it('mutes, then brings back the volume the player had rather than a default', () => {
    expect(toggleView(view({ volume: 0.4 }), 'volume')).toEqual({ volume: 0 });
    expect(toggleView(view({ volume: 0 }), 'volume', 0.4)).toEqual({ volume: 0.4 });
    expect(toggleView(view({ volume: 0 }), 'volume', 0)).toEqual({ volume: DEFAULT_VIEW_SETTINGS.volume });
  });

  it('says what changed in plain words for the confirmation toast', () => {
    expect(describeView(view({ fog: false }), 'fog')).toBe('Fog of war: off');
    expect(describeView(view({ barks: 'key' }), 'barks')).toBe('Barks: key moments');
    expect(describeView(view({ volume: 0 }), 'volume')).toBe('Volume: muted');
  });
});
