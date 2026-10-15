import { describe, expect, it } from 'vitest';
import { Rng } from '../core';
import type { Strategy, ValidationIssue } from '../core';
import { fakeWorld, fighter, view } from '../brain/test-world';
import { encodeStrategyCode } from './code';
import { HOUSE_STACKS } from './house';
import { formatJson } from './rulebook';
import { InvalidStrategyError, MAX_STRATEGY_TEXT, gatedBrainFactory, headlessBrainFactory, loadStrategy, requireValidStrategy } from './load';

const gary = HOUSE_STACKS[0]!;

/** Line and column of the first occurrence of `needle` in `text` (1-based), plus `extra` columns. */
function where(text: string, needle: string, extra = 0): { line: number; column: number } {
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`no ${needle}`);
  const before = text.slice(0, i).split('\n');
  return { line: before.length, column: before.at(-1)!.length + 1 + extra };
}

function only(issues: ValidationIssue[]): ValidationIssue {
  expect(issues).toHaveLength(1);
  return issues[0]!;
}

describe('loadStrategy: one gate for every source', () => {
  it('accepts JSON text, a parsed value and a strategy code alike, with the same result', () => {
    const text = loadStrategy(JSON.stringify(gary), 'file');
    const value = loadStrategy(gary, 'saved');
    const code = loadStrategy(encodeStrategyCode(gary), 'paste');
    expect(text.errors).toEqual([]);
    expect(text.strategy).toEqual(gary);
    expect(value.strategy).toEqual(gary);
    expect(code.strategy).toEqual(gary);
  });

  // Editors use "$schema" to find the published schema; it must not count as an unknown field.
  it('accepts "$schema" for editors and drops it from the strategy', () => {
    const r = loadStrategy({ $schema: '/pit-strategy-2.schema.json', ...gary }, 'file');
    expect(r.errors).toEqual([]);
    expect(r.strategy).not.toHaveProperty('$schema');
  });

  it('never throws, whatever it is given', () => {
    const weird: unknown[] = [undefined, null, 0, NaN, true, 'x', '', '{', '[]', [], {}, () => 1, Symbol('s'), 10n, new Map(), Object.create(null)];
    const hostile = { get name(): string { throw new Error('boom'); } };
    for (const w of [...weird, hostile]) {
      const r = loadStrategy(w, 'paste');
      expect(r.strategy).toBeUndefined();
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it('refuses text past the size limit before reading it', () => {
    const r = loadStrategy(' '.repeat(MAX_STRATEGY_TEXT + 1), 'paste');
    expect(only(r.errors).message).toMatch(/at most 65536/);
  });
});

describe('loadStrategy: issues point at the text', () => {
  const text = formatJson(gary);

  it('reports invalid JSON with line, column and the likely fix', () => {
    const broken = `${text.slice(0, -1)},\n}`;
    const e = only(loadStrategy(broken, 'paste').errors);
    expect(e.path).toBe('');
    const last = broken.split('\n').length;
    expect(e.message).toBe(`Invalid JSON at line ${last}, column 1: trailing comma before "}"; remove it.`);
    // Points at the closing brace right after the stray comma.
    expect({ line: e.line, column: e.column }).toEqual({ line: last, column: 1 });
    const single = only(loadStrategy("{'schema': 'pit-strategy/2'}", 'paste').errors);
    expect(single).toMatchObject({ line: 1, column: 2 });
    expect(single.message).toMatch(/double quotes/);
    expect(only(loadStrategy('{\n  // my strategy\n}', 'paste').errors)).toMatchObject({ line: 2, column: 3, message: expect.stringMatching(/no comments/) });
  });

  // JSON.parse keeps only the last of two same-named keys, so a second "lurk" would silently
  // replace the first. The gate refuses that and points at the second one.
  it('refuses duplicate keys at the second key', () => {
    const doubled = text.replace('"wade_in": {', '"loiter": {');
    const r = loadStrategy(doubled, 'file');
    const dup = r.errors.find((e) => e.message.startsWith('Duplicate key "loiter"'))!;
    expect(dup.path).toBe('behaviours.loiter');
    const second = doubled.indexOf('"loiter"', doubled.indexOf('"loiter"') + 1);
    const lines = doubled.slice(0, second).split('\n');
    expect({ line: dup.line, column: dup.column }).toEqual({ line: lines.length, column: lines.at(-1)!.length + 1 });
    expect(r.strategy).toBeUndefined();
  });

  it('points an unknown field at its key, with "did you mean"', () => {
    const typo = text.replace('"commit": 30', '"comit": 30');
    const e = loadStrategy(typo, 'file').errors.find((x) => x.path === 'comit')!;
    expect(e.suggestion).toBe('commit');
    expect({ line: e.line, column: e.column }).toEqual(where(typo, '"comit"'));
  });

  it('points an expression error at the exact character inside the string', () => {
    const bad = text.replace('it.fighting + 200', 'it.fihgting + 200');
    const e = only(loadStrategy(bad, 'file').errors);
    expect(e.path).toBe('target');
    expect(e.suggestion).toBe('it.fighting');
    expect({ line: e.line, column: e.column }).toEqual(where(bad, 'it.fihgting'));
  });

  it('points a missing field at the object that lacks it', () => {
    const s = structuredClone(gary) as unknown as Record<string, Record<string, unknown>>;
    delete (s.build!.attributes as Record<string, unknown>).haste;
    const t = formatJson(s);
    const e = loadStrategy(t, 'file').errors.find((x) => x.path === 'build.attributes.haste')!;
    expect({ line: e.line, column: e.column }).toEqual(where(t, '{"vitality"'));
  });

  it('points a static analysis finding at its operator', () => {
    const s: Strategy = structuredClone(gary);
    s.behaviours.finish!.score = '0.5 / enemies_near';
    const t = formatJson(s);
    const e = only(loadStrategy(t, 'file').errors);
    expect(e.message).toMatch(/can be 0/);
    expect({ line: e.line, column: e.column }).toEqual(where(t, '0.5 / enemies_near', 4));
  });

  // The LLM loop: the prompt asks for a ```json block, and players paste the whole answer.
  it('reads the JSON out of a pasted LLM answer, keeping lines and columns of the whole text', () => {
    const answer = `Here you go:\n\n\`\`\`json\n${text.replace('"commit": 30', '"comit": 30')}\n\`\`\`\n\nI made it braver.`;
    const r = loadStrategy(answer, 'paste');
    const e = r.errors.find((x) => x.path === 'comit')!;
    expect({ line: e.line, column: e.column }).toEqual(where(answer, '"comit"'));
    expect(loadStrategy(`Sure:\n\`\`\`json\n${text}\n\`\`\``, 'paste').strategy).toEqual(gary);
  });

  it('gives issues no position when there was no text', () => {
    const s = { ...gary, comit: 1 };
    const e = loadStrategy(s, 'saved').errors[0]!;
    expect(e.line).toBeUndefined();
    const fromCode = loadStrategy(encodeStrategyCode({ ...gary, target: 'it.nope' }), 'code').errors[0]!;
    expect(fromCode.path).toBe('target');
    expect(fromCode.line).toBeUndefined();
  });
});

describe('the gate in front of brains', () => {
  it('requireValidStrategy throws a named error carrying the full report', () => {
    const bad = { ...gary, target: 'it.distnce' } as Strategy;
    let err: unknown;
    try {
      requireValidStrategy(bad, 'test');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidStrategyError);
    expect((err as InvalidStrategyError).name).toBe('InvalidStrategyError');
    expect((err as InvalidStrategyError).message).toMatch(/^Apologetic Gary failed validation: target:/);
    expect((err as InvalidStrategyError).report.errors[0]!.suggestion).toBe('it.distance');
  });

  // Both factories are what the sim gets: neither may let an unchecked strategy through.
  it('both brain factories gate, and the headless one skips only the inspector data', () => {
    const bad = { ...gary, build: { ...gary.build, attributes: { ...gary.build.attributes, power: 40 } } };
    expect(() => gatedBrainFactory(bad)).toThrow(InvalidStrategyError);
    expect(() => headlessBrainFactory(bad)).toThrow(InvalidStrategyError);
    const v = view(fighter({ weapon: gary.build.weapon, attributes: gary.build.attributes }), [], fakeWorld());
    const full = gatedBrainFactory(gary).think(v, new Rng(1));
    const lean = headlessBrainFactory(gary).think(v, new Rng(1));
    expect(lean.behaviour).toBe(full.behaviour);
    expect(Object.keys(full.sensors).length).toBeGreaterThan(50);
    expect(lean.sensors).toEqual({});
  });
});
