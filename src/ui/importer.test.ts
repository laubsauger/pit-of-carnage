import { describe, expect, it } from 'vitest';
import type { Strategy } from '../core';
import { HOUSE_STACKS, encodeStrategyCode } from '../strategy';
import { prettyJson } from './editor';
import { checkImport, importVerdict, isJsonFile, rejectedFile, sourceOf } from './importer';

const house: Strategy = HOUSE_STACKS[0];

describe('checkImport', () => {
  it('lets a clean strategy straight through to the editor', () => {
    const e = checkImport('gary.json', prettyJson(house), true);
    expect(e.source).toBe('file');
    expect(e.report.strategy?.name).toBe(house.name);
    expect(importVerdict(e.report)).toEqual({ ok: true, label: 'Open in editor' });
  });

  it('recognises a strategy code wherever it was pasted or dropped, and loads it through the same gate', () => {
    const code = encodeStrategyCode(house);
    expect(sourceOf(`  ${code}\n`, false)).toBe('code');
    const e = checkImport('Pasted text', code, false);
    expect(e.source).toBe('code');
    expect(e.report.strategy?.name).toBe(house.name);
  });

  it('blocks broken JSON and says where it broke, so a truncated paste is easy to fix', () => {
    const text = prettyJson(house);
    const cut = text.slice(0, Math.floor(text.length / 2));
    const e = checkImport('Pasted text', cut, false);
    expect(importVerdict(e.report).ok).toBe(false);
    expect(e.issues[0].line).toBeGreaterThan(1);
    expect(e.issues[0].column).toBeGreaterThan(0);
  });

  it('points a validation error at the line of the bad key', () => {
    const bad = { ...house, build: { ...house.build, weapon: 'SPOON' } } as unknown as Strategy;
    const text = prettyJson(bad);
    const e = checkImport('bad.json', text, true);
    expect(importVerdict(e.report).ok).toBe(false);
    const weapon = e.issues.find((i) => i.path.startsWith('build.weapon'));
    expect(weapon?.line).toBeDefined();
    expect(text.split('\n')[(weapon?.line ?? 1) - 1]).toContain('weapon');
  });

  it('lets warnings through but names them on the button, so accepting them is a choice', () => {
    const a = house.build.attributes;
    const lazy = { ...house, build: { ...house.build, attributes: { ...a, haste: a.haste - 3 } } };
    const e = checkImport('lazy.json', prettyJson(lazy), true);
    expect(e.report.warnings.length).toBeGreaterThan(0);
    const v = importVerdict(e.report);
    expect(v.ok).toBe(true);
    expect(v.label).toMatch(/^Open with \d+ warnings?$/);
  });
});

describe('files', () => {
  it('reads only JSON files and reports anything else as an error', () => {
    expect(isJsonFile({ name: 'Kiter.JSON', type: '' })).toBe(true);
    expect(isJsonFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false);
    expect(importVerdict(rejectedFile('cat.png').report).ok).toBe(false);
  });
});
