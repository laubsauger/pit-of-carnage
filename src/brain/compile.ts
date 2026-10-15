/**
 * Turns a strategy into closures, once, before the match. Expressions, places and zones are parsed
 * and every name is resolved against the registry here, so `think` never looks anything up by
 * string. The validator runs the same compiler, so whatever validates is exactly what runs.
 *
 * Compiling also prices the strategy (evaluation units per think, see GUARDS.costBudget) and hangs
 * a guard-trip counter on every spot a runtime guard watches.
 */

import { STEER_DIRS, WEAPONS } from '../core';
import type { Behaviour, MoveTerm, Stance, Strategy } from '../core';
import { mergeBehaviours } from '../strategy/library';
import type { ThinkCtx } from './ctx';
import { ExprError, FUNCTIONS, KEYWORDS, compileExpr, exprNodes, parseExpr } from './expr';
import type { Expr, ExprGuards, Fn } from './expr';
import { Guards } from './guards';
import type { GuardCounter } from './guards';
import {
  ATTACK_POLICY_NAMES,
  ENEMIES_WORD,
  FIGHTER_REFS,
  FIGHTER_REF_INDEX,
  PICKUP_ARG_WORDS,
  PLACES,
  PLACE_INDEX,
  SENSORS,
  SENSOR_INDEX,
  ZONES,
  ZONE_INDEX,
  sensorRange,
} from './registry';
import type { ArgSpec, AttackPolicyName, BuildFacts, CompiledArg, FighterGetter, PlaceFn, TermKind, ZoneFn } from './registry';
import { fleeTerm, keepRangeTerm, orbitTerm, seekTerm, zoneTerm } from './steering';
import type { TermRater } from './steering';
import { didYouMean } from './suggest';
import { GUARDS } from './tuning';

export type ExprScope = 'target' | 'behaviour';

export type CompiledTerm = {
  kind: TermKind;
  /** Inspector label, e.g. "seek behind(target, 30)". */
  label: string;
  weight: number;
  rate: TermRater;
  /** This term's latest unweighted ratings (owned by the brain that compiled it). */
  buf: Float64Array;
  /** Evaluation units one think of this term costs. */
  cost: number;
};

export type AttackPolicy = { kind: AttackPolicyName } | { kind: 'expr'; fn: Fn<ThinkCtx> };

export type CompiledBehaviour = {
  name: string;
  /** Path of the behaviour in the strategy (`behaviours.x` or `imports.x`). */
  path: string;
  score: Fn<ThinkCtx>;
  /** Units to evaluate the score once. */
  scoreCost: number;
  /** Counts scores cut to GUARDS.scoreLimit. */
  scoreClamp: GuardCounter;
  terms: CompiledTerm[];
  /** Sum of term weights (scales wall and hazard danger). */
  weightSum: number;
  attack: AttackPolicy;
  skill: Fn<ThinkCtx> | null;
  set: { slot: string; fn: Fn<ThinkCtx> }[];
  stance: Stance;
  /** Units one think of this behaviour costs once it has won: terms, attack, skill and memory writes. */
  actionCost: number;
};

export type CompiledStrategy = {
  name: string;
  target: Fn<ThinkCtx>;
  /** Units to rate one target candidate. */
  targetCost: number;
  behaviours: CompiledBehaviour[];
  memory: Record<string, number>;
  commit: number;
  /** Every guard's trip counter, for `Decision.guardTrips`. */
  guards: Guards;
  /** Counts thinks cut short by the evaluation budget. */
  costTrip: GuardCounter;
};

export type CompileIssue = {
  path: string;
  message: string;
  suggestion?: string;
  /** 0-based offset into the expression, place or zone text the issue is about, when there is one. */
  pos?: number;
};

/** Thrown by `compileStrategy` when no issue callback is given. */
export class StrategyCompileError extends Error {
  constructor(readonly issue: CompileIssue) {
    super(`${issue.path}: ${issue.message}${issue.suggestion ? ` Did you mean "${issue.suggestion}"?` : ''}`);
    this.name = 'StrategyCompileError';
  }
}

const ZERO: Fn<ThinkCtx> = () => 0;
const NO_PLACE: PlaceFn = () => false;
const NO_ZONE: ZoneFn = () => 0;

/** What an expression compiles against: the build (it narrows some sensor ranges) and guard counters. */
export type ExprEnv = { build?: BuildFacts | null; guards?: ExprGuards };

