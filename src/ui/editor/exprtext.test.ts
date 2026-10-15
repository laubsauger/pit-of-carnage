import { describe, expect, it } from 'vitest';
import { exprText, parseExpr } from '../../brain';
import { HOUSE_STACKS } from '../../strategy';
import { decimalsOf, defaultCall, joinSum, parseCall, printCall, replaceToken, scrubbed, splitSum } from './exprtext';
import { lexExpr } from './language';

/** Same syntax tree, written canonically: equal means the expressions compute the same thing. */
const canon = (src: string) => exprText(parseExpr(src));

describe('target preferences', () => {
  it('splits a target expression into the terms that add up, and joins them back to the same meaning', () => {
    const src = '1000 - it.distance + it.fighting * 150 - it.hp * 200';
    const terms = splitSum(src)!;
    expect(terms).toEqual([
      { sign: 1, text: '1000' },
      { sign: -1, text: 'it.distance' },
      { sign: 1, text: 'it.fighting * 150' },
      { sign: -1, text: 'it.hp * 200' },
    ]);
    expect(canon(joinSum(terms))).toBe(canon(src));
  });

  it('keeps every house stack target the same through split and join', () => {
    for (const s of HOUSE_STACKS) {
      const terms = splitSum(s.target);
      if (terms) expect(canon(joinSum(terms)), s.name).toBe(canon(s.target));
    }
  });

  it('refuses to split where a comparison or and/or binds looser than +, because that would change the meaning', () => {
    expect(splitSum('it.hp + 1 > 2')).toBeNull();
    expect(splitSum('it.visible and it.hp + 1')).toBeNull();
    expect(splitSum('')).toBeNull();
    // Inside parentheses is fine: the sum is the outer one.
    expect(splitSum('(it.hp < 0.5) * 100 - it.distance')?.length).toBe(2);
  });

  it('treats a minus after an operator as part of the number, not a new term', () => {
    expect(splitSum('2 * -3 + 1')).toEqual([
      { sign: 1, text: '2 * -3' },
      { sign: 1, text: '1' },
    ]);
    expect(splitSum('-it.distance + 5')).toEqual([
      { sign: -1, text: 'it.distance' },
      { sign: 1, text: '5' },
    ]);
  });

  it('wraps a subtracted term that is itself a sum, so flipping a sign never changes other terms', () => {
    const joined = joinSum([
      { sign: 1, text: '10' },
      { sign: -1, text: 'it.hp + it.kills' },
    ]);
    expect(canon(joined)).toBe(canon('10 - (it.hp + it.kills)'));
  });
});

describe('scrubbing', () => {
  it('moves a number by its smallest written unit and keeps how it is written', () => {
    expect(scrubbed('0.25', 3)).toBe('0.28');
    expect(scrubbed('200', -5)).toBe('195');
    expect(scrubbed('1.0', 4)).toBe('1.4');
    expect(decimalsOf('12.500')).toBe(3);
  });

  it('never goes below zero: a literal is always positive, signs are written as operators', () => {
    expect(scrubbed('0.1', -50)).toBe('0.0');
    expect(scrubbed('3', -10)).toBe('0');
  });

  it('replaces exactly the token being dragged', () => {
    const src = '0.6 + enemies_seen * 0.1';
    const tok = lexExpr(src).filter((t) => t.kind === 'num')[1]!;
    expect(replaceToken(src, tok, scrubbed(tok.text, 2))).toBe('0.6 + enemies_seen * 0.3');
  });
});

describe('places as calls', () => {
  it('reads and writes places and zones the pickers show', () => {
    for (const src of ['target', 'behind(target, 36)', 'side(nearest_enemy, -90, 60)', 'beyond(hazard_near(target), target, 85)', 'seen_by(enemies)', 'pickup(berserk)']) {
      const c = parseCall(src)!;
      expect(c).not.toBeNull();
      expect(printCall(c)).toBe(src);
    }
    expect(parseCall('target.distance < 3')).toBeNull();
    expect(parseCall('behind(')).toBeNull();
  });

  it('keeps the arguments that still fit when the picker switches place', () => {
    const prev = parseCall('behind(nearest_enemy, 60)');
    // X and d carry over by name; side's angle is new.
    expect(printCall(defaultCall('side', false, prev))).toBe('side(nearest_enemy, 40, 60)');
    expect(printCall(defaultCall('cover_from', false, prev))).toBe('cover_from(nearest_enemy)');
    expect(printCall(defaultCall('cover_from', false))).toBe('cover_from(enemies)');
    expect(printCall(defaultCall('shrine', false, prev))).toBe('shrine');
    expect(printCall(defaultCall('seen_by', true))).toBe('seen_by(enemies)');
  });
});
