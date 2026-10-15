import { describe, expect, it } from 'vitest';
import type { FighterReport, KillRecord, MatchReport, ReportRosterEntry, WeaponId } from '../core';
import { aggregateReports } from './aggregate';
import { RatingBook } from './ratings';

type Seat = { key: string; weapon: WeaponId; behaviours: string[] };
const LURKER: Seat = { key: 'Lurker@v1', weapon: 'TWIN_DAGGERS', behaviours: ['lurk', 'heal'] };
const BOWMAN: Seat = { key: 'Bowman@v1', weapon: 'LONGBOW', behaviours: ['kite'] };
const GARY: Seat = { key: 'Gary@v1', weapon: 'GREATSWORD', behaviours: ['brawl'] };
const SEATS = [LURKER, BOWMAN, GARY];

/**
 * A 3-fighter match: `order` lists seat indexes best first. The last-placed fighter dies first; each
 * death is dealt by `killers[victim]` (a seat index), in the victim's first behaviour.
 */
function match(seed: number, mapId: string, order: number[], killers: Record<number, number>): MatchReport {
  const roster: ReportRosterEntry[] = SEATS.map((s, i) => {
    const name = s.key.split('@')[0]!;
    return { fighterId: `f${i}`, entrantId: `e${i}`, name, strategyName: name, strategyVersion: 1, strategyKey: s.key, weapon: s.weapon, skill: 'DASH', squad: i, color: '#fff' };
  });
  const kills: KillRecord[] = [];
  [...order].reverse().slice(0, -1).forEach((victim, n) => {
    const killer = killers[victim]!;
    kills.push({
      tick: (n + 1) * 600, killerId: `f${killer}`, victimId: `f${victim}`, weapon: SEATS[killer]!.weapon, cause: 'weapon',
      pos: { x: 0, y: 0 }, flags: [], killerBehaviour: SEATS[killer]!.behaviours[0]!, victimBehaviour: SEATS[victim]!.behaviours[0]!,
    });
  });
  const fighters: FighterReport[] = SEATS.map((s, i) => {
    const kill = kills.find((k) => k.victimId === `f${i}`);
    const alive = kill?.tick ?? 1800;
    return {
      fighterId: `f${i}`, place: order.indexOf(i) + 1, kills: kills.filter((k) => k.killerId === `f${i}`).length,
      damageDealt: 100, damageTaken: 50, diedAtTick: kill?.tick ?? null,
      behaviourTicks: { [s.behaviours[0]!]: alive }, neverWon: s.behaviours.slice(1),
      exposure: { ticksAlive: alive, ticksSeen: Math.round(alive / 2), ticksInShadow: 0 },
      damageDealtBySource: { weapon: 100 }, damageTakenBySource: { weapon: 50 }, attacks: 4, hitsLanded: 2, skillUses: 1, parries: 0,
      pickupsTaken: {}, killsWhileBuffed: {}, guardTrips: [],
    };
  });
  return {
    seed, mapId, format: 'ffa', timeLimitTicks: 5400, suddenDeath: true, friendlyFire: true,
    ticks: 1800, ending: 'elimination', suddenDeathStart: null, roster, placements: order.map((i) => `f${i}`), kills, fighters, findings: [],
  };
}

/**
 * Ten matches for Lurker: wins 3, then dies 5 times to Bowman's LONGBOW and twice to Gary, always
 * while in `lurk`; its `heal` behaviour never runs. Maps alternate pit / catacombs.
 */
function lurkerSeason(): MatchReport[] {
  return Array.from({ length: 10 }, (_, m) => {
    const map = m % 2 === 0 ? 'pit' : 'catacombs';
    if (m < 3) return match(m, map, [0, 1, 2], { 2: 0, 1: 0 });
    if (m < 8) return match(m, map, [1, 2, 0], { 0: 1, 2: 1 });
    return match(m, map, [2, 0, 1], { 1: 2, 0: 2 });
  });
}

const mapName = (id: string) => (id === 'pit' ? 'The Pit' : 'The Catacombs');

