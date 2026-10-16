import { describe, expect, it } from 'vitest';
import * as core from '../core';
import { STRATEGY_SCHEMA, strategyKey } from '../core';
import type { MatchConfig, MatchReport, Strategy, StrategySource, ValidationResult } from '../core';
import { HOUSE_STACKS, STARTER_LIBRARY, loadStrategy } from '../strategy';
import type { MatchRunner } from './batch';
import { fakeRunner } from './testkit';
import { describeChanges, minimumBudget, tune, type TuneDeps, type TuneRequest } from './tune';

/** The real gate, in the gym's result shape: the tuner's output must pass what players' files pass. */
function gate(input: unknown, source: StrategySource): ValidationResult {
  const r = loadStrategy(input, source);
  return { ok: r.strategy !== undefined, issues: [...r.errors, ...r.warnings], strategy: r.strategy };
}

const intern = HOUSE_STACKS.find((s) => s.name === 'The Unpaid Intern')!;

/** Small but complete: FFAs on two maps plus a duel per seed, so every path runs in milliseconds. */
function request(over: Partial<TuneRequest> = {}): TuneRequest {
  return { strategy: intern, field: [...HOUSE_STACKS], mapIds: ['pit', 'catacombs'], duelMapIds: ['pit'], seeds: 4, budget: 900, seed: 3, fighters: 6, duelsPerSeed: 1, mutants: 3, ...over };
}

function deps(runner: MatchRunner): TuneDeps & { played: () => number } {
  let n = 0;
  return {
    play: (configs: MatchConfig[]): MatchReport[] => {
      n += configs.length;
      return configs.map(runner);
    },
    validate: gate,
    library: STARTER_LIBRARY,
    played: () => n,
  };
}

/** Vitality wins fights: every 4 points are worth one standard deviation of match luck. A tuner can find that. */
const byVitality = (s: Strategy) => s.build.attributes.vitality / 4;

/** Every number and table the game's rules are made of (everything in src/core that is data, not code). */
function rulesSnapshot(): string {
  return JSON.stringify(Object.entries(core).filter(([, v]) => typeof v !== 'function'));
}

