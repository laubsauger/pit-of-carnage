// Owned by: ui
// The View popover's model: every display setting with its control and keyboard shortcut. Pure data
// and functions, so the popover, the Watch key map and the tests all read the same list.
import { DEFAULT_VIEW_SETTINGS } from '../core';
import type { ViewSettings } from '../core';

export type ViewKey = keyof ViewSettings;
type BoolKey = { [K in ViewKey]: ViewSettings[K] extends boolean ? K : never }[ViewKey];
type ChoiceKey = { [K in ViewKey]: ViewSettings[K] extends string ? K : never }[ViewKey];

export type ViewChoice = { value: string; label: string };

/** One control in the popover. `shortcut` is the key that toggles (or cycles) it on the Watch screen. */
export type ViewItem =
  | { kind: 'toggle'; key: BoolKey; label: string; hint?: string; shortcut?: string }
  | { kind: 'choice'; key: ChoiceKey; label: string; options: readonly ViewChoice[]; shortcut?: string }
  | { kind: 'volume'; key: 'volume'; label: string; shortcut?: string };

export type ViewGroup = { title: string; items: readonly ViewItem[] };

/**
 * Shortcuts match the word the user expects (spec): H hearing ripples, B HP bars, O fog, T name
 * tags. The rest use the first free letter of the label: F is follow and C is kept for the camera,
 * so barks are A. Blood has no key: it is set once, not flipped mid-match.
 */
export const VIEW_GROUPS: readonly ViewGroup[] = [
  {
    title: 'Over the fighters',
    items: [
      { kind: 'toggle', key: 'nameTags', label: 'Name tags', shortcut: 'T' },
      { kind: 'toggle', key: 'hpBars', label: 'HP bars', shortcut: 'B' },
      { kind: 'toggle', key: 'damageNumbers', label: 'Damage numbers', shortcut: 'N' },
      {
        kind: 'choice', key: 'barks', label: 'Barks', shortcut: 'A',
        options: [{ value: 'off', label: 'Off' }, { value: 'key', label: 'Key moments' }, { value: 'all', label: 'All' }],
      },
      { kind: 'toggle', key: 'killStamps', label: 'Kill stamps', shortcut: 'K' },
    ],
  },
  {
    title: 'What they know',
    items: [
      {
        kind: 'choice', key: 'cones', label: 'Vision cones', shortcut: 'V',
        options: [{ value: 'off', label: 'Off' }, { value: 'selected', label: 'Selected' }, { value: 'all', label: 'All' }],
      },
      { kind: 'toggle', key: 'rings', label: 'Steering ring and target line', shortcut: 'R' },
      { kind: 'toggle', key: 'fog', label: 'Fog of war', hint: "The selected fighter's view", shortcut: 'O' },
      { kind: 'toggle', key: 'hearing', label: 'Hearing ripples', hint: 'Rough rings, never exact', shortcut: 'H' },
    ],
  },
  {
    title: 'Feel',
    items: [
      { kind: 'choice', key: 'shake', label: 'Screen shake', shortcut: 'S', options: [{ value: 'off', label: 'Off' }, { value: 'kills', label: 'On kills' }] },
      {
        kind: 'choice', key: 'blood', label: 'Blood',
        options: [{ value: 'light', label: 'Light' }, { value: 'normal', label: 'Normal' }, { value: 'carnage', label: 'Carnage' }],
      },
      { kind: 'volume', key: 'volume', label: 'Volume', shortcut: 'M' },
    ],
  },
];

export const VIEW_ITEMS: readonly ViewItem[] = VIEW_GROUPS.flatMap((g) => g.items);

/** The setting a key toggles, or null. Letters match either case. */
export function viewKeyForShortcut(key: string): ViewKey | null {
  if (key.length !== 1) return null;
  const k = key.toUpperCase();
  return VIEW_ITEMS.find((i) => i.shortcut === k)?.key ?? null;
}

/**
 * What one press of a setting's shortcut changes: switches flip, choices step to the next option
 * (wrapping round), and the volume key mutes, or unmutes back to `restoreVolume`.
 */
export function toggleView(view: ViewSettings, key: ViewKey, restoreVolume = DEFAULT_VIEW_SETTINGS.volume): Partial<ViewSettings> {
  const item = VIEW_ITEMS.find((i) => i.key === key);
  if (!item) return {};
  switch (item.kind) {
    case 'toggle':
      return { [item.key]: !view[item.key] };
    case 'choice': {
      const at = item.options.findIndex((o) => o.value === view[item.key]);
      return { [item.key]: item.options[(at + 1) % item.options.length].value } as Partial<ViewSettings>;
    }
    case 'volume':
      return { volume: view.volume > 0 ? 0 : restoreVolume > 0 ? restoreVolume : DEFAULT_VIEW_SETTINGS.volume };
  }
}

/** One line for the toast after a shortcut: "Fog of war: off", "Vision cones: all", "Volume: muted". */
export function describeView(view: ViewSettings, key: ViewKey): string {
  const item = VIEW_ITEMS.find((i) => i.key === key);
  if (!item) return key;
  switch (item.kind) {
    case 'toggle':
      return `${item.label}: ${view[item.key] ? 'on' : 'off'}`;
    case 'choice':
      return `${item.label}: ${(item.options.find((o) => o.value === view[item.key])?.label ?? String(view[item.key])).toLowerCase()}`;
    case 'volume':
      return view.volume > 0 ? `Volume: ${Math.round(view.volume * 100)}%` : 'Volume: muted';
  }
}