// ---------------------------------------------------------------------------------------------
// Sensors
// ---------------------------------------------------------------------------------------------

/**
 * Sensor `idx` for this think, computed at most once per think (self and target sensors) and
 * always inside its range (`sensorRange`); NaN reads as the low end.
 */
export function readSensor(c: ThinkCtx, idx: number, lo: number, hi: number): number {
  if (c.cacheAt[idx] === c.stamp) return c.cache[idx]!;
  const raw = SENSORS[idx]!.get(c);
  const v = raw >= lo ? (raw <= hi ? raw : hi) : lo;
  c.cache[idx] = v;
  c.cacheAt[idx] = c.stamp;
  return v;
}

// ---------------------------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------------------------

function splitTail(name: string): string {
  const i = name.indexOf('.');
  return i < 0 ? name : name.slice(i + 1);
}

/** Names an expression may use in this scope (for suggestions and the editor). */
export function expressionVocabulary(scope: ExprScope, memory: Iterable<string> = []): string[] {
  const out: string[] = [];
  for (const s of SENSORS) {
    if (s.scope === 'it' && scope !== 'target') continue;
    if (s.scope === 'target' && scope === 'target') continue;
    out.push(s.name);
  }
  for (const m of memory) out.push(m);
  return out;
}

function resolveName(name: string, pos: number, scope: ExprScope, memory: ReadonlySet<string>, build: BuildFacts | null): Fn<ThinkCtx> {
  const idx = SENSOR_INDEX.get(name);
  if (idx !== undefined) {
    const def = SENSORS[idx]!;
    const tail = splitTail(name);
    if (def.scope === 'it' && scope !== 'target') {
      throw new ExprError(`"${name}" only exists in the target expression (column ${pos + 1}); here use "target.${tail}".`, pos, name, `target.${tail}`);
    }
    if (def.scope === 'target' && scope === 'target') {
      throw new ExprError(`"${name}" is not known while the target is being chosen (column ${pos + 1}); rate each candidate with "it.${tail}".`, pos, name, `it.${tail}`);
    }
    const { lo, hi } = sensorRange(idx, build);
    if (def.scope === 'it') {
      // Changes with every candidate, so never cached.
      const get = def.get;
      return (c) => {
        const v = get(c);
        return v >= lo ? (v <= hi ? v : hi) : lo;
      };
    }
    return (c) => readSensor(c, idx, lo, hi);
  }
  if (memory.has(name)) return (c) => c.memory[name] ?? 0;
  if (ATTACK_POLICY_NAMES.includes(name)) {
    const hint = name === 'in_range' ? 'target.in_reach' : undefined;
    throw new ExprError(`"${name}" is an attack policy and only works as the whole attack value (column ${pos + 1}); inside an expression use a sensor${hint ? ` such as "${hint}"` : ''}.`, pos, name, hint);
  }
  if (FIGHTER_REF_INDEX.has(name) || PLACE_INDEX.has(name)) {
    const hint = FIGHTER_REF_INDEX.has(name) && name === 'target' ? 'target.distance' : undefined;
    throw new ExprError(`"${name}" is a place, not a number (column ${pos + 1}); places go in move terms. To measure, use a sensor${hint ? ` such as "${hint}"` : ''}.`, pos, name, hint);
  }
  if (ZONE_INDEX.has(name)) {
    const hint = name === 'shadow' ? 'self.in_shadow' : name === 'lit' ? 'self.light' : undefined;
    throw new ExprError(`"${name}" is a zone, not a number (column ${pos + 1}); zones go in avoid/prefer terms.`, pos, name, hint);
  }
  if (Object.hasOwn(FUNCTIONS, name)) throw new ExprError(`"${name}" is a function; call it like ${FUNCTIONS[name]!.signature} (column ${pos + 1}).`, pos, name);
  throw new ExprError(`Unknown name "${name}" at column ${pos + 1}.`, pos, name, didYouMean(name, expressionVocabulary(scope, memory)));
}

function compileExprSrc(src: string, scope: ExprScope, memory: ReadonlySet<string>, env: ExprEnv): { fn: Fn<ThinkCtx>; nodes: number } {
  if (typeof src !== 'string') throw new ExprError('Expected an expression string.', 0);
  const ast = parseExpr(src);
  const build = env.build ?? null;
  const fn = compileExpr<ThinkCtx>(ast, (name, pos) => resolveName(name, pos, scope, memory, build), env.guards);
  return { fn, nodes: exprNodes(ast) };
}

