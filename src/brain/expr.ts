/**
 * The expression language of pit-strategy/2: tokenizer, recursive-descent parser and a compiler
 * that turns the syntax tree into plain closures once per strategy. No `eval`, no `Function`.
 *
 * Grammar, loosest binding first:
 *   or      := and ('or' and)*
 *   and     := not ('and' not)*
 *   not     := 'not' not | compare
 *   compare := sum (('<' | '<=' | '>' | '>=' | '==' | '!=') sum)?     comparisons do not chain
 *   sum     := product (('+' | '-') product)*
 *   product := unary (('*' | '/') unary)*
 *   unary   := '-' unary | primary
 *   primary := number | 'true' | 'false' | name | name '(' args ')' | '(' or ')'
 *
 * Values are numbers. Comparisons and `and`/`or`/`not` return 1 or 0. Anything above 0 counts as
 * true. Division by zero gives 0, and a result that is not a finite number reads as 0, so a
 * strategy can never poison the steering maths with NaN.
 */

export type BinOp = '+' | '-' | '*' | '/' | '<' | '<=' | '>' | '>=' | '==' | '!=' | 'and' | 'or';

export type Expr =
  | { k: 'num'; v: number; pos: number }
  | { k: 'ref'; name: string; pos: number }
  | { k: 'neg'; e: Expr; pos: number }
  | { k: 'not'; e: Expr; pos: number }
  | { k: 'bin'; op: BinOp; a: Expr; b: Expr; pos: number }
  | { k: 'call'; fn: string; args: Expr[]; pos: number };

/** A parse or name error. `pos` is a 0-based character offset into the source. */
export class ExprError extends Error {
  constructor(
    message: string,
    readonly pos: number,
    /** The unknown or misused name, when the error is about one. */
    readonly ident?: string,
    readonly suggestion?: string,
  ) {
    super(message);
    this.name = 'ExprError';
  }
}

/** Built-in functions, documented for the rulebook. */
export const FUNCTIONS: Readonly<Record<string, { minArgs: number; maxArgs: number; signature: string; doc: string }>> = {
  min: { minArgs: 2, maxArgs: 8, signature: 'min(a, b, ...)', doc: 'Smallest of its arguments.' },
  max: { minArgs: 2, maxArgs: 8, signature: 'max(a, b, ...)', doc: 'Largest of its arguments.' },
  clamp: { minArgs: 1, maxArgs: 3, signature: 'clamp(x, lo, hi) or clamp(x)', doc: 'x limited to [lo, hi]; with one argument, to [0, 1].' },
  abs: { minArgs: 1, maxArgs: 1, signature: 'abs(x)', doc: 'x without its sign.' },
};

/** Words with a fixed meaning; they cannot be used as memory slot names. */
export const KEYWORDS: readonly string[] = ['and', 'or', 'not', 'true', 'false'];

/**
 * Longest expression (characters) and deepest syntax tree the parser accepts. Strategy text comes
 * from strangers (codes, pasted JSON), and parsing, compiling and evaluating all recurse over the
 * tree, so these bounds are what keep any input from overflowing the stack.
 */
export const MAX_EXPR_LENGTH = 600;
export const MAX_EXPR_DEPTH = 48;

// ---------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------

type Token =
  | { t: 'num'; v: number; pos: number; text: string }
  | { t: 'name'; v: string; pos: number; text: string }
  | { t: 'op'; v: string; pos: number; text: string }
  | { t: 'eof'; pos: number; text: string };

const TWO_CHAR_OPS = ['<=', '>=', '==', '!='];
const ONE_CHAR_OPS = '+-*/<>(),';
/** Operators people bring from other languages, with what to write instead. */
const FOREIGN_OPS: Readonly<Record<string, string>> = {
  '&&': 'and',
  '||': 'or',
  '!': 'not',
  '=': '==',
  '%': 'a different formula (there is no remainder operator)',
  '^': 'a * a (there is no power operator)',
  '?': 'a sum of products, e.g. "c * a + (1 - c) * b" (there is no ?: operator)',
};

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isNameStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isNameChar(ch: string): boolean {
  return isNameStart(ch) || isDigit(ch);
}

