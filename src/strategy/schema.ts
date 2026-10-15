/**
 * JSON Schema (draft 2020-12) for pit-strategy/2, generated from the core tables and the brain
 * registry. It describes shape and limits; expression, place and zone strings are checked by the
 * validator (a schema cannot parse them), so their descriptions list the vocabulary instead.
 *
 * Published as `public/pit-strategy-2.schema.json` (served at SCHEMA_PATH), so a strategy file can
 * say `"$schema": "/pit-strategy-2.schema.json"` and editors check it while it is typed. A test
 * keeps the published file equal to this; regenerate it with
 * `npx tsx scripts/lint-strategy.ts --write-schema`.
 */

import {
  ATTRIBUTE_BUDGET,
  ATTRIBUTE_DOCS,
  ATTRIBUTE_KEYS,
  ATTRIBUTE_MAX,
  ATTRIBUTE_MIN,
  BARK_RULES,
  MAX_BEHAVIOURS,
  MAX_MEMORY_SLOTS,
  MAX_MOVE_TERMS,
  SKILLS,
  SKILL_IDS,
  STRATEGY_SCHEMA,
  WEAPONS,
  WEAPON_IDS,
} from '../core';
import { ATTACK_POLICY_NAMES, FIGHTER_REFS, FUNCTIONS, MOVE_TERMS, PICKUP_ARG_WORDS, PLACES, SENSORS, ZONES } from '../brain';
import { STARTER_NAMES } from './library';
import { BARK_KINDS, LIMITS, STANCE_NAMES } from './validate';

type Json = Record<string, unknown>;

/** Where the generated schema is published (relative to the site root, from `public/`). */
export const SCHEMA_PATH = 'pit-strategy-2.schema.json';

function signature(name: string, args: readonly { name: string }[]): string {
  return args.length ? `${name}(${args.map((a) => a.name).join(', ')})` : name;
}

