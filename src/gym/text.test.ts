import { describe, expect, it } from 'vitest';
import { addToHeatmap, createHeatmap } from '../core';
import type { DeathRecord } from '../core';
import { aggregateReports } from './aggregate';
import { buildBatch } from './batch';
import { RatingBook } from './ratings';
import { fakeRunner, makeStrategy } from './testkit';
import { runCompare } from './compare';
import { LLM_HEATMAP_CELLS, compareToText, deathPhrase, reportToText } from './text';

const lineup = [makeStrategy('Gary'), makeStrategy('Brenda', { weapon: 'LONGBOW' }), makeStrategy('Doug', { weapon: 'TWIN_DAGGERS' })];
const configs = buildBatch({ candidates: [], field: lineup, mapIds: ['pit'], matches: 4, fighters: 3, seed: 4 });
const runner = fakeRunner((s) => (s.name === 'Gary' ? 1 : 0), 1);

/** The JSON block that follows the summary. */
function jsonOf(text: string): unknown {
  const at = text.indexOf('\nJSON\n');
  expect(at).toBeGreaterThan(0);
  return JSON.parse(text.slice(at + 6));
}

describe('reportToText', () => {
  // Pasted into an LLM: readable summary first, then the complete data it can quote from.
  it('summarises a match and then carries the whole report as JSON', () => {
    const report = { ...runner(configs[0]!), findings: ['Gary takes the Pit: 2 kills, never seen once.'] };
    const text = reportToText(report);
    expect(text.startsWith('PIT OF CARNAGE: MATCH REPORT\nMap pit, FFA, 3 fighters')).toBe(true);
    expect(text).toContain('- Gary takes the Pit: 2 kills, never seen once.');
    const winner = report.roster.find((r) => r.fighterId === report.placements[0])!;
    expect(text).toContain(`1. ${winner.name} [${winner.strategyName} v1; ${winner.weapon} + ${winner.skill}]`);
    for (const k of report.kills) expect(text).toContain(`killed ${report.roster.find((r) => r.fighterId === k.victimId)!.name} (in ${k.victimBehaviour})`);
    // Every field survives into the JSON; only the heatmaps' raw cells are cut to the busiest few.
    const json = jsonOf(text) as typeof report;
    expect({ ...json, fighters: json.fighters.map((f) => ({ ...f, heatmap: null })) }).toEqual({ ...report, fighters: report.fighters.map((f) => ({ ...f, heatmap: null })) });
    json.fighters.forEach((f, i) => {
      const h = report.fighters[i]!.heatmap;
      expect(f.heatmap).toMatchObject({ cell: h.cell, cols: h.cols, rows: h.rows, total: h.total });
      expect((f.heatmap as unknown as { top: unknown[] }).top.length).toBeLessThanOrEqual(LLM_HEATMAP_CELLS);
    });
  });

  // An LLM tuning a strategy needs the "why" numbers in words: how it moved and fought, how it died
  // and where it spent its time. 187 heatmap cells per fighter in the JSON would drown the rest.
  it('gives every fighter its stats, its death and where it spent its time, and trims the heatmap cells', () => {
    const report = runner(configs[0]!);
    const loser = report.fighters.find((f) => f.place === 3)!;
    loser.stats = {
      ...loser.stats, distanceTravelled: 2437, ticksEngaged: 150, damageDealtPerSecondEngaged: 40.3, damageTakenPerSecondEngaged: 56.8,
      ticksToFirstContact: 120, ticksIdle: 30, ticksStuck: 3, ticksNearWalls: 150, assists: 1, killParticipation: 0.5,
    };
    loser.exposure = { ticksAlive: 300, ticksSeen: 150, ticksInShadow: 0 };
    loser.death = { ...loser.death!, flags: ['backstab'], title: 'SHANKED' };
    loser.heatmap = createHeatmap(1360, 860);
    addToHeatmap(loser.heatmap, 60, 60, 240); // north-west corner
    addToHeatmap(loser.heatmap, 680, 430, 60); // centre
    const killer = report.roster.find((e) => e.fighterId === loser.death!.killerId)!;
    const text = reportToText(report);
    const lines = text.split('\n');
    const at = lines.findIndex((l) => l.startsWith('3. '));

    expect(lines[at]).toContain(`died ${'0:02'} (SHANKED: ${killer.weapon} by ${killer.name} [backstab])`);
    expect(lines[at + 1]).toBe(
      '   Moved 2437 px; engaged 50% of its time alive (dealt 40.3/s, took 56.8/s); first contact 0:02. ' +
        'Idle 10%, stuck 1%, near walls 50%. Accuracy 50%, skill hits 0, assists 1, kill participation 50%.',
    );
    expect(lines[at + 2]).toBe('   Where: corners 80%, centre 20%, sides 0%; busiest spot: the north-west corner, 80% of its time in one 240 px square; visited 1% of the map.');
    expect(text).toContain('"Where" splits each fighter\'s time alive between the centre');
    const json = jsonOf(text) as { fighters: { fighterId: string; heatmap: unknown }[] };
    expect(json.fighters.find((f) => f.fighterId === loser.fighterId)!.heatmap).toEqual({
      cell: 80, cols: 17, rows: 11, total: 300, top: [{ col: 0, row: 0, ticks: 240 }, { col: 8, row: 5, ticks: 60 }],
    });
  });

  // The LLM must see how the match ended, when the walls closed and why, what the power-ups bought
  // and every guard trip, without digging through the JSON.
  it('states the ending, the sudden-death start, power-ups and guard trips', () => {
    const report = runner(configs[0]!);
    const plain = reportToText(report).split('\n');
    expect(plain[2]).toBe('Ended by elimination. No sudden death.');

    report.ending = 'judges';
    report.suddenDeathStart = { tick: 2700, reason: 'stalemate' };
    const winner = report.fighters.find((f) => f.place === 1)!;
    winner.pickupsTaken = { berserk: 2 };
    winner.killsWhileBuffed = { berserk: 1 };
    winner.guardTrips = [{ path: 'behaviours.brawl.score', kind: 'div_zero', count: 7 }];
    const text = reportToText(report);
    expect(text.split('\n')[2]).toBe("Ended by judges' decision at the hard cap. Sudden death from 0:45 (stalemate).");
    const line = text.split('\n').find((l) => l.startsWith('1. '))!;
    expect(line).toContain('Power-ups: berserk 2 (1 kill while buffed).');
    expect(line).toContain('Guard trips: behaviours.brawl.score hit division by zero 7 times.');
  });

  it('summarises a batch with ratings, places and findings', () => {
    const agg = aggregateReports(configs.map(runner), { seed: 4, mapIds: ['pit'], book: new RatingBook() });
    const text = reportToText(agg);
    expect(text.startsWith('PIT OF CARNAGE: BATCH REPORT\n4 matches on pit; seed 4.')).toBe(true);
    expect(text).toMatch(/1\. \w+ v1: rating \d+ \(mu [\d.]+, sigma [\d.]+\)\. 4 matches/);
    expect(text).toContain('Places: 1st ');
    for (const s of agg.strategies) for (const f of s.findings) expect(text).toContain(`- ${f}`);
    const json = jsonOf(text) as typeof agg;
    expect({ ...json, strategies: json.strategies.map((s) => ({ ...s, heatmaps: null })) }).toEqual({ ...agg, strategies: agg.strategies.map((s) => ({ ...s, heatmaps: null })) });
    // Every strategy says where it spent its time on each map it played.
    expect(text.split('\n').filter((l) => l.startsWith('   Where on pit: '))).toHaveLength(agg.strategies.length);
  });

  // Balance work reads how matches end: a camper that wins on the judges' card or a field that
  // always needs the walls to close is a problem a win rate hides.
  it("states the batch's endings, sudden-death share and every judges' decision", () => {
    const reports = configs.map(runner);
    reports[0]!.ending = 'judges';
    reports[0]!.suddenDeathStart = { tick: 5400, reason: 'time' };
    reports[0]!.judges = [
      { id: reports[0]!.placements[0]!, hpFraction: 0.4, damageDealt: 120, kills: 1 },
      { id: reports[0]!.placements[1]!, hpFraction: 0.25, damageDealt: 80, kills: 0 },
    ];
    reports[1]!.suddenDeathStart = { tick: 900, reason: 'stalemate' };
    const agg = aggregateReports(reports, { seed: 4, mapIds: ['pit'], book: new RatingBook() });
    const lines = reportToText(agg).split('\n');
    const name = (id: string) => {
      const e = reports[0]!.roster.find((r) => r.fighterId === id)!;
      return `${e.strategyName} v1`;
    };
    expect(lines[2]).toBe('Endings: elimination 3, judges 1. Sudden death in 2 of 4 (50%; time 1, stalemate 1), on average from 0:53.');
    expect(lines[3]).toBe(
      `Judges' decision, seed ${reports[0]!.seed} on pit: 1st ${name(reports[0]!.placements[0]!)} (40% HP, 120 damage, 1 kill); 2nd ${name(reports[0]!.placements[1]!)} (25% HP, 80 damage, 0 kills).`,
    );
    const winner = agg.strategies.find((s) => s.judges.wins === 1)!;
    const block = lines.slice(lines.findIndex((l) => l.includes(`${winner.name} v1: rating`)));
    expect(block.find((l) => l.includes('Sudden death in'))).toMatch(/The judges decided 1; it won 1 of those\.$/);
  });

  // "Compare with current" pasted into an LLM: the verdict per shared seed, the numbers side by side
  // and where each spent its time, without two full sets of match reports in the JSON.
  it('summarises a comparison side by side and leaves the match reports out of the JSON', () => {
    const v2 = makeStrategy('Gary', { version: 2 });
    const c = runCompare({ a: lineup[0]!, b: v2, field: lineup.slice(1), mapIds: ['pit'], matches: 4, fighters: 3, seed: 4 }, runner);
    const text = compareToText(c);
    const lines = text.split('\n');
    expect(lines[0]).toBe('PIT OF CARNAGE: COMPARISON');
    expect(lines[1]).toContain('A = Gary v1, B = Gary v2: 4 shared seeds on pit');
    expect(text).toContain(`- ${c.findings[0]}`);
    const win = c.rows.find((r) => r.label === 'Win rate')!;
    expect(text).toContain(`Win rate: ${Math.round(win.a! * 100)}% vs ${Math.round(win.b! * 100)}%${win.better ? ` [${win.better.toUpperCase()}]` : ''}`);
    expect(lines.filter((l) => l.startsWith('Where on pit, '))).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith('seed '))).toHaveLength(4);
    const json = jsonOf(text) as Record<string, unknown>;
    expect(json.reportsA).toBeUndefined();
    expect(json.reportsB).toBeUndefined();
    expect(json.matches).toEqual(c.matches);
    expect(json.rows).toEqual(c.rows);
  });
});

