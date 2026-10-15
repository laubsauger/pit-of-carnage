import { describe, expect, it } from 'vitest';
import { Rng } from '../core';
import type { Behaviour, Strategy, ValidationIssue } from '../core';
import { GUARDS, SENSORS, SENSOR_INDEX, compileExpression, sensorRange } from '../brain';
import { compileExpr, parseExpr } from '../brain/expr';
import { expressionRange } from './analyze';
import { validateStrategy } from './validate';

const ATTRS = { vitality: 17, power: 17, agility: 17, perception: 17, armor: 16, haste: 16 };
const SWORD = { weapon: 'GREATSWORD' as const, attributes: ATTRS };

function strat(behaviours: Record<string, Behaviour>, over: Partial<Strategy> = {}): Strategy {
  return {
    schema: 'pit-strategy/2', name: 'Analysed', build: { weapon: 'GREATSWORD', skill: 'DASH', attributes: ATTRS },
    target: '0 - it.distance', behaviours, commit: 30, ...over,
  };
}

const go = (score: string, over: Partial<Behaviour> = {}): Behaviour => ({ score, move: [{ seek: 'target', weight: 1 }], attack: 'in_range', ...over });

function issues(s: Strategy, severity: 'error' | 'warning'): ValidationIssue[] {
  return validateStrategy(s).issues.filter((i) => i.severity === severity);
}

describe('static analysis: what a runtime guard would catch is an error', () => {
  it('rejects a division by something that can be 0, and accepts the max(1, ...) fix', () => {
    const [e, ...rest] = issues(strat({ a: go('0.5 / enemies_known') }), 'error');
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ path: 'behaviours.a.score' });
    expect(e!.message).toBe('In "0.5 / enemies_known": "enemies_known" can be 0 (it reads 0..15), and a division by 0 gives 0. Divide by something that cannot be 0, e.g. max(1, enemies_known).');
    expect(validateStrategy(strat({ a: go('0.5 / max(1, enemies_known)') })).ok).toBe(true);
    // Ranges follow the arithmetic: 1 + self.hp is never 0.
    expect(validateStrategy(strat({ a: go('0.5 / (1 + self.hp)') })).ok).toBe(true);
  });

  it('rejects a score that can leave the score limit, showing the range it can reach', () => {
    const [e] = issues(strat({ a: go('0.02 * target.distance') }), 'error');
    expect(e!.path).toBe('behaviours.a.score');
    expect(e!.message).toMatch(/can reach 0\.\.199\.98; scores are cut to -100\.\.100/);
    expect(validateStrategy(strat({ a: go('min(1, 0.02 * target.distance)') })).ok).toBe(true);
  });

  it('rejects a value that can overflow, even where a later step looks like it tames it', () => {
    const run = Array(30).fill('m').join(' * ');
    const big = `(${run}) * (${run})`;
    // 1e6^60 is Infinity at runtime; times 0 that is NaN, and clamp passes NaN through.
    for (const score of [big, `clamp(${big} * 0)`]) {
      const [e] = issues(strat({ a: go(score, { set: { m: 'm' } }) }, { memory: { m: 1e6 } }), 'error');
      expect(e?.message, score).toMatch(/past what a number can hold/);
    }
    // A comparison always gives 0 or 1, so comparing a huge value is safe.
    expect(issues(strat({ a: go(`0.5 * (${big} > 1)`, { set: { m: 'm' } }) }, { memory: { m: 1e6 } }), 'error')).toEqual([]);
  });

  // A think that costs too much slows every fighter; the budget must hold before the match.
  it('rejects a strategy whose worst think is over budget, naming the dearest part', () => {
    const heavy: Behaviour = { score: '1', move: Array.from({ length: 6 }, () => ({ avoid: 'seen_by(enemies)', weight: 1 })), attack: 'in_range' };
    const s = strat({ heavy }, { target: Array.from({ length: 12 }, () => 'it.hp * 2').join(' + ') });
    const [e] = issues(s, 'error');
    expect(e!.path).toBe('behaviours.heavy');
    expect(e!.message).toMatch(new RegExp(`budget is ${GUARDS.costBudget}.*"heavy"`));
    heavy.move = heavy.move.slice(0, 4);
    expect(validateStrategy(s).ok).toBe(true);
  });
});

