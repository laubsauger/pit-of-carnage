import { describe, expect, it } from 'vitest';
import { TICK_HZ } from '../core';
import { formatAgo, formatClock, formatClockTenths, formatPercent, formatPlace, formatStat, formatValue, keyLabel, roman, squadLetter } from './format';

describe('formatClock', () => {
  it('reads sim ticks as broadcast time, so 90 s of regulation shows 1:30', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(TICK_HZ * 9)).toBe('0:09');
    expect(formatClock(TICK_HZ * 90)).toBe('1:30');
  });

  it('rounds down, because the clock must not claim a second that has not happened', () => {
    expect(formatClock(TICK_HZ * 60 - 1)).toBe('0:59');
  });

  it('never shows negative time after a seek to before the start', () => {
    expect(formatClock(-30)).toBe('0:00');
  });

  it('adds tenths for the scrubber, where one think step (0.1 s) is visible', () => {
    expect(formatClockTenths(TICK_HZ * 12 + 6)).toBe('0:12.1');
  });
});

describe('formatPlace', () => {
  it('uses English ordinals, including the 11th-13th exceptions that naive suffixing gets wrong', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 111].map(formatPlace)).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '111th',
    ]);
  });
});

describe('formatValue', () => {
  it('keeps player-written scores readable whether they are fractions or distances', () => {
    expect(formatValue(0)).toBe('0');
    expect(formatValue(0.4567)).toBe('0.46');
    expect(formatValue(3)).toBe('3');
    expect(formatValue(12.345)).toBe('12.3');
    expect(formatValue(-0.25)).toBe('-0.25');
    expect(formatValue(842.6)).toBe('843');
    expect(formatValue(1234.5)).toBe('1235');
  });
});

describe('formatPercent', () => {
  it('shows a dash rather than NaN% for strategies with no matches', () => {
    expect(formatPercent(0.7)).toBe('70%');
    expect(formatPercent(Number.NaN)).toBe('–');
  });
});

describe('roman', () => {
  it('numbers mirror-match duplicates the way a ring announcer would', () => {
    expect([1, 2, 3, 4, 9, 14, 16].map(roman)).toEqual(['I', 'II', 'III', 'IV', 'IX', 'XIV', 'XVI']);
  });
});

describe('formatAgo', () => {
  it('gives coarse, human times on the leaderboard', () => {
    const now = 1_000_000_000;
    expect(formatAgo(now - 10_000, now)).toBe('just now');
    expect(formatAgo(now - 4 * 60_000, now)).toBe('4 min ago');
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(formatAgo(now - 3 * 86_400_000, now)).toBe('3 days ago');
  });
});

describe('labels', () => {
  it('turns report keys back into the names players gave their strategies', () => {
    expect(keyLabel('Lurking Daggers@v3')).toBe('Lurking Daggers v3');
    expect(keyLabel('weird')).toBe('weird');
  });

  it('letters squads from A', () => {
    expect([0, 1, 2].map(squadLetter)).toEqual(['A', 'B', 'C']);
  });
});

describe('formatStat', () => {
  it('shows build stats in player units, so two builds compare at a glance instead of in sim ticks', () => {
    expect(formatStat('moveSpeed', 2)).toBe(`${2 * TICK_HZ} px/s`);
    expect(formatStat('attackCooldown', 42)).toBe('0.70 s');
    expect(formatStat('armorMitigation', 0.32)).toBe('32%');
    expect(formatStat('visionFov', Math.PI / 2)).toBe('90°');
    expect(formatStat('turnRate', Math.PI)).toBe('180°/s');
    expect(formatStat('damageMultiplier', 1.48)).toBe('x1.48');
    expect(formatStat('visionRange', 397.4)).toBe('397 px');
    expect(formatStat('maxHp', 320)).toBe('320');
  });
});