describe('deathPhrase', () => {
  // "How did it die" is the first question about a loss; the phrase must say what did it and who
  // gets the blame without implying a hazard swung a sword.
  it('names the weapon and killer, the hazard and who it is credited to, the keg and the wall', () => {
    const name = (id: string) => ({ f0: 'Gary', f1: 'Brenda' })[id] ?? id;
    const d: Pick<DeathRecord, 'tick' | 'weapon' | 'hazard' | 'flags'> = { tick: 60, weapon: null, hazard: null, flags: [] };
    expect(deathPhrase({ ...d, cause: 'weapon', killerId: 'f0', weapon: 'TWIN_DAGGERS', flags: ['backstab'], title: 'SHANKED' }, name, 'f1')).toBe('SHANKED: TWIN_DAGGERS by Gary [backstab]');
    expect(deathPhrase({ ...d, cause: 'hazard', killerId: null, hazard: 'saw', title: 'SAWED' }, name, 'f1')).toBe('SAWED: saw');
    expect(deathPhrase({ ...d, cause: 'hazard', killerId: 'f0', hazard: 'saw', title: 'SAWED' }, name, 'f1')).toBe('SAWED: saw, credited to Gary');
    expect(deathPhrase({ ...d, cause: 'keg', killerId: 'f0', title: 'KABOOM' }, name, 'f1')).toBe('KABOOM: a keg set off by Gary');
    expect(deathPhrase({ ...d, cause: 'keg', killerId: 'f1', title: 'OWN GOAL' }, name, 'f1')).toBe('OWN GOAL: a keg, own goal');
    expect(deathPhrase({ ...d, cause: 'sudden_death', killerId: null, flags: ['crushed'], title: 'CRUSHED' }, name, 'f1')).toBe('CRUSHED: the closing wall [crushed]');
  });
});
