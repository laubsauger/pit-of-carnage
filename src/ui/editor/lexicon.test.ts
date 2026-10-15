import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_KEYS, SKILL_IDS, STAT_DOCS, WEAPON_IDS, deriveStats } from '../../core';
import { ATTACK_POLICIES, FIGHTER_REFS, FIGHTER_SENSORS, FUNCTIONS, MOVE_TERMS, PLACES, SENSORS, ZONES } from '../../brain';
import { BARK_KINDS, STARTER_NAMES, generateJsonSchema } from '../../strategy';
import { lexExpr } from './language';
import { EVEN_BUILD, allEntries, attributeEffect, entryById, entryForWord, exampleOf, fieldEntry } from './lexicon';

describe('lexicon coverage', () => {
  it('has a card for every word the registry defines, so no hover is ever empty', () => {
    for (const s of SENSORS.filter((x) => x.scope === 'self')) expect(entryForWord(s.name)?.kind, s.name).toBe('sensor');
    for (const d of FIGHTER_SENSORS) {
      expect(entryForWord(`target.${d.key}`)?.kind).toBe('fighter-sensor');
      // it.* reads the same fact: the same card.
      expect(entryForWord(`it.${d.key}`)).toBe(entryForWord(`target.${d.key}`));
    }
    for (const r of FIGHTER_REFS) expect(entryForWord(r.name, 'fighter')).not.toBeNull();
    for (const p of PLACES) expect(entryForWord(p.name, 'place')).not.toBeNull();
    for (const z of ZONES) expect(entryForWord(z.name, 'zone')).not.toBeNull();
    for (const t of MOVE_TERMS) expect(entryForWord(t.key, 'term')).not.toBeNull();
    for (const p of ATTACK_POLICIES) expect(entryForWord(p.name, 'policy')).not.toBeNull();
    for (const f of Object.keys(FUNCTIONS)) expect(entryForWord(f, 'function')).not.toBeNull();
    for (const w of WEAPON_IDS) expect(entryForWord(w, 'weapon')?.facts?.length).toBeGreaterThan(0);
    for (const s of SKILL_IDS) expect(entryForWord(s, 'skill')).not.toBeNull();
    for (const a of ATTRIBUTE_KEYS) expect(entryForWord(a, 'attribute')?.formulas?.length).toBeGreaterThan(0);
    for (const n of STARTER_NAMES) expect(entryForWord(n, 'starter')?.example?.code).toContain('"score"');
    for (const b of BARK_KINDS) expect(entryForWord(b, 'bark')).not.toBeNull();
  });

  it('docs every property of the document from the rulebook the LLM reads', () => {
    const schema = generateJsonSchema() as { properties: Record<string, unknown>; $defs: { behaviour: { properties: Record<string, unknown> } } };
    for (const k of Object.keys(schema.properties)) {
      const e = fieldEntry([k]);
      expect(e?.doc, k).toBeTruthy();
    }
    for (const k of Object.keys(schema.$defs.behaviour.properties)) expect(fieldEntry(['behaviours', 'kite', k])?.doc, k).toBeTruthy();
    expect(fieldEntry(['behaviours', 'kite', 'move', 2, 'weight'])?.doc).toMatch(/0 to 5/);
    expect(fieldEntry(['behaviours', 'kite', 'move', 2, 'orbit'])?.kind).toBe('term');
    expect(fieldEntry(['build', 'attributes', 'haste'])?.kind).toBe('attribute');
  });

  it('only links related words that exist, and never an entry to itself', () => {
    for (const e of allEntries()) {
      for (const id of e.related) expect(entryById(id), `${e.id} -> ${id}`).not.toBeNull();
      expect(e.related).not.toContain(e.id);
    }
    // Places link to the sensors that read them, and back.
    expect(entryById('place:shrine')?.related).toContain('sensor:shrine.ready');
    expect(entryById('sensor:shrine.ready')?.related).toContain('place:shrine');
  });

  it('shows real examples: the word really appears in the snippet, taken from the shipped library', () => {
    for (const e of allEntries()) {
      if (!e.example || e.kind === 'starter') continue;
      const words = lexExpr(e.example.code).filter((t) => t.kind === 'name').map((t) => t.text);
      expect(words, `${e.id}: ${e.example.code}`).toContain(e.word);
    }
    expect(exampleOf('no_such_word')).toBeUndefined();
  });
});

describe('attribute effects', () => {
  it('says what +10 does using the real stat formulas, so the card cannot drift from the sim', () => {
    const { to, changes } = attributeEffect('vitality', EVEN_BUILD, 'GREATSWORD');
    expect(to).toBe(EVEN_BUILD.vitality + 10);
    const hp = changes.find((c) => c.key === 'maxHp')!;
    expect(hp.from).toBe(String(deriveStats(EVEN_BUILD, 'GREATSWORD').maxHp));
    expect(hp.to).toBe(String(deriveStats({ ...EVEN_BUILD, vitality: to }, 'GREATSWORD').maxHp));
    expect(hp.better).toBe(true);
    // A bigger body is the price of vitality: shown, and marked as worse.
    expect(changes.find((c) => c.key === 'radius')?.better).toBe(false);
  });

  it('lists only the stats an attribute moves, and stops at the attribute maximum', () => {
    const haste = attributeEffect('haste', EVEN_BUILD, 'LONGBOW').changes.map((c) => c.key);
    expect(haste).toEqual(['attackCooldown', 'skillCooldown']);
    const maxed = attributeEffect('power', { ...EVEN_BUILD, power: 40 }, 'LONGBOW');
    expect(maxed.to).toBe(40);
    expect(maxed.changes).toEqual([]);
  });

  it('prints each formula the attribute feeds, straight from the stat docs', () => {
    const e = entryForWord('perception', 'attribute')!;
    expect(e.formulas!.map((f) => f.value)).toContain(STAT_DOCS.visionRange.doc);
    expect(e.formulas!.map((f) => f.value)).toContain(STAT_DOCS.parryChance.doc);
  });
});