function describe(tok: Token): string {
  return tok.t === 'eof' ? 'the end' : `"${tok.text}"`;
}

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    const start = i;
    if (isDigit(ch) || (ch === '.' && isDigit(src[i + 1] ?? ''))) {
      while (i < src.length && isDigit(src[i]!)) i++;
      if (src[i] === '.') {
        i++;
        while (i < src.length && isDigit(src[i]!)) i++;
      }
      if (isNameStart(src[i] ?? '')) throw new ExprError(`A number cannot run into a name at column ${start + 1}.`, start);
      const text = src.slice(start, i);
      out.push({ t: 'num', v: Number(text), pos: start, text });
      continue;
    }
    if (isNameStart(ch)) {
      // A name is one or more identifiers joined by dots: `self.hp`, `target.distance`, `flee_timer`.
      for (;;) {
        while (i < src.length && isNameChar(src[i]!)) i++;
        if (src[i] === '.' && isNameStart(src[i + 1] ?? '')) {
          i++;
          continue;
        }
        break;
      }
      if (src[i] === '.') throw new ExprError(`Name "${src.slice(start, i + 1)}" ends with a dot at column ${i + 1}.`, i);
      const text = src.slice(start, i);
      out.push({ t: 'name', v: text, pos: start, text });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) {
      out.push({ t: 'op', v: two, pos: i, text: two });
      i += 2;
      continue;
    }
    if (two === '&&' || two === '||') {
      throw new ExprError(`"${two}" at column ${i + 1} is not an operator here; write "${FOREIGN_OPS[two]}".`, i, two, FOREIGN_OPS[two]);
    }
    if (ONE_CHAR_OPS.includes(ch)) {
      out.push({ t: 'op', v: ch, pos: i, text: ch });
      i++;
      continue;
    }
    const instead = FOREIGN_OPS[ch];
    if (instead) throw new ExprError(`"${ch}" at column ${i + 1} is not an operator here; write ${instead.includes(' ') ? instead : `"${instead}"`}.`, i, ch, instead.includes(' ') ? undefined : instead);
    throw new ExprError(`Unexpected character "${ch}" at column ${i + 1}.`, i);
  }
  out.push({ t: 'eof', pos: src.length, text: '' });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

const COMPARE_OPS = ['<', '<=', '>', '>=', '==', '!='];

class Parser {
  private i = 0;
  constructor(private readonly toks: Token[]) {}

  private peek(): Token {
    return this.toks[this.i]!;
  }

  private next(): Token {
    return this.toks[this.i++]!;
  }

  private isOp(v: string): boolean {
    const t = this.peek();
    return t.t === 'op' && t.v === v;
  }

  private isWord(v: string): boolean {
    const t = this.peek();
    return t.t === 'name' && t.v === v;
  }

  parseAll(): Expr {
    const first = this.peek();
    if (first.t === 'eof') throw new ExprError('Expression is empty.', 0);
    const e = this.or();
    const rest = this.peek();
    if (rest.t !== 'eof') {
      const hint = rest.t === 'op' && rest.v === ')' ? ' (one ")" too many)' : ' (missing an operator?)';
      throw new ExprError(`Unexpected ${describe(rest)} at column ${rest.pos + 1}${hint}.`, rest.pos);
    }
    return e;
  }

  private or(): Expr {
    let a = this.and();
    while (this.isWord('or')) {
      const pos = this.next().pos;
      a = { k: 'bin', op: 'or', a, b: this.and(), pos };
    }
    return a;
  }

  private and(): Expr {
    let a = this.not();
    while (this.isWord('and')) {
      const pos = this.next().pos;
      a = { k: 'bin', op: 'and', a, b: this.not(), pos };
    }
    return a;
  }

  private not(): Expr {
    if (this.isWord('not')) {
      const pos = this.next().pos;
      return { k: 'not', e: this.not(), pos };
    }
    return this.compare();
  }

  private compare(): Expr {
    const a = this.sum();
    const t = this.peek();
    if (t.t === 'op' && COMPARE_OPS.includes(t.v)) {
      this.next();
      const b = this.sum();
      const again = this.peek();
      if (again.t === 'op' && COMPARE_OPS.includes(again.v)) {
        throw new ExprError(`Comparisons do not chain (column ${again.pos + 1}); write "a < b and b < c".`, again.pos);
      }
      return { k: 'bin', op: t.v as BinOp, a, b, pos: t.pos };
    }
    return a;
  }

