import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_KEYS, SKILL_IDS, WEAPON_IDS } from '../../core';
import { FIGHTER_REFS, FIGHTER_SENSORS, MOVE_TERMS, PLACES, SENSORS, ZONES } from '../../brain';
import { HOUSE_STACKS, generateJsonSchema, loadStrategy } from '../../strategy';
import { scanJson } from './jsontext';
import { ENUM_VALUES, expressionWords, keysFor, lexExpr, memoryNames, slotOf, wordKind } from './language';

describe('slotOf', () => {
  it('reads every string of a real strategy as the kind the validator compiles it as', () => {
    expect(slotOf(['target'])).toEqual({ kind: 'expr', scope: 'target' });
    expect(slotOf(['behaviours', 'kite', 'score'])).toEqual({ kind: 'expr', scope: 'behaviour' });
    expect(slotOf(['behaviours', 'kite', 'set', 'struck_at'])).toEqual({ kind: 'expr', scope: 'behaviour' });
    expect(slotOf(['behaviours', 'kite', 'attack'])).toEqual({ kind: 'attack' });
    expect(slotOf(['behaviours', 'kite', 'move', 0, 'seek'])).toEqual({ kind: 'place' });
    expect(slotOf(['behaviours', 'kite', 'move', 2, 'keep_range', 0])).toEqual({ kind: 'place' });
    // The numbers of keep_range are not places.
    expect(slotOf(['behaviours', 'kite', 'move', 2, 'keep_range', 1])).toEqual({ kind: 'text' });
    expect(slotOf(['behaviours', 'kite', 'move', 1, 'orbit', 1])).toEqual({ kind: 'enum', of: 'direction' });
    expect(slotOf(['behaviours', 'kite', 'move', 3, 'avoid'])).toEqual({ kind: 'zone' });
    expect(slotOf(['build', 'weapon'])).toEqual({ kind: 'enum', of: 'weapon' });
    expect(slotOf(['imports', 0])).toEqual({ kind: 'enum', of: 'starter' });
    expect(slotOf(['name'])).toEqual({ kind: 'text' });
  });

  it('offers exactly the weapons, skills and stances the game has', () => {
    expect(ENUM_VALUES.weapon).toEqual(WEAPON_IDS);
    expect(ENUM_VALUES.skill).toEqual(SKILL_IDS);
  });
});

describe('keysFor', () => {
  it('suggests the keys the JSON Schema allows, so completion never offers a field the gate rejects', () => {
    const schema = generateJsonSchema() as { properties: Record<string, unknown> };
    expect(keysFor([])!.map((k) => k.key)).toEqual(Object.keys(schema.properties));
    expect(keysFor([])!.find((k) => k.key === 'behaviours')?.required).toBe(true);
    expect(keysFor(['build', 'attributes'])!.map((k) => k.key)).toEqual([...ATTRIBUTE_KEYS]);
    expect(keysFor(['behaviours', 'kite'])!.map((k) => k.key)).toEqual(['score', 'move', 'attack', 'skill', 'set', 'stance']);
    expect(keysFor(['behaviours', 'kite', 'move', 0])!.map((k) => k.key)).toEqual([...MOVE_TERMS.map((t) => t.key), 'weight']);
    // Behaviour and memory names are free: nothing to suggest.
    expect(keysFor(['behaviours'])).toBeNull();
    expect(keysFor(['memory'])).toBeNull();
  });
});

describe('expression words', () => {
  const memory = new Set(['struck_at']);

  it('knows it.* only in the target expression and target.* only in behaviours, like the compiler', () => {
    expect(wordKind('it.hp', { kind: 'expr', scope: 'target' }, memory)).toBe('fighter-sensor');
    expect(wordKind('it.hp', { kind: 'expr', scope: 'behaviour' }, memory)).toBeNull();
    expect(wordKind('target.hp', { kind: 'expr', scope: 'behaviour' }, memory)).toBe('fighter-sensor');
    expect(wordKind('target.hp', { kind: 'expr', scope: 'target' }, memory)).toBeNull();
    expect(wordKind('self.hp', { kind: 'expr', scope: 'target' }, memory)).toBe('sensor');
  });

  it('recognises memory slots, functions, operators and policies where they mean something', () => {
    const expr = { kind: 'expr', scope: 'behaviour' } as const;
    expect(wordKind('struck_at', expr, memory)).toBe('memory');
    expect(wordKind('clamp', expr, memory)).toBe('function');
    expect(wordKind('and', expr, memory)).toBe('keyword');
    expect(wordKind('in_range', expr, memory)).toBeNull();
    expect(wordKind('in_range', { kind: 'attack' }, memory)).toBe('policy');
    // A place is not a number.
    expect(wordKind('shrine', expr, memory)).toBeNull();
  });

  it('recognises places, fighters and zones only in their own slots', () => {
    const place = { kind: 'place' } as const;
    const zone = { kind: 'zone' } as const;
    for (const p of PLACES) expect(wordKind(p.name, place, memory)).toBe('place');
    for (const r of FIGHTER_REFS) expect(wordKind(r.name, zone, memory)).toBe('fighter');
    for (const z of ZONES) expect(wordKind(z.name, zone, memory)).toBe('zone');
    expect(wordKind('shadow', place, memory)).toBeNull();
    expect(wordKind('enemies', zone, memory)).toBe('enemies');
  });

  it('completes every sensor the compiler accepts in that scope, and nothing it rejects', () => {
    const target = expressionWords('target', []).map((w) => w.word);
    const behaviour = expressionWords('behaviour', ['struck_at']).map((w) => w.word);
    for (const d of FIGHTER_SENSORS) {
      expect(target).toContain(`it.${d.key}`);
      expect(target).not.toContain(`target.${d.key}`);
      expect(behaviour).toContain(`target.${d.key}`);
      expect(behaviour).not.toContain(`it.${d.key}`);
    }
    for (const s of SENSORS.filter((x) => x.scope === 'self')) expect(target).toContain(s.name);
    expect(behaviour).toContain('struck_at');
  });

  it('reads every word of every house stack as something the language knows', () => {
    for (const s of HOUSE_STACKS) {
      const memory = memoryNames(scanJson(JSON.stringify(s)).tokens);
      expect(loadStrategy(s, 'test').errors).toEqual([]);
      const check = (src: string, slot: Parameters<typeof wordKind>[1]) => {
        for (const t of lexExpr(src)) if (t.kind === 'name') expect(wordKind(t.text, slot, memory), `${s.name}: "${t.text}" in ${src}`).not.toBeNull();
      };
      check(s.target, { kind: 'expr', scope: 'target' });
      for (const b of Object.values(s.behaviours)) {
        check(b.score, { kind: 'expr', scope: 'behaviour' });
        check(b.attack, { kind: 'attack' });
        for (const t of b.move) {
          if ('seek' in t) check(t.seek, { kind: 'place' });
          if ('avoid' in t) check(t.avoid, { kind: 'zone' });
        }
      }
    }
  });

  it('never throws on garbage and always covers the text it was given', () => {
    const junk = 'a.b.c(1,,2) && || !x ?: %^ 3.14.15 .5 _x9 ))(( "quoted" é';
    for (let n = 0; n <= junk.length; n++) {
      const src = junk.slice(0, n);
      const toks = lexExpr(src);
      for (let i = 1; i < toks.length; i++) expect(toks[i]!.from).toBeGreaterThanOrEqual(toks[i - 1]!.to);
      expect(toks.every((t) => src.slice(t.from, t.to) === t.text)).toBe(true);
    }
  });
});
