import { describe, expect, it } from 'vitest';
import type { SavedStrategy, Strategy } from '../../core';
import { HOUSE_STACKS } from '../../strategy';
import { baseLine, changeBase, diffStrategies, diffSummary, draftBase, formatSavedAt, freeStrategyName, nextVersionOf, originLabel, savePlan, savedMessage, versionLine, withoutVersion } from './versions';

const gary = HOUSE_STACKS[0]!;

function saved(name: string, version: number, extra: Partial<SavedStrategy> = {}): SavedStrategy {
  return { id: `${name}@v${version}`, name, version, parentVersion: null, origin: null, savedAt: 0, code: '', strategy: { ...gary, name, version }, parentId: null, ...extra };
}

const lib = [saved('Slurpy Hawk', 1), saved('Slurpy Hawk', 2, { parentId: 'Slurpy Hawk@v1', parentVersion: 1 }), saved('Big Lad', 1)];
const next = (name: string) => lib.reduce((v, s) => (s.name === name ? Math.max(v, s.version) : v), 0) + 1;

describe('the draft base', () => {
  // The header says "based on v3": that must be the saved version the draft really came from.
  it('is the saved version with the draft’s own name and library number', () => {
    expect(draftBase({ name: 'Slurpy Hawk', version: 2 }, lib)?.id).toBe('Slurpy Hawk@v2');
    // A new fighter, an import or an LLM answer carries no number, so it has no base.
    expect(draftBase({ name: 'Slurpy Hawk' }, lib)).toBeNull();
    expect(draftBase({ name: 'Slurpy Hawk', version: 9 }, lib)).toBeNull();
    expect(draftBase(null, lib)).toBeNull();
  });
});

describe('what Save does', () => {
  it('saves the next version of the strategy it was loaded from, with that version as parent', () => {
    const plan = savePlan('Slurpy Hawk', lib[1]!, lib, next);
    expect(plan).toMatchObject({ kind: 'version', version: 3, parentId: 'Slurpy Hawk@v2', parentVersion: 2 });
  });

  // SPEC: "Name collisions ask". A different strategy saved under a taken name must never silently
  // become the next version of a lineage it did not come from.
  it('asks when the name belongs to a lineage the draft did not come from', () => {
    expect(savePlan('Slurpy Hawk', null, lib, next)).toMatchObject({ kind: 'collision', version: 3, suggestedName: 'Slurpy Hawk 2' });
    expect(savePlan('Slurpy Hawk', lib[2]!, lib, next).kind).toBe('collision');
  });

  it('starts a new strategy under a free name, remembering what it was copied from', () => {
    expect(savePlan('Fresh Meat', null, lib, next)).toMatchObject({ kind: 'first', version: 1, parentId: null });
    // Renamed from Big Lad v1: a new lineage (no "from v1"), but the copy source is kept.
    expect(savePlan('Small Lad', null, lib, next, lib[2]!)).toMatchObject({ kind: 'first', parentId: 'Big Lad@v1', parentVersion: null });
  });

  it('suggests a free name within the 40-character limit', () => {
    expect(freeStrategyName('Big Lad', ['Big Lad', 'Big Lad 2'])).toBe('Big Lad 3');
    expect(freeStrategyName('Big Lad 2', ['Big Lad', 'Big Lad 2'])).toBe('Big Lad 3');
    const long = 'X'.repeat(40);
    expect(freeStrategyName(long, [long]).length).toBeLessThanOrEqual(40);
  });

  // "Save as v4" must be the number the library will really give, deleted numbers included.
  it('asks the library for the next number when it knows about deleted versions', () => {
    const store = { list: () => lib, save: () => lib[0]!, versions: () => [], history: () => ({ name: '', entries: [] }), remove: () => {} };
    expect(nextVersionOf(store, lib, 'Slurpy Hawk')).toBe(3);
    expect(nextVersionOf({ ...store, nextVersion: () => 7 } as typeof store, lib, 'Slurpy Hawk')).toBe(7);
  });
});

