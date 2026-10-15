// Owned by: ui
// Everything the editor and the Codex can explain, one entry per word, property or rule: what it
// is, its type, unit and range, the values it takes, its effect (formulas, what +10 changes), a
// real example and related words. Generated from the brain registry, the core rule tables and the
// rulebook the LLM prompt is built from, so a hover card, the Codex and the prompt cannot disagree.
import {
  ATTRIBUTE_BUDGET,
  ATTRIBUTE_DOCS,
  ATTRIBUTE_KEYS,
  ATTRIBUTE_MAX,
  ATTRIBUTE_MIN,
  BARK_RULES,
  COMBAT,
  COMBAT_DOCS,
  HAZARD_RULES,
  MATCH_RULES,
  MATCH_RULES_DOCS,
  MAX_BEHAVIOURS,
  MAX_MEMORY_SLOTS,
  MAX_MOVE_TERMS,
  PERCEPTION,
  PERCEPTION_DOCS,
  PICKUP_RULES,
  PROP_RULES,
  SKILLS,
  SKILL_IDS,
  SPEED_SCALE,
  STANCES,
  STAT_DOCS,
  TICK_HZ,
  WEAPONS,
  WEAPON_IDS,
  deriveStats,
  skillCooldown,
  skillDamage,
} from '../../core';
import type { AttributeKey, Attributes, Behaviour, DerivedStats, MoveTerm, SkillId, Strategy, WeaponId } from '../../core';
import {
  ATTACK_POLICIES,
  ENEMIES_WORD,
  FIGHTER_REFS,
  FIGHTER_SENSORS,
  FUNCTIONS,
  GUARDS,
  GUARDS_DOCS,
  MAX_EXPR_DEPTH,
  MAX_EXPR_LENGTH,
  MOVE_TERMS,
  PICKUP_ARG_WORDS,
  PLACES,
  SENSORS,
  STEERING,
  STEERING_DOCS,
  ZONES,
} from '../../brain';
import type { ArgSpec } from '../../brain';
import { MAPS } from '../../sim';
import { BARK_KINDS, HOUSE_STACKS, LIMITS, STARTER_DOCS, STARTER_LIBRARY, generateRulebook } from '../../strategy';
import { parseMarkdown, plain, tableUnder } from '../codex/markdown';
import { inlineJson } from '../editor';
import { formatStat } from '../format';
import { lexExpr } from './language';
import type { WordKind } from './language';
import type { PathSeg } from './jsontext';

export type EntryKind =
  | WordKind
  | 'field'
  | 'term'
  | 'attribute'
  | 'stat'
  | 'weapon'
  | 'skill'
  | 'stance'
  | 'bark'
  | 'starter'
  | 'direction'
  | 'hazard'
  | 'prop'
  | 'pickup'
  | 'map'
  | 'limit'
  | 'rule';

export const KIND_LABEL: Readonly<Record<EntryKind, string>> = {
  sensor: 'Sensor',
  'fighter-sensor': 'Fighter sensor',
  memory: 'Memory slot',
  function: 'Function',
  keyword: 'Operator',
  policy: 'Attack policy',
  fighter: 'Fighter',
  enemies: 'Fighter group',
  place: 'Place',
  zone: 'Zone',
  'pickup-word': 'Power-up kind',
  field: 'Property',
  term: 'Move term',
  attribute: 'Attribute',
  stat: 'Derived stat',
  weapon: 'Weapon',
  skill: 'Skill',
  stance: 'Stance',
  bark: 'Bark kind',
  starter: 'Starter behaviour',
  direction: 'Orbit direction',
  hazard: 'Hazard',
  prop: 'Prop',
  pickup: 'Power-up',
  map: 'Map',
  limit: 'Limit',
  rule: 'Rule',
};

export type Fact = { label: string; value: string };

export type Entry = {
  /** `${kind}:${word}`, unique. */
  id: string;
  kind: EntryKind;
  /** The word as written in a strategy (`self.hp`, `behind`, `GREATSWORD`, `vitality`). */
  word: string;
  /** Heading: the word, its call form (`behind(X, d)`) or its display name (`Greatsword`). */
  title: string;
  type?: string;
  unit?: string;
  range?: string;
  /** Inline Markdown. */
  doc: string;
  /** Arguments of places and zones. */
  args?: Fact[];
  /** Values it takes (enums, pickup kinds). */
  values?: string[];
  /** Formulas and rules, inline Markdown. */
  formulas?: Fact[];
  /** Number tables (weapon stats, skill numbers). */
  facts?: Fact[];
  example?: { code: string; source: string };
  related: string[];
  attribute?: AttributeKey;
  weapon?: WeaponId;
  skill?: SkillId;
  /** Lowercase text the Codex searches. */
  search: string;
};

