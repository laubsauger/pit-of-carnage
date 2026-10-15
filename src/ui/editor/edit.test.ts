import { describe, expect, it } from 'vitest';
import type { Strategy } from '../../core';
import { HOUSE_STACKS, loadStrategy } from '../../strategy';
import { prettyJson } from '../editor';
import { renameKey, renameMemory, setAt } from './edit';

const base = HOUSE_STACKS.find((s) => s.memory && Object.keys(s.memory).length) ?? HOUSE_STACKS[0]!;
// A hand-formatted draft: the builder must keep this formatting wherever it does not edit.
const text = prettyJson(base).replace('"schema": "pit-strategy/2",', '"schema":    "pit-strategy/2",   ');

function changedLines(a: string, b: string): number {
  const x = a.split('\n');
  const y = b.split('\n');
  let n = Math.abs(x.length - y.length);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) n++;
  return n;
}

describe('setAt', () => {
  it('replaces just the value it changes and leaves every other character alone', () => {
    const out = setAt(text, ['build', 'weapon'], 'LONGBOW');
    expect(JSON.parse(out).build.weapon).toBe('LONGBOW');
    expect(out.replace('"LONGBOW"', JSON.stringify(base.build.weapon))).toBe(text);
  });

  it('changes a number inside a one-line move term without reformatting the line', () => {
    const [name, b] = Object.entries(base.behaviours)[0]!;
    const out = setAt(text, ['behaviours', name, 'move', 0, 'weight'], 2.5);
    expect((JSON.parse(out) as Strategy).behaviours[name]!.move[0]!.weight).toBe(2.5);
    expect(changedLines(text, out)).toBe(1);
    expect(b.move[0]!.weight).not.toBe(2.5);
  });

  it('adds a missing member by rewriting only the object that holds it', () => {
    const out = setAt(text, ['look', 'glyph'], 'G');
    expect(JSON.parse(out).look).toEqual({ ...(base.look ?? {}), glyph: 'G' });
    expect(out).toContain('"schema":    "pit-strategy/2",   ');
    expect(loadStrategy(out, 'editor').errors).toEqual([]);
  });

  it('removes a member when the value is undefined', () => {
    const [name, b] = Object.entries(base.behaviours).find(([, x]) => x.skill) ?? Object.entries(base.behaviours)[0]!;
    const withSkill = b.skill ? text : setAt(text, ['behaviours', name, 'skill'], 'target.distance < 90');
    const out = setAt(withSkill, ['behaviours', name, 'skill'], undefined);
    expect((JSON.parse(out) as Strategy).behaviours[name]!.skill).toBeUndefined();
    expect(out).toContain('"schema":    "pit-strategy/2",   ');
  });

  it('removes a list item and keeps the rest of the list in order', () => {
    const [name, b] = Object.entries(base.behaviours).find(([, x]) => x.move.length >= 2)!;
    const out = setAt(text, ['behaviours', name, 'move'], b.move.slice(1));
    expect((JSON.parse(out) as Strategy).behaviours[name]!.move).toEqual(b.move.slice(1));
  });

  it('returns the same text when nothing changes, so a no-op never dirties the draft', () => {
    expect(setAt(text, ['build', 'weapon'], base.build.weapon)).toBe(text);
    expect(setAt(text, ['author_nope'], undefined)).toBe(text);
  });

  it('creates missing parents', () => {
    const out = setAt(text, ['behaviours', 'brand_new', 'score'], '0.5');
    expect((JSON.parse(out) as Strategy).behaviours.brand_new).toEqual({ score: '0.5' });
  });
});

describe('renames', () => {
  it('renames a behaviour key in place without touching its body', () => {
    const name = Object.keys(base.behaviours)[0]!;
    const out = renameKey(text, ['behaviours', name], 'renamed');
    const s = JSON.parse(out) as Strategy;
    expect(s.behaviours.renamed).toEqual(base.behaviours[name]);
    expect(Object.keys(s.behaviours)[0]).toBe('renamed');
  });

  it('renames a memory slot everywhere it is declared, written and read, and nowhere else', () => {
    const src = prettyJson({
      ...base,
      memory: { hit: 0, hits: 0 },
      behaviours: {
        a: { score: 'hit + hits * 2', move: [], attack: 'never', set: { hit: 'hit + 1', hits: 'time' } },
      },
    });
    const out = renameMemory(src, 'hit', 'struck');
    const s = JSON.parse(out) as Strategy;
    expect(s.memory).toEqual({ struck: 0, hits: 0 });
    expect(s.behaviours.a!.score).toBe('struck + hits * 2');
    expect(s.behaviours.a!.set).toEqual({ struck: 'struck + 1', hits: 'time' });
  });
});
