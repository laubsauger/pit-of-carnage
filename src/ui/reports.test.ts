import { describe, expect, it } from 'vitest';
import { TICK_HZ, createHeatmap, emptyFighterStats, makeRating } from '../core';
import { heatmapPhrase } from '../gym';
import type { FighterReport, KillRecord, MatchReport, Rating, StrategyAggregate } from '../core';
import {
  DEATH_LEAD_IN_TICKS,
  PROVISIONAL_SIGMA,
  candidatePlaces,
  compareCell,
  formatSigned,
  headToHead,
  heatShades,
  heatSummary,
  histogramHeights,
  howOut,
  inSentence,
  isProvisional,
  leadInTick,
  ratingView,
  statLines,
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
    ending: 'elimination', suddenDeathStart: null, judges: null,
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
    expect(isProvisional({ mu: 25, sigma: 25 / 3, ordinal: 0, provisional: true })).toBe(true);
    expect(isProvisional({ mu: 28, sigma: PROVISIONAL_SIGMA - 1, ordinal: 16, provisional: false })).toBe(false);
  });
});

describe('inSentence', () => {
  it('lowercases a leading "The" so map names read naturally mid-sentence', () => {
    expect(inSentence('The Pit')).toBe('the Pit');
    expect(inSentence('Pillar Forest')).toBe('Pillar Forest');
  });
});

// A gym match where 'Mine@v1' sits in seat f0 and finishes `place` (others fill in around it).
function gymMatch(place: number, opts: { died?: number | null; kills?: number; ticks?: number; seed?: number } = {}): MatchReport {
  const ids = ['f0', 'f1', 'f2', 'f3'];
  const others = ids.slice(1);
  const placements = [...others];
  placements.splice(place - 1, 0, 'f0');
  const fighter = (id: string): FighterReport => ({
    fighterId: id, place: placements.indexOf(id) + 1, kills: id === 'f0' ? (opts.kills ?? 0) : 0, damageDealt: 0, damageTaken: 0,
    diedAtTick: id === 'f0' ? (opts.died ?? null) : null, behaviourTicks: {}, neverWon: [], exposure: { ticksAlive: 0, ticksSeen: 0, ticksInShadow: 0 },
    damageDealtBySource: {}, damageTakenBySource: {}, attacks: 0, hitsLanded: 0, skillUses: 0, parries: 0, pickupsTaken: {}, killsWhileBuffed: {},
    guardTrips: [], stats: emptyFighterStats(), death: null, heatmap: createHeatmap(160, 160),
  });
  return {
    seed: opts.seed ?? 1, mapId: 'pit', format: 'ffa', timeLimitTicks: 5400, suddenDeath: true, friendlyFire: true, ticks: opts.ticks ?? 3000,
    ending: 'elimination', suddenDeathStart: null, judges: null,
    roster: ids.map((id, i) => ({
      fighterId: id, entrantId: `e${i}`, name: id === 'f0' ? 'Mine' : `Other ${i}`, strategyName: id === 'f0' ? 'Mine' : 'Other',
      strategyVersion: 1, strategyKey: id === 'f0' ? 'Mine@v1' : `Other${i}@v1`, weapon: 'LONGBOW', skill: 'DASH', squad: i, color: '#fff',
    })),
    placements, kills: [], fighters: ids.map(fighter), findings: [],
  };
}

describe('leadInTick', () => {
  it('opens a death a few seconds early, so you watch the fight that caused it', () => {
    expect(leadInTick(1500)).toBe(1500 - DEATH_LEAD_IN_TICKS);
  });

  it('never opens before the first tick when it died in the opening seconds', () => {
    expect(leadInTick(TICK_HZ)).toBe(0);
  });
});