// ---------------------------------------------------------------------------------------------
// The rulebook's own field docs
// ---------------------------------------------------------------------------------------------

let rulebookBlocks: ReturnType<typeof parseMarkdown> | null = null;

/** The rulebook the LLM prompt is built from, parsed once. */
export function rulebookMarkdown(): ReturnType<typeof parseMarkdown> {
  rulebookBlocks ??= parseMarkdown(generateRulebook());
  return rulebookBlocks;
}

function fieldRows(title: string): Map<string, { required: string; meaning: string }> {
  return new Map(tableUnder(rulebookMarkdown(), title).map((r) => [r[0] ?? '', { required: r[1] ?? '', meaning: r[2] ?? '' }]));
}

// ---------------------------------------------------------------------------------------------
// Examples from the starter library and the house stacks
// ---------------------------------------------------------------------------------------------

type Snippet = { code: string; source: string; words: Set<string>; length: number };

let snippets: Snippet[] | null = null;

function termText(t: MoveTerm): string {
  return inlineJson(t);
}

function collectSnippets(): Snippet[] {
  if (snippets) return snippets;
  const out: Snippet[] = [];
  const add = (code: string, source: string, words: Iterable<string>) => out.push({ code, source, words: new Set(words), length: code.length });
  const exprWords = (src: string) => lexExpr(src).filter((t) => t.kind === 'name').map((t) => t.text);
  const behaviour = (b: Behaviour, where: string) => {
    add(b.score, `${where} score`, exprWords(b.score));
    if (b.attack) add(b.attack, `${where} attack`, exprWords(b.attack));
    if (b.skill) add(b.skill, `${where} skill`, exprWords(b.skill));
    for (const [slot, e] of Object.entries(b.set ?? {})) add(`"${slot}": "${e}"`, `${where} set`, [slot, ...exprWords(e)]);
    for (const t of b.move) {
      const words = Object.entries(t).flatMap(([k, v]) => [k, ...(typeof v === 'string' ? exprWords(v) : Array.isArray(v) ? v.flatMap((x) => (typeof x === 'string' ? exprWords(x) : [])) : [])]);
      add(termText(t), `${where} move`, words);
    }
    if (b.stance) add(`"stance": "${b.stance}"`, `${where}`, [b.stance]);
  };
  for (const [name, b] of Object.entries(STARTER_LIBRARY)) behaviour(b, `Starter ${name}`);
  for (const s of HOUSE_STACKS as readonly Strategy[]) {
    add(s.target, `${s.name}, target`, exprWords(s.target));
    for (const [name, b] of Object.entries(s.behaviours)) behaviour(b, `${s.name}, ${name}`);
  }
  snippets = out;
  return out;
}

/** The shortest real use of `word` in the starter library or a house stack. */
export function exampleOf(word: string): { code: string; source: string } | undefined {
  let best: Snippet | null = null;
  for (const s of collectSnippets()) if (s.words.has(word) && (!best || s.length < best.length)) best = s;
  return best ? { code: best.code, source: best.source } : undefined;
}

// ---------------------------------------------------------------------------------------------
// Attributes: formulas and what +10 changes
// ---------------------------------------------------------------------------------------------

/** An even spread used when the draft has no complete build. */
export const EVEN_BUILD: Attributes = { vitality: 17, power: 17, agility: 17, perception: 17, armor: 16, haste: 16 };

const STAT_KEYS = Object.keys(STAT_DOCS) as (keyof DerivedStats)[];

export type StatChange = { key: keyof DerivedStats; label: string; from: string; to: string; better: boolean };

/**
 * What raising `key` by `by` points (capped at the attribute maximum) does to this build's derived
 * stats. Only stats that change are listed. `better` is whether the change helps the fighter
 * (a bigger body and slower cooldowns are worse).
 */