export function generateJsonSchema(): Record<string, unknown> {
  const ident = `^[a-z][a-z0-9_]{0,${LIMITS.identLength - 1}}$`;
  const sensorList = SENSORS.filter((s) => s.scope !== 'it').map((s) => s.name).join(', ');
  const itList = SENSORS.filter((s) => s.scope === 'it').map((s) => s.name).join(', ');
  const placeList = [...FIGHTER_REFS.map((r) => r.name), ...PLACES.map((p) => signature(p.name, p.args))].join(', ');
  const zoneList = ZONES.map((z) => signature(z.name, z.args)).join(', ');
  const ops = '+ - * / < <= > >= == != and or not, parentheses, numbers, true/false';
  const fns = Object.values(FUNCTIONS).map((f) => f.signature).join(', ');

  const term = (key: string, value: Json, description: string): Json => ({
    type: 'object',
    description,
    additionalProperties: false,
    required: [key],
    properties: {
      [key]: value,
      weight: { type: 'number', minimum: 0, maximum: LIMITS.weightMax, default: 1, description: 'How much this term counts in the steering sum.' },
    },
  });
  const termDoc = (key: string) => MOVE_TERMS.find((t) => t.key === key)?.doc ?? '';

  const barkLine = { type: 'string', minLength: 1, maxLength: BARK_RULES.maxLength };

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:pit-of-carnage:strategy:pit-strategy-2',
    title: 'Pit of Carnage strategy (pit-strategy/2)',
    description: 'A fighter build plus behaviours written in a small expression language. See the rulebook for exact semantics.',
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'name', 'build', 'target', 'behaviours', 'commit'],
    properties: {
      $schema: { type: 'string', description: `Optional link to this JSON Schema for editors (e.g. "/${SCHEMA_PATH}"). The game ignores it.` },
      schema: { const: STRATEGY_SCHEMA },
      name: { type: 'string', minLength: 1, maxLength: LIMITS.nameLength, description: 'Also the fighter\'s name in the arena.' },
      author: { type: 'string', minLength: 1, maxLength: LIMITS.nameLength },
      version: { type: 'integer', minimum: 1, default: 1, description: 'Bump it when you change the strategy; reports identify strategies as name@vN.' },
      build: {
        type: 'object',
        additionalProperties: false,
        required: ['weapon', 'skill', 'attributes'],
        properties: {
          weapon: { enum: [...WEAPON_IDS], description: WEAPON_IDS.map((w) => `${w}: ${WEAPONS[w].doc}`).join(' ') },
          skill: { enum: [...SKILL_IDS], description: SKILL_IDS.map((s) => `${s}: ${SKILLS[s].doc}`).join(' ') },
          attributes: {
            type: 'object',
            description: `Each attribute ${ATTRIBUTE_MIN}-${ATTRIBUTE_MAX}; the six together may not exceed ${ATTRIBUTE_BUDGET}.`,
            additionalProperties: false,
            required: [...ATTRIBUTE_KEYS],
            properties: Object.fromEntries(
              ATTRIBUTE_KEYS.map((k) => [k, { type: 'integer', minimum: ATTRIBUTE_MIN, maximum: ATTRIBUTE_MAX, description: ATTRIBUTE_DOCS[k] }]),
            ),
          },
        },
      },
      target: {
        $ref: '#/$defs/expression',
        description: `Rates each known enemy; the highest becomes the target. Use it.* sensors here: ${itList}.`,
      },
      behaviours: {
        type: 'object',
        description: `At most ${MAX_BEHAVIOURS} including imports. Each think the highest score runs.`,
        maxProperties: MAX_BEHAVIOURS,
        propertyNames: { pattern: ident },
        additionalProperties: { $ref: '#/$defs/behaviour' },
      },
      imports: {
        type: 'array',
        description: 'Starter-library behaviours to include by name. Your own behaviour with the same name wins.',
        uniqueItems: true,
        items: { enum: [...STARTER_NAMES] },
      },
      memory: {
        type: 'object',
        description: `Up to ${MAX_MEMORY_SLOTS} named numbers with starting values; read them by name in expressions, write them with "set".`,
        maxProperties: MAX_MEMORY_SLOTS,
        propertyNames: { pattern: ident },
        additionalProperties: { type: 'number' },
      },
      commit: {
        type: 'integer',
        minimum: 0,
        maximum: LIMITS.commitMax,
        default: LIMITS.commitDefault,
        description: 'Ticks (60 per second) a newly chosen behaviour keeps a +0.25 score bonus, so close scores do not flip-flop.',
      },
      barks: {
        type: 'object',
        additionalProperties: false,
        description: 'Lines the fighter shouts. One line or a list per kind.',
        properties: Object.fromEntries(
          BARK_KINDS.map((k) => [k, { oneOf: [barkLine, { type: 'array', minItems: 1, maxItems: LIMITS.barkLinesPerKind, items: barkLine }] }]),
        ),
      },
      look: {
        type: 'object',
        additionalProperties: false,
        properties: {
          color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'Preferred fighter colour (the match may assign another to keep colours distinct).' },
          glyph: { type: 'string', minLength: 1, maxLength: LIMITS.glyphLength },
        },
      },
    },
    $defs: {
      expression: {
        type: 'string',
        minLength: 1,
        description: `Expression. Operators: ${ops}. Functions: ${fns}. Booleans are 1/0; above 0 counts as true. Sensors: ${sensorList}. Memory slots by name.`,
      },
      place: { type: 'string', minLength: 1, description: `A place: ${placeList}. Fighter arguments take ${FIGHTER_REFS.map((r) => r.name).join(', ')}; the K of pickup(K) is ${PICKUP_ARG_WORDS.join(', ')}.`, examples: ['target', 'behind(target, 36)', 'cover_from(enemies)', 'search_point', 'pickup(berserk)'] },
      zone: { type: 'string', minLength: 1, description: `A zone: ${zoneList}.`, examples: ['shadow', 'seen_by(enemies)', 'hazards', 'outside_zone'] },
      moveTerm: {
        oneOf: [
          term('seek', { $ref: '#/$defs/place' }, termDoc('seek')),
          term('flee', { $ref: '#/$defs/place' }, termDoc('flee')),
          term('keep_range', {
            type: 'array',
            prefixItems: [{ $ref: '#/$defs/place' }, { type: 'number', minimum: 0, maximum: LIMITS.rangeMax }, { type: 'number', minimum: 0, maximum: LIMITS.rangeMax }],
            minItems: 3,
            maxItems: 3,
          }, termDoc('keep_range')),
          term('orbit', { type: 'array', prefixItems: [{ $ref: '#/$defs/place' }, { enum: ['cw', 'ccw'] }], minItems: 2, maxItems: 2 }, termDoc('orbit')),
          term('avoid', { $ref: '#/$defs/zone' }, termDoc('avoid')),
          term('prefer', { $ref: '#/$defs/zone' }, termDoc('prefer')),
        ],
      },
      behaviour: {
        type: 'object',
        additionalProperties: false,
        required: ['score', 'move', 'attack'],
        properties: {
          score: { $ref: '#/$defs/expression', description: 'How much this behaviour wants to run right now (about 0..1).' },
          move: { type: 'array', maxItems: MAX_MOVE_TERMS, items: { $ref: '#/$defs/moveTerm' } },
          attack: { type: 'string', minLength: 1, description: `${ATTACK_POLICY_NAMES.join(', ')}, or an expression (above 0 = attack the target).` },
          skill: { $ref: '#/$defs/expression', description: 'Use the skill when this is above 0 and the skill is ready. Leave out to never use it.' },
          set: { type: 'object', propertyNames: { pattern: ident }, additionalProperties: { $ref: '#/$defs/expression' }, description: 'Memory writes applied every think while this behaviour runs.' },
          stance: { enum: [...STANCE_NAMES], default: 'normal' },
        },
      },
    },
  };
}