describe('tune', () => {
  // A tuner that changed a rule would tune the game for everyone, not the strategy; and one that
  // changed the weapon, skill or behaviours would hand back a different fighter under the same name.
  it('changes only the strategy\'s numbers and policies, never a rule, its build or its behaviours', async () => {
    const rules = rulesSnapshot();
    const input = structuredClone(intern);
    const result = await tune(request({ budget: 1500 }), deps(fakeRunner(byVitality, 1)));
    expect(rulesSnapshot()).toBe(rules);
    expect(intern).toEqual(input);
    expect(result.improved).toBe(true);
    const a = result.original;
    const b = result.best;
    expect(b.name).toBe(a.name);
    expect(b.build.weapon).toBe(a.build.weapon);
    expect(b.build.skill).toBe(a.build.skill);
    expect(b.barks).toEqual(a.barks);
    expect(b.look).toEqual(a.look);
    expect(b.imports).toEqual(a.imports);
    expect(Object.keys(b.behaviours)).toEqual(Object.keys(a.behaviours));
    // Same move terms on the same places: only their weights and bands may move.
    const shape = (s: Strategy) => Object.values(s.behaviours).map((x) => x.move.map((t) => Object.keys(t).sort().join() + JSON.stringify(Object.values(t)[0]).replace(/\d+(\.\d+)?/g, '#')));
    expect(shape(b)).toEqual(shape(a));
    // It found the planted edge and says so in plain words.
    expect(b.build.attributes.vitality).toBeGreaterThan(a.build.attributes.vitality);
    expect(result.changes.join('\n')).toMatch(/attributes: .*vitality 4 -> \d+/);
    expect(result.note).toMatch(/What changed: .*vitality/);
  });

  // The output is meant to be saved and played: it must load through the same gate as any file.
  it('always outputs a strategy that loads through loadStrategy, versioned above the original', async () => {
    for (const seed of [1, 2, 5]) {
      for (const strategy of [intern, HOUSE_STACKS.find((s) => s.build.weapon === 'TWIN_DAGGERS')!]) {
        const result = await tune(request({ strategy, seed }), deps(fakeRunner(byVitality, 1)));
        const loaded = loadStrategy(`${JSON.stringify(result.best, null, 2)}\n`, 'file');
        expect(loaded.errors, `${strategy.name}, seed ${seed}`).toEqual([]);
        expect(loaded.strategy!.schema).toBe(STRATEGY_SCHEMA);
        expect(result.best.version).toBe(result.improved ? (strategy.version ?? 1) + 1 : strategy.version);
      }
    }
  });

  // Every mutant that reaches a match must have passed the gate: a broken one could crash the sim.
  it('plays only strategies that passed the gate', async () => {
    const ok = new Map<string, boolean>();
    const inner = fakeRunner(byVitality, 1);
    const checked: MatchRunner = (config) => {
      for (const e of config.entrants) {
        const k = JSON.stringify(e.strategy);
        if (!ok.has(k)) ok.set(k, loadStrategy(e.strategy, 'test').strategy !== undefined);
        expect(ok.get(k)).toBe(true);
      }
      return inner(config);
    };
    await tune(request(), deps(checked));
    expect(ok.size).toBeGreaterThan(HOUSE_STACKS.length);
  });

  // Same request, same result: a tuning run can be reproduced and checked by someone else.
  it('is deterministic in the request', async () => {
    const a = await tune(request(), deps(fakeRunner(byVitality, 1)));
    const b = await tune(request(), deps(fakeRunner(byVitality, 1)));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    // A parallel runner that finishes out of order but returns reports in config order changes nothing.
    const runner = fakeRunner(byVitality, 1);
    const shuffled: TuneDeps = {
      ...deps(runner),
      play: async (configs) => {
        const out = new Array<MatchReport>(configs.length);
        const order = configs.map((_, i) => i).reverse();
        for (const i of order) out[i] = await Promise.resolve(runner(configs[i]!));
        return out;
      },
    };
    expect(JSON.stringify(await tune(request(), shuffled))).toBe(JSON.stringify(a));
    const other = await tune(request({ seed: 4 }), deps(fakeRunner(byVitality, 1)));
    expect(JSON.stringify(other.rounds)).not.toBe(JSON.stringify(a.rounds));
  });

  // The budget is the promise to the person waiting: the run never plays a match beyond it.
  it('never plays more matches than the budget, final check included', async () => {
    const min = minimumBudget(request());
    for (const budget of [min, min + 1, min + 97, 700, 2000]) {
      const d = deps(fakeRunner(byVitality, 1));
      const result = await tune(request({ budget }), d);
      expect(d.played(), `budget ${budget}`).toBeLessThanOrEqual(budget);
      expect(result.matchesPlayed).toBe(d.played());
      expect(result.rounds.length).toBeGreaterThan(0);
    }
    await expect(tune(request({ budget: min - 1 }), deps(fakeRunner(byVitality, 1)))).rejects.toThrow(/too small/);
  });

  // "Fewer, honest changes": when no change matters, the best of several mutants still leads by
  // luck now and then; the re-test on fresh seeds must keep that luck out of the output.
  it('keeps the original when nothing it can change makes a difference', async () => {
    let lucky = 0;
    for (const seed of [1, 2, 3]) {
      const result = await tune(request({ seed, budget: 2000 }), deps(fakeRunner(() => 0, 1)));
      lucky += result.rounds.filter((r) => r.best?.retest).length;
      expect(result.improved, `seed ${seed}: ${result.rounds.map((r) => r.summary).join(' ')}`).toBe(false);
      expect(result.best).toBe(result.original);
      expect(result.note).toMatch(/is unchanged after/);
    }
    // The shared-seed test alone would have let some through: the re-test is doing real work.
    expect(lucky).toBeGreaterThan(0);
  });

  // Over many rounds a neutral change sometimes passes both tests by luck. The held-out seeds are the
  // last word: a result that does worse there than the original is not handed out as an improvement.
  it('drops a result the held-out seeds do not confirm', async () => {
    const calls = { n: 0 };
    const counting: TuneDeps = {
      ...deps(fakeRunner(byVitality, 1)),
      play: (configs) => {
        calls.n++;
        return configs.map(fakeRunner(byVitality, 1));
      },
    };
    const honest = await tune(request({ budget: 1500 }), counting);
    expect(honest.improved).toBe(true);
    // Same run again (deterministic), but in the last call, the final check, vitality suddenly hurts.
    let call = 0;
    const flipped: TuneDeps = {
      ...deps(fakeRunner(byVitality, 1)),
      play: (configs) => configs.map(fakeRunner(++call === calls.n ? (s) => -byVitality(s) : byVitality, 1)),
    };
    const result = await tune(request({ budget: 1500 }), flipped);
    expect(result.rounds).toEqual(honest.rounds);
    expect(result.candidate).toEqual(honest.candidate);
    expect(result.improved).toBe(false);
    expect(result.best).toBe(result.original);
    expect(result.after.score).toBeLessThan(result.before.score);
    expect(result.note).toMatch(/passed the re-test .* so it was luck and the original stays\./);
    expect(result.table).toMatch(/not kept/);
  });

  // The before/after numbers must come from seeds no decision was made on, or they flatter the result.
  it('measures before and after on held-out seeds with the same matches for both', async () => {
    const seen: MatchConfig[] = [];
    const runner = fakeRunner(byVitality, 1);
    const result = await tune(request({ budget: 1500 }), {
      ...deps(runner),
      play: (configs) => {
        seen.push(...configs);
        return configs.map(runner);
      },
    });
    const finals = seen.slice(-2 * (result.before.ffa.matches + result.before.duels.matches));
    const half = finals.length / 2;
    const seat = (c: MatchConfig, key: string) => c.entrants.findIndex((e) => strategyKey(e.strategy) === key);
    for (let i = 0; i < half; i++) {
      const b = finals[i]!;
      const a = finals[half + i]!;
      expect([a.seed, a.mapId, seat(a, result.after.key)]).toEqual([b.seed, b.mapId, seat(b, result.before.key)]);
    }
    const earlier = new Set(seen.slice(0, -finals.length).map((c) => c.seed));
    expect(finals.some((c) => earlier.has(c.seed))).toBe(false);
    expect(result.after.score).toBeGreaterThan(result.before.score);
    expect(result.table).toMatch(/\| FFA average place \| [\d.]+ \| [\d.]+ \|/);
    expect(result.table).toMatch(/\| Rating \(held-out matches\) \| \d+ ±\d+/);
  });

  it('refuses an invalid strategy and an empty field', async () => {
    const broken = { ...intern, build: { ...intern.build, attributes: { ...intern.build.attributes, power: 90 } } };
    await expect(tune(request({ strategy: broken }), deps(fakeRunner(byVitality)))).rejects.toThrow(/invalid/);
    await expect(tune(request({ field: [intern] }), deps(fakeRunner(byVitality)))).rejects.toThrow(/field/);
  });
});

describe('describeChanges', () => {
  // The note is what a player reads: it must name each net change once, not every step that led there.
  it('names net changes in plain words and ignores unchanged imports', () => {
    const after = structuredClone(intern);
    after.build.attributes.agility -= 6;
    after.build.attributes.vitality += 6;
    after.behaviours.hide!.move[2] = { keep_range: ['nearest_enemy', 350, 900], weight: 0.7 };
    after.behaviours.hide!.attack = 'in_range';
    expect(describeChanges(intern, after, STARTER_LIBRARY)).toEqual([
      'attributes: vitality 4 -> 10, agility 36 -> 30',
      'hide: attack "if_blocked" -> "in_range"',
      'hide: keep_range [nearest_enemy, 350, 2000] -> keep_range [nearest_enemy, 350, 900]',
    ]);
    expect(describeChanges(intern, structuredClone(intern), STARTER_LIBRARY)).toEqual([]);
  });
});