describe('headToHead', () => {
  it('counts only the matches both played, and who finished ahead in each', () => {
    const a = gymMatch(1);
    const b = gymMatch(4, { died: 5 });
    // In gymMatch, Other1 sits behind Mine when Mine is 1st and ahead of it when Mine is 4th.
    expect(headToHead([a, b], 'Mine@v1', 'Other1@v1')).toEqual({ shared: 2, aAhead: 1, bAhead: 1 });
    expect(headToHead([a], 'Mine@v1', 'Ghost@v1').shared).toBe(0);
  });
});

describe('compareCell', () => {
  it('shows each unit of the gym comparison the way players read it', () => {
    expect(compareCell(0.456, 'share')).toBe('46%');
    expect(compareCell(2.125, 'place')).toBe('2.13');
    expect(compareCell(7, 'seconds')).toBe('7.0 s');
    expect(compareCell(2121.6, 'px')).toBe('2,122 px');
    expect(compareCell(3.25, 'number')).toBe('3.3');
  });

  it('says "never" instead of 0 when there is no value (it never engaged anyone)', () => {
    expect(compareCell(null, 'seconds')).toBe('never');
  });
});

describe('statLines', () => {
  it('shows ticks as seconds and fractions as percentages', () => {
    const lines = statLines({ ...emptyFighterStats(), accuracy: 0.46, ticksIdle: 186 });
    expect(lines.find((l) => l.label === 'Accuracy')?.value).toBe('46%');
    expect(lines.find((l) => l.label === 'Idle')?.value).toBe('3.1 s');
  });
});

describe('heatmaps', () => {
  // 3 x 3 cells of 80 px on a 240 x 240 map.
  const map = (fill: (col: number, row: number) => number) => {
    const h = createHeatmap(240, 240);
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
      h.counts[row * 3 + col] = fill(col, row);
      h.total += fill(col, row);
    }
    return h;
  };

  it('shades cells against the busiest one', () => {
    expect(heatShades(map((c, r) => (c === 0 && r === 0 ? 10 : 5)))[0]).toBe(1);
    expect(heatShades(createHeatmap(240, 240)).every((v) => v === 0)).toBe(true);
  });

  it('describes it in the same words as the gym findings and the LLM paste', () => {
    // Two different summaries of one heatmap ("29% in the centre" here, "62%" in the findings)
    // would make players distrust both.
    const corner = createHeatmap(720, 720);
    corner.counts[0] = 60;
    corner.counts[corner.counts.length - 1] = 40;
    corner.total = 100;
    expect(heatSummary(corner)).toBe(`${heatmapPhrase(corner).charAt(0).toUpperCase()}${heatmapPhrase(corner).slice(1)}.`);
    expect(heatSummary(corner)).toMatch(/north-west corner/);
  });

  it('admits when there is no data instead of inventing a spot', () => {
    expect(heatSummary(createHeatmap(240, 240))).toBe('No time on this map.');
  });
});

describe('ratingView', () => {
  // The spec: uncertainty is shown, not hinted; a provisional rating is explained, never a bare "?".
  it('shows a new rating as "1000 ±333" with a "new" card saying how many matches it rests on', () => {
    const v = ratingView(makeRating(25, 25 / 3), 3);
    expect(v.value).toBe('1000');
    expect(v.plusMinus).toBe('±333');
    expect(v.provisional).toBe(true);
    expect(v.card).toBe('Provisional: rated from 3 matches. Settles after about 10.');
    expect(`${v.value} ${v.plusMinus} ${v.card}`).not.toContain('?');
  });

  it('drops the mark once settled, and the ± shrinks with the evidence', () => {
    const settled = ratingView(makeRating(30, 2), 40);
    expect(settled.provisional).toBe(false);
    expect(settled.plusMinus).toBe('±80');
    expect(Number(settled.value)).toBeGreaterThan(1000);
  });

  it('reads ratings stored before the provisional flag existed from their sigma', () => {
    const old = { mu: 25, sigma: 25 / 3, ordinal: 0 } as unknown as Rating;
    expect(ratingView(old).provisional).toBe(true);
    expect(ratingView(old).card).toContain('only a few matches');
  });
});