/** Parse and compile one expression. Throws ExprError with a column and, for unknown names, a suggestion. */
export function compileExpression(src: string, scope: ExprScope, memory: ReadonlySet<string>, env: ExprEnv = {}): Fn<ThinkCtx> {
  return compileExprSrc(src, scope, memory, env).fn;
}

// ---------------------------------------------------------------------------------------------
// Places and zones
// ---------------------------------------------------------------------------------------------

const FIGHTER_NAMES = FIGHTER_REFS.map((r) => r.name);

/** Every word that can start a place, for suggestions and docs. */
export function placeVocabulary(): string[] {
  return [...FIGHTER_NAMES, ...PLACES.map((p) => p.name)];
}

export function zoneVocabulary(): string[] {
  return ZONES.map((z) => z.name);
}

function signature(name: string, args: readonly ArgSpec[]): string {
  return args.length ? `${name}(${args.map((a) => a.name).join(', ')})` : name;
}

function fighterPlace(get: FighterGetter): PlaceFn {
  return (c, out) => {
    const f = get(c);
    if (!f) return false;
    out.x = f.pos.x;
    out.y = f.pos.y;
    out.fighter = f;
    return true;
  };
}

function numberValue(e: Expr): number | null {
  if (e.k === 'num') return e.v;
  if (e.k === 'neg' && e.e.k === 'num') return -e.e.v;
  return null;
}

function compileArg(e: Expr, spec: ArgSpec, owner: string): CompiledArg {
  switch (spec.kind) {
    case 'number': {
      const v = numberValue(e);
      if (v === null) throw new ExprError(`${owner}: ${spec.name} must be a plain number (column ${e.pos + 1}).`, e.pos);
      if ((spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max)) {
        throw new ExprError(`${owner}: ${spec.name} must be between ${spec.min} and ${spec.max}, got ${v} (column ${e.pos + 1}).`, e.pos);
      }
      return { kind: 'number', value: v };
    }
    case 'pickup': {
      const word = e.k === 'ref' ? e.name : '';
      const kind = PICKUP_ARG_WORDS.find((w) => w === word);
      if (kind) return { kind: 'pickup', value: kind };
      throw new ExprError(
        `${owner}: ${spec.name} must be ${PICKUP_ARG_WORDS.join(', ')} (column ${e.pos + 1}).`,
        e.pos, word || undefined, word ? didYouMean(word, PICKUP_ARG_WORDS) : undefined,
      );
    }
    case 'fighter':
    case 'fighters': {
      const allowEnemies = spec.kind === 'fighters';
      if (e.k === 'ref' && allowEnemies && e.name === ENEMIES_WORD) return { kind: 'fighters', get: null };
      const ref = e.k === 'ref' ? FIGHTER_REF_INDEX.get(e.name) : undefined;
      if (ref) return spec.kind === 'fighter' ? { kind: 'fighter', get: ref.get } : { kind: 'fighters', get: ref.get };
      const allowed = allowEnemies ? [...FIGHTER_NAMES, ENEMIES_WORD] : FIGHTER_NAMES;
      const word = e.k === 'ref' ? e.name : e.k === 'call' ? e.fn : '';
      throw new ExprError(
        `${owner}: ${spec.name} must be a fighter (${allowed.join(', ')}) (column ${e.pos + 1}).`,
        e.pos, word || undefined, word ? didYouMean(word, allowed) : undefined,
      );
    }
    case 'place':
      return { kind: 'place', get: placeFromAst(e) };
  }
}

