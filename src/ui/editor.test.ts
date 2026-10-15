import { describe, expect, it } from 'vitest';
import type { Strategy } from '../core';
import type { ValidationIssue } from '../core';
import {
  NEW_STRATEGY_NAME,
  budget,
  completeAttributes,
  issueAtCaret,
  issueOffset,
  lineCol,
  lineSeverity,
  locatePath,
  newStrategyText,
  offsetOf,
  parseJson,
  placeIssues,
  prettyJson,
  readAttributes,
  readWeapon,
  tokenEnd,
  underlineSpans,
} from './editor';

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

describe('locatePath', () => {
  const text = JSON.stringify(
    {
      name: 'Kiter',
      behaviours: {
        lurk: { score: '1', move: [{ seek: 'target', weight: 1 }] },
        kite: { score: '2', move: [{ seek: 'target', weight: 1 }, { keep_range: ['target', 200, 300], weight: 1 }] },
      },
    },
    null,
    2,
  );

  it('finds the key a validator path names, not an earlier key with the same name', () => {
    const at = locatePath(text, 'behaviours.kite.move[1].keep_range');
    expect(text.slice(at, at + 12)).toBe('"keep_range"');
    // The "move" under kite, not the one under lurk:
    expect(locatePath(text, 'behaviours.kite.move')).toBeGreaterThan(text.indexOf('"kite"'));
  });

  it('falls back to the deepest key it found when the rest of the path is missing', () => {
    expect(locatePath(text, 'behaviours.kite.attack')).toBe(text.indexOf('"kite"'));
  });

  it('returns -1 when nothing matches, so the editor does not jump to a random place', () => {
    expect(locatePath(text, 'build.weapon')).toBe(-1);
  });
});

describe('offsetOf', () => {
  it('turns a JSON error line and column back into a cursor position', () => {
    const text = 'ab\ncdef\ng';
    expect(offsetOf(text, 2, 3)).toBe(5);
    expect(lineCol(text, offsetOf(text, 2, 3))).toEqual({ line: 2, col: 3 });
  });

  it('clamps past the end of a line or the text', () => {
    expect(offsetOf('ab\ncd', 1, 99)).toBe(2);
    expect(offsetOf('ab\ncd', 9, 1)).toBe(5);
  });
});

describe('newStrategyText', () => {
  const house = { schema: 'pit-strategy/2', name: 'Apologetic Gary', author: 'House', version: 4, build: { weapon: 'LONGBOW', skill: 'DASH', attributes: { vitality: 16, power: 16, agility: 16, perception: 16, armor: 16, haste: 16 } }, target: '0', behaviours: {}, commit: 30 } as Strategy;

  it('never reuses a house stack name, so saving the copy cannot merge into the house stack ratings', () => {
    const s = JSON.parse(newStrategyText([house])) as Strategy;
    expect(s.name).toBe(NEW_STRATEGY_NAME);
    expect(s.name).not.toBe(house.name);
    expect(s.version).toBe(1);
    expect(s.author).toBeUndefined();
    expect(s.build.weapon).toBe('LONGBOW');
  });

  it('still gives a complete strategy when there are no house stacks', () => {
    const s = JSON.parse(newStrategyText([])) as Strategy;
    expect(s.schema).toBe('pit-strategy/2');
    expect(Object.keys(s.behaviours).length).toBeGreaterThan(0);
  });
});

