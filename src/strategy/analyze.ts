/**
 * Static analysis: everything a runtime guard could catch, found before the match.
 *
 * Every sensor declares its range in the registry (and reads inside it at runtime), so the range
 * of every expression can be worked out by interval arithmetic over its syntax tree: a division
 * whose divisor can be 0, a score that can leave ±GUARDS.scoreLimit, a value that can overflow are
 * errors, because the runtime guards would have to catch them. Comparisons that are always true or
 * always false, expressions that cannot change, behaviours that can never win, memory that is
 * never read or never written, weightless moves and strategies that never attack are warnings.
 * The worst-case evaluation cost of a think is checked against GUARDS.costBudget.
 *
 * Interval arithmetic over-approximates (it does not know that `x` and `1 - x` move together), so
 * every "can" is a "might", and every "always" and "never" is certain.
 */

import { WEAPONS } from '../core';
import type { Strategy } from '../core';
import { GUARDS, SENSOR_INDEX, exprText, parseExpr, sensorRange, worstThinkCost } from '../brain';
import type { BinOp, BuildFacts, CompiledStrategy, CompileIssue, ExprScope, Expr, ValueRange } from '../brain';
import { mergeBehaviours } from './library';

export type AnalysisIssue = CompileIssue & { severity: 'error' | 'warning' };

export type Analysis = {
  issues: AnalysisIssue[];
  /** Range each behaviour's score can take (after the runtime cut to ±GUARDS.scoreLimit). */
  scores: Record<string, ValueRange>;
  memory: Record<string, ValueRange>;
  /** Worst-case evaluation units of one think. */
  cost: number;
};

/** Beyond this a value risks becoming Infinity, which the runtime would have to turn into 0. */
const OVERFLOW = 1e300;
const MEMORY_ROUNDS = 12;

type Walk = {
  path: string;
  src: string;
  scope: ExprScope;
  build: BuildFacts;
  memory: ReadonlyMap<string, ValueRange>;
  /** Where findings go; null while only ranges are wanted (memory fixpoint). */
  out: AnalysisIssue[] | null;
  /** A division by something that can be 0 was reported: later findings would repeat that cause. */
  tainted: boolean;
  /** A comparison was reported always true or false (so "constant" would say the same twice). */
  decided: boolean;
  /** A sensor is read (only then can a constant result be a mistake rather than a choice). */
  readsSensor: boolean;
  memoryRead: Set<string>;
};

function r(lo: number, hi: number): ValueRange {
  // NaN bounds come from Infinity - Infinity and friends: treat them as unbounded.
  return { lo: Number.isNaN(lo) ? -Infinity : lo, hi: Number.isNaN(hi) ? Infinity : hi };
}

const BOOL: ValueRange = { lo: 0, hi: 1 };
const TRUE: ValueRange = { lo: 1, hi: 1 };
const FALSE: ValueRange = { lo: 0, hi: 0 };

function fmt(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? 'infinity' : '-infinity';
  if (Math.abs(v) >= 1e6) return v.toExponential(2);
  return String(Math.round(v * 1000) / 1000);
}

function fmtRange(x: ValueRange): string {
  return x.lo === x.hi ? fmt(x.lo) : `${fmt(x.lo)}..${fmt(x.hi)}`;
}

/** Truthiness: 1 = always above 0, 0 = never, null = depends. */
function truth(x: ValueRange): 0 | 1 | null {
  if (x.lo > 0) return 1;
  if (x.hi <= 0) return 0;
  return null;
}

/** Unbounded: the value may be anything, including Infinity or NaN at runtime. */
const WILD: ValueRange = { lo: -Infinity, hi: Infinity };

/**
 * A range that may hold values a double cannot keep finite. Arithmetic on such a value can give
 * NaN at runtime (Infinity - Infinity, 0 x Infinity), so any arithmetic on it is WILD.
 * Comparisons and logic are safe: they always give 0 or 1.
 */
function wild(x: ValueRange): boolean {
  return !(Math.abs(x.lo) <= OVERFLOW && Math.abs(x.hi) <= OVERFLOW);
}

function mul(a: ValueRange, b: ValueRange): ValueRange {
  const p = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi];
  return r(Math.min(...p), Math.max(...p));
}

