import { describe, expect, it } from 'vitest';
import { SKILL_IDS, WEAPONS, WEAPON_IDS } from '../core';
import { ATTACK_POLICIES, FIGHTER_REFS, GUARDS, MOVE_TERMS, PLACES, SENSORS, STEERING, ZONES } from '../brain';
import { HOUSE_STACKS } from './house';
import { STARTER_LIBRARY } from './library';
import { buildLlmPrompt } from './prompt';
import { formatJson, generateRulebook } from './rulebook';
import published from '../../public/pit-strategy-2.schema.json';
import { SCHEMA_PATH, generateJsonSchema } from './schema';

// ---------------------------------------------------------------------------------------------
// A checker for the subset of JSON Schema 2020-12 that generateJsonSchema emits. Enough to prove
// the schema accepts real strategies and rejects broken ones, which is what structured-output
// LLMs depend on.
// ---------------------------------------------------------------------------------------------

type S = Record<string, unknown>;

function check(schema: S, v: unknown, root: S, path = '$'): string[] {
  if (typeof schema.$ref === 'string') {
    const def = (root.$defs as S)[schema.$ref.replace('#/$defs/', '')] as S;
    return check(def, v, root, path);
  }
  const errs: string[] = [];
  const fail = (m: string) => errs.push(`${path}: ${m}`);
  if ('const' in schema && v !== schema.const) fail(`not ${String(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(v)) fail(`not in enum`);
  if (Array.isArray(schema.oneOf)) {
    const ok = schema.oneOf.filter((s) => check(s as S, v, root, path).length === 0).length;
    if (ok !== 1) fail(`matches ${ok} of oneOf`);
  }
  const t = schema.type;
  if (t === 'object') {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return [...errs, `${path}: not an object`];
    const o = v as S;
    for (const k of (schema.required as string[] | undefined) ?? []) if (!(k in o)) fail(`missing ${k}`);
    const props = (schema.properties as S | undefined) ?? {};
    if (typeof schema.maxProperties === 'number' && Object.keys(o).length > schema.maxProperties) fail('too many properties');
    for (const [k, val] of Object.entries(o)) {
      const pn = (schema.propertyNames as S | undefined)?.pattern;
      if (typeof pn === 'string' && !new RegExp(pn).test(k)) fail(`bad key ${k}`);
      if (k in props) errs.push(...check(props[k] as S, val, root, `${path}.${k}`));
      else if (schema.additionalProperties === false) fail(`unexpected ${k}`);
      else if (typeof schema.additionalProperties === 'object') errs.push(...check(schema.additionalProperties as S, val, root, `${path}.${k}`));
    }
  } else if (t === 'array') {
    if (!Array.isArray(v)) return [...errs, `${path}: not an array`];
    if (typeof schema.minItems === 'number' && v.length < schema.minItems) fail('too few items');
    if (typeof schema.maxItems === 'number' && v.length > schema.maxItems) fail('too many items');
    if (schema.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) fail('duplicate items');
    const prefix = (schema.prefixItems as S[] | undefined) ?? [];
    v.forEach((item, i) => {
      const s = prefix[i] ?? (schema.items as S | undefined);
      if (s) errs.push(...check(s, item, root, `${path}[${i}]`));
    });
  } else if (t === 'string') {
    if (typeof v !== 'string') return [...errs, `${path}: not a string`];
    if (typeof schema.minLength === 'number' && v.length < schema.minLength) fail('too short');
    if (typeof schema.maxLength === 'number' && v.length > schema.maxLength) fail('too long');
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(v)) fail('pattern');
  } else if (t === 'number' || t === 'integer') {
    if (typeof v !== 'number' || (t === 'integer' && !Number.isInteger(v))) return [...errs, `${path}: not a ${t}`];
    if (typeof schema.minimum === 'number' && v < schema.minimum) fail('below minimum');
    if (typeof schema.maximum === 'number' && v > schema.maximum) fail('above maximum');
  }
  return errs;
}

describe('JSON Schema', () => {
  const schema = generateJsonSchema();

  it('accepts every house stack', () => {
    for (const s of HOUSE_STACKS) expect(check(schema, s, schema), s.name).toEqual([]);
  });

  it('rejects the mistakes it can see: unknown fields, bad enums, over-limit attributes, two-kind terms', () => {
    const s = structuredClone(HOUSE_STACKS[0]!) as unknown as S;
    s.behaviors = {};
    (s.build as S).weapon = 'SPOON';
    ((s.build as S).attributes as S).power = 41;
    const behaviours = s.behaviours as Record<string, S>;
    (behaviours.loiter!.move as S[])[0] = { seek: 'target', flee: 'target', weight: 1 };
    const errs = check(schema, s, schema);
    expect(errs.some((e) => e.includes('unexpected behaviors'))).toBe(true);
    expect(errs.some((e) => e.startsWith('$.build.weapon'))).toBe(true);
    expect(errs.some((e) => e.startsWith('$.build.attributes.power'))).toBe(true);
    expect(errs.some((e) => e.startsWith('$.behaviours.loiter.move[0]'))).toBe(true);
  });

  // Editors read the published file; if it drifted from the generator they would accept strategies
  // the game rejects (or the other way round).
  it('is published unchanged at public/' + SCHEMA_PATH + ' (regenerate: npx tsx scripts/lint-strategy.ts --write-schema)', () => {
    expect(published).toEqual(JSON.parse(JSON.stringify(schema)));
  });

  it('lets a strategy name the schema with "$schema"', () => {
    expect(check(schema, { $schema: `/${SCHEMA_PATH}`, ...HOUSE_STACKS[0]! }, schema)).toEqual([]);
  });

  it('enumerates the same weapons, skills and imports the game uses', () => {
    const props = schema.properties as S;
    const build = (props.build as S).properties as S;
    expect((build.weapon as S).enum).toEqual([...WEAPON_IDS]);
    expect((build.skill as S).enum).toEqual([...SKILL_IDS]);
    expect(((props.imports as S).items as S).enum).toEqual(Object.keys(STARTER_LIBRARY));
  });
});

describe('rulebook', () => {
  const book = generateRulebook();

  // An outside LLM can only use what the rulebook names. Everything in the registry must be in it.
  it('documents every sensor, place, zone, move term, policy, weapon, skill and steering constant', () => {
    const names = [
      ...SENSORS.map((s) => s.name),
      ...FIGHTER_REFS.map((r) => r.name),
      ...PLACES.map((p) => p.name),
      ...ZONES.map((z) => z.name),
      ...MOVE_TERMS.map((t) => t.key),
      ...ATTACK_POLICIES.map((p) => p.name),
      ...WEAPON_IDS,
      ...SKILL_IDS,
      ...Object.keys(STEERING),
      ...Object.keys(GUARDS),
      ...Object.keys(STARTER_LIBRARY),
    ];
    const missing = names.filter((n) => !book.includes(n));
    expect(missing).toEqual([]);
  });

  // The LLM writing strategies has to know what fails the gate, and that a strategy cannot hang.
  it('explains validation, the budget and the runtime guards, and that expressions always finish', () => {
    expect(book).toContain('## Validation and safety');
    expect(book).toContain(`a think stops spending at ${GUARDS.costBudget} units`);
    expect(book).toContain('no loops, recursion');
    expect(book).toContain('## What a fighter knows');
    expect(book).toContain('### Sudden death');
    expect(book).toContain("Judges' decision");
  });

  it('prints the real numbers from the rule tables', () => {
    const gs = WEAPONS.GREATSWORD;
    expect(book).toContain(`| GREATSWORD | melee | ${gs.range} | ${gs.damage} | ${gs.cooldown} | ${gs.windup}/${gs.strike}/${gs.recovery} |`);
    expect(book).toContain('+0.25');
    expect(book).toContain(`throttle(x) = clamp((x - ${STEERING.throttleDead})`);
  });

  it('includes every starter behaviour as parseable JSON', () => {
    const blocks = [...book.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]!));
    for (const b of Object.values(STARTER_LIBRARY)) expect(blocks).toContainEqual(b);
  });
});

describe('buildLlmPrompt', () => {
  it('bundles rulebook, goal, strategy, report and answer rules', () => {
    const s = HOUSE_STACKS[2]!;
    const p = buildLlmPrompt({ strategy: s, reportText: 'Doug placed 7th. Killed most by Distant Cousin Pam.', goal: 'Beat archers.' });
    expect(p).toContain('<rulebook>');
    expect(p).toContain('Beat archers.');
    expect(p).toContain(formatJson(s));
    expect(JSON.parse(formatJson(s))).toEqual(s);
    expect(p).toContain('Killed most by Distant Cousin Pam');
    expect(p).toContain('"schema": "pit-strategy/2"');
  });

  // The library owns version numbers; a prompt that asks for "version N+1" made saved versions
  // look renumbered behind the player's back.
  it('leaves version numbering to the game', () => {
    const p = buildLlmPrompt({ strategy: HOUSE_STACKS[2]! });
    expect(p).toContain('Leave out "version"');
    expect(p).not.toMatch(/set "version" to/);
  });

  // Without an interview, models hand back the starter sample from the editor, lightly edited.
  it('makes the model interview the player before designing a new fighter', () => {
    const p = buildLlmPrompt({});
    expect(p).toMatch(/Design a brand-new fighter/);
    expect(p).toMatch(/interview the player/);
    expect(p).toMatch(/Name and personality/);
    expect(p).toMatch(/must never be copied/);
    expect(p).not.toContain('## Strategy open in the editor');
    expect(p).not.toContain('## Last battle report');
  });

  // The editor always has some strategy open, often an untouched sample: ask before improving it.
  it('asks whether to start fresh or improve when a strategy is open and no goal is given', () => {
    const s = HOUSE_STACKS[2]!;
    const p = buildLlmPrompt({ strategy: s });
    expect(p).toMatch(/starter sample/);
    expect(p).toMatch(/a brand-new fighter/);
    expect(p).toMatch(/Wait for the answer before writing JSON/);
    expect(p).toContain(`keep "name": ${JSON.stringify(s.name)}`);
  });

  // "New fighter with an LLM": the open strategy and its report stay out, or the model hands
  // back a lightly edited copy of whatever happened to be in the editor.
  it('designs from scratch in new mode even with a strategy open', () => {
    const s = HOUSE_STACKS[2]!;
    const p = buildLlmPrompt({ strategy: s, reportText: 'Doug placed 7th.', mode: 'new' });
    expect(p).toMatch(/Design a brand-new fighter/);
    expect(p).not.toMatch(/starter sample/);
    expect(p).not.toContain('## Strategy open in the editor');
    expect(p).not.toContain(formatJson(s));
    expect(p).not.toContain('Doug placed 7th.');
  });

  // "Improve this with an LLM": the player already chose, so the model asks what to change (using
  // the report) instead of asking whether to start over, and keeps the fighter's name.
  it('improves the open strategy with its report when asked to improve', () => {
    const s = HOUSE_STACKS[2]!;
    const p = buildLlmPrompt({ strategy: s, reportText: 'Doug placed 7th. Killed most by Distant Cousin Pam.', mode: 'improve' });
    expect(p).toMatch(/Improve the strategy below/);
    expect(p).toMatch(/drawn from the battle report/);
    expect(p).not.toMatch(/a brand-new fighter \(then run the interview/);
    expect(p).toContain(formatJson(s));
    expect(p).toContain('Killed most by Distant Cousin Pam');
    expect(p).toContain(`keep "name": ${JSON.stringify(s.name)}`);
    expect(p).toContain('Leave out "version"');
  });

  // The reply comes back through Import, which reads one ```json block in place.
  it('tells the model its whole reply is pasted back', () => {
    expect(buildLlmPrompt({ mode: 'new' })).toMatch(/pastes your whole reply back/);
  });
});