export function attributeEffect(key: AttributeKey, attrs: Attributes, weapon: WeaponId, by = 10): { to: number; changes: StatChange[] } {
  const to = Math.min(ATTRIBUTE_MAX, attrs[key] + by);
  const a = deriveStats(attrs, weapon);
  const b = deriveStats({ ...attrs, [key]: to }, weapon);
  const worse = new Set<keyof DerivedStats>(['radius', 'attackCooldown', 'skillCooldown']);
  const changes = STAT_KEYS.filter((k) => Math.abs(a[k] - b[k]) > 1e-9 && formatStat(k, a[k]) !== formatStat(k, b[k])).map((k) => ({
    key: k,
    label: STAT_DOCS[k].label,
    from: formatStat(k, a[k]),
    to: formatStat(k, b[k]),
    better: worse.has(k) ? b[k] < a[k] : b[k] > a[k],
  }));
  return { to, changes };
}

/** Derived stats an attribute moves (on an even greatsword build, so every formula shows). */
function statsMovedBy(key: AttributeKey): (keyof DerivedStats)[] {
  const changes = new Set<keyof DerivedStats>();
  for (const w of ['GREATSWORD', 'LONGBOW'] as const) for (const c of attributeEffect(key, EVEN_BUILD, w, 5).changes) changes.add(c.key);
  return STAT_KEYS.filter((k) => changes.has(k));
}

// ---------------------------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------------------------

/** "Vitality" for `vitality`. */
export function attributeLabel(k: AttributeKey): string {
  return k.charAt(0).toUpperCase() + k.slice(1);
}

function usedBy(pred: (s: Strategy) => boolean): Fact[] {
  const names = (HOUSE_STACKS as readonly Strategy[]).filter(pred).map((s) => s.name);
  return names.length ? [{ label: 'House stacks', value: names.join(', ') }] : [];
}

function num(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
}

function signature(name: string, args: readonly ArgSpec[]): string {
  return args.length ? `${name}(${args.map((a) => a.name).join(', ')})` : name;
}

function argText(a: ArgSpec): string {
  switch (a.kind) {
    case 'fighter':
      return `a fighter: ${FIGHTER_REFS.map((r) => `\`${r.name}\``).join(', ')}`;
    case 'fighters':
      return `a fighter, or \`${ENEMIES_WORD}\` for every enemy you know of`;
    case 'place':
      return 'a place (nested)';
    case 'number':
      return `a plain number, ${a.min ?? '-∞'} to ${a.max ?? '∞'}`;
    case 'pickup':
      return PICKUP_ARG_WORDS.map((w) => `\`${w}\``).join(', ');
  }
}

const KEYWORD_DOCS: Readonly<Record<string, string>> = {
  and: '1 when both sides are above 0, else 0. Binds tighter than `or`.',
  or: '1 when either side is above 0, else 0. The loosest operator.',
  not: '1 when what follows is 0 or below, else 0. `not a < b` means `not (a < b)`.',
  true: 'The number 1.',
  false: 'The number 0.',
};

const DIRECTION_DOCS: Readonly<Record<string, string>> = {
  cw: 'Clockwise as seen on screen.',
  ccw: 'Counter-clockwise as seen on screen.',
};

function make(kind: EntryKind, word: string, title: string, rest: Omit<Entry, 'id' | 'kind' | 'word' | 'title' | 'related' | 'search'> & { related?: string[] }): Entry {
  return { id: `${kind}:${word}`, kind, word, title, related: [], search: '', ...rest } as Entry;
}

