// Owned by: ui
// Text-level helpers for the visual builder: target preferences as the additive terms of the
// target expression, scrubbing a number inside an expression, and places and zones as call trees
// for the pickers. Everything works on the player's own text and changes only what it must.
import { ENEMIES_WORD, PLACES, ZONES, parseExpr } from '../../brain';
import type { ArgSpec, Expr } from '../../brain';
import { lexExpr } from './language';
import type { ExprToken } from './language';

// ---------------------------------------------------------------------------------------------
// Additive terms
// ---------------------------------------------------------------------------------------------

export type SumTerm = { sign: 1 | -1; text: string };

const LOOSER_THAN_SUM = new Set(['<', '<=', '>', '>=', '==', '!=', 'and', 'or', 'not']);

function isValueEnd(t: ExprToken | undefined): boolean {
  return !!t && (t.kind === 'num' || t.kind === 'close' || (t.kind === 'name' && !LOOSER_THAN_SUM.has(t.text)));
}

/**
 * The top-level terms of a sum: `0 - it.distance + 80 * it.is_target` is `0`, `- it.distance`,
 * `+ 80 * it.is_target`. Null when the expression is not a plain sum (a top-level comparison or
 * `and`/`or` binds looser than `+`, so splitting there would change its meaning), or is empty.
 */
export function splitSum(src: string): SumTerm[] | null {
  const toks = lexExpr(src);
  if (!toks.length) return null;
  let depth = 0;
  const cuts: { at: number; sign: 1 | -1; end: number }[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind === 'open') depth++;
    else if (t.kind === 'close') depth--;
    else if (depth === 0 && (t.kind === 'op' || t.kind === 'name') && LOOSER_THAN_SUM.has(t.text)) return null;
    else if (depth === 0 && t.kind === 'op' && (t.text === '+' || t.text === '-') && isValueEnd(toks[i - 1])) {
      cuts.push({ at: t.from, end: t.to, sign: t.text === '-' ? -1 : 1 });
    } else if (t.kind === 'bad') return null;
  }
  if (depth !== 0) return null;
  const out: SumTerm[] = [];
  let start = 0;
  let sign: 1 | -1 = 1;
  for (const c of cuts) {
    out.push({ sign, text: src.slice(start, c.at).trim() });
    start = c.end;
    sign = c.sign;
  }
  out.push({ sign, text: src.slice(start).trim() });
  if (out.some((t) => !t.text)) return null;
  // A leading unary minus belongs to the first term's sign.
  const first = out[0]!;
  const lead = /^-\s*(?![\d.])/.exec(first.text);
  if (lead) out[0] = { sign: -1, text: first.text.slice(lead[0].length) };
  return out;
}

function needsParens(text: string): boolean {
  const parts = splitSum(text);
  return parts === null ? /\b(and|or|not)\b|[<>=!]/.test(text) : parts.length > 1;
}

/** Inverse of `splitSum`. A term that is itself a sum or a comparison is wrapped in parentheses. */
export function joinSum(terms: readonly SumTerm[]): string {
  return terms
    .map((t, i) => {
      const body = needsParens(t.text) && (t.sign < 0 || terms.length > 1) ? `(${t.text})` : t.text;
      if (i === 0) return t.sign < 0 ? `-${body}` : body;
      return `${t.sign < 0 ? '-' : '+'} ${body}`;
    })
    .join(' ');
}

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

/** Decimal places a number literal is written with (`0.25` has 2). */
export function decimalsOf(text: string): number {
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * A scrubbed number: `start` moved by `steps` of its smallest written unit (a `0.25` moves by
 * 0.01, a `200` by 1), never below `min`, written with the same decimals.
 */
export function scrubbed(start: string, steps: number, min = 0, max = Infinity): string {
  const d = decimalsOf(start);
  const unit = 10 ** -d;
  const v = Math.min(max, Math.max(min, Number(start) + steps * unit));
  return v.toFixed(d);
}

/** `src` with the token `tok` replaced by `text`. */
export function replaceToken(src: string, tok: Pick<ExprToken, 'from' | 'to'>, text: string): string {
  return src.slice(0, tok.from) + text + src.slice(tok.to);
}

// ---------------------------------------------------------------------------------------------
// Places and zones as call trees
// ---------------------------------------------------------------------------------------------

export type CallArg = { kind: 'call'; call: Call } | { kind: 'num'; value: number };
export type Call = { name: string; args: CallArg[] };

function toCall(e: Expr): Call | null {
  if (e.k === 'ref') return { name: e.name, args: [] };
  if (e.k !== 'call') return null;
  const args: CallArg[] = [];
  for (const a of e.args) {
    if (a.k === 'num') args.push({ kind: 'num', value: a.v });
    else if (a.k === 'neg' && a.e.k === 'num') args.push({ kind: 'num', value: -a.e.v });
    else {
      const c = toCall(a);
      if (!c) return null;
      args.push({ kind: 'call', call: c });
    }
  }
  return { name: e.fn, args };
}

/** `behind(target, 36)` as a tree, or null when the text is not a plain name or call. */
export function parseCall(src: string): Call | null {
  try {
    return toCall(parseExpr(src));
  } catch {
    return null;
  }
}

export function printCall(c: Call): string {
  if (!c.args.length) return c.name;
  return `${c.name}(${c.args.map((a) => (a.kind === 'num' ? String(a.value) : printCall(a.call))).join(', ')})`;
}

/** A sensible first value for an argument: the target, every enemy, any power-up, 40 px. */
export function argDefault(a: ArgSpec): CallArg {
  switch (a.kind) {
    case 'fighter':
    case 'place':
      return { kind: 'call', call: { name: 'target', args: [] } };
    case 'fighters':
      return { kind: 'call', call: { name: ENEMIES_WORD, args: [] } };
    case 'pickup':
      return { kind: 'call', call: { name: 'any', args: [] } };
    case 'number': {
      const lo = a.min ?? 0;
      const hi = a.max ?? 100;
      return { kind: 'num', value: lo <= 40 && 40 <= hi ? 40 : lo };
    }
  }
}

/** The arguments a place or zone takes (none for fighters and unknown names). */
export function argsOf(name: string, zone: boolean): readonly ArgSpec[] {
  return (zone ? ZONES : PLACES).find((d) => d.name === name)?.args ?? [];
}

/**
 * `name` as a call with arguments: those `prev` already had under the same name and kind (switching
 * behind(nearest_enemy, 60) to side keeps the fighter X and the distance d), defaults for the rest.
 */
export function defaultCall(name: string, zone: boolean, prev: Call | null = null): Call {
  const specs = argsOf(name, zone);
  const prevSpecs = prev ? argsOf(prev.name, zone) : [];
  return {
    name,
    args: specs.map((spec) => {
      // A single fighter also fits where a group of fighters is accepted.
      const j = prevSpecs.findIndex((p) => p.name === spec.name && (p.kind === spec.kind || (p.kind === 'fighter' && spec.kind === 'fighters')));
      const old = j >= 0 ? prev?.args[j] : undefined;
      return old ?? argDefault(spec);
    }),
  };
}
