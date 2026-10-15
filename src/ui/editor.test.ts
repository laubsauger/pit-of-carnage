import { describe, expect, it } from 'vitest';
import { budget, completeAttributes, lineCol, parseJson, readAttributes, readWeapon } from './editor';

describe('parseJson', () => {
  it('passes valid JSON through', () => {
    expect(parseJson('{"a": 1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('points at the line of a syntax error, because LLM pastes break in the middle of long files', () => {
    const text = '{\n  "name": "Gary",\n  "commit": 30,,\n}';
    const r = parseJson(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.line).toBe(3);
  });

  it('points at the end of a truncated paste', () => {
    const r = parseJson('{\n  "name": "Gary"');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.line).toBe(2);
      expect(r.message).not.toMatch(/position/);
    }
  });

  it('computes 1-based lines and columns', () => {
    expect(lineCol('ab\ncd', 4)).toEqual({ line: 2, col: 2 });
    expect(lineCol('ab', 0)).toEqual({ line: 1, col: 1 });
  });
});

describe('budget meter', () => {
  it('keeps working on a half-edited draft, showing which attribute is missing', () => {
    const attrs = readAttributes({ build: { attributes: { vitality: 20, power: 'lots', agility: 20, perception: 20, armor: 20, haste: 10 } } });
    expect(attrs?.power).toBeNull();
    const b = budget(attrs!);
    expect(b.complete).toBe(false);
    expect(b.total).toBe(90);
    expect(b.rows.find((r) => r.key === 'power')?.outOfRange).toBe(true);
    expect(completeAttributes(attrs)).toBeNull();
  });

  it('flags going over the 100-point budget', () => {
    const b = budget({ vitality: 40, power: 30, agility: 20, perception: 10, armor: 4, haste: 4 });
    expect(b.total).toBe(108);
    expect(b.left).toBe(-8);
    expect(b.over).toBe(true);
  });

  it('flags single attributes outside 4..40 even when the total is fine', () => {
    const b = budget({ vitality: 45, power: 2, agility: 20, perception: 10, armor: 10, haste: 10 });
    expect(b.rows.filter((r) => r.outOfRange).map((r) => r.key)).toEqual(['vitality', 'power']);
    expect(b.over).toBe(false);
  });

  it('reads the weapon only when it is a real weapon id', () => {
    expect(readWeapon({ build: { weapon: 'LONGBOW' } })).toBe('LONGBOW');
    expect(readWeapon({ build: { weapon: 'BAZOOKA' } })).toBeNull();
    expect(readAttributes(null)).toBeNull();
  });
});
