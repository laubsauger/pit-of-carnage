import { describe, expect, it } from 'vitest';
import { aggregateReports } from './aggregate';
import { buildBatch } from './batch';
import { RatingBook } from './ratings';
import { fakeRunner, makeStrategy } from './testkit';
import { reportToText } from './text';

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
    expect(jsonOf(text)).toEqual(report);
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
    expect(jsonOf(text)).toEqual(agg);
  });
});