describe('prettyJson', () => {
  const strategy = {
    schema: 'pit-strategy/2',
    name: 'Kiter',
    build: { weapon: 'LONGBOW', skill: 'DASH', attributes: { vitality: 14, power: 16, agility: 20, perception: 26, armor: 8, haste: 16 } },
    behaviours: {
      kite: {
        score: '(target.distance < 260) * (1 - target.family_ranged)',
        move: [{ keep_range: ['target', 220, 320], weight: 1 }, { avoid: 'walls', weight: 0.5 }],
        attack: 'in_range',
      },
    },
    memory: {},
    barks: { kill: ['Pardon.', 'Lovely.'] },
    commit: 30,
  };

  it('round-trips exactly, because the editor text is what gets validated and saved', () => {
    expect(JSON.parse(prettyJson(strategy))).toEqual(strategy);
    expect(JSON.parse(prettyJson([]))).toEqual([]);
    expect(JSON.parse(prettyJson({}))).toEqual({});
  });

  it('keeps a move term on one line so a behaviour fits on screen', () => {
    const lines = prettyJson(strategy).split('\n');
    expect(lines).toContain('        { "keep_range": ["target", 220, 320], "weight": 1 },');
    expect(lines.some((l) => l.trim() === '"weight": 1')).toBe(false);
  });

  it('breaks anything that does not fit the width', () => {
    for (const line of prettyJson(strategy, 60).split('\n')) {
      // Only a single long string value may overflow (it cannot be broken without changing it).
      if (line.length > 60) expect(line.trim()).toMatch(/^"[a-z_]+": ".*",?$/);
    }
  });
});

describe('issue placement', () => {
  const text = ['{', '  "name": "Kiter",', '  "behaviours": {', '    "kite": { "score": "target.distnce < 200", "attack": "in_range" }', '  }', '}'].join('\n');
  const issue = (p: Partial<ValidationIssue>): ValidationIssue => ({ path: '', message: 'x', severity: 'error', ...p });

  it("uses the gate's own line and column when it gives them, because that is where the problem is", () => {
    const at = issueOffset(text, issue({ path: 'behaviours.kite.score', line: 4, column: 24 }));
    expect(text.slice(at, at + 22)).toBe('"target.distnce < 200"');
  });

  it("falls back to the key the path names when the gate gave no position", () => {
    const at = issueOffset(text, issue({ path: 'behaviours.kite.score' }));
    expect(text.slice(at, at + 7)).toBe('"score"');
  });

  it('places a JSON syntax error without a position where parsing breaks', () => {
    const broken = '{\n  "name": "Kiter",\n  "commit": 30,\n}';
    const [span] = placeIssues(broken, [issue({ message: 'Not valid JSON' })]);
    expect(span.line).toBe(4);
  });

  it('underlines a whole string, escapes included, and stops at the end of the line', () => {
    const t = '"a \\"b\\" c", 12.5e3, x';
    expect(t.slice(0, tokenEnd(t, 0))).toBe('"a \\"b\\" c"');
    expect(t.slice(13, tokenEnd(t, 13))).toBe('12.5e3');
    expect(tokenEnd('"open\nnext', 0)).toBe(5);
    expect(tokenEnd('{ }', 0)).toBe(1);
  });

  it('lists errors before warnings and never draws two underlines over each other', () => {
    const spans = placeIssues(text, [
      issue({ path: 'name', severity: 'warning' }),
      issue({ path: 'behaviours.kite.score', line: 4, column: 24 }),
      issue({ path: 'name', severity: 'error' }),
    ]);
    expect(spans.map((s) => s.severity)).toEqual(['error', 'error', 'warning']);
    const drawn = underlineSpans(spans);
    expect(drawn.map((s) => [s.line, s.severity])).toEqual([[2, 'error'], [4, 'error']]);
    for (let i = 1; i < drawn.length; i++) expect(drawn[i].start).toBeGreaterThanOrEqual(drawn[i - 1].end);
  });

  it('marks each line with its worst problem for the gutter', () => {
    const spans = placeIssues(text, [issue({ path: 'name', severity: 'warning' }), issue({ path: 'name' })]);
    expect(lineSeverity(spans).get(2)).toBe('error');
  });

  it('skips issues the text has no spot for instead of pointing somewhere random', () => {
    expect(placeIssues(text, [issue({ path: 'build.weapon' })])).toEqual([]);
  });

  it('explains the issue under the caret, or the one on its line', () => {
    const spans = placeIssues(text, [issue({ path: 'behaviours.kite.score', line: 4, column: 24, message: 'Unknown sensor' })]);
    expect(issueAtCaret(spans, text, offsetOf(text, 4, 30))?.issue.message).toBe('Unknown sensor');
    expect(issueAtCaret(spans, text, offsetOf(text, 4, 1))?.issue.message).toBe('Unknown sensor');
    expect(issueAtCaret(spans, text, offsetOf(text, 2, 3))).toBeNull();
  });
});