function buildEntries(): Entry[] {
  const out: Entry[] = [];
  const push = (e: Entry) => out.push(e);
  const rangeType = (unit: string) => (unit === '0/1' ? 'flag (1 or 0)' : 'number');

  for (const s of SENSORS) {
    if (s.scope !== 'self') continue;
    push(make('sensor', s.name, s.name, { type: rangeType(s.unit), unit: s.unit, range: s.range, doc: s.doc }));
  }
  for (const d of FIGHTER_SENSORS) {
    push(
      make('fighter-sensor', `target.${d.key}`, `target.${d.key}`, {
        type: rangeType(d.unit),
        unit: d.unit,
        range: d.range,
        doc: `${d.doc} Reads your target in behaviours; write \`it.${d.key}\` in the target expression to rate each candidate.`,
        formulas: [{ label: 'No target', value: num(d.none) }],
      }),
    );
  }
  for (const r of FIGHTER_REFS) push(make('fighter', r.name, r.name, { type: 'fighter (a place)', doc: `${r.doc} A fighter is also a place: \`seek\` stops at touching distance and leads it.` }));
  push(make('enemies', ENEMIES_WORD, ENEMIES_WORD, { type: 'every known enemy', doc: 'Every enemy you see or hear now, or saw in the last few seconds. Only as the X of `cover_from(X)` and `seen_by(X)`.' }));
  for (const p of PLACES) {
    push(make('place', p.name, signature(p.name, p.args), { type: 'place', doc: p.doc, args: p.args.map((a) => ({ label: a.name, value: argText(a) })) }));
  }
  for (const z of ZONES) {
    push(make('zone', z.name, signature(z.name, z.args), { type: 'zone (0..1 at each point)', range: '0..1', doc: z.doc, args: z.args.map((a) => ({ label: a.name, value: argText(a) })) }));
  }
  for (const t of MOVE_TERMS) {
    push(make('term', t.key, t.key, { type: 'move term', doc: t.doc, formulas: [{ label: 'Form', value: `\`${t.form}\`` }, { label: 'Weight', value: `0 to ${LIMITS.weightMax}, default 1` }] }));
  }
  for (const p of ATTACK_POLICIES) push(make('policy', p.name, p.name, { type: 'attack policy', doc: p.doc }));
  for (const [name, f] of Object.entries(FUNCTIONS)) push(make('function', name, f.signature, { type: 'function', doc: f.doc, formulas: [{ label: 'Arguments', value: f.minArgs === f.maxArgs ? String(f.minArgs) : `${f.minArgs} to ${f.maxArgs}` }] }));
  for (const [k, doc] of Object.entries(KEYWORD_DOCS)) push(make('keyword', k, k, { type: k === 'true' || k === 'false' ? 'constant' : 'operator', doc }));
  for (const w of PICKUP_ARG_WORDS) {
    const doc = w === 'any' ? 'Whichever power-up `nearest_pickup` picks.' : PICKUP_RULES[w].doc;
    push(make('pickup-word', w, w, { type: 'power-up kind', doc: `As the K of \`pickup(K)\`. ${doc}` }));
  }
  for (const [d, doc] of Object.entries(DIRECTION_DOCS)) push(make('direction', d, d, { type: 'orbit direction', doc: `${doc} The second item of \`orbit\`.` }));

  for (const k of ATTRIBUTE_KEYS) {
    const moved = statsMovedBy(k);
    push(
      make('attribute', k, attributeLabel(k), {
        type: 'whole number',
        range: `${ATTRIBUTE_MIN}..${ATTRIBUTE_MAX}`,
        doc: `${ATTRIBUTE_DOCS[k]} All six together may not exceed ${ATTRIBUTE_BUDGET} points.`,
        formulas: moved.map((s) => ({ label: STAT_DOCS[s].label, value: STAT_DOCS[s].doc })),
        attribute: k,
        related: moved.map((s) => `stat:${s}`),
      }),
    );
  }
  for (const s of STAT_KEYS) push(make('stat', s, STAT_DOCS[s].label, { type: 'derived stat', unit: STAT_DOCS[s].unit, doc: STAT_DOCS[s].doc }));

  for (const id of WEAPON_IDS) {
    const w = WEAPONS[id];
    const facts: Fact[] = [
      { label: 'Family', value: w.family },
      { label: 'Range', value: `${w.range} px` },
      { label: 'Damage', value: String(w.damage) },
      { label: 'Cooldown', value: `${w.cooldown} ticks` },
      { label: 'Windup / strike / recovery', value: `${w.windup} / ${w.strike} / ${w.recovery}` },
      { label: 'Knockback', value: String(w.knockback) },
    ];
    if (w.arc) facts.push({ label: 'Arc', value: `${Math.round((w.arc * 180) / Math.PI)}°${w.cleave ? ', cleaves' : ''}` });
    facts.push({ label: 'Backstab', value: `x${w.backstabMult}` });
    if (w.ammo) facts.push({ label: w.ammoRegenTicks ? 'Charges' : 'Ammo', value: `${w.ammo}${w.ammoPickup ? ', pick up spent ones' : ''}${w.ammoRegenTicks ? `, +1 per ${w.ammoRegenTicks} ticks` : ''}` });
    if (w.projectileSpeed) facts.push({ label: 'Projectile speed', value: `${num(w.projectileSpeed * SPEED_SCALE)} px/tick` });
    if (w.splash) facts.push({ label: 'Splash', value: `${Math.round(w.splashMul * 100)}% within ${w.splash} px` });
    if (w.stunTicks) facts.push({ label: 'Stun', value: `${w.stunTicks} ticks` });
    if (w.slowTicks) facts.push({ label: 'Slow', value: `${w.slowTicks} ticks` });
    facts.push({ label: 'Vision bonus', value: `${w.visionBonus > 0 ? '+' : ''}${w.visionBonus} px` });
    facts.push({ label: 'Move / turn', value: `x${w.moveMul} / x${w.turnMul}` });
    if (w.shield) facts.push({ label: 'Shield', value: 'blocks shots from the front in guard stance' });
    facts.push(...usedBy((h) => h.build.weapon === id));
    push(make('weapon', id, w.name, { type: `${w.family} weapon`, doc: w.doc, facts, weapon: id }));
  }
  for (const id of SKILL_IDS) {
    const s = SKILLS[id];
    const facts: Fact[] = [];
    if (s.damage) facts.push({ label: 'Damage', value: `${s.damage}${s.powerScale ? ` + power x ${s.powerScale}` : ''} (${num(skillDamage(id, EVEN_BUILD))} at power 17)` });
    if (s.radius) facts.push({ label: 'Radius', value: `${s.radius} px${s.arc ? `, ${Math.round((s.arc * 180) / Math.PI)}° cone` : ''}` });
    if (s.stunTicks) facts.push({ label: 'Stun', value: `${s.stunTicks} ticks` });
    if (s.parryTicks) facts.push({ label: 'Parry window', value: `${s.parryTicks} ticks` });
    if (s.hasteTicks) facts.push({ label: 'Haste', value: `${s.hasteTicks} ticks` });
    if (s.berserkTicks) facts.push({ label: 'Berserk', value: `${s.berserkTicks} ticks` });
    if (s.needsTarget) facts.push({ label: 'Needs', value: `a target within ${s.maxRange} px` });
    facts.push({ label: 'Cooldown', value: `${STAT_DOCS.skillCooldown.doc} (${(skillCooldown(EVEN_BUILD) / TICK_HZ).toFixed(2)} s at haste 16)` });
    facts.push(...usedBy((h) => h.build.skill === id));
    push(make('skill', id, s.name, { type: 'skill', doc: s.doc, facts, skill: id }));
  }
  for (const [k, st] of Object.entries(STANCES)) push(make('stance', k, k, { type: 'stance', doc: st.doc, facts: [{ label: 'Move speed', value: `x${st.moveMul}` }] }));
  for (const k of BARK_KINDS) {
    push(make('bark', k, k, { type: 'bark kind', doc: barkDoc(k), facts: [{ label: 'Chance', value: `${Math.round(BARK_RULES.chance[k] * 100)}% per trigger` }, { label: 'Lines', value: `up to ${LIMITS.barkLinesPerKind}, ${BARK_RULES.maxLength} characters each` }] }));
  }
  for (const [name, b] of Object.entries(STARTER_LIBRARY)) {
    push(make('starter', name, name, { type: 'starter behaviour', doc: `${STARTER_DOCS[name] ?? ''} Import it with \`"imports": ["${name}"]\`, or copy it into your behaviours to change it.`, example: { code: JSON.stringify(b, null, 2), source: 'Starter library' } }));
  }

  for (const h of Object.values(HAZARD_RULES)) push(make('hazard', h.kind, h.name, { type: 'hazard', doc: h.doc }));
  for (const p of Object.values(PROP_RULES)) push(make('prop', p.kind, p.name, { type: 'prop', doc: p.doc }));
  for (const [k, p] of Object.entries(PICKUP_RULES)) push(make('pickup', k, p.name, { type: k === 'shrine' ? 'shrine' : 'power-up', doc: p.doc }));
  for (const m of Object.values(MAPS)) {
    const facts: Fact[] = [
      { label: 'Size', value: `${m.width} x ${m.height} px` },
      { label: 'Ambient light', value: `${Math.round(m.ambient * 100)}%${m.ambient < PERCEPTION.shadowLight ? ' (shadow unless lit)' : ''}` },
      { label: 'Pillars', value: String(m.pillars.length) },
      { label: 'Hazards', value: countKinds(m.hazards.map((h) => HAZARD_RULES[h.kind].name)) || 'none' },
      { label: 'Props', value: countKinds(m.props.map((p) => PROP_RULES[p.kind].name)) || 'none' },
      { label: 'Shrines', value: String(m.shrines.length) },
      { label: 'Power-ups', value: countKinds(m.pickups.map((p) => PICKUP_RULES[p.kind].name)) || 'none' },
    ];
    push(make('map', m.id, m.name, { type: 'map', doc: `Floor: ${m.floor}. ${m.lights.length} lights.`, facts }));
  }

  const limits: [string, string, string][] = [
    ['behaviours', String(MAX_BEHAVIOURS), 'Behaviours per strategy, imports included.'],
    ['move_terms', String(MAX_MOVE_TERMS), 'Move terms per behaviour.'],
    ['memory_slots', String(MAX_MEMORY_SLOTS), `Memory slots, values within ±${GUARDS.memoryLimit}.`],
    ['expression_length', String(MAX_EXPR_LENGTH), 'Characters per expression, place or zone.'],
    ['expression_depth', String(MAX_EXPR_DEPTH), 'Nesting depth of an expression.'],
    ['name_length', String(LIMITS.nameLength), 'Characters in name and author.'],
    ['ident_length', String(LIMITS.identLength), 'Characters in behaviour and memory names (lowercase letters, digits, _; start with a letter).'],
    ['commit', `0..${LIMITS.commitMax}`, `Ticks of commit bonus; default ${LIMITS.commitDefault}.`],
    ['bark_lines', String(LIMITS.barkLinesPerKind), `Lines per bark kind, ${BARK_RULES.maxLength} characters each.`],
  ];
  for (const [k, v, doc] of limits) push(make('limit', k, k.replace(/_/g, ' '), { type: 'limit', doc, facts: [{ label: 'Value', value: v }] }));
  for (const k of Object.keys(GUARDS) as (keyof typeof GUARDS)[]) push(make('limit', k, k, { type: 'limit', doc: GUARDS_DOCS[k], facts: [{ label: 'Value', value: num(GUARDS[k]) }] }));
  const rules = (table: Record<string, number>, docs: Record<string, string>, group: string) => {
    for (const k of Object.keys(table)) push(make('rule', `${group}.${k}`, k, { type: `${group} rule`, doc: docs[k] ?? '', facts: [{ label: 'Value', value: num(table[k]!) }] }));
  };
  rules(COMBAT, COMBAT_DOCS, 'combat');
  rules(PERCEPTION, PERCEPTION_DOCS, 'perception');
  rules(MATCH_RULES, MATCH_RULES_DOCS, 'match');
  rules(STEERING, STEERING_DOCS, 'steering');

  out.push(...fieldEntries());
  return out;
}