function compare(op: BinOp, a: ValueRange, b: ValueRange): 0 | 1 | null {
  switch (op) {
    case '<':
      return a.hi < b.lo ? 1 : a.lo >= b.hi ? 0 : null;
    case '<=':
      return a.hi <= b.lo ? 1 : a.lo > b.hi ? 0 : null;
    case '>':
      return a.lo > b.hi ? 1 : a.hi <= b.lo ? 0 : null;
    case '>=':
      return a.lo >= b.hi ? 1 : a.hi < b.lo ? 0 : null;
    case '==':
      return a.hi < b.lo || b.hi < a.lo ? 0 : a.lo === a.hi && b.lo === b.hi ? 1 : null;
    case '!=':
      return a.hi < b.lo || b.hi < a.lo ? 1 : a.lo === a.hi && b.lo === b.hi ? 0 : null;
    default:
      return null;
  }
}

function quote(src: string): string {
  return src.length > 80 ? `${src.slice(0, 77)}...` : src;
}

function find(w: Walk, severity: 'error' | 'warning', message: string, pos?: number): void {
  if (!w.out) return;
  w.out.push({ path: w.path, severity, message: `In "${quote(w.src)}": ${message}`, ...(pos === undefined ? {} : { pos }) });
}

function rangeOf(e: Expr, w: Walk): ValueRange {
  switch (e.k) {
    case 'num':
      return { lo: e.v, hi: e.v };
    case 'ref': {
      const idx = SENSOR_INDEX.get(e.name);
      if (idx !== undefined) {
        w.readsSensor = true;
        return sensorRange(idx, w.build);
      }
      w.memoryRead.add(e.name);
      return w.memory.get(e.name) ?? FALSE;
    }
    case 'neg': {
      const a = rangeOf(e.e, w);
      return wild(a) ? WILD : { lo: -a.hi, hi: -a.lo };
    }
    case 'not': {
      const t = truth(rangeOf(e.e, w));
      return t === null ? BOOL : t ? FALSE : TRUE;
    }
    case 'call': {
      const args = e.args.map((x) => rangeOf(x, w));
      // Math.min/max/abs pass a NaN through, so a wild argument makes the call wild.
      if (args.some(wild)) return WILD;
      switch (e.fn) {
        case 'abs': {
          const a = args[0]!;
          if (a.lo >= 0) return a;
          if (a.hi <= 0) return { lo: -a.hi, hi: -a.lo };
          return { lo: 0, hi: Math.max(-a.lo, a.hi) };
        }
        case 'min':
          return { lo: Math.min(...args.map((a) => a.lo)), hi: Math.min(...args.map((a) => a.hi)) };
        case 'max':
          return { lo: Math.max(...args.map((a) => a.lo)), hi: Math.max(...args.map((a) => a.hi)) };
        case 'clamp': {
          const [x, lo, hi] = args.length === 1 ? [args[0]!, FALSE, TRUE] : [args[0]!, args[1]!, args[2]!];
          const m = { lo: Math.max(lo.lo, x.lo), hi: Math.max(lo.hi, x.hi) };
          return { lo: Math.min(hi.lo, m.lo), hi: Math.min(hi.hi, m.hi) };
        }
      }
      return WILD;
    }
    case 'bin':
      return binRange(e, w);
  }
}

