// Owned by: integrator
/**
 * The local strategy library: every saved version of every strategy, persisted in localStorage.
 * Strategies pass the one gate (`loadStrategy`) on the way in and again when read back, so a
 * hand-edited or outdated entry can never reach a brain.
 *
 * Version numbers belong to the library (SPEC "Versions and the library"): per name, monotonic,
 * assigned on save. Monotonic means a number is never handed out twice, not even after its version
 * was deleted: reports and ratings key on `name@vN`, so a reused number would pour a new strategy's
 * results into an old row. The highest number ever given per name is kept next to the library.
 *
 * Nothing saved is ever lost by reading it: an entry that no longer validates (a rule changed, a
 * hand edit) is left out of the list but written back untouched, so a later build that accepts it
 * again still has it. Every write first re-reads storage, so two tabs saving in turn both keep
 * their saves instead of the last one overwriting the other's.
 */

import type { SavedOrigin, SavedStrategy, Strategy, StrategyHistory, StrategyStore } from '../core';
import { encodeStrategyCode, loadStrategy } from '../strategy';

export const STRATEGIES_STORAGE_KEY = 'pit-of-carnage/strategies';
/** Highest version number ever assigned per name: `{ "Slurpy Hawk": 4 }`. */
export const STRATEGY_NUMBERS_KEY = 'pit-of-carnage/strategy-numbers';

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
  return typeof e.id === 'string' && typeof e.name === 'string' && typeof e.version === 'number' && Number.isInteger(e.version) && e.version > 0 && typeof e.savedAt === 'number';
}

/** A stored origin, or null when missing or not one we know (entries saved before origins existed). */
function originOf(x: unknown): SavedOrigin | null {
  if (typeof x !== 'object' || x === null) return null;
  const o = x as { kind?: unknown; generation?: unknown };
  if (o.kind === 'editor' || o.kind === 'llm-paste' || o.kind === 'import' || o.kind === 'room' || o.kind === 'house') return { kind: o.kind };
  if (o.kind === 'evolution' && typeof o.generation === 'number' && Number.isFinite(o.generation)) return { kind: 'evolution', generation: o.generation };
  return null;
}

/**
 * The parent's version number when the parent (`parentId`) is a version of the same name; null for a
 * new lineage, a copy from another name, or a parent no longer in the library.
 */
function parentVersionOf(entries: readonly SavedStrategy[], name: string, parentId: string | null): number | null {
  const parent = parentId === null ? undefined : entries.find((e) => e.id === parentId);
  return parent && parent.name === name ? parent.version : null;
}

/** Name and version of a stored item that is entry-shaped, even when its strategy no longer validates. */
function numbered(x: unknown): { name: string; version: number } | null {
  if (typeof x !== 'object' || x === null) return null;
  const e = x as { name?: unknown; version?: unknown };
  return typeof e.name === 'string' && typeof e.version === 'number' && Number.isInteger(e.version) && e.version > 0 ? { name: e.name, version: e.version } : null;
}

type Library = {
  entries: SavedStrategy[];
  /** Stored items that are not valid entries today, written back untouched on every save. */
  kept: unknown[];
  /** Highest version ever assigned per name (at least the highest stored). */
  numbers: Map<string, number>;
  /** Reading renumbered something (duplicate ids from older builds or two tabs): write it back. */
  migrated: boolean;
};

function readRaw(storage: KeyValueStore | null, key: string): { ok: boolean; raw: string | null } {
  try {
    return { ok: true, raw: storage?.getItem(key) ?? null };
  } catch (err) {
    console.warn('Strategy library: could not read saved strategies.', err);
    return { ok: false, raw: null };
  }
}

function readNumbers(storage: KeyValueStore | null): Map<string, number> {
  const out = new Map<string, number>();
  const { raw } = readRaw(storage, STRATEGY_NUMBERS_KEY);
  if (!raw) return out;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      for (const [name, n] of Object.entries(parsed)) if (typeof n === 'number' && Number.isInteger(n) && n > 0) out.set(name, n);
    }
  } catch {
    // A broken counter only loses the memory of deleted numbers; the library itself still counts.
  }
  return out;
}