function countKinds(names: string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].map(([n, c]) => `${c} ${n.toLowerCase()}${c === 1 ? '' : 's'}`).join(', ');
}

function barkDoc(k: string): string {
  switch (k) {
    case 'spawn':
      return 'Said when the match starts.';
    case 'kill':
      return 'Said after a kill.';
    case 'hit':
      return 'Said when you land a hit.';
    case 'low_hp':
      return `Said once, when you drop below ${Math.round(BARK_RULES.lowHp * 100)}% HP.`;
    case 'death':
      return 'Last words.';
    case 'skill':
      return 'Said when you use your skill.';
    default:
      return 'Said now and then while you see an enemy and are not fighting.';
  }
}

/**
 * Property entries. Their docs are the rulebook's own field tables; the few properties the
 * rulebook describes inside another row (weight, set slots, look) say what the validator checks.
 */
function fieldEntries(): Entry[] {
  const top = fieldRows('The strategy document');
  const beh = fieldRows('Behaviour fields');
  const out: Entry[] = [];
  const field = (pattern: string, title: string, doc: string, type: string, required?: string) =>
    out.push(make('field', pattern, title, { type, doc, facts: required ? [{ label: 'Required', value: required }] : undefined }));
  const typeOf: Record<string, string> = {
    $schema: 'string', schema: 'string', name: 'string', author: 'string', version: 'whole number', build: 'object', target: 'expression (it.* sensors)',
    behaviours: 'object of behaviours', imports: 'list of starter names', memory: 'object of numbers', commit: 'whole number (ticks)', barks: 'object of lines', look: 'object',
  };
  for (const [k, row] of top) field(k, k, row.meaning, typeOf[k] ?? 'value', row.required);
  const behType: Record<string, string> = { score: 'expression', move: `list of 0-${MAX_MOVE_TERMS} move terms`, attack: 'policy or expression', skill: 'expression', set: 'object of expressions', stance: 'normal, creep or guard' };
  for (const [k, row] of beh) field(`behaviours.*.${k}`, k, row.meaning, behType[k] ?? 'value', row.required);
  field('build.weapon', 'weapon', `One of ${WEAPON_IDS.map((w) => `\`${w}\``).join(', ')}.`, 'weapon id', 'yes');
  field('build.skill', 'skill', `One of ${SKILL_IDS.map((s) => `\`${s}\``).join(', ')}.`, 'skill id', 'yes');
  field('build.attributes', 'attributes', `All six attributes, whole numbers ${ATTRIBUTE_MIN}-${ATTRIBUTE_MAX}, at most ${ATTRIBUTE_BUDGET} in total. Unspent points are wasted.`, 'object', 'yes');
  field('behaviours.*', 'behaviour', `A behaviour: when it wins (\`score\`), how it moves (\`move\`), when it attacks and uses its skill. ${top.get('behaviours')?.meaning ?? ''}`, 'behaviour');
  field('behaviours.*.move[]', 'move term', 'One context-steering term: rates 16 directions in [-1, 1]; the weighted sum picks the heading. Exactly one of `seek`, `flee`, `keep_range`, `orbit`, `avoid`, `prefer`, plus `weight`.', 'move term');
  field('behaviours.*.move[].weight', 'weight', `How much this term counts in the steering sum: 0 to ${LIMITS.weightMax}, default 1.`, 'number 0-5', 'yes');
  field('behaviours.*.set.*', 'memory write', 'Writes this expression into the memory slot every think while the behaviour runs. Every write sees memory as it was at the start of the think.', 'expression');
  field('memory.*', 'memory slot', `A named number with its starting value (within ±${GUARDS.memoryLimit}). Read it by name in any expression; write it with \`set\`.`, 'number');
  field('look.color', 'color', 'Preferred fighter colour as `#RRGGBB`. The match may assign another to keep fighters distinct.', 'string');
  field('look.glyph', 'glyph', `1-${LIMITS.glyphLength} characters drawn on the fighter.`, 'string');
  field('barks.*', 'bark lines', `One line or a list of up to ${LIMITS.barkLinesPerKind}, ${BARK_RULES.maxLength} characters each.`, 'string or list');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------------------------

