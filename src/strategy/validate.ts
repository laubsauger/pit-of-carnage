/**
 * Strategy validation. Three passes: a structural pass (shape, known names, limits, attribute
 * budget) that also builds the normalized strategy; the brain's own compiler over every
 * structurally sound part, so expression, place and zone errors come back in the same list; and,
 * once both are clean, the static analysis (analyze.ts: value ranges, lint, evaluation budget).
 * Every issue is one line with a path and, for unknown names, a "did you mean"; when the strategy
 * came as text, also the line and column it is about.
 */

import {
  ATTRIBUTE_BUDGET,
  ATTRIBUTE_KEYS,
  ATTRIBUTE_MAX,
  ATTRIBUTE_MIN,
  BARK_RULES,
  MAX_BEHAVIOURS,
  MAX_MEMORY_SLOTS,
  MAX_MOVE_TERMS,
  SKILL_IDS,
  STRATEGY_SCHEMA,
  WEAPON_IDS,
  attributeTotal,
  deriveStats,
} from '../core';
import type { Attributes, BarkKind, Behaviour, DerivedStats, MoveTerm, SkillId, Stance, Strategy, ValidationIssue, ValidationResult, WeaponId } from '../core';
import { GUARDS, compileStrategy, didYouMean } from '../brain';
import { analyzeStrategy } from './analyze';
import { lineColumn, stringCharOffset } from './json';
import type { JsonSpot } from './json';
import { STARTER_LIBRARY, STARTER_NAMES, mergeBehaviours } from './library';

export const BARK_KINDS: readonly BarkKind[] = ['spawn', 'kill', 'hit', 'low_hp', 'death', 'skill', 'taunt'];
export const STANCE_NAMES: readonly Stance[] = ['normal', 'creep', 'guard'];
export const TERM_KEYS = ['seek', 'flee', 'keep_range', 'orbit', 'avoid', 'prefer'] as const;

/** Limits the validator enforces beyond the core constants (documented in the rulebook). */
export const LIMITS = {
  nameLength: 40,
  identLength: 24,
  weightMax: GUARDS.weightLimit,
  rangeMax: 2000,
  commitMax: 600,
  commitDefault: 30,
  barkLinesPerKind: 8,
  glyphLength: 2,
} as const;

const IDENT = /^[a-z][a-z0-9_]*$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

/** `$schema` lets editors find the published JSON Schema; the game ignores it. */
const TOP_KEYS = ['$schema', 'schema', 'name', 'author', 'version', 'build', 'target', 'behaviours', 'imports', 'memory', 'commit', 'barks', 'look'];
const BUILD_KEYS = ['weapon', 'skill', 'attributes'];
const BEHAVIOUR_KEYS = ['score', 'move', 'attack', 'skill', 'set', 'stance'];
const LOOK_KEYS = ['color', 'glyph'];

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a list';
  return typeof v === 'object' ? 'an object' : `a ${typeof v}`;
}

/** Where the strategy text came from, for line and column (see `readJson`). */
export type SourceText = { text: string; spots: ReadonlyMap<string, JsonSpot> };

/** What an issue points at: the key of `path` (unknown fields), or a character of its string value. */
type IssueAt = { key?: boolean; pos?: number };

function parentPath(path: string): string {
  const dot = path.lastIndexOf('.');
  const bracket = path.lastIndexOf('[');
  return path.slice(0, Math.max(dot, bracket, 0));
}

/** Line and column for an issue: its own spot, or the nearest enclosing one that exists in the text. */
function locateIssue(src: SourceText, path: string, at: IssueAt = {}): { line: number; column: number } | null {
  for (let p = path; ; p = parentPath(p)) {
    const spot = src.spots.get(p);
    if (spot) {
      if (p !== path) return lineColumn(src.text, spot.start);
      if (at.key && spot.keyStart !== undefined) return lineColumn(src.text, spot.keyStart);
      if (at.pos !== undefined && src.text[spot.start] === '"') return lineColumn(src.text, stringCharOffset(src.text, spot.start, at.pos));
      return lineColumn(src.text, spot.start);
    }
    if (!p) return null;
  }
}

