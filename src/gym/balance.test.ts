import { describe, expect, it } from 'vitest';
import { WEAPONS, WEAPON_IDS, attackCooldown } from '../core';
import type { MatchReport, Strategy, WeaponId } from '../core';
import { requireValidStrategy } from '../strategy';
import { BALANCE_TARGETS, STACK_ATTRIBUTES, analyseBalance, balanceMarkdown, balancePlan, balanceStack, familyShares, nominalDps, type BalanceOptions } from './balance';
import { fakeRunner, makeStrategy, placedReport } from './testkit';

const field = [
  makeStrategy('Gary', { weapon: 'GREATSWORD' }),
  makeStrategy('Doug', { weapon: 'WARHAMMER' }),
  makeStrategy('Brenda', { weapon: 'TWIN_DAGGERS' }),
  makeStrategy('Pam', { weapon: 'LONGBOW' }),
  makeStrategy('Hatchet', { weapon: 'THROWING_AXES' }),
  makeStrategy('Mildred', { weapon: 'ARCANE_STAFF' }),
];

function options(over: Partial<BalanceOptions> = {}): BalanceOptions {
  return { seed: 7, duelSeeds: 4, duelMapId: 'pit', field, mapIds: ['pit', 'catacombs'], ffasPerMap: 6, fighters: 4, ...over };
}

/** A finished FFA: seat i runs `weapons[i]`, `winner` placed 1st, the rest in seat order. */
function ffa(weapons: readonly WeaponId[], winner: number, mapId = 'pit'): MatchReport {
  const order = [winner, ...weapons.map((_, i) => i).filter((i) => i !== winner)];
  const r = placedReport(weapons.map((_, i) => `S${i}@v1`), order);
  r.mapId = mapId;
  r.roster.forEach((e, i) => (e.weapon = weapons[i]!));
  return r;
}

const strengthOf = (weapon: WeaponId | null) => (s: Strategy) => (s.build.weapon === weapon ? 1 : 0);

describe('balanceStack', () => {
  // The duel matrix is meant to measure weapons. If the stacks differed in build, skill, targeting
  // or plan beyond what the weapon's family needs, it would measure those instead.
  it('gives every weapon the same build, skill, target rule and family plan', () => {
    const stacks = WEAPON_IDS.map(balanceStack);
    const strip = (s: Strategy) => {
      const { name, build, behaviours, ...rest } = structuredClone(s);
      void name;
      return { ...rest, attributes: build.attributes, skill: build.skill, behaviours: Object.keys(behaviours) };
    };
    const melee = stacks.filter((s) => WEAPONS[s.build.weapon].family === 'melee');
    const ranged = stacks.filter((s) => WEAPONS[s.build.weapon].family === 'ranged');
    for (const s of [...melee, ...ranged]) expect(s.build.attributes).toEqual(STACK_ATTRIBUTES);
    for (const s of melee) expect(strip(s)).toEqual(strip(melee[0]!));
    for (const s of ranged) expect(strip(s)).toEqual(strip(ranged[0]!));
    expect(strip(melee[0]!).target).toBe(strip(ranged[0]!).target);
    expect(new Set(stacks.map((s) => s.name)).size).toBe(stacks.length);
  });

  // A bow kiting at axe range would handicap the bow: each ranged stack keeps the same fraction of its own range.
  it('scales the ranged kite band to the weapon range', () => {
    for (const weapon of WEAPON_IDS.filter((w) => WEAPONS[w].family === 'ranged')) {
      const term = balanceStack(weapon).behaviours.kite!.move[0]!;
      expect('keep_range' in term).toBe(true);
      const [, min, max] = (term as { keep_range: [string, number, number] }).keep_range;
      expect(min / WEAPONS[weapon].range).toBeCloseTo(0.55, 2);
      expect(max / WEAPONS[weapon].range).toBeCloseTo(0.85, 2);
      expect(max).toBeLessThanOrEqual(WEAPONS[weapon].range);
    }
  });

  // The harness plays every stack through the real gate; one that fails it would stop the run.
  it('passes the strategy gate for every weapon', () => {
    for (const weapon of WEAPON_IDS) expect(() => requireValidStrategy(balanceStack(weapon), 'test')).not.toThrow();
  });
});

