import { describe, expect, it } from 'vitest';
import { strategyKey } from '../core';
import type { EvolveRequest, MatchConfig, Strategy, ValidationResult } from '../core';
import type { MatchRunner } from './batch';
import { beats, evolutionMatch, evolve, type EvolveDeps, type GenerationReport } from './evolve';
import { collectTerms } from './mutate';
import { TEST_LIBRARY, fakeRunner, makeStrategy, strictValidate } from './testkit';

const house = [
  makeStrategy('Gary', { weapon: 'GREATSWORD' }),
  makeStrategy('Brenda', { weapon: 'LONGBOW' }),
  makeStrategy('Doug', { weapon: 'TWIN_DAGGERS', behaviours: { lurk: TEST_LIBRARY.lurk!, heal: TEST_LIBRARY.heal! } }),
  makeStrategy('Mabel', { weapon: 'ARCANE_STAFF' }),
  makeStrategy('Otis', { weapon: 'WARHAMMER' }),
];
const parent = makeStrategy('Lurking Daggers', { weapon: 'TWIN_DAGGERS', version: 2 });

function request(over: Partial<EvolveRequest> = {}): EvolveRequest {
  return { parent, field: house, mapIds: ['pit', 'catacombs'], generations: 8, population: 6, matchesPerCandidate: 6, fighters: 6, seed: 5, ...over };
}

function deps(runMatch: MatchRunner, validate: (s: unknown) => ValidationResult = strictValidate): EvolveDeps {
  return { runMatch, validate, library: TEST_LIBRARY, termPool: collectTerms(Object.values(TEST_LIBRARY), house) };
}

/** Agility wins fights: every 3 points of agility are worth one standard deviation of match luck. */
const byAgility = (s: Strategy) => s.build.attributes.agility / 3;

