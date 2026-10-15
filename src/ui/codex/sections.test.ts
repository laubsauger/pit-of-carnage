import { describe, expect, it } from 'vitest';
import { generateRulebook } from '../../strategy';
import { allEntries } from '../editor/lexicon';
import { CODEX_SECTIONS, proseUnder, searchCodex, sectionEntries, sectionOf, sectionProse } from './sections';

describe('the Codex', () => {
  it('covers every section of the rulebook the LLM prompt contains', () => {
    const md = generateRulebook();
    const used = new Set(CODEX_SECTIONS.flatMap((s) => s.prose));
    const titles = md.split('\n').filter((l) => /^##? /.test(l));
    for (const t of titles) {
      // A section is covered directly or through one of its sub-headings.
      const subs = t.startsWith('## ') ? proseUnder(t).filter((b) => b.t === 'h').map((b) => `### ${(b as { text: string }).text}`) : [];
      expect(used.has(t) || subs.some((s) => used.has(s)), t).toBe(true);
    }
  });

  it('shows every word, build part and rule in exactly one section', () => {
    for (const e of allEntries()) {
      if (e.kind === 'field') continue;
      const homes = CODEX_SECTIONS.filter((s) => sectionEntries(s).includes(e));
      expect(homes.length, e.id).toBeLessThanOrEqual(1);
      if (e.kind !== 'rule') expect(homes.length, e.id).toBe(1);
    }
    expect(sectionOf('weapon:LONGBOW')?.id).toBe('weapons');
    expect(sectionOf('starter:lurk')?.id).toBe('library');
  });

  it('finds what a player searches for, cards first by exact word', () => {
    const hits = searchCodex('backstab');
    const ids = hits.flatMap((h) => h.entries.map((e) => e.id));
    expect(ids).toContain('fighter-sensor:target.facing_away');
    expect(ids).toContain('starter:backstab');
    expect(ids).toContain('weapon:TWIN_DAGGERS');
    const lib = hits.find((h) => h.section.id === 'library')!;
    expect(lib.entries[0]!.id).toBe('starter:backstab');
    // Every word must match, not just one.
    expect(searchCodex('backstab zzzz')).toEqual([]);
    expect(searchCodex('   ')).toEqual([]);
  });

  it('cuts tables in search results down to the rows that match', () => {
    const rules = searchCodex('parryCooldown').find((h) => h.section.id === 'rules');
    const table = rules?.prose.find((b) => b.t === 'table');
    expect(table && table.t === 'table' ? table.rows.length : 0).toBe(1);
  });

  it('gives every section something to show', () => {
    for (const s of CODEX_SECTIONS) expect(sectionProse(s).length + sectionEntries(s).length, s.id).toBeGreaterThan(0);
  });
});