describe('balancePlan', () => {
  // Spawn points follow seats: without the swap a seat advantage would read as a weapon advantage.
  it('plays every pairing on every seed twice, seats swapped, on the duel map', () => {
    const plan = balancePlan(options());
    const pairings = (WEAPON_IDS.length * (WEAPON_IDS.length - 1)) / 2;
    expect(plan.duels).toHaveLength(pairings * 4 * 2);
    for (let i = 0; i < plan.duels.length; i += 2) {
      const [a, b] = [plan.duels[i]!, plan.duels[i + 1]!];
      expect(b.seed).toBe(a.seed);
      expect(b.entrants.map((e) => e.strategy.build.weapon)).toEqual([...a.entrants.map((e) => e.strategy.build.weapon)].reverse());
      expect(a).toMatchObject({ format: 'duel', mapId: 'pit', suddenDeath: true });
    }
    expect(new Set(plan.duels.map((c) => c.seed)).size).toBe(4);
  });

  // FFAs cover the whole pool evenly, and the same options always give the same matches.
  it('rotates the FFAs over the map pool and is deterministic', () => {
    const plan = balancePlan(options());
    expect(plan.ffas).toHaveLength(12);
    expect(plan.ffas.filter((c) => c.mapId === 'pit')).toHaveLength(6);
    for (const c of plan.ffas) expect(c.entrants).toHaveLength(4);
    expect(balancePlan(options())).toEqual(plan);
    expect(balancePlan(options({ seed: 8 })).ffas.map((c) => c.seed)).not.toEqual(plan.ffas.map((c) => c.seed));
  });
});

