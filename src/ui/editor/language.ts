// Owned by: ui
// What the strategy language means at each spot of the JSON: which kind of string a path holds
// (expression, place, zone, enum), which keys an object takes, and a lenient tokenizer for the
// expression language that labels every word it recognises. All of it is read from the brain
// registry and the generated JSON Schema, so the editor cannot disagree with the validator.
import { ATTRIBUTE_KEYS, SKILL_IDS, STRATEGY_SCHEMA, WEAPON_IDS } from '../../core';
import {
  ATTACK_POLICY_NAMES,
  ENEMIES_WORD,
  FIGHTER_REFS,
  FUNCTIONS,
  KEYWORDS,
  MOVE_TERMS,
  PICKUP_ARG_WORDS,
  PLACES,
  SENSORS,
  ZONES,
} from '../../brain';
import { BARK_KINDS, STARTER_NAMES, generateJsonSchema } from '../../strategy';
import type { JsonToken, PathSeg } from './jsontext';

export type ExprScope = 'target' | 'behaviour';

/** What a string value at a path is. */
export type Slot =
  | { kind: 'expr'; scope: ExprScope }
  /** `attack`: a policy word or an expression. */
  | { kind: 'attack' }
  | { kind: 'place' }
  | { kind: 'zone' }
  | { kind: 'enum'; of: EnumKind }
  | { kind: 'text' };

export type EnumKind = 'weapon' | 'skill' | 'stance' | 'starter' | 'direction' | 'schema';

export const STANCE_WORDS = ['normal', 'creep', 'guard'] as const;
export const DIRECTION_WORDS = ['cw', 'ccw'] as const;

export const ENUM_VALUES: Readonly<Record<EnumKind, readonly string[]>> = {
  weapon: WEAPON_IDS,
  skill: SKILL_IDS,
  stance: STANCE_WORDS,
  starter: STARTER_NAMES,
  direction: DIRECTION_WORDS,
  schema: [STRATEGY_SCHEMA],
};

const TERM_PLACE = new Set(['seek', 'flee']);
const TERM_ZONE = new Set(['avoid', 'prefer']);

/** The meaning of the string value at `path`. */
export function slotOf(path: readonly PathSeg[]): Slot {
  const [a, b, c, d, e, f] = path;
  if (path.length === 1 && a === 'target') return { kind: 'expr', scope: 'target' };
  if (path.length === 1 && a === 'schema') return { kind: 'enum', of: 'schema' };
  if (a === 'build' && path.length === 2) {
    if (b === 'weapon') return { kind: 'enum', of: 'weapon' };
    if (b === 'skill') return { kind: 'enum', of: 'skill' };
  }
  if (a === 'imports' && path.length === 2) return { kind: 'enum', of: 'starter' };
  if (a === 'behaviours' && typeof b === 'string') {
    if (path.length === 3) {
      if (c === 'score' || c === 'skill') return { kind: 'expr', scope: 'behaviour' };
      if (c === 'attack') return { kind: 'attack' };
      if (c === 'stance') return { kind: 'enum', of: 'stance' };
    }
    if (c === 'set' && path.length === 4) return { kind: 'expr', scope: 'behaviour' };
    if (c === 'move' && typeof d === 'number' && typeof e === 'string') {
      if (path.length === 5 && TERM_PLACE.has(e)) return { kind: 'place' };
      if (path.length === 5 && TERM_ZONE.has(e)) return { kind: 'zone' };
      if (path.length === 6 && (e === 'keep_range' || e === 'orbit') && f === 0) return { kind: 'place' };
      if (path.length === 6 && e === 'orbit' && f === 1) return { kind: 'enum', of: 'direction' };
    }
  }
  return { kind: 'text' };
}

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

type SchemaNode = { properties?: Record<string, SchemaNode>; required?: string[]; description?: string; oneOf?: SchemaNode[]; $ref?: string };

let keyTables: { top: SchemaNode; build: SchemaNode; behaviour: SchemaNode; terms: string[] } | null = null;

function tables() {
  if (keyTables) return keyTables;
  const s = generateJsonSchema() as SchemaNode & { $defs: Record<string, SchemaNode> };
  const props = s.properties!;
  keyTables = {
    top: s,
    build: props.build!,
    behaviour: s.$defs.behaviour!,
    terms: MOVE_TERMS.map((t) => t.key),
  };
  return keyTables;
}

export type KeyOption = { key: string; required: boolean };

/**
 * Keys the object at `objectPath` takes, from the JSON Schema. Null for objects whose keys are
 * free names (behaviours, memory slots).
 */
