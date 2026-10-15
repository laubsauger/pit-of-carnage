import { describe, expect, it } from 'vitest';
import type { Strategy } from '../core';
import { deflateSync, strToU8 } from 'fflate';
import { CODE_PREFIX, MAX_CODE_JSON_BYTES, MAX_CODE_LENGTH, decodeStrategyCode, encodeStrategyCode } from './code';
import { HOUSE_STACKS } from './house';

describe('strategy codes', () => {
  // Codes are how strategies travel between players: anything lost in the round trip is a
  // different fighter on the other side.
  it('round-trips every house stack exactly', () => {
    for (const s of HOUSE_STACKS) {
      const r = decodeStrategyCode(encodeStrategyCode(s));
      expect(r.ok, s.name).toBe(true);
      expect(r.strategy).toEqual(s);
    }
  });

  it('is one URL- and chat-safe line with the PIT2 prefix, smaller than the JSON', () => {
    const s = HOUSE_STACKS[0]!;
    const code = encodeStrategyCode(s);
    expect(code).toMatch(/^PIT2\.[A-Za-z0-9_-]+$/);
    expect(code.length).toBeLessThan(JSON.stringify(s).length);
  });

  it('survives line breaks and spaces picked up when pasting', () => {
    const code = encodeStrategyCode(HOUSE_STACKS[1]!);
    const wrapped = `  ${code.slice(0, 30)}\n${code.slice(30, 70)} \r\n${code.slice(70)}  `;
    expect(decodeStrategyCode(wrapped).strategy).toEqual(HOUSE_STACKS[1]);
  });

  it('returns a readable error for anything that is not a valid code, never throws', () => {
    const cases = ['', 'hello', 'PIT1.abc', `${CODE_PREFIX}!!!!`, `${CODE_PREFIX}AAAAAAAA`, encodeStrategyCode(HOUSE_STACKS[0]!).slice(0, 40)];
    for (const c of cases) {
      const r = decodeStrategyCode(c);
      expect(r.ok, c).toBe(false);
      expect(r.issues[0]!.message.length, c).toBeGreaterThan(10);
    }
  });

  // A code from a stranger is checked like a hand-written strategy: no smuggling an illegal build.
  it('validates what it decodes', () => {
    const cheat: Strategy = structuredClone(HOUSE_STACKS[0]!);
    cheat.build.attributes = { vitality: 40, power: 40, agility: 40, perception: 40, armor: 40, haste: 40 };
    const r = decodeStrategyCode(encodeStrategyCode(cheat));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === 'build.attributes' && /over/.test(i.message))).toBe(true);
  });

  // A hostile code with a huge or deeply nested expression used to blow the stack inside the
  // validator: the editor crashed instead of showing a problem.
  it('turns a stack-busting expression into an error on its path, never a crash', () => {
    const bomb: Strategy = structuredClone(HOUSE_STACKS[0]!);
    bomb.target = '('.repeat(20000) + '1' + ')'.repeat(20000);
    const r = decodeStrategyCode(encodeStrategyCode(bomb));
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.path === 'target');
    expect(issue?.message).toMatch(/the limit is 600/);
    expect(issue!.message.length).toBeLessThan(200);
  });

  // A few hundred characters of code can unpack to megabytes ("zip bomb"); a pasted code must
  // not be able to eat the page's memory before validation even starts.
  it('refuses a code that unpacks to more than any strategy needs, and an over-long code', () => {
    const bomb = { ...HOUSE_STACKS[0]!, name: 'x'.repeat(5_000_000) };
    const bytes = deflateSync(strToU8(JSON.stringify(bomb)), { level: 9 });
    let b64 = '';
    for (const byte of bytes) b64 += String.fromCharCode(byte);
    const code = CODE_PREFIX + btoa(b64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(code.length).toBeLessThan(MAX_CODE_LENGTH);
    const r = decodeStrategyCode(code);
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toBe(`This code unpacks to more than ${MAX_CODE_JSON_BYTES} bytes; no strategy is that big.`);
    expect(decodeStrategyCode(CODE_PREFIX + 'A'.repeat(MAX_CODE_LENGTH)).issues[0]!.message).toMatch(/strategy codes are at most/);
  });
});