describe('aggregateReports', () => {
  // Findings are what a player reads first: they must name the killer, the weapon and what the
  // fighter was doing, from the actual counts.
  it("names the most frequent killer, its weapon and the victim's behaviour, and the behaviour that never won", () => {
    const agg = aggregateReports(lurkerSeason(), { seed: 1, mapIds: ['pit', 'catacombs'], book: new RatingBook(), mapName });
    const lurker = agg.strategies.find((s) => s.key === 'Lurker@v1')!;
    expect(lurker.killedMostBy).toEqual({ key: 'Bowman@v1', count: 5 });
    expect(lurker.findings).toContain('Died 7 of 10 times, 5 to LONGBOW while in lurk.');
    expect(lurker.findings).toContain('Killed most by Bowman v1: 5 of 7 deaths.');
    expect(lurker.findings).toContain('heal never won a think in 10 matches.');
    expect(lurker.findings).toContain('Finished behind Gary v1 in 7 of 10 meetings.');
  });

  // The numbers behind the findings: placement, maps and head-to-head records must add up.
  it('counts placements, wins by map and head-to-head results from the reports', () => {
    const agg = aggregateReports(lurkerSeason(), { seed: 1, mapIds: ['pit', 'catacombs'], book: new RatingBook() });
    const lurker = agg.strategies.find((s) => s.key === 'Lurker@v1')!;
    expect(lurker.matches).toBe(10);
    expect(lurker.placementHistogram).toEqual([3, 2, 5]);
    expect(lurker.avgPlace).toBe(2.2);
    expect(lurker.winRate).toBe(0.3);
    expect(lurker.byMap).toEqual({ pit: { matches: 5, wins: 2, winRate: 0.4 }, catacombs: { matches: 5, wins: 1, winRate: 0.2 } });
    expect(lurker.byOpponent['Bowman@v1']).toEqual({ matches: 10, wins: 5, winRate: 0.5 });
    expect(lurker.byOpponent['Gary@v1']).toEqual({ matches: 10, wins: 3, winRate: 0.3 });
    expect(lurker.deathsByCause).toEqual({ weapon: 7 });
    expect(lurker.avgSurvivalTicks).toBe(Math.round((3 * 1800 + 2 * 1200 + 5 * 600) / 10));
  });

  // Batch totals behind findings like "never touches a power-up" and the guard-trip list the LLM
  // reads: every appearance counts, and the same path and kind add up into one line, worst first.
  it('sums power-ups, buffed kills and guard trips over every appearance', () => {
    const reports = lurkerSeason();
    for (const r of reports) {
      const lurkerSeat = r.fighters[0]!;
      lurkerSeat.pickupsTaken = { berserk: 2 };
      lurkerSeat.killsWhileBuffed = { berserk: 1 };
      lurkerSeat.guardTrips = [{ path: 'behaviours.lurk.score', kind: 'div_zero', count: 3 }];
    }
    reports[0]!.fighters[0]!.guardTrips.push({ path: 'target', kind: 'nan', count: 50 });
    const agg = aggregateReports(reports, { seed: 1, mapIds: ['pit', 'catacombs'], book: new RatingBook() });
    const lurker = agg.strategies.find((s) => s.key === 'Lurker@v1')!;
    expect(lurker.pickupsTaken).toEqual({ berserk: 20 });
    expect(lurker.killsWhileBuffed).toEqual({ berserk: 10 });
    expect(lurker.guardTrips).toEqual([
      { path: 'target', kind: 'nan', count: 50 },
      { path: 'behaviours.lurk.score', kind: 'div_zero', count: 30 },
    ]);
    expect(agg.strategies.find((s) => s.key === 'Bowman@v1')!.pickupsTaken).toEqual({});
  });

  // Aggregates read the persistent book after rating every report, and list the best first.
  it('rates every report into the book and sorts strategies by rating', () => {
    const book = new RatingBook();
    const agg = aggregateReports(lurkerSeason(), { seed: 1, mapIds: ['pit'], book });
    expect(book.record('Lurker@v1')!.matches).toBe(10);
    expect(agg.strategies.map((s) => s.rating)).toEqual(agg.strategies.map((s) => book.get(s.key)));
    const ordinals = agg.strategies.map((s) => s.rating.ordinal);
    expect([...ordinals].sort((a, b) => b - a)).toEqual(ordinals);
  });

  // The batch headline: how the strategy under test did against the field, in broadcast voice.
  it('reports how a candidate fared against the field', () => {
    const reports = lurkerSeason().filter((r) => r.mapId === 'pit');
    const agg = aggregateReports(reports, {
      seed: 1, mapIds: ['pit'], book: new RatingBook(), mapName, candidateKeys: ['Lurker@v1'], fieldLabel: 'the house stacks',
    });
    expect(agg.findings[0]).toBe('Lurker v1 beats the house stacks 2 of 5 on the Pit.');
  });
});