describe('history lines', () => {
  it('says where a version came from, never mistaking a generation for a version', () => {
    const evolved = saved('Slurpy Hawk', 4, { parentVersion: 3, origin: { kind: 'evolution', generation: 140 } });
    expect(versionLine(evolved, null)).toBe('v4, from v3, evolved, generation 140');
    const copy = saved('Small Lad', 1, { parentId: 'Big Lad@v1', origin: { kind: 'editor' } });
    expect(versionLine(copy, lib[2]!)).toBe('v1, copied from Big Lad v1, edited');
    expect(originLabel({ kind: 'llm-paste' })).toBe('from an LLM');
    expect(originLabel(null)).toBe('saved');
  });

  it('states the base in the header, or that nothing is saved yet', () => {
    const at = new Date(2026, 9, 15, 17, 42).getTime();
    expect(baseLine('Slurpy Hawk', { ...lib[1]!, savedAt: at }, null, at + 60_000)).toBe('Editing Slurpy Hawk, based on v2 (saved 17:42)');
    expect(baseLine('Slurpy Hawk', null, { kind: 'llm-paste' }, at)).toMatch(/LLM.*not saved yet/);
    expect(baseLine(null, null, null, at)).toMatch(/not saved yet/);
  });

  it('shows the time today and the date before', () => {
    const now = new Date(2026, 9, 15, 20, 0).getTime();
    expect(formatSavedAt(new Date(2026, 9, 15, 9, 5).getTime(), now)).toBe('09:05');
    expect(formatSavedAt(new Date(2026, 9, 14, 9, 5).getTime(), now)).toBe('Oct 14, 09:05');
    expect(formatSavedAt(new Date(2025, 9, 14, 9, 5).getTime(), now)).toBe('Oct 14 2025');
  });
});

describe('what changed', () => {
  const base: Strategy = {
    ...gary,
    build: { ...gary.build, attributes: { ...gary.build.attributes } },
    behaviours: { a: { score: '1', move: [{ seek: 'target', weight: 1 }, { avoid: 'hazards', weight: 0.5 }], attack: 'in_range' }, b: { score: '0.2', move: [], attack: 'never' } },
  };

  // The panel answers "what did I change between v3 and v4?" in the words of the builder.
  it('spells out weights, attributes and behaviours added or removed', () => {
    const next: Strategy = {
      ...base,
      build: { ...base.build, attributes: { ...base.build.attributes, vitality: base.build.attributes.vitality + 4, power: base.build.attributes.power - 4 } },
      behaviours: { a: { ...base.behaviours.a!, move: [{ seek: 'target', weight: 1.5 }, { avoid: 'hazards', weight: 0.5 }] }, c: { score: '0', move: [], attack: 'never' } },
    };
    const d = diffStrategies(base, next);
    expect(d[0]).toMatch(/^vitality \d+ → \d+, power/);
    expect(d).toContain('+ behaviour c');
    expect(d).toContain('− behaviour b');
    expect(d).toContain('a: seek target weight 1 → 1.5');
  });

  it('notices reordering, which changes who wins a tie', () => {
    const swapped: Strategy = { ...base, behaviours: { b: base.behaviours.b!, a: base.behaviours.a! } };
    expect(diffStrategies(base, swapped)).toEqual(['behaviours reordered']);
    const terms: Strategy = { ...base, behaviours: { ...base.behaviours, a: { ...base.behaviours.a!, move: [...base.behaviours.a!.move].reverse() } } };
    expect(diffStrategies(base, terms)).toEqual(['a: moves reordered']);
  });

  it('ignores the version number, and summarises long lists', () => {
    expect(diffStrategies(base, { ...base, version: 9 })).toEqual([]);
    expect(diffSummary([])).toBe('no change in play');
    expect(diffSummary(['a', 'b', 'c', 'd', 'e'])).toBe('a; b; c; and 2 more');
  });
});

describe('saving and opening', () => {
  it('confirms what was saved and where it came from', () => {
    expect(savedMessage({ name: 'Slurpy Hawk', version: 4, parentVersion: 3 })).toBe('Saved as Slurpy Hawk v4 (from v3).');
    expect(savedMessage({ name: 'Fresh', version: 1, parentVersion: null })).toBe('Saved as Fresh v1.');
  });

  // "Never trusted on import": an imported v140 must not pose as the library's v140.
  it('drops an imported version so the draft has no base until it is saved', () => {
    const opened = withoutVersion({ ...gary, name: 'Slurpy Hawk', version: 2 });
    expect('version' in opened).toBe(false);
    expect(draftBase(opened, lib)).toBeNull();
  });

  it('diffs a history row against its parent, else the next older version', () => {
    const v1 = lib[0]!;
    const v2 = lib[1]!;
    const v3 = saved('Slurpy Hawk', 3);
    const rows = [{ saved: v3, parent: null }, { saved: v2, parent: v1 }, { saved: v1, parent: null }];
    expect(changeBase(rows, 0)).toBe(v2);
    expect(changeBase(rows, 1)).toBe(v1);
    expect(changeBase(rows, 2)).toBeNull();
  });
});
