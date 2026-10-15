// Owned by: integrator
/**
 * The local strategy library: every saved version of every strategy, persisted in localStorage.
 * Strategies pass the one gate (`loadStrategy`) on the way in and again when read back, so a
 * hand-edited or outdated entry can never reach a brain.
 */

import type { SavedOrigin, SavedStrategy, Strategy, StrategyStore } from '../core';
import { encodeStrategyCode, loadStrategy } from '../strategy';

export const STRATEGIES_STORAGE_KEY = 'pit-of-carnage/strategies';

export type KeyValueStore = { getItem(key: string): string | null; setItem(key: string, value: string): void };

/** localStorage when the browser allows it (private modes and sandboxes may refuse), else null. */
export function browserStorage(): KeyValueStore | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function isEntry(x: unknown): x is SavedStrategy {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Partial<SavedStrategy>;
  return typeof e.id === 'string' && typeof e.name === 'string' && typeof e.version === 'number' && typeof e.savedAt === 'number';
}

/** A stored origin, or null when missing or not one we know (entries saved before origins existed). */
function originOf(x: unknown): SavedOrigin | null {
  if (typeof x !== 'object' || x === null) return null;
  const o = x as { kind?: unknown; generation?: unknown };
  if (o.kind === 'editor' || o.kind === 'import' || o.kind === 'room') return { kind: o.kind };
  if (o.kind === 'evolution' && typeof o.generation === 'number' && Number.isFinite(o.generation)) return { kind: 'evolution', generation: o.generation };
  return null;
}

/** Read the stored library, keeping only entries whose strategy still validates. */
function load(storage: KeyValueStore | null): SavedStrategy[] {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(STRATEGIES_STORAGE_KEY) ?? null;
  } catch (err) {
    console.warn('Strategy library: could not read saved strategies.', err);
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('Strategy library: the saved library is not valid JSON and was ignored.');
    return [];
  }
  const out: SavedStrategy[] = [];
  let dropped = 0;
  for (const x of Array.isArray(parsed) ? parsed : []) {
    const result = isEntry(x) ? loadStrategy(x.strategy, 'saved') : null;
    if (!isEntry(x) || !result?.strategy) {
      dropped++;
      continue;
    }
    const strategy = { ...result.strategy, version: x.version };
    const parentId = typeof x.parentId === 'string' ? x.parentId : null;
    out.push({ id: x.id, name: x.name, version: x.version, savedAt: x.savedAt, strategy, code: encodeStrategyCode(strategy), parentId, origin: originOf(x.origin) });
  }
  if (dropped > 0) console.warn(`Strategy library: ${dropped} saved strateg${dropped === 1 ? 'y' : 'ies'} failed validation and were left out.`);
  return out;
}

export function createStrategyStore(storage: KeyValueStore | null, now: () => number = () => Date.now()): StrategyStore {
  const entries = load(storage);

  function persist(): void {
    try {
      storage?.setItem(STRATEGIES_STORAGE_KEY, JSON.stringify(entries));
    } catch (err) {
      console.warn('Strategy library: could not store strategies; they last until the page closes.', err);
    }
  }

  return {
    list: () => entries,

    save(s: Strategy, meta: { parentId?: string | null; origin?: SavedOrigin | null } = {}): SavedStrategy {
      const result = loadStrategy(s, 'saved');
      if (!result.strategy) {
        const first = result.errors[0];
        throw new Error(`Cannot save "${s.name}": ${first ? `${first.path || '(top level)'}: ${first.message}` : 'invalid strategy'}.`);
      }
      const name = result.strategy.name;
      const version = entries.reduce((v, e) => (e.name === name ? Math.max(v, e.version) : v), 0) + 1;
      const strategy = { ...result.strategy, version };
      const entry: SavedStrategy = {
        id: `${name}@v${version}`,
        name,
        version,
        savedAt: now(),
        strategy,
        code: encodeStrategyCode(strategy),
        parentId: meta.parentId ?? null,
        origin: meta.origin ?? null,
      };
      entries.push(entry);
      persist();
      return entry;
    },

    versions: (name) => entries.filter((e) => e.name === name).sort((a, b) => b.version - a.version),

    remove(id) {
      const i = entries.findIndex((e) => e.id === id);
      if (i < 0) return;
      entries.splice(i, 1);
      persist();
    },
  };
}