describe('static analysis: lint', () => {
  it('warns about comparisons that are always true or always false, with the range that decides it', () => {
    const w = issues(strat({ a: go('(self.hp > 2) * 0.5 + 0.3 * (target.distance >= 0)') }), 'warning');
    expect(w.map((x) => x.message)).toEqual([
      'In "(self.hp > 2) * 0.5 + 0.3 * (target.distance >= 0)": "self.hp > 2" is always false (self.hp reads 0..1).',
    ]);
    // Only the first decided comparison is named, so one mistake gives one line.
  });

  it('warns about a formula that cannot change, but not about a plain number', () => {
    const w = issues(strat({ a: go('0.5', { skill: '1 + 0 * self.hp' }), b: go('self.hp') }), 'warning');
    expect(w.map((x) => x.message)).toEqual(['In "1 + 0 * self.hp": this is always 1, whatever the sensors read; write 1 or fix the formula.']);
  });

  it('warns about a behaviour that can never win', () => {
    const w = issues(strat({ always: go('0.8'), never: go('0.1 + 0.2 * self.hp') }), 'warning');
    expect(w).toHaveLength(1);
    expect(w[0]!.path).toBe('behaviours.never');
    expect(w[0]!.message).toMatch(/can never win: it scores at most 0.3, and "always" always scores at least 0.8/);
    // A tie goes to the behaviour written first, so the second of two equal scores never runs.
    expect(issues(strat({ first: go('0.5'), second: go('0.5') }), 'warning').map((x) => x.path)).toEqual(['behaviours.second']);
  });

  // The build decides some sensors (a greatsword is never ranged), so a ranged-only import on a
  // melee build is dead weight the player should hear about.
  it('knows what the build can do: kite never runs for a greatsword', () => {
    const kiteOnSword = issues(strat({ a: go('0.5') }, { imports: ['kite'] }), 'warning');
    expect(kiteOnSword.map((x) => [x.path, x.message])).toEqual([['imports[0]', 'Imported "kite" never scores above 0 for a greatsword build, so it only runs when nothing else wants to; remove it from imports.']]);
    const bow = strat({ a: go('0.5') }, { imports: ['kite'], build: { weapon: 'LONGBOW', skill: 'DASH', attributes: ATTRS } });
    expect(issues(bow, 'warning')).toEqual([]);
  });

  it('warns about an import that the strategy replaces with its own behaviour', () => {
    const w = issues(strat({ lurk: go('0.5') }, { imports: ['lurk'] }), 'warning');
    expect(w.map((x) => x.path)).toEqual(['imports[0]']);
    expect(w[0]!.message).toMatch(/Your own behaviour "lurk" replaces the imported one/);
  });

  it('warns about memory that is never read or never written, and copes with counters', () => {
    const s = strat({ a: go('0.5 + 0.0001 * min(10, count)', { set: { count: 'count + 1', spare: '1' } }) }, { memory: { count: 0, spare: 0, fixed: 3, unused: 0 } });
    const w = issues(s, 'warning');
    expect(w.map((x) => x.path).sort()).toEqual(['memory.fixed', 'memory.spare', 'memory.unused']);
    const read = strat({ a: go('0.1 * fixed') }, { memory: { fixed: 3 } });
    expect(issues(read, 'warning').map((x) => x.message)).toContain('Memory slot "fixed" is never written, so it always reads 3; write it with "set" or use the number instead.');
    // A counter grows without bound in the analysis (up to the memory limit), so a score that
    // uses it unclamped is caught.
    const loose = strat({ a: go('0.001 * count', { set: { count: 'count + 1' } }) }, { memory: { count: 0 } });
    expect(issues(loose, 'error')[0]!.message).toMatch(/can reach 0\.\.1000/);
  });

  it('warns when every move weight is 0 and when nothing ever attacks', () => {
    const s = strat({ a: { score: '0.5', move: [{ seek: 'target', weight: 0 }], attack: 'never' } });
    expect(issues(s, 'warning').map((x) => x.path).sort()).toEqual(['behaviours', 'behaviours.a.move']);
  });
});