/** Parse the stored library. Valid entries are listed, everything else is kept for writing back. */
function parseLibrary(raw: string | null, numbers: Map<string, number>): Library {
  const lib: Library = { entries: [], kept: [], numbers, migrated: false };
  if (!raw) return lib;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not ours to overwrite blindly: keep the text as one opaque item so it is written back.
    console.warn('Strategy library: the saved library is not valid JSON; it is kept as it is and left out.');
    lib.kept.push({ unreadable: raw });
    return lib;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const bump = (name: string, v: number) => numbers.set(name, Math.max(numbers.get(name) ?? 0, v));
  for (const x of items) {
    const n = numbered(x);
    if (n) bump(n.name, n.version);
  }
  const ids = new Set<string>();
  let dropped = 0;
  for (const x of items) {
    const result = isEntry(x) ? loadStrategy(x.strategy, 'saved') : null;
    if (!isEntry(x) || !result?.strategy) {
      dropped++;
      lib.kept.push(x);
      continue;
    }
    let { id, version } = x;
    if (ids.has(id)) {
      // Two different saves under one id (an older build, or two tabs saving at once): the later one
      // becomes the next version of its name rather than disappearing.
      version = (numbers.get(x.name) ?? 0) + 1;
      bump(x.name, version);
      id = `${x.name}@v${version}`;
      lib.migrated = true;
    }
    ids.add(id);
    const strategy = { ...result.strategy, version };
    const parentId = typeof x.parentId === 'string' ? x.parentId : null;
    // A stored parentVersion is trusted only when it is a plain number (resolved again below when missing).
    const parentVersion = typeof x.parentVersion === 'number' && Number.isFinite(x.parentVersion) ? x.parentVersion : null;
    lib.entries.push({ id, name: x.name, version, savedAt: x.savedAt, strategy, code: encodeStrategyCode(strategy), parentId, parentVersion, origin: originOf(x.origin) });
  }
  // Older saves recorded only the parent's id: work out its version where it is still in the library.
  for (const e of lib.entries) if (e.parentVersion === null) e.parentVersion = parentVersionOf(lib.entries, e.name, e.parentId);
  if (dropped > 0) console.warn(`Strategy library: ${dropped} saved strateg${dropped === 1 ? 'y' : 'ies'} failed validation and were left out (kept in storage).`);
  return lib;
}

/** The library as the app builds it (the `StrategyStore` contract; `nextVersion` counts deleted numbers too). */
export type LibraryStore = StrategyStore;

export function createStrategyStore(storage: KeyValueStore | null, now: () => number = () => Date.now()): LibraryStore {
  const first = readRaw(storage, STRATEGIES_STORAGE_KEY);
  const lib = parseLibrary(first.raw, readNumbers(storage));
  const entries = lib.entries;
  let kept = lib.kept;
  const numbers = lib.numbers;
  // The stored text this store last read or wrote; storage differing from it means another tab wrote.
  let lastRaw: string | null = first.ok ? first.raw : null;
  if (lib.migrated) persist();

  function persist(): void {
    const raw = JSON.stringify([...kept, ...entries]);
    try {
      storage?.setItem(STRATEGIES_STORAGE_KEY, raw);
      storage?.setItem(STRATEGY_NUMBERS_KEY, JSON.stringify(Object.fromEntries(numbers)));
      lastRaw = raw;
    } catch (err) {
      console.warn('Strategy library: could not store strategies; they last until the page closes.', err);
    }
  }

  /** Pick up what another tab saved since this store last looked. */
  function sync(): void {
    const now = readRaw(storage, STRATEGIES_STORAGE_KEY);
    if (!now.ok || now.raw === lastRaw) return;
    const fresh = parseLibrary(now.raw, readNumbers(storage));
    for (const [name, n] of numbers) fresh.numbers.set(name, Math.max(fresh.numbers.get(name) ?? 0, n));
    entries.splice(0, entries.length, ...fresh.entries);
    kept = fresh.kept;
    numbers.clear();
    for (const [name, n] of fresh.numbers) numbers.set(name, n);
    lastRaw = now.raw;
    if (fresh.migrated) persist();
  }

  const versionsOf = (name: string) => entries.filter((e) => e.name === name).sort((a, b) => b.version - a.version);
  const nextVersion = (name: string) => entries.reduce((v, e) => (e.name === name ? Math.max(v, e.version) : v), numbers.get(name) ?? 0) + 1;

  return {
    list: () => {
      sync();
      return entries;
    },

    save(s: Strategy, meta: { parentId?: string | null; origin?: SavedOrigin | null } = {}): SavedStrategy {
      const result = loadStrategy(s, 'saved');
      if (!result.strategy) {
        const first = result.errors[0];
        throw new Error(`Cannot save "${s.name}": ${first ? `${first.path || '(top level)'}: ${first.message}` : 'invalid strategy'}.`);
      }
      sync();
      const name = result.strategy.name;
      const version = nextVersion(name);
      numbers.set(name, version);
      const strategy = { ...result.strategy, version };
      const entry: SavedStrategy = {
        id: `${name}@v${version}`,
        name,
        version,
        savedAt: now(),
        strategy,
        code: encodeStrategyCode(strategy),
        parentId: meta.parentId ?? null,
        parentVersion: parentVersionOf(entries, name, meta.parentId ?? null),
        origin: meta.origin ?? null,
      };
      entries.push(entry);
      persist();
      return entry;
    },

    nextVersion: (name) => {
      sync();
      return nextVersion(name);
    },

    versions: (name) => {
      sync();
      return versionsOf(name);
    },

    history: (name): StrategyHistory => {
      sync();
      return {
        name,
        entries: versionsOf(name).map((saved) => ({ saved, parent: (saved.parentId !== null && entries.find((e) => e.id === saved.parentId)) || null })),
      };
    },

    remove(id) {
      sync();
      const i = entries.findIndex((e) => e.id === id);
      if (i < 0) return;
      entries.splice(i, 1);
      persist();
    },
  };
}