type Index = { all: Entry[]; byId: Map<string, Entry>; byWord: Map<string, Entry[]> };

let index: Index | null = null;

const IDENT = /[a-z_][a-z0-9_]*(?:\.[a-z_*][a-z0-9_]*)+|[a-z]+_[a-z0-9_]+/g;

function link(all: Entry[], byId: Map<string, Entry>, byWord: Map<string, Entry[]>): void {
  const vocab = all.filter((e) => ['sensor', 'fighter-sensor', 'fighter', 'place', 'zone', 'term', 'policy', 'function', 'starter'].includes(e.kind));
  for (const e of all) {
    const rel = new Set(e.related);
    // Words the doc names: dotted or underscored identifiers, `pickup.any.*` wildcards included.
    for (const m of plain(e.doc).toLowerCase().match(IDENT) ?? []) {
      if (m.endsWith('.*')) {
        const prefix = m.slice(0, -1);
        for (const v of vocab) if (v.word.startsWith(prefix)) rel.add(v.id);
        continue;
      }
      for (const v of byWord.get(m) ?? []) if (vocab.includes(v)) rel.add(v.id);
    }
    if (e.kind === 'term' || e.kind === 'policy') {
      for (const t of MOVE_TERMS) if (new RegExp(`\\b${t.key}\\b`).test(e.doc)) rel.add(`term:${t.key}`);
    }
    // Sensors that read a place or zone: shrine -> shrine.ready, zone_centre -> zone.distance.
    if (e.kind === 'place' || e.kind === 'zone') {
      const head = e.word.split('_')[0];
      for (const v of vocab) if (v.kind === 'sensor' && v.word.startsWith(`${head}.`)) rel.add(v.id);
    }
    // Siblings: pickup.haste.ready <-> pickup.haste.distance, zone.distance <-> zone.time_to_reach.
    if (e.kind === 'sensor' && e.word.includes('.') && !e.word.startsWith('self.')) {
      const head = e.word.slice(0, e.word.lastIndexOf('.') + 1);
      for (const v of vocab) if (v.kind === 'sensor' && v !== e && v.word.startsWith(head)) rel.add(v.id);
    }
    if (e.kind === 'sensor' && e.word.startsWith('self.')) {
      const twin = byId.get(`fighter-sensor:target.${e.word.slice(5)}`);
      if (twin) rel.add(twin.id);
    }
    if (e.kind === 'fighter-sensor') {
      const twin = byId.get(`sensor:self.${e.word.slice(7)}`);
      if (twin) rel.add(twin.id);
    }
    rel.delete(e.id);
    e.related = [...rel].filter((id) => byId.has(id));
  }
  // Related is mutual: if the shrine place names shrine.ready, shrine.ready names the shrine place.
  for (const e of all) for (const id of e.related) {
    const other = byId.get(id);
    if (other && other.kind !== 'stat' && !other.related.includes(e.id)) other.related.push(e.id);
  }
  for (const e of all) {
    e.related = e.related.slice(0, 8);
    e.search = [e.word, e.title, KIND_LABEL[e.kind], e.type ?? '', plain(e.doc), ...(e.facts ?? []).map((f) => `${f.label} ${f.value}`)].join(' ').toLowerCase();
  }
}

