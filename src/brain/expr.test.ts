import { describe, expect, it } from 'vitest';
import { ExprError, compileExpr, parseExpr } from './expr';

type Vars = Record<string, number>;

function run(src: string, vars: Vars = {}): number {
  const fn = compileExpr<Vars>(parseExpr(src), (name, pos) => {
    if (!(name in vars)) throw new ExprError(`Unknown name "${name}"`, pos, name);
    return (v) => v[name]!;
  });
  return fn(vars);
}

function errorOf(src: string): ExprError {
  try {
    parseExpr(src);
  } catch (e) {
    if (e instanceof ExprError) return e;
    throw e;
  }
  throw new Error(`expected "${src}" to fail`);
}

describe('operator precedence', () => {
  // Strategy authors (and LLMs) write formulas the way maths reads; a precedence bug would
  // silently change every score that mixes + and *.
  it('multiplies before adding and subtracts left to right', () => {
    expect(run('1 + 2 * 3')).toBe(7);
    expect(run('(1 + 2) * 3')).toBe(9);
    expect(run('10 - 3 - 2')).toBe(5);
    expect(run('8 / 4 / 2')).toBe(1);
    expect(run('-2 * 3 + 1')).toBe(-5);
    expect(run('2 - -3')).toBe(5);
  });

  it('compares after arithmetic and before logic', () => {
    expect(run('1 + 2 < 4')).toBe(1);
    expect(run('a * 2 > 5 and b < 1', { a: 3, b: 0 })).toBe(1);
    expect(run('a * 2 > 5 and b < 1', { a: 2, b: 0 })).toBe(0);
  });

  it('binds and tighter than or, and not looser than comparisons', () => {
    // "1 or (0 and 0)" = 1; "(1 or 0) and 0" would be 0.
    expect(run('1 or 0 and 0')).toBe(1);
    // not applies to the whole comparison: not (2 > 3) = 1. If not bound tighter it would be (not 2) > 3 = 0.
    expect(run('not 1 + 1 > 3')).toBe(1);
  });

  it('lets a gated score be written as condition * value', () => {
    // The commonest idiom in the starter library: comparisons are 1/0 so they gate a product.
    expect(run('(hp < 0.4) * 0.8', { hp: 0.3 })).toBe(0.8);
    expect(run('(hp < 0.4) * 0.8', { hp: 0.5 })).toBe(0);
  });
});

describe('values and safety', () => {
  it('treats only values above zero as true, so a negative score never means "yes"', () => {
    expect(run('not -1')).toBe(1);
    expect(run('-1 or 0')).toBe(0);
    expect(run('0.01 and 5')).toBe(1);
  });

  it('turns division by zero into 0 instead of Infinity or NaN, which would poison steering', () => {
    expect(run('1 / 0')).toBe(0);
    expect(run('0 / 0')).toBe(0);
    expect(run('5 / x', { x: 0 })).toBe(0);
  });

  it('supports min, max, abs and both forms of clamp', () => {
    expect(run('min(3, 1, 2)')).toBe(1);
    expect(run('max(3, 1, 2)')).toBe(3);
    expect(run('abs(-4)')).toBe(4);
    expect(run('clamp(1.7)')).toBe(1);
    expect(run('clamp(-2, -1, 1)')).toBe(-1);
    expect(run('true + false')).toBe(1);
  });
});

describe('errors', () => {
  // Errors are shown to players and fed back to LLMs: they must point at the exact spot.
  it('reports the column of a stray closing parenthesis', () => {
    const e = errorOf('self.hp > 0.5)');
    expect(e.pos).toBe(13);
    expect(e.message).toContain('column 14');
  });

  it('refuses chained comparisons instead of guessing what they mean', () => {
    expect(errorOf('0 < x < 1').message).toMatch(/do not chain/);
  });

  it('suggests "and" for "&&" and "==" for "="', () => {
    expect(errorOf('a && b').suggestion).toBe('and');
    expect(errorOf('a = b').suggestion).toBe('==');
  });

  it('reports a missing closing parenthesis and an empty expression', () => {
    expect(errorOf('(1 + 2').message).toMatch(/Missing "\)"/);
    expect(errorOf('   ').message).toMatch(/empty/);
    expect(errorOf('1 +').message).toMatch(/ends too early/);
  });

  it('checks function argument counts when compiling', () => {
    expect(() => run('max(1)')).toThrow(/max\(\) takes 2 to 8 arguments/);
    expect(() => run('clamp(1, 2)')).toThrow(/clamp\(\) takes 1 or 3 arguments/);
    expect(() => run('sqrt(4)')).toThrow(/Unknown function "sqrt"/);
  });

  // Strategy text comes from strangers. Parsing, compiling and evaluating recurse over the tree, so
  // without these limits a pasted code could overflow the stack and take the editor down with it.
  it('refuses over-long and over-deep expressions with an ExprError instead of overflowing the stack', () => {
    expect(errorOf('('.repeat(20000) + '1' + ')'.repeat(20000)).message).toMatch(/characters; the limit is 600/);
    expect(errorOf(Array(100000).fill('1').join('+')).message).toMatch(/characters; the limit is 600/);
    expect(errorOf(Array(60).fill('1').join('+')).message).toMatch(/nests 60 levels deep; the limit is 48/);
    expect(run(Array(40).fill('1').join('+'))).toBe(40);
  });
});