  private sum(): Expr {
    let a = this.product();
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op' || (t.v !== '+' && t.v !== '-')) return a;
      this.next();
      a = { k: 'bin', op: t.v, a, b: this.product(), pos: t.pos };
    }
  }

  private product(): Expr {
    let a = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op' || (t.v !== '*' && t.v !== '/')) return a;
      this.next();
      a = { k: 'bin', op: t.v, a, b: this.unary(), pos: t.pos };
    }
  }

  private unary(): Expr {
    if (this.isOp('-')) {
      const pos = this.next().pos;
      return { k: 'neg', e: this.unary(), pos };
    }
    if (this.isOp('+')) {
      this.next();
      return this.unary();
    }
    return this.primary();
  }

  private primary(): Expr {
    const t = this.next();
    if (t.t === 'num') return { k: 'num', v: t.v, pos: t.pos };
    if (t.t === 'name') {
      if (t.v === 'true') return { k: 'num', v: 1, pos: t.pos };
      if (t.v === 'false') return { k: 'num', v: 0, pos: t.pos };
      if (t.v === 'and' || t.v === 'or' || t.v === 'not') {
        throw new ExprError(`"${t.v}" at column ${t.pos + 1} needs a value before it.`, t.pos);
      }
      if (this.isOp('(')) {
        this.next();
        const args: Expr[] = [];
        if (!this.isOp(')')) {
          for (;;) {
            args.push(this.or());
            if (this.isOp(',')) {
              this.next();
              continue;
            }
            break;
          }
        }
        const close = this.next();
        if (close.t !== 'op' || close.v !== ')') {
          throw new ExprError(`Expected "," or ")" in ${t.v}(...) at column ${close.pos + 1}, found ${describe(close)}.`, close.pos);
        }
        return { k: 'call', fn: t.v, args, pos: t.pos };
      }
      return { k: 'ref', name: t.v, pos: t.pos };
    }
    if (t.t === 'op' && t.v === '(') {
      const e = this.or();
      const close = this.next();
      if (close.t !== 'op' || close.v !== ')') {
        throw new ExprError(`Missing ")" for the "(" at column ${t.pos + 1}; found ${describe(close)} at column ${close.pos + 1}.`, close.pos);
      }
      return e;
    }
    if (t.t === 'eof') throw new ExprError('Expression ends too early: a value is missing at the end.', t.pos);
    throw new ExprError(`Expected a number or a name at column ${t.pos + 1}, found ${describe(t)}.`, t.pos);
  }
}

/** Parse source text to a syntax tree. Throws ExprError with a column on any mistake. */
export function parseExpr(src: string): Expr {
  if (src.length > MAX_EXPR_LENGTH) {
    throw new ExprError(`Expression is ${src.length} characters; the limit is ${MAX_EXPR_LENGTH}.`, MAX_EXPR_LENGTH);
  }
  const e = new Parser(tokenize(src)).parseAll();
  const depth = exprDepth(e);
  if (depth > MAX_EXPR_DEPTH) throw new ExprError(`Expression nests ${depth} levels deep; the limit is ${MAX_EXPR_DEPTH}.`, 0);
  return e;
}

function exprDepth(e: Expr): number {
  switch (e.k) {
    case 'num':
    case 'ref':
      return 1;
    case 'neg':
    case 'not':
      return 1 + exprDepth(e.e);
    case 'bin':
      return 1 + Math.max(exprDepth(e.a), exprDepth(e.b));
    case 'call':
      return 1 + e.args.reduce((m, a) => Math.max(m, exprDepth(a)), 0);
  }
}

// ---------------------------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------------------------

export type Fn<C> = (c: C) => number;

/** Looks up a name and returns its reader; throws ExprError (with a suggestion) for unknown names. */
export type NameResolver<C> = (name: string, pos: number) => Fn<C>;

/** A runtime guard's trip counter (see brain/guards.ts). */
export type TripCounter = { n: number };

/** Counters the compiled expression bumps when a guard catches something. */
export type ExprGuards = {
  /** A division by zero, answered with 0. */
  divZero: TripCounter;
  /** A result that was NaN or infinite, answered with 0. */
  nan: TripCounter;
};

function truthy(v: number): boolean {
  return v > 0;
}