function binRange(e: Extract<Expr, { k: 'bin' }>, w: Walk): ValueRange {
  const a = rangeOf(e.a, w);
  const b = rangeOf(e.b, w);
  const arithmetic = e.op === '+' || e.op === '-' || e.op === '*' || e.op === '/';
  if (arithmetic && (wild(a) || wild(b))) return WILD;
  switch (e.op) {
    case '+':
      return r(a.lo + b.lo, a.hi + b.hi);
    case '-':
      return r(a.lo - b.hi, a.hi - b.lo);
    case '*':
      return mul(a, b);
    case '/': {
      if (b.lo === 0 && b.hi === 0) {
        if (!w.tainted) find(w, 'error', `this divides by "${exprText(e.b)}", which is always 0, so the result is always 0. Remove the division.`, e.pos);
        w.tainted = true;
        return FALSE;
      }
      if (b.lo <= 0 && b.hi >= 0) {
        if (!w.tainted) find(w, 'error', `"${exprText(e.b)}" can be 0 (it reads ${fmtRange(b)}), and a division by 0 gives 0. Divide by something that cannot be 0, e.g. max(1, ${exprText(e.b)}).`, e.pos);
        w.tainted = true;
        return WILD;
      }
      return mul(a, { lo: 1 / b.hi, hi: 1 / b.lo });
    }
    case 'and': {
      const ta = truth(a);
      const tb = truth(b);
      return ta === 0 || tb === 0 ? FALSE : ta === 1 && tb === 1 ? TRUE : BOOL;
    }
    case 'or': {
      const ta = truth(a);
      const tb = truth(b);
      return ta === 1 || tb === 1 ? TRUE : ta === 0 && tb === 0 ? FALSE : BOOL;
    }
    default: {
      // NaN compares false whatever the ranges say, so nothing is decided about a wild side.
      const t = wild(a) || wild(b) ? null : compare(e.op, a, b);
      if (t === null) return BOOL;
      if (!w.tainted && !w.decided) {
        const side = (x: Expr, rx: ValueRange) => (x.k === 'num' ? null : `${exprText(x)} reads ${fmtRange(rx)}`);
        const why = [side(e.a, a), side(e.b, b)].filter((x) => x !== null).join(', ');
        find(w, 'warning', `"${exprText(e)}" is always ${t ? 'true' : 'false'}${why ? ` (${why})` : ''}.`, e.pos);
      }
      w.decided = true;
      return t ? TRUE : FALSE;
    }
  }
}

function walker(path: string, src: string, scope: ExprScope, build: BuildFacts, memory: ReadonlyMap<string, ValueRange>, out: AnalysisIssue[] | null): Walk {
  return { path, src, scope, build, memory, out, tainted: false, decided: false, readsSensor: false, memoryRead: new Set() };
}

/** Range of one expression, with its findings appended to `out` (or none when out is null). */
function analyseExpr(w: Walk): ValueRange {
  const e = parseExpr(w.src);
  const range = rangeOf(e, w);
  if (w.tainted) return range;
  if (wild(range)) {
    find(w, 'error', `this can grow to ${fmtRange(range)}, past what a number can hold, and would then read 0. Use smaller factors or wrap parts in min/max.`);
    w.tainted = true;
  } else if (range.lo === range.hi && w.readsSensor && !w.decided && e.k !== 'num') {
    find(w, 'warning', `this is always ${fmt(range.lo)}, whatever the sensors read; write ${fmt(range.lo)} or fix the formula.`);
  }
  return range;
}

/**
 * The range of one expression for a build, with what the analysis says about it (errors are what
 * a runtime guard would otherwise catch). For tests and editor tooling; throws ExprError on bad text.
 */
export function expressionRange(src: string, scope: ExprScope, build: BuildFacts, memory: ReadonlyMap<string, ValueRange> = new Map()): { range: ValueRange; issues: AnalysisIssue[] } {
  const issues: AnalysisIssue[] = [];
  const range = analyseExpr(walker('', src, scope, build, memory, issues));
  return { range, issues };
}

type ExprSite = { path: string; src: string; scope: ExprScope; own: boolean; role: 'target' | 'score' | 'attack' | 'skill' | 'set'; behaviour?: string; slot?: string };

/**
 * Analyse a normalized strategy. `compiled` supplies the costs (the brain's own accounting, so the
 * budget check and the runtime counter cannot disagree). Meant for a strategy without errors; on
 * one with errors it still runs (expressions that do not parse are skipped), and the validator
 * keeps only the findings its own errors do not explain.
 */