describe('evolve', () => {
  // The point of MAP-Elites: keep different play styles alive instead of converging on one build.
  // A plain GA here would converge on the single best build (whatever maxes agility).
  it('keeps distinct niches in the archive instead of collapsing to one build', () => {
    const result = evolve(request({ generations: 20, population: 8, matchesPerCandidate: 4 }), deps(fakeRunner(byAgility, 1)));
    const reports = result.generations as GenerationReport[];
    const archive = reports.at(-1)!.archive;
    expect(archive.length).toBeGreaterThanOrEqual(5);
    expect(new Set(archive.map((c) => c.nicheKey)).size).toBe(archive.length);
    expect(new Set(archive.map((c) => c.niche.family))).toEqual(new Set(['melee', 'ranged']));
    // A niche, once filled, stays filled: weaker play styles are kept, not crowded out by the best.
    for (let i = 1; i < reports.length; i++) {
      const before = reports[i - 1]!.archive.map((c) => c.nicheKey);
      const after = new Set(reports[i]!.archive.map((c) => c.nicheKey));
      for (const k of before) expect(after.has(k)).toBe(true);
    }
    const best = Math.max(...archive.map((c) => c.fitness));
    expect(archive.some((c) => c.fitness < best)).toBe(true);
    expect(archive.filter((c) => c.champion).length).toBeLessThanOrEqual(1);
  });

  // A better build exists (more agility); evolution has to find it and say so.
  it('finds and promotes a better build', () => {
    const result = evolve(request({ generations: 12, population: 8 }), deps(fakeRunner(byAgility, 1)));
    expect(result.improved).toBe(true);
    expect(result.champion.build.attributes.agility).toBeGreaterThan(parent.build.attributes.agility);
    expect(result.champion.name).toBe(parent.name);
    expect(result.champion.version).toBeGreaterThan(parent.version!);
    expect(result.summary).toMatch(/^New champion: Lurking Daggers v\d+ \(from Lurking Daggers v2\)/);
    const promoted = result.generations.filter((g) => g.promoted);
    expect(promoted.length).toBeGreaterThan(0);
    expect(promoted[0]!.summary).toMatch(/^New contender: Lurking Daggers v\d+ beats Lurking Daggers v2 on \d of 6 shared seeds and \d+ of 12 fresh ones/);
  });

  // "Fewer, honest promotions": when every strategy is equally good, the best of several mutants
  // still beats the champion on the shared seeds by luck most generations. The fresh-seed race must
  // stop that luck from crowning a new champion.
  it('does not promote on luck when nothing is better', () => {
    const flat = evolve(request({ generations: 12 }), deps(fakeRunner(() => 0, 1)));
    const luckyOnShared = flat.generations.filter((g) => / beat it on the shared seeds/.test(g.summary) || g.promoted).length;
    const promotions = flat.generations.filter((g) => g.promoted).length;
    expect(luckyOnShared).toBeGreaterThanOrEqual(3);
    expect(promotions).toBeLessThanOrEqual(1);
  });

  // Only valid strategies may reach the sim: an invalid one could crash a match or play nonsense.
  it('plays only strategies that passed the validator, and reports rejections', () => {
    const validated = new Set<string>();
    const powerCap = (s: unknown): ValidationResult => {
      const r = strictValidate(s);
      if (r.ok && (s as Strategy).build.attributes.power > 20) {
        return { ok: false, issues: [{ path: 'build.attributes.power', message: 'test cap', severity: 'error' }] };
      }
      if (r.ok) validated.add(JSON.stringify(r.strategy));
      return r;
    };
    const fieldJson = new Set(house.map((s) => JSON.stringify(s)));
    const inner = fakeRunner(byAgility, 1);
    let matches = 0;
    const runner = (config: MatchConfig) => {
      matches++;
      for (const e of config.entrants) expect(validated.has(JSON.stringify(e.strategy)) || fieldJson.has(JSON.stringify(e.strategy))).toBe(true);
      return inner(config);
    };
    const result = evolve(request({ generations: 8, population: 8 }), deps(runner, powerCap));
    expect(matches).toBeGreaterThan(0);
    const rejected = (result.generations as GenerationReport[]).reduce((n, g) => n + g.rejected, 0);
    expect(rejected).toBeGreaterThan(0);
    expect(result.generations.some((g) => /\d+ mutants? failed validation\./.test(g.summary))).toBe(true);
    for (const g of result.generations) for (const c of g.candidates) expect(c.strategy.build.attributes.power).toBeLessThanOrEqual(20);
  });

  // Fitness is FFA placement against the archive plus the house stacks, never a 1v1.
  it('scores candidates in full free-for-alls against the field and the archive', () => {
    const seen = new Set<string>();
    const inner = fakeRunner(byAgility, 1);
    const runner = (config: MatchConfig) => {
      expect(config.entrants).toHaveLength(6);
      expect(config.format).toBe('ffa');
      config.entrants.forEach((e) => seen.add(strategyKey(e.strategy)));
      return inner(config);
    };
    const result = evolve(request({ generations: 4 }), deps(runner));
    for (const s of house) expect(seen.has(strategyKey(s))).toBe(true);
    const archiveKeys = (result.generations.at(-2) as GenerationReport).archive.map((c) => c.key);
    for (const k of archiveKeys) expect(seen.has(k)).toBe(true);
    const maps = new Set(result.generations.flatMap((g) => Object.keys(g.champion.byMap)));
    expect(maps).toEqual(new Set(['pit', 'catacombs']));
  });

  // Same request, same run: results can be reproduced and compared.
  it('is deterministic in the request and reports every generation', () => {
    const calls: number[] = [];
    const a = evolve(request({ generations: 3 }), deps(fakeRunner(byAgility, 1)), (_g, done, total) => calls.push(done * 10 + total));
    const b = evolve(request({ generations: 3 }), deps(fakeRunner(byAgility, 1)));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(calls).toEqual([13, 23, 33]);
    expect(a.generations.map((g) => g.generation)).toEqual([1, 2, 3]);
  });

  // Watch on an archive entry must show the fight that earned its place, not a fresh match against
  // the field: the replay is only worth something if it is the very match the report counted.
  it('records each generation\'s matches so Watch replays the exact match an entry played', () => {
    const inner = fakeRunner(byAgility, 1);
    const played = new Map<string, number>();
    const runner = (config: MatchConfig) => {
      const report = inner(config);
      played.set(JSON.stringify(config), report.roster.length);
      return report;
    };
    const req = request({ generations: 6, population: 6, matchesPerCandidate: 4 });
    const result = evolve(req, deps(runner));
    const gens = result.generations as GenerationReport[];
    const cells = gens.at(-1)!.archive;
    const promoted = gens.filter((g) => g.promoted).map((g) => ({ strategy: g.promoted!.strategy, generation: g.generation }));
    const entries = [...cells.map((c) => ({ strategy: c.strategy, generation: c.bornGeneration })), ...promoted];
    expect(entries.length).toBeGreaterThan(1);
    for (const { strategy, generation } of entries) {
      const m = evolutionMatch(gens, req.field, strategy, generation);
      expect(m, `${strategyKey(strategy)} has a recorded match`).not.toBeNull();
      // The rebuilt config is byte for byte one the run played, with the entry in the followed seat.
      expect(played.has(JSON.stringify(m!.config))).toBe(true);
      const seat = m!.config.entrants.findIndex((e) => e.id === m!.entrantId);
      expect(strategyKey(m!.config.entrants[seat]!.strategy)).toBe(strategyKey(strategy));
      expect(m!.fighterId).toBe(`f${seat}`);
      // Born in generation g means it played generation g (the starting strategy first plays in 1).
      expect(m!.generation).toBe(Math.max(1, generation));
      // Replaying it reproduces the finish the generation recorded.
      const again = inner(m!.config);
      expect(again.fighters.find((f) => f.fighterId === m!.fighterId)!.place).toBe(m!.place);
    }
    // Field strategies are not copied into every generation (the request has them).
    const fieldKeys = new Set(house.map(strategyKey));
    for (const g of gens) for (const s of g.matches.strategies) expect(fieldKeys.has(strategyKey(s))).toBe(false);
    expect(evolutionMatch(gens, req.field, { name: 'Nobody', version: 1 }, 1)).toBeNull();
  });

  it('refuses an invalid parent and a 1v1 setup', () => {
    const broken = { ...parent, build: { ...parent.build, attributes: { ...parent.build.attributes, power: 90 } } };
    expect(() => evolve(request({ parent: broken }), deps(fakeRunner(byAgility)))).toThrow(/invalid/);
    expect(() => evolve(request({ fighters: 2 }), deps(fakeRunner(byAgility)))).toThrow(/3-16 fighters/);
  });
});

describe('beats', () => {
  // A single lucky match or a hair-thin lead must not count as better.
  it('needs a real margin and consistency across seeds', () => {
    expect(beats([1, 1, 1, 1], [0, 0, 0, 0])).toBe(true);
    expect(beats([0.52, 0.52], [0.5, 0.5])).toBe(false);
    expect(beats([1, 0, 1, 0], [0, 1, 0, 0.9])).toBe(false);
    expect(beats([0.8, 0.7, 0.9, 0.6], [0.5, 0.6, 0.4, 0.5], 1.645)).toBe(true);
    expect(beats([], [])).toBe(false);
  });
});