function placeFromAst(e: Expr): PlaceFn {
  if (e.k === 'ref') {
    const ref = FIGHTER_REF_INDEX.get(e.name);
    if (ref) return fighterPlace(ref.get);
    const def = PLACE_INDEX.get(e.name);
    if (def) {
      if (def.args.length) throw new ExprError(`"${e.name}" needs arguments: ${signature(def.name, def.args)} (column ${e.pos + 1}).`, e.pos, e.name);
      return def.build([]);
    }
    if (e.name === ENEMIES_WORD) throw new ExprError(`"enemies" is not one place (column ${e.pos + 1}); use nearest_enemy, or enemies inside cover_from(...) and seen_by(...).`, e.pos, e.name, 'nearest_enemy');
    if (ZONE_INDEX.has(e.name)) {
      const hint = e.name === 'shadow' ? 'dark_spot' : undefined;
      throw new ExprError(`"${e.name}" is a zone, not a place (column ${e.pos + 1}); zones go in avoid/prefer.`, e.pos, e.name, hint);
    }
    if (SENSOR_INDEX.has(e.name)) {
      throw new ExprError(`"${e.name}" is a sensor, not a place (column ${e.pos + 1}); a place says where, e.g. "target" or "behind(target, 40)".`, e.pos, e.name);
    }
    throw new ExprError(`Unknown place "${e.name}" at column ${e.pos + 1}.`, e.pos, e.name, didYouMean(e.name, placeVocabulary()));
  }
  if (e.k === 'call') {
    const def = PLACE_INDEX.get(e.fn);
    if (!def) {
      if (ZONE_INDEX.has(e.fn)) throw new ExprError(`"${e.fn}(...)" is a zone, not a place (column ${e.pos + 1}); zones go in avoid/prefer.`, e.pos, e.fn);
      if (FIGHTER_REF_INDEX.has(e.fn)) throw new ExprError(`"${e.fn}" takes no arguments (column ${e.pos + 1}).`, e.pos, e.fn);
      throw new ExprError(`Unknown place "${e.fn}(...)" at column ${e.pos + 1}.`, e.pos, e.fn, didYouMean(e.fn, PLACES.filter((p) => p.args.length).map((p) => p.name)));
    }
    if (e.args.length !== def.args.length) {
      throw new ExprError(`${def.name} takes ${def.args.length} argument${def.args.length === 1 ? '' : 's'}: ${signature(def.name, def.args)}; got ${e.args.length} (column ${e.pos + 1}).`, e.pos, e.fn);
    }
    const args = e.args.map((a, i) => compileArg(a, def.args[i]!, def.name));
    return def.build(args);
  }
  throw new ExprError(`Expected a place such as "target" or "behind(target, 40)" at column ${e.pos + 1}.`, e.pos);
}

function compilePlaceSrc(src: string): { fn: PlaceFn; nodes: number } {
  if (typeof src !== 'string') throw new ExprError('Expected a place string.', 0);
  const ast = parseExpr(src);
  return { fn: placeFromAst(ast), nodes: exprNodes(ast) };
}

/** Parse and compile a place ("target", "behind(target, 30)", "beyond(hazard_near(target), target, 85)"). */
export function compilePlace(src: string): PlaceFn {
  return compilePlaceSrc(src).fn;
}

/** A compiled zone and its cost per lookup in units (seen_by(enemies) counts GUARDS.costKnown enemies). */
function compileZoneSrc(src: string): { fn: ZoneFn; perSample: number } {
  if (typeof src !== 'string') throw new ExprError('Expected a zone string.', 0);
  const e = parseExpr(src);
  const name = e.k === 'ref' ? e.name : e.k === 'call' ? e.fn : null;
  const def = name ? ZONE_INDEX.get(name) : undefined;
  if (!def || !name) {
    const pos = e.pos;
    if (name && (PLACE_INDEX.has(name) || FIGHTER_REF_INDEX.has(name))) {
      throw new ExprError(`"${name}" is a place, not a zone (column ${pos + 1}); places go in seek, flee, keep_range and orbit.`, pos, name);
    }
    throw new ExprError(`Unknown zone "${name ?? src}" at column ${pos + 1}.`, pos, name ?? undefined, name ? didYouMean(name, zoneVocabulary()) : undefined);
  }
  const args = e.k === 'call' ? e.args : [];
  if (args.length !== def.args.length) {
    throw new ExprError(`${def.name} takes ${def.args.length} argument${def.args.length === 1 ? '' : 's'}: ${signature(def.name, def.args)}; got ${args.length} (column ${e.pos + 1}).`, e.pos, name);
  }
  const compiled = args.map((a, i) => compileArg(a, def.args[i]!, def.name));
  const everyEnemy = compiled.some((a) => a.kind === 'fighters' && a.get === null);
  return { fn: def.build(compiled), perSample: exprNodes(e) + (everyEnemy ? GUARDS.costKnown : 0) };
}

/** Parse and compile a zone ("shadow", "seen_by(enemies)"). */
export function compileZone(src: string): ZoneFn {
  return compileZoneSrc(src).fn;
}

// ---------------------------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------------------------

const TERM_KEYS: readonly TermKind[] = ['seek', 'flee', 'keep_range', 'orbit', 'avoid', 'prefer'];

