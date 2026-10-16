import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_BUDGET, MAX_BEHAVIOURS, Rng, attributeTotal } from '../core';
import type { Behaviour, Strategy } from '../core';
import { TUNE_MUTATIONS, collectTerms, crossover, materializeImports, mutate, nicheKey, nicheOf } from './mutate';
import { TEST_LIBRARY, makeStrategy, strictValidate } from './testkit';

const pool = collectTerms(Object.values(TEST_LIBRARY));

const fixtures: Strategy[] = [
  makeStrategy('Gary', { weapon: 'GREATSWORD' }),
  makeStrategy('Brenda', { weapon: 'LONGBOW' }),
  makeStrategy('Doug', { weapon: 'TWIN_DAGGERS', behaviours: { lurk: TEST_LIBRARY.lurk!, heal: TEST_LIBRARY.heal! } }),
  // Points left unspent, so the attribute mutation can also spend them.
  makeStrategy('Mabel', { weapon: 'ARCANE_STAFF', attributes: { vitality: 10, power: 10 } }),
];

function errors(s: Strategy): string[] {
  return strictValidate(s).issues.map((i) => `${i.path}: ${i.message}`);
}

describe('mutate', () => {
  // Evolution only works if mutants are playable; a mutation that breaks the language wastes a slot
  // (or, without the validator gate, crashes a match).
  it('keeps strategies valid, within the attribute budget, and leaves the parent untouched', () => {
    for (const parent of fixtures) {
      const before = structuredClone(parent);
      for (let seed = 0; seed < 300; seed++) {
        const { strategy, mutations } = mutate(parent, new Rng(seed), { termPool: pool });
        expect(mutations).toHaveLength(1);
        expect(errors(strategy)).toEqual([]);
        expect(attributeTotal(strategy.build.attributes)).toBeLessThanOrEqual(ATTRIBUTE_BUDGET);
        expect(strategy).not.toEqual(parent);
      }
      expect(parent).toEqual(before);
    }
  });

  // The tuner sharpens a strategy; it must not turn it into a different fighter. Its operators touch
  // numbers and policies only, never the weapon, the skill or which move terms a behaviour has.
  it('with the tuner\'s operators, keeps build, behaviours and move terms, and does tune policies', () => {
    const shape = (s: Strategy) => Object.entries(s.behaviours).map(([n, b]) => `${n}:${b.move.map((t) => Object.keys(t).sort().join('+')).join(',')}`);
    const seen = new Set<string>();
    for (const parent of fixtures) {
      for (let seed = 0; seed < 300; seed++) {
        const { strategy, mutations } = mutate(parent, new Rng(seed), { termPool: pool, operators: TUNE_MUTATIONS });
        expect(mutations).toHaveLength(1);
        expect(errors(strategy)).toEqual([]);
        expect(strategy.build.weapon).toBe(parent.build.weapon);
        expect(strategy.build.skill).toBe(parent.build.skill);
        expect(shape(strategy)).toEqual(shape(parent));
        const kind = /: attack (in_range|if_blocked) -> /.test(mutations[0]!) ? 'attack' : /: stance /.test(mutations[0]!) ? 'stance' : /^commit /.test(mutations[0]!) ? 'commit' : 'other';
        seen.add(kind);
      }
    }
    expect(seen).toEqual(new Set(['attack', 'stance', 'commit', 'other']));
  });

  // Evolution's operator mix is tuned by its own tests; adding the policy operator must not change it.
  it('offers the policy operator only when asked for', () => {
    for (let seed = 0; seed < 300; seed++) {
      const { mutations } = mutate(fixtures[0]!, new Rng(seed), { termPool: pool });
      expect(mutations[0]).not.toMatch(/: stance |^commit |: attack (in_range|if_blocked) -> (in_range|if_blocked)$/);
    }
  });

  // Lineages run for many generations; limits must hold after long chains, not just one step.
  it('stays valid over a long chain of mutations', () => {
    const rng = new Rng(7);
    let s = fixtures[0]!;
    for (let i = 0; i < 400; i++) {
      s = mutate(s, rng, { termPool: pool }).strategy;
      expect(errors(s)).toEqual([]);
    }
  });

  // Players read these lines to understand what evolution changed.
  it('describes each change in plain words', () => {
    const all = [...Array(300).keys()].flatMap((seed) => mutate(fixtures[1]!, new Rng(seed), { termPool: pool }).mutations);
    for (const line of all) expect(line).toMatch(/^(target|kite: |heal: |attributes: |build: )/);
    expect(all.some((l) => /^kite: keep_range (min|max) \d+ -> \d+$/.test(l))).toBe(true);
    expect(all.some((l) => /weight [\d.]+ -> [\d.]+$/.test(l))).toBe(true);
    expect(all.some((l) => /^attributes: /.test(l))).toBe(true);
    expect(all.some((l) => /^build: weapon LONGBOW -> /.test(l))).toBe(true);
    expect(all.some((l) => / -> (seek|flee|keep_range|orbit|avoid|prefer)/.test(l))).toBe(true);
  });

  // `== 1` compares a 0/1 flag; nudging that 1 to 1.2 would silently turn the condition off.
  it('never nudges a number compared with ==', () => {
    const doug = fixtures[2]!;
    for (let seed = 0; seed < 300; seed++) {
      expect(mutate(doug, new Rng(seed)).strategy.behaviours.lurk!.attack).toBe('target.facing_away == 1');
    }
  });
});

