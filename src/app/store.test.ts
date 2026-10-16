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

  // "Slurpy Hawk v4, evolved from v3, generation 140": origin and parent are separate from the
  // version number, survive a reload, and libraries saved before they existed still load.
  it('keeps each version’s parent and origin across a reload, null for older saves', () => {
    const storage = memory();
    const store = createStrategyStore(storage);
    const v1 = store.save({ ...gary, version: 140 }, { origin: { kind: 'import' } });
    const v2 = store.save(gary, { parentId: v1.id, origin: { kind: 'evolution', generation: 140 } });
    const plain = store.save(brenda);
    expect(v1.version).toBe(1); // the JSON's own version is never trusted
    expect([plain.parentId, plain.origin]).toEqual([null, null]);
    const again = createStrategyStore(storage).list();
    expect(again.find((e) => e.id === v2.id)).toMatchObject({ parentId: v1.id, origin: { kind: 'evolution', generation: 140 } });
    expect(again.find((e) => e.id === v1.id)).toMatchObject({ parentId: null, origin: { kind: 'import' } });

    const old = memory();
    old.data.set(STRATEGIES_STORAGE_KEY, JSON.stringify([{ ...v1, parentId: undefined, origin: { kind: 'teleporter' } }]));
    expect(createStrategyStore(old).list()[0]).toMatchObject({ id: v1.id, parentId: null, origin: null });
  });

  // The history panel reads "v3, from v2" and diffs each version against its parent. A copy under a
  // new name starts its own lineage: it must never claim "from v2" of a name it does not carry.
  it('records the parent version within a name and lists the history newest first with parents', () => {
    const storage = memory();
    const store = createStrategyStore(storage);
    const v1 = store.save(gary, { origin: { kind: 'house' } });
    const v2 = store.save(gary, { parentId: v1.id, origin: { kind: 'editor' } });
    const v3 = store.save(gary, { parentId: v2.id, origin: { kind: 'llm-paste' } });
    const copy = store.save({ ...gary, name: 'Gary Junior' }, { parentId: v2.id, origin: { kind: 'editor' } });
    expect([v1.parentVersion, v2.parentVersion, v3.parentVersion]).toEqual([null, 1, 2]);
    expect(copy.parentVersion).toBeNull();
    expect(copy.parentId).toBe(v2.id);

    const again = createStrategyStore(storage);
    const history = again.history(gary.name);
    expect(history.entries.map((e) => [e.saved.version, e.parent?.version ?? null])).toEqual([[3, 2], [2, 1], [1, null]]);
    expect(history.entries[0]!.saved.origin).toEqual({ kind: 'llm-paste' });
    expect(again.list().find((e) => e.id === v1.id)?.origin).toEqual({ kind: 'house' });
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

  // Reports and ratings key on name@vN: if deleting v3 let the next save be v3 again, the new
  // strategy would inherit the old one's rows. Numbers are never handed out twice, reload or not.
  it('never reuses a version number, even after that version was deleted', () => {
    const storage = memory();
    const store = createStrategyStore(storage);
    store.save(gary);
    store.save(gary);
    const v3 = store.save(gary);
    store.remove(v3.id);
    expect(store.save(gary).version).toBe(4);
    const again = createStrategyStore(storage);
    again.remove(`${gary.name}@v4`);
    expect(createStrategyStore(storage).save(gary).version).toBe(5);
    expect(createStrategyStore(storage).versions(gary.name).map((e) => e.version)).toEqual([5, 2, 1]);
    // The editor's "Save as vN" asks the same counter, so its label never promises a reused number.
    const last = createStrategyStore(storage);
    last.remove(`${gary.name}@v5`);
    expect(last.nextVersion(gary.name)).toBe(6);
    expect(last.nextVersion('Nobody Yet')).toBe(1);
  });

  // The migration rule: reading the library must never lose a saved strategy. An entry that fails
  // today's validation is hidden, but it stays in storage through later saves, so a build that
  // accepts it again (or a person fixing it by hand) gets it back.
  it('keeps entries that fail validation in storage through later saves', () => {
    const storage = memory();
    const store = createStrategyStore(storage);
    store.save(gary);
    store.save(brenda);
    const raw = JSON.parse(storage.data.get(STRATEGIES_STORAGE_KEY)!);
    const good = raw[1].strategy.behaviours;
    raw[1].strategy.behaviours = 'garbage';
    storage.data.set(STRATEGIES_STORAGE_KEY, JSON.stringify(raw));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hidden = createStrategyStore(storage);
    expect(hidden.list().map((e) => e.name)).toEqual([gary.name]);
    hidden.save(gary);
    const after = JSON.parse(storage.data.get(STRATEGIES_STORAGE_KEY)!) as { id: string; strategy: { behaviours: unknown } }[];
    const broken = after.find((e) => e.id === `${brenda.name}@v1`)!;
    expect(broken.strategy.behaviours).toBe('garbage');
    // Fixed again: it is back, and its number was never reused meanwhile.
    broken.strategy.behaviours = good;
    storage.data.set(STRATEGIES_STORAGE_KEY, JSON.stringify(after));
    const back = createStrategyStore(storage);
    expect(back.versions(brenda.name).map((e) => e.version)).toEqual([1]);
    expect(back.save(brenda).version).toBe(2);
  });

  it('keeps a library that is not valid JSON instead of overwriting it on the next save', () => {
    const storage = memory();
    storage.data.set(STRATEGIES_STORAGE_KEY, '{not json');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    createStrategyStore(storage).save(gary);
    expect(storage.data.get(STRATEGIES_STORAGE_KEY)).toContain('{not json');
    expect(createStrategyStore(storage).list().map((e) => e.name)).toEqual([gary.name]);
  });

  // Libraries written by older builds (or two tabs racing) can hold two different strategies under
  // one id. Both are kept: the later one becomes the next version of its name.
  it('renumbers a duplicate id from older data instead of dropping either strategy', () => {
    const storage = memory();
    const a = createStrategyStore(memory()).save(gary);
    const b = { ...a, savedAt: a.savedAt + 1, strategy: { ...a.strategy, commit: a.strategy.commit + 7 } };
    storage.data.set(STRATEGIES_STORAGE_KEY, JSON.stringify([a, b]));
    const store = createStrategyStore(storage);
    const listed = store.versions(gary.name);
    expect(listed.map((e) => e.id)).toEqual([`${gary.name}@v2`, `${gary.name}@v1`]);
    expect(listed[0]!.strategy.commit).toBe(a.strategy.commit + 7);
    expect(listed[0]!.strategy.version).toBe(2);
    // Written back, so every later reader agrees on the numbers.
    expect(createStrategyStore(storage).list().map((e) => e.id).sort()).toEqual([`${gary.name}@v1`, `${gary.name}@v2`]);
  });

  // Two tabs on one library: each save must land, under its own number.
  it('keeps saves from two tabs sharing one storage', () => {
    const storage = memory();
    const tabA = createStrategyStore(storage);
    const tabB = createStrategyStore(storage);
    const a = tabA.save(gary);
    const b = tabB.save(gary);
    tabA.save(brenda);
    expect([a.version, b.version]).toEqual([1, 2]);
    expect(createStrategyStore(storage).list().map((e) => e.id).sort()).toEqual([`${brenda.name}@v1`, `${gary.name}@v1`, `${gary.name}@v2`].sort());
    expect(tabB.versions(brenda.name)).toHaveLength(1);
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