function compileNode<C>(e: Expr, resolve: NameResolver<C>, guards: ExprGuards | null): Fn<C> {
  switch (e.k) {
    case 'num': {
      const v = e.v;
      return () => v;
    }
    case 'ref':
      return resolve(e.name, e.pos);
    case 'neg': {
      const a = compileNode(e.e, resolve, guards);
      return (c) => -a(c);
    }
    case 'not': {
      const a = compileNode(e.e, resolve, guards);
      return (c) => (truthy(a(c)) ? 0 : 1);
    }
    case 'bin': {
      const a = compileNode(e.a, resolve, guards);
      const b = compileNode(e.b, resolve, guards);
      switch (e.op) {
        case '+': return (c) => a(c) + b(c);
        case '-': return (c) => a(c) - b(c);
        case '*': return (c) => a(c) * b(c);
        case '/': {
          const trip = guards?.divZero;
          return (c) => {
            const d = b(c);
            if (d !== 0) return a(c) / d;
            if (trip) trip.n++;
            return 0;
          };
        }
        case '<': return (c) => (a(c) < b(c) ? 1 : 0);
        case '<=': return (c) => (a(c) <= b(c) ? 1 : 0);
        case '>': return (c) => (a(c) > b(c) ? 1 : 0);
        case '>=': return (c) => (a(c) >= b(c) ? 1 : 0);
        case '==': return (c) => (a(c) === b(c) ? 1 : 0);
        case '!=': return (c) => (a(c) !== b(c) ? 1 : 0);
        case 'and': return (c) => (truthy(a(c)) && truthy(b(c)) ? 1 : 0);
        case 'or': return (c) => (truthy(a(c)) || truthy(b(c)) ? 1 : 0);
      }
      throw new ExprError(`Unknown operator at column ${e.pos + 1}.`, e.pos);
    }
    case 'call': {
      const def = Object.hasOwn(FUNCTIONS, e.fn) ? FUNCTIONS[e.fn] : undefined;
      if (!def) throw new ExprError(`Unknown function "${e.fn}" at column ${e.pos + 1}.`, e.pos, e.fn);
      if (e.args.length < def.minArgs || e.args.length > def.maxArgs) {
        throw new ExprError(`${e.fn}() takes ${argCountText(def.minArgs, def.maxArgs, e.fn)}, got ${e.args.length} (column ${e.pos + 1}).`, e.pos, e.fn);
      }
      const args = e.args.map((x) => compileNode(x, resolve, guards));
      switch (e.fn) {
        case 'abs': {
          const a = args[0]!;
          return (c) => Math.abs(a(c));
        }
        case 'clamp': {
          const x = args[0]!;
          if (args.length === 1) return (c) => Math.min(1, Math.max(0, x(c)));
          if (args.length !== 3) throw new ExprError(`clamp() takes 1 or 3 arguments, got 2 (column ${e.pos + 1}).`, e.pos, e.fn);
          const lo = args[1]!;
          const hi = args[2]!;
          return (c) => Math.min(hi(c), Math.max(lo(c), x(c)));
        }
        case 'min':
          return (c) => {
            let m = args[0]!(c);
            for (let i = 1; i < args.length; i++) m = Math.min(m, args[i]!(c));
            return m;
          };
        case 'max':
          return (c) => {
            let m = args[0]!(c);
            for (let i = 1; i < args.length; i++) m = Math.max(m, args[i]!(c));
            return m;
          };
      }
      throw new ExprError(`Unknown function "${e.fn}" at column ${e.pos + 1}.`, e.pos, e.fn);
    }
  }
}

function argCountText(min: number, max: number, fn: string): string {
  if (fn === 'clamp') return '1 or 3 arguments';
  if (min === max) return `${min} argument${min === 1 ? '' : 's'}`;
  return `${min} to ${max} arguments`;
}

/**
 * Compile a parsed expression. The returned closure always yields a finite number: a division by
 * zero gives 0 and a non-finite result reads as 0, each counted on `guards` when given.
 */
export function compileExpr<C>(e: Expr, resolve: NameResolver<C>, guards?: ExprGuards): Fn<C> {
  const f = compileNode(e, resolve, guards ?? null);
  const trip = guards?.nan;
  return (c) => {
    const v = f(c);
    if (Number.isFinite(v)) return v;
    if (trip) trip.n++;
    return 0;
  };
}

/** Number of nodes in the tree: the unit the evaluation budget counts in. */
export function exprNodes(e: Expr): number {
  switch (e.k) {
    case 'num':
    case 'ref':
      return 1;
    case 'neg':
    case 'not':
      return 1 + exprNodes(e.e);
    case 'bin':
      return 1 + exprNodes(e.a) + exprNodes(e.b);
    case 'call':
      return e.args.reduce((n, a) => n + exprNodes(a), 1);
  }
}

const BIN_LEVEL: Readonly<Record<BinOp, number>> = {
  or: 1, and: 2, '<': 4, '<=': 4, '>': 4, '>=': 4, '==': 4, '!=': 4, '+': 5, '-': 5, '*': 6, '/': 6,
};

/** Source text for a tree, with only the parentheses its meaning needs (for messages). */
export function exprText(e: Expr, outer = 0): string {
  switch (e.k) {
    case 'num':
      return String(e.v);
    case 'ref':
      return e.name;
    case 'call':
      return `${e.fn}(${e.args.map((a) => exprText(a)).join(', ')})`;
    case 'neg':
      return `-${exprText(e.e, 7)}`;
    case 'not': {
      const s = `not ${exprText(e.e, 3)}`;
      return outer > 3 ? `(${s})` : s;
    }
    case 'bin': {
      const level = BIN_LEVEL[e.op];
      // Left-associative: the right side needs parentheses at the same level ("a - (b - c)").
      const s = `${exprText(e.a, level)} ${e.op} ${exprText(e.b, level + 1)}`;
      return outer > level ? `(${s})` : s;
    }
  }
}

/** Every name an expression references (for docs, tests and the editor). */
export function exprNames(e: Expr, out: string[] = []): string[] {
  switch (e.k) {
    case 'ref':
      out.push(e.name);
      break;
    case 'neg':
    case 'not':
      exprNames(e.e, out);
      break;
    case 'bin':
      exprNames(e.a, out);
      exprNames(e.b, out);
      break;
    case 'call':
      for (const a of e.args) exprNames(a, out);
      break;
    case 'num':
      break;
  }
  return out;
}