class Collector {
  readonly issues: ValidationIssue[] = [];
  constructor(private readonly src: SourceText | null) {}
  private add(issue: ValidationIssue, at?: IssueAt): void {
    // Messages quote the player's own text, which may hold line breaks: keep every message one line.
    const message = issue.message.replace(/[\u0000-\u001f\u2028\u2029]/g, (ch) => (ch === '\n' ? '\\n' : ch === '\t' ? '\\t' : ' '));
    const where = this.src ? locateIssue(this.src, issue.path, at) : null;
    this.issues.push(where ? { ...issue, message, line: where.line, column: where.column } : { ...issue, message });
  }
  error(path: string, message: string, suggestion?: string, at?: IssueAt): void {
    this.add(suggestion ? { path, message, suggestion, severity: 'error' } : { path, message, severity: 'error' }, at);
  }
  warn(path: string, message: string, at?: IssueAt): void {
    this.add({ path, message, severity: 'warning' }, at);
  }
  get errorCount(): number {
    return this.issues.filter((i) => i.severity === 'error').length;
  }
}

function checkKeys(o: Obj, allowed: readonly string[], path: string, out: Collector): void {
  for (const k of Object.keys(o)) {
    if (allowed.includes(k)) continue;
    const hint = didYouMean(k, allowed);
    out.error(path ? `${path}.${k}` : k, `Unknown field "${k}"${hint ? '' : `; allowed here: ${allowed.join(', ')}`}.`, hint, { key: true });
  }
}

function enumValue<T extends string>(v: unknown, values: readonly T[], path: string, what: string, out: Collector): T | null {
  if (typeof v === 'string' && (values as readonly string[]).includes(v)) return v as T;
  if (typeof v !== 'string') {
    out.error(path, `${what} must be one of ${values.join(', ')}; got ${typeName(v)}.`);
    return null;
  }
  const upper = values.find((x) => x.toLowerCase() === v.toLowerCase());
  out.error(path, `Unknown ${what.toLowerCase()} "${v}". Choose one of ${values.join(', ')}.`, upper ?? didYouMean(v, values));
  return null;
}

function numberIn(v: unknown, lo: number, hi: number, path: string, what: string, out: Collector, integer = false): number | null {
  if (typeof v !== 'number') {
    out.error(path, `${what} must be a number; got ${typeName(v)}.`);
    return null;
  }
  if (!Number.isFinite(v)) {
    out.error(path, `${what} must be a finite number between ${lo} and ${hi}; got ${v}.`);
    return null;
  }
  if (integer && !Number.isInteger(v)) {
    out.error(path, `${what} must be a whole number; got ${v}.`);
    return null;
  }
  if (v < lo || v > hi) {
    out.error(path, `${what} must be between ${lo} and ${hi}; got ${v}.`);
    return null;
  }
  return v;
}

