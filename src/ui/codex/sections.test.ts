import { describe, expect, it } from 'vitest';
import { BLEED_RULES, COMBAT, HAZARD_RULES, MATCH_RULES, PERCEPTION, PICKUP_RULES, PROP_RULES, SKILL_IDS, STANCES, STUCK_AMMO, WEAPON_IDS } from '../../core';
import { ATTACK_POLICIES, ENEMIES_WORD, FIGHTER_REFS, FIGHTER_SENSORS, FUNCTIONS, MOVE_TERMS, PICKUP_ARG_WORDS, PLACES, SENSORS, STEERING, ZONES } from '../../brain';
import { MAPS } from '../../sim';
import { BARK_KINDS, STARTER_NAMES, generateRulebook } from '../../strategy';
import { allEntries, entryById } from '../editor/lexicon';
import { CODEX_SECTIONS, proseHeadings, proseUnder, searchCodex, sectionEntries, sectionOf, sectionProse } from './sections';

describe('the Codex', () => {
  it('covers every section of the rulebook the LLM prompt contains', () => {
    const md = generateRulebook();
    const used = new Set(CODEX_SECTIONS.flatMap(proseHeadings));
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

  // The Codex is generated from the registry and the rule tables. When a builder adds a sensor, a
  // place, a skill or a rule (stuck ammo this pass), it must get a page without anyone touching the
  // Codex; this fails, naming the word, the moment one would be missing.
  it('has a page for every word in the registry and every rule in the tables', () => {
    const ids: string[] = [
      ...SENSORS.map((x) => (x.scope === 'self' ? `sensor:${x.name}` : `fighter-sensor:target.${x.name.slice(x.name.indexOf('.') + 1)}`)),
      ...FIGHTER_SENSORS.map((d) => `fighter-sensor:target.${d.key}`),
      ...FIGHTER_REFS.map((r) => `fighter:${r.name}`),
      `enemies:${ENEMIES_WORD}`,
      ...PLACES.map((p) => `place:${p.name}`),
      ...ZONES.map((z) => `zone:${z.name}`),
      ...MOVE_TERMS.map((t) => `term:${t.key}`),
      ...ATTACK_POLICIES.map((p) => `policy:${p.name}`),
      ...Object.keys(FUNCTIONS).map((f) => `function:${f}`),
      ...PICKUP_ARG_WORDS.map((w) => `pickup-word:${w}`),
      ...WEAPON_IDS.map((w) => `weapon:${w}`),
      ...SKILL_IDS.map((k) => `skill:${k}`),
      ...Object.keys(STANCES).map((k) => `stance:${k}`),
      ...Object.values(HAZARD_RULES).map((h) => `hazard:${h.kind}`),
      ...Object.values(PROP_RULES).map((p) => `prop:${p.kind}`),
      ...Object.keys(PICKUP_RULES).map((k) => `pickup:${k}`),
      ...Object.values(MAPS).map((m) => `map:${m.id}`),
      ...STARTER_NAMES.map((n) => `starter:${n}`),
      ...BARK_KINDS.map((b) => `bark:${b}`),
      ...Object.keys(COMBAT).map((k) => `rule:combat.${k}`),
      ...Object.keys(PERCEPTION).map((k) => `rule:perception.${k}`),
      ...Object.keys(MATCH_RULES).map((k) => `rule:match.${k}`),
      ...Object.keys(STEERING).map((k) => `rule:steering.${k}`),
      ...Object.keys(STUCK_AMMO).map((k) => `rule:stuck_ammo.${k}`),
      ...(BLEED_RULES.enabled ? Object.keys(BLEED_RULES).map((k) => `rule:bleed.${k}`) : []),
    ];
    const missing = ids.filter((id) => !entryById(id) || !sectionOf(id));
    expect(missing).toEqual([]);
    // Stuck ammo has its own section with a card per rule, each with its doc.
    expect(sectionOf('rule:stuck_ammo.pickupSlack')?.id).toBe('stuck-ammo');
    expect(entryById('rule:stuck_ammo.pickupSlack')?.doc).toMatch(/takes back/);
    // A rule without a card of its own opens on the rule tables that list it.
    expect(sectionOf('rule:combat.parryCooldown')?.id).toBe('rules');
  });

  // Bleeding is a candidate rule: like the rulebook, the Codex leaves it out until it ships.
  it('shows bleeding only while the rule is switched on', () => {
    expect(CODEX_SECTIONS.some((s) => s.id === 'bleeding')).toBe(BLEED_RULES.enabled);
    expect(allEntries().some((e) => e.id.startsWith('rule:bleed.'))).toBe(BLEED_RULES.enabled);
  });
});