function getIndex(): Index {
  if (index) return index;
  const all = buildEntries();
  const byId = new Map(all.map((e) => [e.id, e]));
  const byWord = new Map<string, Entry[]>();
  for (const e of all) {
    if (e.kind === 'field' || e.kind === 'limit' || e.kind === 'rule' || e.kind === 'map') continue;
    const list = byWord.get(e.word) ?? [];
    list.push(e);
    byWord.set(e.word, list);
  }
  // `it.<key>` reads the same fact as `target.<key>`.
  for (const d of FIGHTER_SENSORS) byWord.set(`it.${d.key}`, [byId.get(`fighter-sensor:target.${d.key}`)!]);
  link(all, byId, byWord);
  for (const e of all) if (!e.example && (e.kind !== 'field' && e.kind !== 'map' && e.kind !== 'rule' && e.kind !== 'limit')) e.example = exampleOf(e.word);
  index = { all, byId, byWord };
  return index;
}

export function allEntries(): readonly Entry[] {
  return getIndex().all;
}

export function entryById(id: string): Entry | null {
  return getIndex().byId.get(id) ?? null;
}

/** The entry a word means. `kind` picks between homonyms (`ammo` the place vs `ammo` the field). */
export function entryForWord(word: string, kind?: EntryKind): Entry | null {
  const list = getIndex().byWord.get(word);
  if (!list?.length) return null;
  return (kind && list.find((e) => e.kind === kind)) || list[0]!;
}

/** The property entry for a concrete JSON path (`behaviours.kite.move[1].weight`). */
export function fieldEntry(path: readonly PathSeg[]): Entry | null {
  const { byId } = getIndex();
  const [a, , c, d, e] = path;
  if (a === 'build' && path[1] === 'attributes' && path.length === 3) return byId.get(`attribute:${String(path[2])}`) ?? null;
  if (a === 'barks' && path.length === 2) return byId.get(`bark:${String(path[1])}`) ?? null;
  if (a === 'behaviours' && c === 'move' && typeof d === 'number' && path.length === 5 && e !== 'weight') return byId.get(`term:${String(e)}`) ?? null;
  const pattern = path
    .map((seg, i) => {
      if (typeof seg === 'number') return '[]';
      if (a === 'behaviours' && i === 1) return '*';
      if ((a === 'memory' || a === 'barks') && i === 1) return '*';
      if (a === 'behaviours' && path[2] === 'set' && i === 3) return '*';
      return seg;
    })
    .reduce((acc, seg) => (seg === '[]' ? `${acc}[]` : acc ? `${acc}.${seg}` : seg), '');
  return byId.get(`field:${pattern}`) ?? null;
}
