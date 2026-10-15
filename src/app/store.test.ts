import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Strategy } from '../core';
import { HOUSE_STACKS, decodeStrategyCode } from '../strategy';
import { STRATEGIES_STORAGE_KEY, createStrategyStore } from './store';
import type { KeyValueStore } from './store';

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const gary = HOUSE_STACKS[0]!;
const brenda = HOUSE_STACKS[1]!;

afterEach(() => vi.restoreAllMocks());

describe('strategy store', () => {
  // Reports key on name@vN: two saves of the same name must never share a version.
  it('saves each save of a name as the next version and stamps it on the strategy', () => {
    const store = createStrategyStore(memory());
    const a = store.save(gary);
    const b = store.save({ ...gary, commit: gary.commit + 6 });
    store.save(brenda);
    expect([a.version, b.version]).toEqual([1, 2]);
    expect(b.strategy.version).toBe(2);
    expect(b.id).not.toBe(a.id);
    expect(store.versions(gary.name).map((e) => e.version)).toEqual([2, 1]);
  });

  it('survives a reload: a new store on the same storage lists the same library', () => {
    const storage = memory();
    const first = createStrategyStore(storage);
    first.save(gary);
    first.save(gary);
    const again = createStrategyStore(storage);
    expect(again.list().map((e) => e.id)).toEqual(first.list().map((e) => e.id));
    expect(again.save(gary).version).toBe(3);
  });

  it('gives every entry a strategy code that decodes back to the saved version', () => {
    const entry = createStrategyStore(memory()).save(gary);
    const decoded = decodeStrategyCode(entry.code);
    expect(decoded.ok).toBe(true);
    expect(decoded.strategy?.version).toBe(entry.version);
  });

  it('removes a version and keeps it removed after a reload', () => {
    const storage = memory();
    const store = createStrategyStore(storage);
    const a = store.save(gary);
    store.save(gary);
    store.remove(a.id);
    expect(createStrategyStore(storage).versions(gary.name).map((e) => e.version)).toEqual([2]);
  });

  // The one-gate rule: nothing invalid gets into the library, from the editor or from storage.
  it('refuses to save an invalid strategy', () => {
    const store = createStrategyStore(memory());
    expect(() => store.save({ ...gary, target: 'it.nope' } as Strategy)).toThrow(/Apologetic Gary/);
    expect(store.list()).toHaveLength(0);
  });

  it('leaves out stored entries that no longer validate, and says so', () => {
    const storage = memory();
    const store = createStrategyStore(storage);
    store.save(gary);
    store.save(brenda);
    const raw = JSON.parse(storage.data.get(STRATEGIES_STORAGE_KEY)!);
    raw[1].strategy.behaviours = 'garbage';
    storage.data.set(STRATEGIES_STORAGE_KEY, JSON.stringify(raw));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(createStrategyStore(storage).list().map((e) => e.name)).toEqual([gary.name]);
    expect(warn).toHaveBeenCalled();
  });

  it('starts empty instead of crashing on a corrupt library', () => {
    const storage = memory();
    storage.data.set(STRATEGIES_STORAGE_KEY, '{not json');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(createStrategyStore(storage).list()).toEqual([]);
  });

  // Private mode or a full quota must not break saving; the library just does not outlive the page.
  it('keeps working in memory when storage throws', () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createStrategyStore(broken);
    expect(store.save(gary).version).toBe(1);
    expect(store.list()).toHaveLength(1);
  });
});
