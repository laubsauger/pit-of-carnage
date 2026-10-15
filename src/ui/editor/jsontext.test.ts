import { describe, expect, it } from 'vitest';
import { HOUSE_STACKS } from '../../strategy';
import { readJson } from '../../strategy/json';
import { prettyJson } from '../editor';
import { parsePath, pathKey, scanJson, slotAt, stringContent, tokenAt } from './jsontext';

const text = prettyJson(HOUSE_STACKS[0]);

describe('scanJson', () => {
  it('names every token with the same path the validator reports, so hover and issues agree', () => {
    const { tokens } = scanJson(text);
    const keys = tokens.filter((t) => t.kind === 'key').map((t) => pathKey(t.path));
    expect(keys).toContain('build.attributes.vitality');
    const firstBehaviour = Object.keys(HOUSE_STACKS[0]!.behaviours)[0]!;
    expect(keys).toContain(`behaviours.${firstBehaviour}.score`);
    expect(keys.some((k) => /^behaviours\.\w+\.move\[\d+\]\.weight$/.test(k))).toBe(true);
  });

  it('records the span of every complete value, so the builder can replace exactly one', () => {
    const { values } = scanJson(text);
    const span = values.get('build.weapon')!;
    expect(text.slice(span.from, span.to)).toBe(JSON.stringify(HOUSE_STACKS[0]!.build.weapon));
    const build = values.get('build')!;
    expect(JSON.parse(text.slice(build.from, build.to))).toEqual(HOUSE_STACKS[0]!.build);
    expect(text.slice(build.keyFrom!, build.keyFrom! + 7)).toBe('"build"');
  });

  it('keeps going through half-typed text instead of giving up (the editor scans every keystroke)', () => {
    const broken = '{\n  "name": "Gar\n  "build": { "weapon": "LONG';
    const { tokens } = scanJson(broken);
    const name = tokens.find((t) => t.kind === 'string' && pathKey(t.path) === 'name');
    expect(name?.closed).toBe(false);
    // The unclosed string ends at its line; the next line is still read as a key.
    expect(tokens.some((t) => t.kind === 'key' && pathKey(t.path) === 'build')).toBe(true);
    expect(tokens.some((t) => t.kind === 'string' && pathKey(t.path) === 'build.weapon')).toBe(true);
  });

  it('always advances, whatever the text, so it cannot hang the editor', () => {
    const junk = '{{]]:,,"\\\\x" tru nul 1e 0x12 @@@ [ { "a": [1, 2, {"b": ';
    for (let n = 0; n <= junk.length; n++) {
      const { tokens } = scanJson(junk.slice(0, n));
      expect(tokens.length).toBeLessThanOrEqual(n);
    }
  });

  // Every token carries its path, so absurd nesting made the scan quadratic: a pasted 20 000 `[`
  // (a third of the 64 KiB the editor takes) ran the tab out of memory on the first keystroke.
  // Past the gate's own depth limit the rest is one bad token; everything the gate reads is scanned.
  it('stays bounded on absurd nesting, and still reads everything as deep as the gate allows', () => {
    const deep = '['.repeat(60_000);
    const { tokens } = scanJson(deep);
    expect(tokens.length).toBeLessThan(100);
    expect(tokens.at(-1)).toMatchObject({ kind: 'bad', to: deep.length });
    expect(Math.max(...tokens.map((t) => t.path.length))).toBeLessThanOrEqual(65);
    expect(slotAt(deep, deep.length)).not.toBeNull();
    // The deepest text the strategy reader accepts is scanned to the last token.
    const allowed = '['.repeat(64) + '1' + ']'.repeat(64);
    expect(readJson(allowed).ok).toBe(true);
    expect(readJson(`[${allowed}]`).ok).toBe(false);
    const scanned = scanJson(allowed);
    expect(scanned.tokens.some((t) => t.kind === 'bad')).toBe(false);
    expect(scanned.tokens.find((t) => t.kind === 'number')?.path).toHaveLength(64);
  });
});

describe('positions', () => {
  it('finds the token under the caret, including right after a word being typed', () => {
    const t = '{ "target": "it.hp" }';
    const { tokens } = scanJson(t);
    const at = tokenAt(tokens, t.indexOf('it.hp') + 2)!;
    expect(at.kind).toBe('string');
    expect(pathKey(at.path)).toBe('target');
    const c = stringContent(at);
    expect(t.slice(c.from, c.to)).toBe('it.hp');
    // Right after the closing quote is outside the string.
    expect(tokenAt(tokens, t.indexOf('it.hp') + 6)).toBeNull();
  });

  it('knows whether a key or a value goes where nothing is typed yet', () => {
    const t = '{\n  "behaviours": {\n    "kite": {\n      \n    }\n  },\n  "commit": ';
    expect(slotAt(t, t.indexOf('      ') + 6)).toEqual({ at: 'key', object: ['behaviours', 'kite'] });
    expect(slotAt(t, t.length)).toEqual({ at: 'value', path: ['commit'] });
    const arr = '{ "imports": ["lurk", ';
    expect(slotAt(arr, arr.length)).toEqual({ at: 'value', path: ['imports', 1] });
  });

  it('turns a validator path into segments and back', () => {
    for (const p of ['behaviours.kite.move[1].keep_range[0]', 'build.attributes.haste', 'target', 'imports[2]']) {
      expect(pathKey(parsePath(p))).toBe(p);
    }
    expect(parsePath('behaviours.kite.move[1]')).toEqual(['behaviours', 'kite', 'move', 1]);
  });
});
