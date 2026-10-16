import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_MAX, ATTRIBUTE_MIN } from '../../core';
import { LIMITS } from '../../strategy';
import { scanJson } from './jsontext';
import { dragSteps, scrubTargetAt, scrubValue } from './scrub';

const text = [
  '{',
  '  "version": 3,',
  '  "build": { "attributes": { "vitality": 18 } },',
  '  "target": "0 - it.distance + 80 * it.is_target",',
  '  "behaviours": { "kite": { "score": "0.25 + enemies_seen * 0.3", "move": [{ "keep_range": ["target", 180, 260], "weight": 1 }], "attack": "in_range" } },',
  '  "memory": { "seen": -2 },',
  '  "barks": { "kill": "Number 5 is alive" }',
  '}',
].join('\n');
const tokens = scanJson(text).tokens;
const at = (needle: string, nth = 0) => {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = text.indexOf(needle, i + 1);
  return i + 1;
};
const target = (needle: string, nth = 0) => scrubTargetAt(text, tokens, at(needle, nth));

describe('what can be scrubbed in the code view', () => {
  it('finds JSON numbers with the same ranges and steps as the visual builder', () => {
    expect(target('18')).toMatchObject({ text: '18', min: ATTRIBUTE_MIN, max: ATTRIBUTE_MAX, step: 1 });
    expect(target('"weight": 1')).toBeNull(); // on the key, not the number
    const w = scrubTargetAt(text, tokens, text.indexOf('"weight": 1') + 10)!;
    expect(w).toMatchObject({ text: '1', min: 0, max: LIMITS.weightMax, step: 0.05 });
    expect(target('180')).toMatchObject({ step: 5, max: LIMITS.rangeMax });
    expect(target('-2')).toMatchObject({ text: '-2', step: null });
  });

  // A drag must change exactly the number under the pointer, inside the expression text.
  it('finds a number inside an expression, and only there', () => {
    const t = target('80')!;
    expect(text.slice(t.from, t.to)).toBe('80');
    expect(target('0.3')).toMatchObject({ text: '0.3', min: 0 });
    // Bark lines are text, not expressions: their digits are not draggable.
    expect(target('5 is alive')).toBeNull();
  });

  // The version number belongs to the library and is overwritten on save: dragging it would lie.
  it('leaves the version number alone', () => {
    expect(target('3,')).toBeNull();
  });
});

describe('scrubbing', () => {
  it('moves by the field’s step and stays inside its range', () => {
    const w = scrubTargetAt(text, tokens, text.indexOf('"weight": 1') + 10)!;
    expect(scrubValue(w, 3)).toBe('1.15');
    expect(scrubValue(w, 2)).toBe('1.1');
    expect(scrubValue(w, -100)).toBe('0');
    expect(scrubValue(w, 10_000)).toBe(String(LIMITS.weightMax));
    expect(scrubValue(target('18')!, 40)).toBe(String(ATTRIBUTE_MAX));
    expect(scrubValue(target('180')!, 2)).toBe('190');
  });

  it('moves an expression number by its smallest written unit, never below zero', () => {
    expect(scrubValue(target('0.25')!, 3)).toBe('0.28');
    expect(scrubValue(target('80')!, -100)).toBe('0');
  });

  it('turns pointer travel into steps: Shift is ten times faster, Alt ten times finer', () => {
    expect(dragSteps({ clientX: 140, shiftKey: false, altKey: false }, 100)).toBe(10);
    expect(dragSteps({ clientX: 140, shiftKey: true, altKey: false }, 100)).toBe(100);
    expect(dragSteps({ clientX: 140, shiftKey: false, altKey: true }, 100)).toBe(1);
  });
});