describe('analyseBalance', () => {
  // With equal weapons and seat 0 winning every tie, only the seat swap keeps each pairing at 50%.
  it('cancels a seat advantage: equal weapons come out at exactly 50%', () => {
    const plan = balancePlan(options());
    const run = fakeRunner(strengthOf(null), 0);
    expect(run(plan.duels[0]!).placements[0]).toBe('f0');
    const report = analyseBalance(options(), plan.duels.map(run), []);
    expect(report.pairings).toHaveLength(15);
    for (const p of report.pairings) expect(p).toMatchObject({ winRate: 0.5, matches: 8, pass: true });
    expect(report.checks[0]!.pass).toBe(true);
  });

  // A dominant weapon must fail the duel target and be named, with its win rate, in the result.
  it('fails the duel target when one weapon wins its pairings and names it', () => {
    const opts = options();
    const plan = balancePlan(opts);
    const run = fakeRunner(strengthOf('LONGBOW'), 0);
    const report = analyseBalance(opts, plan.duels.map(run), plan.ffas.map(run));
    const bow = report.pairings.filter((p) => p.a === 'LONGBOW' || p.b === 'LONGBOW');
    expect(bow).toHaveLength(5);
    for (const p of bow) expect(p.pass).toBe(false);
    expect(report.pairings.filter((p) => p.pass)).toHaveLength(10);
    expect(report.checks[0]).toMatchObject({ pass: false });
    expect(report.checks[0]!.measured).toContain('10 of 15 inside; outside: ');
    expect(report.checks[0]!.measured).toContain('LONGBOW 100% vs TWIN_DAGGERS');
    expect(report.pass).toBe(false);
  });

  // An FFA lineup with more melee seats should produce more melee wins; fair share is per seat, not per match.
  it('measures family wins against the share of seats held', () => {
    const lineup: WeaponId[] = ['GREATSWORD', 'WARHAMMER', 'TWIN_DAGGERS', 'LONGBOW'];
    const even = [ffa(lineup, 0), ffa(lineup, 1), ffa(lineup, 2), ffa(lineup, 3)];
    expect(familyShares(even)).toEqual([
      { key: 'melee', seats: 12, wins: 3, fair: 3, ratio: 1 },
      { key: 'ranged', seats: 4, wins: 1, fair: 1, ratio: 1 },
    ]);
    const bowsWin = [ffa(lineup, 3), ffa(lineup, 3), ffa(lineup, 3), ffa(lineup, 0)];
    const report = analyseBalance(options({ mapIds: ['pit'] }), [], bowsWin);
    const [melee, ranged] = [report.checks[1]!, report.checks[2]!];
    expect(melee).toMatchObject({ pass: false, measured: '0.33x (1 win, fair share 3 of 4)' });
    expect(ranged).toMatchObject({ pass: false, measured: '3x (3 wins, fair share 1 of 4)' });
  });

  // Only the duel map counts for the family target; FFAs elsewhere must not stand in for it, and
  // missing data is a failure, never a silent pass.
  it('fails the family targets when no FFA was played on the duel map', () => {
    const report = analyseBalance(options({ mapIds: ['catacombs'] }), [], [ffa(['GREATSWORD', 'LONGBOW'], 0, 'catacombs')]);
    expect(report.checks[1]).toMatchObject({ pass: false, measured: 'no FFAs with melee seats on pit' });
    expect(report.checks[0]).toMatchObject({ pass: false, measured: 'only 0 of 15 pairings were played' });
  });

  // The DPS guideline must use the real attack cycle: the next windup waits for both the cooldown
  // and the end of the swing.
  it('computes nominal DPS over the full attack cycle', () => {
    for (const weapon of WEAPON_IDS) {
      const w = WEAPONS[weapon];
      const { cycleTicks } = nominalDps(weapon);
      expect(cycleTicks).toBeGreaterThanOrEqual(w.windup + w.strike + w.recovery);
      expect(cycleTicks).toBeGreaterThanOrEqual(w.windup + attackCooldown(STACK_ATTRIBUTES, weapon));
    }
    const report = analyseBalance(options(), [], []);
    const guide = report.checks.find((c) => c.guideline)!;
    expect(guide.target).toContain('melee nominal DPS');
    // A guideline never decides the run on its own.
    expect(report.checks.filter((c) => !c.guideline)).toHaveLength(3);
  });
});

describe('balanceMarkdown', () => {
  // docs/BALANCE.md is regenerated after every rules change; it must show the verdict per target,
  // flag out-of-band cells and be byte-identical for identical results (clean diffs).
  it('writes the targets, the duel matrix and the numbers, deterministically', () => {
    const opts = options({ mapIds: ['pit'] });
    const plan = balancePlan(opts);
    const run = fakeRunner(strengthOf('LONGBOW'), 0);
    const report = analyseBalance(opts, plan.duels.map(run), plan.ffas.map(run));
    const md = balanceMarkdown(report);
    expect(md).toBe(balanceMarkdown(analyseBalance(opts, plan.duels.map(run), plan.ffas.map(run))));
    expect(md).toContain(`| Every duel pairing wins between ${BALANCE_TARGETS.duelMin * 100}% and ${BALANCE_TARGETS.duelMax * 100}% on pit |`);
    expect(md).toMatch(/\| FAIL \|/);
    // Row LONGBOW beats every column; row GREATSWORD loses to LB (bold) and ties the rest.
    expect(md).toContain('| LONGBOW | **100%** | **100%** | **100%** | **100%** | - | **100%** | 100% |');
    expect(md).toContain('| GREATSWORD | - | 50% | 50% | 50% | **0%** | 50% | 40% |');
    expect(md).toContain('| COMBAT.backpedalMoveMul |');
    // The targets' source is the living spec; the retired build spec must not be cited.
    expect(md).toContain('Targets come from `docs/SPEC.md`, section 6, "Balance: ranged vs melee".');
    expect(md).not.toMatch(/build spec/);
  });
});