/** Which kind a move term is (the one term key it carries), or null. */
export function termKind(t: MoveTerm): TermKind | null {
  for (const k of TERM_KEYS) if (k in t) return k;
  return null;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

type Reporter = (issue: CompileIssue) => void;

function attempt<T>(report: Reporter, path: string, src: unknown, fallback: T, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (!(err instanceof ExprError)) throw err;
    // Quote the source, but keep the message one line even for an over-long expression.
    const quoted = typeof src === 'string' && src.length > 80 ? `${src.slice(0, 77)}...` : src;
    const where = typeof src === 'string' ? `In "${quoted}": ${lowerFirst(err.message)}` : err.message;
    report({ path, message: where, suggestion: err.suggestion, pos: typeof src === 'string' ? err.pos : undefined });
    return fallback;
  }
}

type Compiler = {
  report: Reporter;
  memory: ReadonlySet<string>;
  build: BuildFacts | null;
  guards: Guards;
};

/** Compile an expression at `path`, with its guard counters. Returns its cost too (0 if it failed). */
function expressionAt(k: Compiler, path: string, src: string, scope: ExprScope): { fn: Fn<ThinkCtx>; nodes: number } {
  return attempt(k.report, path, src, { fn: ZERO, nodes: 0 }, () => compileExprSrc(src, scope, k.memory, { build: k.build, guards: k.guards.expr(path) }));
}

function compileTerm(k: Compiler, t: MoveTerm, path: string): Omit<CompiledTerm, 'buf'> | null {
  const kind = termKind(t);
  if (!kind) {
    k.report({ path, message: `A move term needs one of ${TERM_KEYS.join(', ')}.` });
    return null;
  }
  let weight = typeof t.weight === 'number' && Number.isFinite(t.weight) ? t.weight : 1;
  if (weight < 0 || weight > GUARDS.weightLimit) {
    // Never reached through the gate (the validator checks weights); counted if it ever is.
    weight = Math.min(GUARDS.weightLimit, Math.max(0, weight));
    k.guards.counter(`${path}.weight`, 'clamped').n++;
  }
  const raw = t as Record<string, unknown>;
  const place = (src: string, at: string) => attempt(k.report, at, src, { fn: NO_PLACE, nodes: 0 }, () => compilePlaceSrc(src));
  switch (kind) {
    case 'seek':
    case 'flee': {
      const src = raw[kind] as string;
      const p = place(src, `${path}.${kind}`);
      return { kind, label: `${kind} ${src}`, weight, rate: kind === 'seek' ? seekTerm(p.fn) : fleeTerm(p.fn), cost: p.nodes };
    }
    case 'keep_range': {
      const [src, min, max] = raw.keep_range as [string, number, number];
      const p = place(src, `${path}.keep_range[0]`);
      return { kind, label: `keep_range ${src} ${min}-${max}`, weight, rate: keepRangeTerm(p.fn, min, max), cost: p.nodes };
    }
    case 'orbit': {
      const [src, dir] = raw.orbit as [string, 'cw' | 'ccw'];
      const p = place(src, `${path}.orbit[0]`);
      return { kind, label: `orbit ${src} ${dir}`, weight, rate: orbitTerm(p.fn, dir === 'ccw' ? 'ccw' : 'cw'), cost: p.nodes };
    }
    case 'avoid':
    case 'prefer': {
      const src = raw[kind] as string;
      const z = attempt(k.report, `${path}.${kind}`, src, { fn: NO_ZONE, perSample: 0 }, () => compileZoneSrc(src));
      return { kind, label: `${kind} ${src}`, weight, rate: zoneTerm(z.fn, kind === 'prefer' ? 1 : -1), cost: z.perSample * GUARDS.zoneSamples };
    }
  }
}

function compileAttack(k: Compiler, src: string, path: string): { policy: AttackPolicy; nodes: number } {
  const trimmed = typeof src === 'string' ? src.trim() : src;
  if (trimmed === 'in_range' || trimmed === 'never' || trimmed === 'if_blocked') return { policy: { kind: trimmed }, nodes: 1 };
  const e = expressionAt(k, path, src, 'behaviour');
  return { policy: { kind: 'expr', fn: e.fn }, nodes: e.nodes };
}