export function analyzeStrategy(s: Strategy, compiled: CompiledStrategy): Analysis {
  const issues: AnalysisIssue[] = [];
  const build: BuildFacts = s.build;
  const behaviours = mergeBehaviours(s);
  const imports = s.imports ?? [];
  const ownNames = new Set(Object.keys(s.behaviours));
  const behaviourPath = (name: string) => (ownNames.has(name) ? `behaviours.${name}` : `imports[${imports.indexOf(name)}]`);

  // Every expression, where it lives and whether the player wrote it (imports are library text).
  const sites: ExprSite[] = [{ path: 'target', src: s.target, scope: 'target', own: true, role: 'target' }];
  for (const [name, b] of behaviours) {
    const own = ownNames.has(name);
    const base = own ? `behaviours.${name}` : `imports.${name}`;
    sites.push({ path: `${base}.score`, src: b.score, scope: 'behaviour', own, role: 'score', behaviour: name });
    const attack = b.attack.trim();
    if (attack !== 'in_range' && attack !== 'never' && attack !== 'if_blocked') sites.push({ path: `${base}.attack`, src: b.attack, scope: 'behaviour', own, role: 'attack', behaviour: name });
    if (b.skill !== undefined) sites.push({ path: `${base}.skill`, src: b.skill, scope: 'behaviour', own, role: 'skill', behaviour: name });
    for (const [slot, src] of Object.entries(b.set ?? {})) sites.push({ path: `${base}.set.${slot}`, src, scope: 'behaviour', own, role: 'set', behaviour: name, slot });
  }
  // Text that does not parse is the validator's to report; the analysis works on the rest.
  const parses = (src: string) => {
    try {
      parseExpr(src);
      return true;
    } catch {
      return false;
    }
  };
  const usable = sites.filter((site) => parses(site.src));

  // Memory: start from the starting values and widen by every write until nothing changes. A slot
  // that keeps growing (a counter) is taken to reach the saturation limit, which ends the search.
  const memory = new Map<string, ValueRange>(Object.entries(s.memory ?? {}).map(([k, v]) => [k, { lo: v, hi: v }]));
  const M = GUARDS.memoryLimit;
  const sets = usable.filter((x) => x.role === 'set' && memory.has(x.slot!));
  /** One round of writes; returns the slots whose low or high bound moved, and which way. */
  const pass = (): Map<string, { lo: boolean; hi: boolean }> => {
    const moved = new Map<string, { lo: boolean; hi: boolean }>();
    for (const site of sets) {
      const v = rangeOf(parseExpr(site.src), walker(site.path, site.src, site.scope, build, memory, null));
      const cur = memory.get(site.slot!)!;
      const lo = Math.max(-M, Math.min(cur.lo, v.lo));
      const hi = Math.min(M, Math.max(cur.hi, v.hi));
      if (lo === cur.lo && hi === cur.hi) continue;
      memory.set(site.slot!, { lo, hi });
      const m = moved.get(site.slot!) ?? { lo: false, hi: false };
      moved.set(site.slot!, { lo: m.lo || lo !== cur.lo, hi: m.hi || hi !== cur.hi });
    }
    return moved;
  };
  for (;;) {
    let moving = pass();
    for (let round = 1; round < MEMORY_ROUNDS && moving.size > 0; round++) moving = pass();
    if (moving.size === 0) break;
    // Still growing: it grows to the limit. Each widening is final (a bound at the limit cannot
    // move again), so this ends.
    for (const [slot, m] of moving) {
      const cur = memory.get(slot)!;
      memory.set(slot, { lo: m.lo ? -M : cur.lo, hi: m.hi ? M : cur.hi });
    }
  }

  // Ranges and findings per expression.
  const scores: Record<string, ValueRange> = {};
  const memoryRead = new Set<string>();
  const truthOf = new Map<string, 0 | 1 | null>();
  for (const site of usable) {
    const out = site.own ? issues : null;
    const w = walker(site.path, site.src, site.scope, build, memory, out);
    const range = analyseExpr(w);
    for (const m of w.memoryRead) memoryRead.add(m);
    if (site.role === 'attack') truthOf.set(site.behaviour!, truth(range));
    if (site.role !== 'score') continue;
    const L = GUARDS.scoreLimit;
    if (!w.tainted && (range.lo < -L || range.hi > L)) {
      issues.push({
        path: site.path, severity: 'error',
        message: `This score can reach ${fmtRange(range)}; scores are cut to -${L}..${L}. Scale it down, or wrap it: clamp(${quote(site.src)}, -${L}, ${L}).`,
      });
    }
    scores[site.behaviour!] = { lo: Math.max(-L, Math.min(L, range.lo)), hi: Math.max(-L, Math.min(L, range.hi)) };
  }

  // Behaviours that can never win: another one always scores more (or the same, and comes first).
  const order = behaviours.map(([n]) => n);
  const neverWins = new Set<string>();
  order.forEach((name, i) => {
    const mine = scores[name];
    if (!mine) return;
    const rival = order.find((other, j) => {
      const o = scores[other];
      return other !== name && o !== undefined && (o.lo > mine.hi || (j < i && o.lo >= mine.hi));
    });
    if (!rival) return;
    neverWins.add(name);
    // An import the build rules out gets the clearer message below.
    if (!ownNames.has(name) && mine.hi <= 0) return;
    const what = ownNames.has(name) ? `Behaviour "${name}"` : `Imported "${name}"`;
    issues.push({
      path: behaviourPath(name), severity: 'warning',
      message: `${what} can never win: it scores at most ${fmt(mine.hi)}, and "${rival}" always scores at least ${fmt(scores[rival]!.lo)}. Raise its score or remove it.`,
    });
  });
  for (const name of imports) {
    if (ownNames.has(name)) {
      issues.push({ path: `imports[${imports.indexOf(name)}]`, severity: 'warning', message: `Your own behaviour "${name}" replaces the imported one; remove "${name}" from imports.` });
    } else if (scores[name] && scores[name]!.hi <= 0) {
      issues.push({
        path: `imports[${imports.indexOf(name)}]`, severity: 'warning',
        message: `Imported "${name}" never scores above 0 for a ${WEAPONS[s.build.weapon].name.toLowerCase()} build, so it only runs when nothing else wants to; remove it from imports.`,
      });
    }
  }

  // Memory slots that do nothing.
  const written = new Set(sets.map((x) => x.slot!));
  for (const slot of Object.keys(s.memory ?? {})) {
    const read = memoryRead.has(slot);
    if (!read && !written.has(slot)) issues.push({ path: `memory.${slot}`, severity: 'warning', message: `Memory slot "${slot}" is never read or written; remove it.` });
    else if (!read) issues.push({ path: `memory.${slot}`, severity: 'warning', message: `Memory slot "${slot}" is written but never read; use it in an expression or remove it.` });
    else if (!written.has(slot)) issues.push({ path: `memory.${slot}`, severity: 'warning', message: `Memory slot "${slot}" is never written, so it always reads ${fmt(s.memory![slot]!)}; write it with "set" or use the number instead.` });
  }

  // Moves that cannot move, and a strategy that can never attack.
  for (const [name, b] of Object.entries(s.behaviours)) {
    if (b.move.length > 0 && b.move.every((t) => t.weight === 0)) {
      issues.push({ path: `behaviours.${name}.move`, severity: 'warning', message: `Every move weight in "${name}" is 0, so it stands still; raise a weight, or make "move" an empty list if standing still is the plan.` });
    }
  }
  const canAttack = behaviours.some(([name, b]) => {
    if (neverWins.has(name)) return false;
    const a = b.attack.trim();
    if (a === 'never') return false;
    if (a === 'in_range' || a === 'if_blocked') return true;
    return truthOf.get(name) !== 0;
  });
  if (!canAttack) issues.push({ path: 'behaviours', severity: 'warning', message: 'No behaviour that can win ever attacks, so this fighter never deals weapon damage; give one an attack policy such as "in_range".' });

  // The evaluation budget.
  const cost = worstThinkCost(compiled);
  if (cost.total > GUARDS.costBudget) {
    const at = cost.target >= cost.action && cost.target >= cost.scores ? 'target' : cost.action >= cost.scores && cost.dearest ? cost.dearest.path : 'behaviours';
    const where = at === 'target'
      ? `the target expression (${cost.target}, it runs once per enemy)`
      : cost.action >= cost.scores && cost.dearest
        ? `"${cost.dearest.name}" (${cost.action}; seen_by(enemies) in avoid/prefer is the dearest part)`
        : `the behaviour scores (${cost.scores})`;
    issues.push({
      path: at.startsWith('imports.') ? `imports[${imports.indexOf(at.slice(8))}]` : at, severity: 'error',
      message: `A think can cost up to ${cost.total} units; the budget is ${GUARDS.costBudget}. The biggest part is ${where}: shorten expressions or use fewer, cheaper avoid/prefer terms.`,
    });
  }

  return { issues, scores, memory: Object.fromEntries(memory), cost: cost.total };
}