export function keysFor(objectPath: readonly PathSeg[]): KeyOption[] | null {
  const t = tables();
  const fromSchema = (n: SchemaNode) => Object.keys(n.properties ?? {}).map((key) => ({ key, required: (n.required ?? []).includes(key) }));
  const [a, b, c, d] = objectPath;
  if (objectPath.length === 0) return fromSchema(t.top);
  if (a === 'build' && objectPath.length === 1) return fromSchema(t.build);
  if (a === 'build' && b === 'attributes' && objectPath.length === 2) return ATTRIBUTE_KEYS.map((key) => ({ key, required: true }));
  if (a === 'look' && objectPath.length === 1) return [{ key: 'color', required: false }, { key: 'glyph', required: false }];
  if (a === 'barks' && objectPath.length === 1) return BARK_KINDS.map((key) => ({ key, required: false }));
  if (a === 'behaviours' && objectPath.length === 2) return fromSchema(t.behaviour);
  if (a === 'behaviours' && c === 'move' && typeof d === 'number' && objectPath.length === 4) {
    return [...t.terms.map((key) => ({ key, required: false })), { key: 'weight', required: true }];
  }
  return null;
}

/** Memory slot names declared in the text (`memory` keys), read from the scan so it works mid-edit. */
export function memoryNames(tokens: readonly JsonToken[]): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) if (t.kind === 'key' && t.path.length === 2 && t.path[0] === 'memory') out.add(String(t.path[1]));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------------------------

export type ExprTokenKind = 'num' | 'name' | 'op' | 'open' | 'close' | 'comma' | 'bad';
export type ExprToken = { kind: ExprTokenKind; from: number; to: number; text: string };

const NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/;
const NUM = /^(?:\d+\.?\d*|\.\d+)/;
const OPS = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '<', '>', '!', '=', '%', '^', '?', ':'];

/** Tokens of an expression, place or zone. Never throws: what it cannot read becomes `bad`. */
export function lexExpr(src: string): ExprToken[] {
  const out: ExprToken[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    const rest = src.slice(i, i + 200);
    const num = NUM.exec(rest);
    if (num) {
      out.push({ kind: 'num', from: i, to: i + num[0].length, text: num[0] });
      i += num[0].length;
      continue;
    }
    const name = NAME.exec(rest);
    if (name) {
      out.push({ kind: 'name', from: i, to: i + name[0].length, text: name[0] });
      i += name[0].length;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ',') {
      out.push({ kind: ch === '(' ? 'open' : ch === ')' ? 'close' : 'comma', from: i, to: i + 1, text: ch });
      i++;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    const len = op ? op.length : 1;
    out.push({ kind: op ? 'op' : 'bad', from: i, to: i + len, text: src.slice(i, i + len) });
    i += len;
  }
  return out;
}

/** What a recognised word is. Matches the lexicon's entry kinds. */
export type WordKind =
  | 'sensor'
  | 'fighter-sensor'
  | 'memory'
  | 'function'
  | 'keyword'
  | 'policy'
  | 'fighter'
  | 'enemies'
  | 'place'
  | 'zone'
  | 'pickup-word';

const SENSOR_SCOPE = new Map(SENSORS.map((s) => [s.name, s.scope]));
const FIGHTER_WORDS = new Set(FIGHTER_REFS.map((r) => r.name));
const PLACE_WORDS = new Set(PLACES.map((p) => p.name));
const ZONE_WORDS = new Set(ZONES.map((z) => z.name));
const PICKUP_WORDS = new Set<string>(PICKUP_ARG_WORDS);

/**
 * What `word` means in this slot, or null when it means nothing here (unknown, or valid only
 * elsewhere: the validator explains those). `memory` is the set of declared slots.
 */
export function wordKind(word: string, slot: Slot, memory: ReadonlySet<string>): WordKind | null {
  if (slot.kind === 'expr' || slot.kind === 'attack') {
    const scope = SENSOR_SCOPE.get(word);
    if (scope) {
      const inTarget = slot.kind === 'expr' && slot.scope === 'target';
      if (scope === 'self') return 'sensor';
      return (scope === 'it') === inTarget ? 'fighter-sensor' : null;
    }
    if (memory.has(word)) return 'memory';
    if (Object.hasOwn(FUNCTIONS, word)) return 'function';
    if (KEYWORDS.includes(word)) return 'keyword';
    if (slot.kind === 'attack' && ATTACK_POLICY_NAMES.includes(word)) return 'policy';
    return null;
  }
  if (slot.kind === 'place' || slot.kind === 'zone') {
    if (FIGHTER_WORDS.has(word)) return 'fighter';
    if (word === ENEMIES_WORD) return 'enemies';
    if (PICKUP_WORDS.has(word)) return 'pickup-word';
    if (slot.kind === 'place' && PLACE_WORDS.has(word)) return 'place';
    if (slot.kind === 'zone' && ZONE_WORDS.has(word)) return 'zone';
  }
  return null;
}

/** Names that may start a word in an expression of this scope, for completion. */
export function expressionWords(scope: ExprScope, memory: Iterable<string>): { word: string; kind: WordKind }[] {
  const out: { word: string; kind: WordKind }[] = [];
  for (const s of SENSORS) {
    if (s.scope === 'self') out.push({ word: s.name, kind: 'sensor' });
    else if ((s.scope === 'it') === (scope === 'target')) out.push({ word: s.name, kind: 'fighter-sensor' });
  }
  for (const m of memory) out.push({ word: m, kind: 'memory' });
  for (const f of Object.keys(FUNCTIONS)) out.push({ word: f, kind: 'function' });
  for (const k of KEYWORDS) out.push({ word: k, kind: 'keyword' });
  return out;
}
