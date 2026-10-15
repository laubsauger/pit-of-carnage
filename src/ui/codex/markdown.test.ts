import { describe, expect, it } from 'vitest';
import { generateRulebook } from '../../strategy';
import { inline, parseMarkdown, plain, sections, tableUnder } from './markdown';

describe('parseMarkdown', () => {
  it('reads the block kinds the rulebook generator writes', () => {
    const md = ['## Title', 'One paragraph', 'that continues.', '', '- a', '- b', '', '1. first', '2. second', '', '| A | B |', '| --- | --- |', '| x \\| y | `z` |', '', '```json', '{ "a": 1 }', '```'].join('\n');
    expect(parseMarkdown(md)).toEqual([
      { t: 'h', level: 2, text: 'Title' },
      { t: 'p', text: 'One paragraph that continues.' },
      { t: 'ul', items: ['a', 'b'] },
      { t: 'ol', items: ['first', 'second'] },
      // An escaped pipe stays inside its cell.
      { t: 'table', head: ['A', 'B'], rows: [['x | y', '`z`']] },
      { t: 'code', lang: 'json', text: '{ "a": 1 }' },
    ]);
  });

  it('splits inline code, bold and italic, and reduces them to plain text for search', () => {
    expect(inline('Use `seek` **now**, *gently*.')).toEqual([
      { t: 'text', text: 'Use ' },
      { t: 'code', text: 'seek' },
      { t: 'text', text: ' ' },
      { t: 'b', text: 'now' },
      { t: 'text', text: ', ' },
      { t: 'i', text: 'gently' },
      { t: 'text', text: '.' },
    ]);
    expect(plain('x `a * b` y')).toBe('x a * b y');
  });

  it('reads the real rulebook without losing a section or a table', () => {
    const md = generateRulebook();
    const titles = md.split('\n').filter((l) => /^##? /.test(l)).map((l) => l.replace(/^#+ /, ''));
    expect(sections(md).map((s) => s.title).filter(Boolean)).toEqual(titles);
    const blocks = parseMarkdown(md);
    expect(tableUnder(blocks, 'The strategy document').map((r) => r[0])).toContain('behaviours');
    expect(tableUnder(blocks, 'Behaviour fields').map((r) => r[0])).toEqual(['score', 'move', 'attack', 'skill', 'set', 'stance']);
    // Every table row has as many cells as its header (escaped pipes did not split a cell).
    for (const b of blocks) if (b.t === 'table') for (const r of b.rows) expect(r.length).toBe(b.head.length);
  });
});