describe('crossover', () => {
  const berserk: Behaviour = { score: 'rage > 2', move: [{ seek: 'target', weight: 1.5 }], attack: 'in_range', set: { rage: 'rage + 1' } };
  // The donor's kite differs from the receiver's, so a swapped-in kite is visible.
  const donor = makeStrategy('Rosa', {
    weapon: 'WARHAMMER',
    memory: { rage: 0 },
    behaviours: { berserk, brawl: TEST_LIBRARY.brawl!, kite: { ...TEST_LIBRARY.kite!, score: '0.7' } },
  });
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  // Crossover swaps whole behaviours; the child must still validate, including memory the behaviour uses.
  it("takes whole behaviours from the donor, keeps the receiver's build and carries memory slots", () => {
    const receiver = fixtures[1]!;
    let tookBerserk = 0;
    for (let seed = 0; seed < 200; seed++) {
      const { strategy, mutations } = crossover(receiver, donor, new Rng(seed));
      expect(errors(strategy)).toEqual([]);
      expect(mutations.length).toBeGreaterThan(0);
      expect(strategy.build).toEqual(receiver.build);
      expect(strategy.target).toBe(receiver.target);
      // Whole behaviours only: each one is an exact copy of the receiver's or the donor's.
      const fromDonor = Object.entries(strategy.behaviours).filter(([n, b]) => same(b, donor.behaviours[n]));
      for (const [n, b] of Object.entries(strategy.behaviours)) expect(same(b, receiver.behaviours[n]) || same(b, donor.behaviours[n])).toBe(true);
      expect(fromDonor.length).toBeGreaterThan(0);
      if ('berserk' in strategy.behaviours) {
        tookBerserk++;
        expect(strategy.memory).toEqual({ rage: 0 });
        expect(strategy.behaviours.berserk).toEqual(berserk);
      }
    }
    expect(tookBerserk).toBeGreaterThan(20);
  });

  it('never goes over the behaviour limit', () => {
    const full = makeStrategy('Full', {
      behaviours: Object.fromEntries(Array.from({ length: MAX_BEHAVIOURS }, (_, i) => [`b${i}`, TEST_LIBRARY.brawl!])),
    });
    for (let seed = 0; seed < 100; seed++) {
      const { strategy } = crossover(full, donor, new Rng(seed));
      expect(Object.keys(strategy.behaviours).length).toBeLessThanOrEqual(MAX_BEHAVIOURS);
      expect(errors(strategy)).toEqual([]);
    }
  });
});

describe('niches', () => {
  // MAP-Elites only keeps diversity if different play styles land in different niches.
  it('separates melee brawlers, ranged kiters and lurkers', () => {
    const brawler = nicheOf(fixtures[0]!, {}, { brawl: 900, heal: 100 });
    const kiter = nicheOf(fixtures[1]!, {}, { kite: 900, heal: 100 });
    const lurker = nicheOf(fixtures[2]!, {}, { lurk: 900, heal: 100 });
    expect(brawler).toEqual({ family: 'melee', range: 'close', aggression: 'aggressive' });
    expect(kiter).toEqual({ family: 'ranged', range: 'far', aggression: 'aggressive' });
    expect(lurker.aggression).toBe('cautious');
    expect(new Set([brawler, kiter, lurker].map(nicheKey)).size).toBe(3);
  });

  // A fallback the fighter rarely uses (heal: run to the shrine) must not decide its play style.
  it('weights behaviours by the time the fighter spent in them', () => {
    const gary = fixtures[0]!;
    expect(nicheOf(gary, {}, { brawl: 950, heal: 50 }).aggression).toBe('aggressive');
    expect(nicheOf(gary, {}, { brawl: 50, heal: 950 }).aggression).toBe('cautious');
    // No record of either behaviour (e.g. only "idle"): equal shares.
    expect(nicheOf(gary, {}, { idle: 1000 })).toEqual(nicheOf(gary));
  });

  it('reads imported starter behaviours, and materializing imports keeps the same fighter', () => {
    const imported = makeStrategy('Imp', { weapon: 'LONGBOW', behaviours: { heal: TEST_LIBRARY.heal! }, imports: ['kite'] });
    const material = materializeImports(imported, TEST_LIBRARY);
    expect(material.imports).toBeUndefined();
    expect(material.behaviours.kite).toEqual(TEST_LIBRARY.kite);
    expect(nicheOf(imported, TEST_LIBRARY)).toEqual(nicheOf(material));
    expect(errors(material)).toEqual([]);
  });
});