function stringField(v: unknown, path: string, what: string, out: Collector, maxLen?: number): string | null {
  if (typeof v !== 'string' || v.trim().length === 0) {
    out.error(path, `${what} must be a non-empty string; got ${typeof v === 'string' ? 'an empty string' : typeName(v)}.`);
    return null;
  }
  if (maxLen !== undefined && v.length > maxLen) {
    out.error(path, `${what} is ${v.length} characters; the limit is ${maxLen}.`);
    return null;
  }
  return v;
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

export type BuildPrice = {
  spent: number;
  left: number;
  budget: number;
  /** Every attribute in range and the total within budget. */
  legal: boolean;
  stats: DerivedStats;
};

/** What a build costs and what it buys (editor meter, rulebook examples). */
export function priceBuild(build: { weapon: WeaponId; attributes: Attributes }): BuildPrice {
  const spent = attributeTotal(build.attributes);
  const inRange = ATTRIBUTE_KEYS.every((k) => {
    const v = build.attributes[k];
    return Number.isFinite(v) && v >= ATTRIBUTE_MIN && v <= ATTRIBUTE_MAX;
  });
  return {
    spent,
    left: ATTRIBUTE_BUDGET - spent,
    budget: ATTRIBUTE_BUDGET,
    legal: inRange && spent <= ATTRIBUTE_BUDGET,
    stats: deriveStats(build.attributes, build.weapon),
  };
}

function checkBuild(v: unknown, out: Collector): Strategy['build'] | null {
  if (!isObj(v)) {
    out.error('build', `"build" must be an object with weapon, skill and attributes; got ${typeName(v)}.`);
    return null;
  }
  checkKeys(v, BUILD_KEYS, 'build', out);
  const weapon = enumValue<WeaponId>(v.weapon, WEAPON_IDS, 'build.weapon', 'Weapon', out);
  const skill = enumValue<SkillId>(v.skill, SKILL_IDS, 'build.skill', 'Skill', out);
  const a = v.attributes;
  if (!isObj(a)) {
    out.error('build.attributes', `"attributes" must be an object with ${ATTRIBUTE_KEYS.join(', ')}; got ${typeName(a)}.`);
    return null;
  }
  checkKeys(a, ATTRIBUTE_KEYS, 'build.attributes', out);
  const attrs = {} as Attributes;
  let complete = true;
  for (const k of ATTRIBUTE_KEYS) {
    if (!(k in a)) {
      out.error(`build.attributes.${k}`, `Missing attribute "${k}" (${ATTRIBUTE_MIN}-${ATTRIBUTE_MAX}).`);
      complete = false;
      continue;
    }
    const n = numberIn(a[k], ATTRIBUTE_MIN, ATTRIBUTE_MAX, `build.attributes.${k}`, `Attribute ${k}`, out, true);
    if (n === null) complete = false;
    else attrs[k] = n;
  }
  if (complete) {
    const total = attributeTotal(attrs);
    if (total > ATTRIBUTE_BUDGET) {
      out.error('build.attributes', `Attributes add up to ${total}; the budget is ${ATTRIBUTE_BUDGET} (${total - ATTRIBUTE_BUDGET} over).`);
    } else if (total < ATTRIBUTE_BUDGET) {
      out.warn('build.attributes', `${ATTRIBUTE_BUDGET - total} attribute point${ATTRIBUTE_BUDGET - total === 1 ? '' : 's'} unspent.`);
    }
  }
  if (!weapon || !skill || !complete) return null;
  return { weapon, skill, attributes: attrs };
}

// ---------------------------------------------------------------------------------------------
// Behaviours
// ---------------------------------------------------------------------------------------------

function checkTerm(v: unknown, path: string, out: Collector): MoveTerm | null {
  if (!isObj(v)) {
    out.error(path, `A move term must be an object like {"seek": "target", "weight": 1}; got ${typeName(v)}.`);
    return null;
  }
  const kinds = TERM_KEYS.filter((k) => k in v);
  for (const k of Object.keys(v)) {
    if (k === 'weight' || (TERM_KEYS as readonly string[]).includes(k)) continue;
    out.error(`${path}.${k}`, `Unknown field "${k}" in a move term.`, didYouMean(k, [...TERM_KEYS, 'weight']), { key: true });
  }
  if (kinds.length !== 1) {
    out.error(path, kinds.length === 0 ? `A move term needs one of ${TERM_KEYS.join(', ')}.` : `A move term has exactly one kind; this one has ${kinds.join(' and ')}.`);
    return null;
  }
  let weight = 1;
  if ('weight' in v) {
    const w = numberIn(v.weight, 0, LIMITS.weightMax, `${path}.weight`, 'Weight', out);
    if (w === null) return null;
    weight = w;
  }
  const kind = kinds[0]!;
  const arg = v[kind];
  switch (kind) {
    case 'seek':
    case 'flee':
    case 'avoid':
    case 'prefer': {
      const what = kind === 'avoid' || kind === 'prefer' ? 'a zone such as "shadow" or "seen_by(enemies)"' : 'a place such as "target" or "behind(target, 40)"';
      if (typeof arg !== 'string') {
        out.error(`${path}.${kind}`, `"${kind}" takes ${what}; got ${typeName(arg)}.`);
        return null;
      }
      return { [kind]: arg, weight } as MoveTerm;
    }
    case 'keep_range': {
      if (!Array.isArray(arg) || arg.length !== 3 || typeof arg[0] !== 'string') {
        out.error(`${path}.keep_range`, '"keep_range" takes [place, min, max], e.g. ["target", 180, 260].');
        return null;
      }
      const min = numberIn(arg[1], 0, LIMITS.rangeMax, `${path}.keep_range[1]`, 'keep_range min', out);
      const max = numberIn(arg[2], 0, LIMITS.rangeMax, `${path}.keep_range[2]`, 'keep_range max', out);
      if (min === null || max === null) return null;
      if (min > max) {
        out.error(`${path}.keep_range`, `keep_range min (${min}) is larger than max (${max}).`);
        return null;
      }
      return { keep_range: [arg[0], min, max], weight };
    }
    case 'orbit': {
      if (!Array.isArray(arg) || arg.length !== 2 || typeof arg[0] !== 'string') {
        out.error(`${path}.orbit`, '"orbit" takes [place, "cw" | "ccw"], e.g. ["target", "cw"].');
        return null;
      }
      const dir = enumValue<'cw' | 'ccw'>(arg[1], ['cw', 'ccw'], `${path}.orbit[1]`, 'Orbit direction', out);
      if (!dir) return null;
      return { orbit: [arg[0], dir], weight };
    }
  }
}

function checkBehaviour(v: unknown, path: string, out: Collector): Behaviour | null {
  if (!isObj(v)) {
    out.error(path, `A behaviour must be an object with score, move and attack; got ${typeName(v)}.`);
    return null;
  }
  const before = out.errorCount;
  checkKeys(v, BEHAVIOUR_KEYS, path, out);
  let score = '';
  if (typeof v.score === 'string') score = v.score;
  else out.error(`${path}.score`, `"score" must be an expression string, e.g. "0.5 + 0.5 * target.facing_away"; got ${typeName(v.score)}.`);
  let move: MoveTerm[] = [];
  if (!Array.isArray(v.move)) {
    out.error(`${path}.move`, `"move" must be a list of move terms (it may be empty); got ${typeName(v.move)}.`);
  } else {
    if (v.move.length > MAX_MOVE_TERMS) out.error(`${path}.move`, `${v.move.length} move terms; the limit is ${MAX_MOVE_TERMS}.`);
    move = v.move.map((t, i) => checkTerm(t, `${path}.move[${i}]`, out)).filter((t): t is MoveTerm => t !== null);
  }
  let attack = 'in_range';
  if (!('attack' in v)) out.warn(`${path}.attack`, 'No attack policy; using "in_range".');
  else if (typeof v.attack === 'string' && v.attack.trim()) attack = v.attack.trim();
  else out.error(`${path}.attack`, `"attack" must be in_range, never, if_blocked or an expression; got ${typeName(v.attack)}.`);
  const b: Behaviour = { score, move, attack };
  if ('skill' in v) {
    if (typeof v.skill === 'string') b.skill = v.skill;
    else out.error(`${path}.skill`, `"skill" must be an expression string, e.g. "enemies_near >= 2"; got ${typeName(v.skill)}.`);
  }
  if ('set' in v) {
    if (!isObj(v.set)) out.error(`${path}.set`, `"set" must map memory slots to expressions; got ${typeName(v.set)}.`);
    else {
      const set: Record<string, string> = {};
      for (const [slot, src] of Object.entries(v.set)) {
        if (typeof src === 'string') set[slot] = src;
        else out.error(`${path}.set.${slot}`, `Memory writes are expression strings; got ${typeName(src)}.`);
      }
      b.set = set;
    }
  }
  if ('stance' in v) {
    const stance = enumValue<Stance>(v.stance, STANCE_NAMES, `${path}.stance`, 'Stance', out);
    if (stance) b.stance = stance;
  }
  return out.errorCount === before ? b : null;
}

// ---------------------------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------------------------

function checkBarks(v: unknown, out: Collector): Strategy['barks'] {
  if (!isObj(v)) {
    out.error('barks', `"barks" must map kinds (${BARK_KINDS.join(', ')}) to lines; got ${typeName(v)}.`);
    return undefined;
  }
  const barks: NonNullable<Strategy['barks']> = {};
  for (const [kind, lines] of Object.entries(v)) {
    if (!(BARK_KINDS as readonly string[]).includes(kind)) {
      out.error(`barks.${kind}`, `Unknown bark kind "${kind}". Kinds: ${BARK_KINDS.join(', ')}.`, didYouMean(kind, BARK_KINDS), { key: true });
      continue;
    }
    const list = typeof lines === 'string' ? [lines] : lines;
    if (!Array.isArray(list) || list.some((l) => typeof l !== 'string')) {
      out.error(`barks.${kind}`, 'Bark lines must be a string or a list of strings.');
      continue;
    }
    if (list.length > LIMITS.barkLinesPerKind) out.error(`barks.${kind}`, `${list.length} lines; the limit is ${LIMITS.barkLinesPerKind}.`);
    list.forEach((l: string, i) => {
      if (l.trim().length === 0) out.error(`barks.${kind}[${i}]`, 'Bark lines cannot be empty.');
      else if (l.length > BARK_RULES.maxLength) out.error(`barks.${kind}[${i}]`, `Bark is ${l.length} characters; the limit is ${BARK_RULES.maxLength}.`);
    });
    barks[kind as BarkKind] = typeof lines === 'string' ? lines : [...list];
  }
  return barks;
}

function checkLook(v: unknown, out: Collector): Strategy['look'] {
  if (!isObj(v)) {
    out.error('look', `"look" must be an object with color and glyph; got ${typeName(v)}.`);
    return undefined;
  }
  checkKeys(v, LOOK_KEYS, 'look', out);
  const look: NonNullable<Strategy['look']> = {};
  if ('color' in v) {
    if (typeof v.color === 'string' && COLOR.test(v.color)) look.color = v.color;
    else out.error('look.color', `"color" must be a hex colour like "#56B4E9"; got ${JSON.stringify(v.color)}.`);
  }
  if ('glyph' in v) {
    if (typeof v.glyph === 'string' && [...v.glyph].length >= 1 && [...v.glyph].length <= LIMITS.glyphLength) look.glyph = v.glyph;
    else out.error('look.glyph', `"glyph" must be 1-${LIMITS.glyphLength} characters; got ${JSON.stringify(v.glyph)}.`);
  }
  return look;
}

/**
 * Validate a parsed strategy document. Returns every problem found (errors and warnings) and,
 * when there are no errors, the normalized strategy: defaults filled (version 1, weight 1,
 * attack "in_range", commit 30), imports kept as names, `$schema` dropped, nothing aliased to the
 * input. With `source` (the text it was read from), issues carry line and column.
 * Never throws for any input.
 */
export function validateStrategy(input: unknown, source?: SourceText): ValidationResult {
  const out = new Collector(source ?? null);
  if (!isObj(input)) {
    out.error('', `A strategy must be a JSON object; got ${typeName(input)}.`);
    return { ok: false, issues: out.issues };
  }
  const o = input;
  checkKeys(o, TOP_KEYS, '', out);
  if ('$schema' in o && typeof o.$schema !== 'string') out.error('$schema', `"$schema" is for editors and must be a string (a link to the JSON Schema); got ${typeName(o.$schema)}.`);

  if (o.schema !== STRATEGY_SCHEMA) {
    if (o.schema === undefined) out.error('schema', `Missing "schema"; it must be "${STRATEGY_SCHEMA}".`, STRATEGY_SCHEMA);
    else out.error('schema', `Schema is ${JSON.stringify(o.schema)}; this game reads "${STRATEGY_SCHEMA}".`, STRATEGY_SCHEMA);
  }
  const name = stringField(o.name, 'name', 'Name', out, LIMITS.nameLength) ?? '';
  const s: Strategy = {
    schema: STRATEGY_SCHEMA,
    name: name.trim(),
    build: { weapon: 'GREATSWORD', skill: 'WHIRLWIND', attributes: { vitality: 0, power: 0, agility: 0, perception: 0, armor: 0, haste: 0 } },
    target: '',
    behaviours: {},
    commit: LIMITS.commitDefault,
  };
  if ('author' in o) {
    const author = stringField(o.author, 'author', 'Author', out, LIMITS.nameLength);
    if (author) s.author = author;
  }
  s.version = 'version' in o ? numberIn(o.version, 1, 1e6, 'version', 'Version', out, true) ?? 1 : 1;

  const build = checkBuild(o.build, out);
  if (build) s.build = build;

  if (typeof o.target === 'string') s.target = o.target;
  else out.error('target', `"target" must be an expression rating each known enemy with it.*, e.g. "300 - it.distance"; got ${typeName(o.target)}.`);

  if ('memory' in o) {
    if (!isObj(o.memory)) out.error('memory', `"memory" must map slot names to starting numbers; got ${typeName(o.memory)}.`);
    else {
      const slots = Object.entries(o.memory);
      if (slots.length > MAX_MEMORY_SLOTS) out.error('memory', `${slots.length} memory slots; the limit is ${MAX_MEMORY_SLOTS}.`);
      const memory: Record<string, number> = {};
      for (const [slot, v] of slots) {
        if (!IDENT.test(slot) || slot.length > LIMITS.identLength) {
          out.error(`memory.${slot}`, `Memory slot names use lowercase letters, digits and _ (start with a letter, at most ${LIMITS.identLength}).`);
          continue;
        }
        if (typeof v !== 'number' || !Number.isFinite(v)) out.error(`memory.${slot}`, `A memory slot starts as a finite number; got ${typeof v === 'number' ? v : typeName(v)}.`);
        else if (Math.abs(v) > GUARDS.memoryLimit) out.error(`memory.${slot}`, `Memory slots hold -${GUARDS.memoryLimit}..${GUARDS.memoryLimit}; "${slot}" starts at ${v}.`);
        else memory[slot] = v;
      }
      s.memory = memory;
    }
  }

  if ('imports' in o) {
    if (!Array.isArray(o.imports) || o.imports.some((x) => typeof x !== 'string')) {
      out.error('imports', `"imports" must be a list of starter behaviour names (${STARTER_NAMES.join(', ')}).`);
    } else {
      const imports: string[] = [];
      o.imports.forEach((n: string, i) => {
        if (!Object.hasOwn(STARTER_LIBRARY, n)) out.error(`imports[${i}]`, `Unknown starter behaviour "${n}". Available: ${STARTER_NAMES.join(', ')}.`, didYouMean(n, STARTER_NAMES));
        else if (imports.includes(n)) out.error(`imports[${i}]`, `"${n}" is imported twice; remove one.`);
        else imports.push(n);
      });
      s.imports = imports;
    }
  }

  if (!isObj(o.behaviours)) {
    out.error('behaviours', `"behaviours" must map behaviour names to behaviours; got ${typeName(o.behaviours)}.`);
  } else {
    for (const [bn, bv] of Object.entries(o.behaviours)) {
      const path = `behaviours.${bn}`;
      if (!IDENT.test(bn) || bn.length > LIMITS.identLength) {
        out.error(path, `Behaviour names use lowercase letters, digits and _ (start with a letter, at most ${LIMITS.identLength}).`);
        continue;
      }
      const b = checkBehaviour(bv, path, out);
      if (b) s.behaviours[bn] = b;
    }
  }
  const declared = new Set([...(isObj(o.behaviours) ? Object.keys(o.behaviours) : []), ...(s.imports ?? [])]);
  if (declared.size === 0) out.error('behaviours', 'A strategy needs at least one behaviour (its own or imported).');
  if (declared.size > MAX_BEHAVIOURS) out.error('behaviours', `${declared.size} behaviours including imports; the limit is ${MAX_BEHAVIOURS}.`);

  if ('commit' in o) s.commit = numberIn(o.commit, 0, LIMITS.commitMax, 'commit', 'Commit', out, true) ?? LIMITS.commitDefault;
  else out.warn('commit', `No "commit"; using ${LIMITS.commitDefault} ticks.`);

  if ('barks' in o) {
    const barks = checkBarks(o.barks, out);
    if (barks) s.barks = barks;
  }
  if ('look' in o) {
    const look = checkLook(o.look, out);
    if (look) s.look = look;
  }

  // Compile what is structurally sound, with the brain's own compiler. Every declared slot name
  // counts (even one with a bad starting value), so a `set` on it is not reported twice.
  const declaredMemory = isObj(o.memory) ? Object.keys(o.memory).filter((k) => IDENT.test(k)) : [];
  const compileInput: Strategy = { ...s, memory: Object.fromEntries(declaredMemory.map((k) => [k, 0])) };
  if (mergeBehaviours(compileInput).length > 0 || typeof o.target === 'string') {
    const compiled = compileStrategy(compileInput, (issue) => {
      // A path that already has a structural error (or a behaviour list emptied by them) is not repeated.
      if (issue.path === 'behaviours' || out.issues.some((i) => i.severity === 'error' && i.path === issue.path)) return;
      out.error(issue.path, issue.message, issue.suggestion, { pos: issue.pos });
    });
    // Lint only means something for a strategy that is otherwise sound. Analysis errors (what a
    // runtime guard would catch) are listed with the other errors, so one round fixes everything,
    // except where an error already explains the spot (and not on a broken build or memory, which
    // the ranges depend on).
    const errorPaths = out.issues.filter((i) => i.severity === 'error').map((i) => i.path);
    const related = (a: string, b: string) => a === b || b.startsWith(`${a}.`) || b.startsWith(`${a}[`) || a.startsWith(`${b}.`) || a.startsWith(`${b}[`);
    const sound = errorPaths.length === 0;
    if (sound || !errorPaths.some((p) => p === '' || related('build', p) || related('memory', p))) {
      for (const issue of analyzeStrategy(s, compiled).issues) {
        if (sound && issue.severity === 'warning') out.warn(issue.path, issue.message, { pos: issue.pos });
        else if (issue.severity === 'error' && !errorPaths.some((p) => related(p, issue.path))) out.error(issue.path, issue.message, issue.suggestion, { pos: issue.pos });
      }
    }
  }

  const ok = out.errorCount === 0;
  return ok ? { ok, issues: out.issues, strategy: structuredClone(s) } : { ok, issues: out.issues };
}
