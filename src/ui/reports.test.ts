import { describe, expect, it } from 'vitest';
import type { KillRecord, MatchReport, StrategyAggregate } from '../core';
import {
  PROVISIONAL_SIGMA,
  candidatePlaces,
  formatSigned,
  histogramHeights,
  howOut,
  inSentence,
  isProvisional,
  versusChampion,
  winRows,
} from './reports';

const kill = (victimId: string, killerId: string | null, patch: Partial<KillRecord> = {}): KillRecord => ({
  tick: 100, killerId, victimId, weapon: 'GREATSWORD', cause: 'weapon', pos: { x: 0, y: 0 }, flags: [],
  killerBehaviour: 'brawl', victimBehaviour: 'heal', ...patch,
});

describe('howOut', () => {
  const name = (id: string) => ({ g: 'Gary', b: 'Brenda' })[id] ?? id;

  it('says who did it and how, in the broadcast voice', () => {
    expect(howOut('b', [kill('b', 'g')], name)).toBe('by Gary');
    expect(howOut('b', [kill('b', 'g', { flags: ['backstab'] })], name)).toBe('Gary, from behind');
    expect(howOut('b', [kill('b', 'g', { cause: 'skill' })], name)).toBe("Gary's skill");
  });

  it('blames the arena when nobody gets the credit', () => {
    expect(howOut('b', [kill('b', null, { cause: 'hazard' })], name)).toBe('the arena got them');
    expect(howOut('b', [kill('b', null, { cause: 'sudden_death' })], name)).toBe('the closing wall');
    expect(howOut('b', [kill('b', null, { cause: 'keg' })], name)).toBe('a keg');
  });

  it('is empty for the survivor', () => {
    expect(howOut('g', [kill('b', 'g')], name)).toBe('');
  });
});

describe('candidatePlaces', () => {
  const report: MatchReport = {
    seed: 1, mapId: 'pit', format: 'ffa', timeLimitTicks: 5400, suddenDeath: true, friendlyFire: true, ticks: 3000,
    ending: 'elimination', suddenDeathStart: null,
    roster: [
      { fighterId: 'f0', entrantId: 'e0', name: 'Mine', strategyName: 'Mine', strategyVersion: 2, strategyKey: 'Mine@v2', weapon: 'LONGBOW', skill: 'DASH', squad: 0, color: '#a' },
      { fighterId: 'f1', entrantId: 'e1', name: 'Gary', strategyName: 'Gary', strategyVersion: 1, strategyKey: 'Gary@v1', weapon: 'GREATSWORD', skill: 'DASH', squad: 1, color: '#b' },
      { fighterId: 'f2', entrantId: 'e2', name: 'Other', strategyName: 'Other', strategyVersion: 1, strategyKey: 'Other@v1', weapon: 'GREATSWORD', skill: 'DASH', squad: 2, color: '#c' },
    ],
    placements: ['f1', 'f2', 'f0'], kills: [], fighters: [], findings: [],
  };

  it('answers "how did mine do" for the tested strategies only, best first', () => {
    expect(candidatePlaces(report, new Set(['Mine@v2', 'Other@v1']))).toEqual([
      { name: 'Other', place: 2 },
      { name: 'Mine', place: 3 },
    ]);
  });

  it('skips fighters missing from the placements instead of reporting place 0', () => {
    expect(candidatePlaces({ ...report, placements: ['f1'] }, new Set(['Mine@v2']))).toEqual([]);
  });
});

describe('winRows', () => {
  it('puts the worst matchups first, since those are what the next version should fix', () => {
    const rows = winRows({
      'Gary@v1': { matches: 10, wins: 8, winRate: 0.8 },
      'Doug@v1': { matches: 10, wins: 2, winRate: 0.2 },
      'Nan@v1': { matches: 4, wins: 1, winRate: 0.25 },
    });
    expect(rows.map((r) => r.key)).toEqual(['Doug@v1', 'Nan@v1', 'Gary@v1']);
  });

  it('treats a record with no matches as 0, not NaN', () => {
    expect(winRows({ x: { matches: 0, wins: 0, winRate: 0 } })[0].rate).toBe(0);
  });
});

describe('histogramHeights', () => {
  it('scales to the tallest column and survives an empty histogram', () => {
    expect(histogramHeights([2, 4, 0, 1])).toEqual([0.5, 1, 0, 0.25]);
    expect(histogramHeights([0, 0])).toEqual([0, 0]);
  });
});

describe('versusChampion and formatSigned', () => {
  const agg = (avgPlace: number, winRate: number) => ({ avgPlace, winRate }) as StrategyAggregate;

  it('counts a lower average place as a gain, because 1st is better than 2nd', () => {
    const v = versusChampion(agg(2.5, 0.3), agg(3.1, 0.2));
    expect(v.placeGain).toBeCloseTo(0.6);
    expect(v.winRateGain).toBeCloseTo(0.1);
  });

  it('signs gains and never shows "-0.0"', () => {
    expect(formatSigned(0.6)).toBe('+0.6');
    expect(formatSigned(-1.24)).toBe('-1.2');
    expect(formatSigned(-0.01)).toBe('0.0');
  });
});

describe('isProvisional', () => {
  it('marks new ratings as settling and settled ones as not', () => {
    expect(isProvisional({ mu: 25, sigma: 25 / 3, ordinal: 0 })).toBe(true);
    expect(isProvisional({ mu: 28, sigma: PROVISIONAL_SIGMA - 1, ordinal: 16 })).toBe(false);
  });
});

describe('inSentence', () => {
  it('lowercases a leading "The" so map names read naturally mid-sentence', () => {
    expect(inSentence('The Pit')).toBe('the Pit');
    expect(inSentence('Pillar Forest')).toBe('Pillar Forest');
  });
});