describe('static analysis is sound', () => {
  const NAMES = ['self.hp', 'target.distance', 'zone.distance', 'enemies_known', 'random', 'time', 'since_hit', 'huge'];
  // A memory slot that can hold 1e200: two of them overflow to Infinity, and then 0 x Infinity or
  // Infinity - Infinity is NaN, which min, max, abs and clamp pass straight through.
  const HUGE = { lo: 0, hi: 1e200 };
  const memory = new Map([['huge', HUGE]]);
  // 1000000 lets deep products overflow, so the NaN and Infinity paths get exercised too.
  const NUMBERS = ['0', '1', '0.5', '2', '9999', '0.001', '300', '1000000'];
  const BIN = ['+', '-', '*', '/', '<', '<=', '>', '>=', '==', '!=', 'and', 'or'];

  function randomExpr(rng: Rng, depth: number): string {
    if (depth <= 0 || rng.chance(0.25)) return rng.chance(0.5) ? rng.pick(NAMES) : rng.pick(NUMBERS);
    switch (rng.int(0, 5)) {
      case 0:
        return `-(${randomExpr(rng, depth - 1)})`;
      case 1:
        return `not (${randomExpr(rng, depth - 1)})`;
      case 2:
        return `${rng.pick(['min', 'max'])}(${randomExpr(rng, depth - 1)}, ${randomExpr(rng, depth - 1)})`;
      case 3:
        return rng.chance(0.5) ? `abs(${randomExpr(rng, depth - 1)})` : `clamp(${randomExpr(rng, depth - 1)}, ${randomExpr(rng, depth - 1)}, ${randomExpr(rng, depth - 1)})`;
      default:
        return `(${randomExpr(rng, depth - 1)}) ${rng.pick(BIN)} (${randomExpr(rng, depth - 1)})`;
    }
  }

  // If the analysis says an expression stays in [lo, hi] and never divides by zero, no actual
  // sensor values may prove it wrong: the gate's promise ("a valid strategy never trips a guard")
  // rests on this.
  it('every value an expression actually takes lies inside its computed range, and unflagged divisions never hit 0', () => {
    const rng = new Rng(77);
    let checked = 0;
    for (let n = 0; n < 2500; n++) {
      const src = randomExpr(rng, rng.int(3, 6));
      if (src.length > 600) continue;
      const { range, issues: found } = expressionRange(src, 'behaviour', SWORD, memory);
      const flagged = found.some((i) => i.severity === 'error');
      const values: Record<string, number> = {};
      const guards = { divZero: { n: 0 }, nan: { n: 0 } };
      const fn = compileExpr<Record<string, number>>(parseExpr(src), (name) => () => values[name]!, guards);
      for (let k = 0; k < 12; k++) {
        for (const name of NAMES) {
          const r = name === 'huge' ? HUGE : sensorRange(SENSOR_INDEX.get(name)!, SWORD);
          // Endpoints matter most (that is where a divisor hits 0), so pick them often.
          values[name] = rng.chance(0.3) ? r.lo : rng.chance(0.3) ? r.hi : rng.range(r.lo, r.hi);
        }
        const v = fn(values);
        if (flagged) continue;
        const tol = 1e-9 * Math.max(1, Math.abs(range.lo), Math.abs(range.hi));
        expect(v, `${src} with ${JSON.stringify(values)}`).toBeGreaterThanOrEqual(range.lo - tol);
        expect(v, `${src} with ${JSON.stringify(values)}`).toBeLessThanOrEqual(range.hi + tol);
        checked++;
      }
      if (!flagged) expect(guards, src).toEqual({ divZero: { n: 0 }, nan: { n: 0 } });
    }
    expect(checked).toBeGreaterThan(10000);
  });

  it('agrees with the compiled brain expression on what names mean (no drift between the two)', () => {
    for (const s of SENSORS) {
      if (s.scope === 'it') continue;
      expect(() => compileExpression(`${s.name} + 1`, 'behaviour', new Set()), s.name).not.toThrow();
      expect(() => expressionRange(`${s.name} + 1`, 'behaviour', SWORD), s.name).not.toThrow();
    }
  });
});