function compileBehaviour(k: Compiler, name: string, b: Behaviour, path: string): CompiledBehaviour {
  const score = expressionAt(k, `${path}.score`, b.score, 'behaviour');
  const terms: CompiledTerm[] = [];
  (b.move ?? []).forEach((t, i) => {
    const ct = compileTerm(k, t, `${path}.move[${i}]`);
    if (ct) terms.push({ ...ct, buf: new Float64Array(STEER_DIRS) });
  });
  const attack = compileAttack(k, b.attack ?? 'in_range', `${path}.attack`);
  const skillSrc = b.skill;
  const skill = skillSrc === undefined ? null : expressionAt(k, `${path}.skill`, skillSrc, 'behaviour');
  const set: CompiledBehaviour['set'] = [];
  let setCost = 0;
  for (const [slot, src] of Object.entries(b.set ?? {})) {
    if (!k.memory.has(slot)) {
      k.report({ path: `${path}.set.${slot}`, message: `Memory slot "${slot}" is not declared; add it to "memory" with a starting value.`, suggestion: didYouMean(slot, [...k.memory]) });
      continue;
    }
    const e = expressionAt(k, `${path}.set.${slot}`, src, 'behaviour');
    set.push({ slot, fn: e.fn });
    setCost += e.nodes;
  }
  const weightSum = terms.reduce((s, t) => s + Math.abs(t.weight), 0);
  const actionCost = terms.reduce((s, t) => s + t.cost, 0) + attack.nodes + (skill?.nodes ?? 0) + setCost;
  return {
    name, path, score: score.fn, scoreCost: score.nodes, scoreClamp: k.guards.counter(`${path}.score`, 'clamped'),
    terms, weightSum, attack: attack.policy, skill: skill?.fn ?? null, set, stance: b.stance ?? 'normal', actionCost,
  };
}

/**
 * Compile a strategy. With `report`, every problem is reported (with its path) and compilation
 * continues with harmless stand-ins, so a validator can list all errors at once. Without it, the
 * first problem throws a StrategyCompileError.
 */
export function compileStrategy(strategy: Strategy, report?: Reporter): CompiledStrategy {
  const rep: Reporter = report ?? ((issue) => {
    throw new StrategyCompileError(issue);
  });
  const memory = new Set(Object.keys(strategy.memory ?? {}));
  for (const slot of memory) {
    if (SENSOR_INDEX.has(slot) || KEYWORDS.includes(slot) || Object.hasOwn(FUNCTIONS, slot) || slot.includes('.')) {
      rep({ path: `memory.${slot}`, message: `"${slot}" cannot be a memory slot name: it is already a sensor, keyword or function, or contains a dot.` });
    }
  }
  const b = strategy.build;
  const build = b && Object.hasOwn(WEAPONS, b.weapon) && b.attributes ? b : null;
  const guards = new Guards();
  const k: Compiler = { report: rep, memory, build, guards };
  const target = expressionAt(k, 'target', strategy.target, 'target');
  const behaviours: CompiledBehaviour[] = [];
  for (const [name, beh] of mergeBehaviours(strategy)) {
    const path = Object.hasOwn(strategy.behaviours ?? {}, name) ? `behaviours.${name}` : `imports.${name}`;
    behaviours.push(compileBehaviour(k, name, beh, path));
  }
  if (behaviours.length === 0) rep({ path: 'behaviours', message: 'A strategy needs at least one behaviour.' });
  return {
    name: strategy.name,
    target: target.fn,
    targetCost: target.nodes,
    behaviours,
    memory: { ...(strategy.memory ?? {}) },
    commit: strategy.commit ?? 0,
    guards,
    costTrip: guards.counter('think', 'cost'),
  };
}

/**
 * The most a think can cost, in units: the target expression once per enemy you could know
 * (GUARDS.costKnown), every behaviour's score, and the dearest behaviour's actions. The brain never
 * spends more than this, so a strategy within GUARDS.costBudget never hits the runtime budget.
 */
export function worstThinkCost(s: CompiledStrategy): { total: number; target: number; scores: number; action: number; dearest: CompiledBehaviour | null } {
  const target = s.targetCost * GUARDS.costKnown;
  const scores = s.behaviours.reduce((n, b) => n + b.scoreCost, 0);
  let dearest: CompiledBehaviour | null = null;
  for (const b of s.behaviours) if (!dearest || b.actionCost > dearest.actionCost) dearest = b;
  const action = dearest?.actionCost ?? 0;
  return { total: target + scores + action, target, scores, action, dearest };
}
