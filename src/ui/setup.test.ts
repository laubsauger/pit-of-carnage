import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_LIMIT_TICKS, FIGHTER_COLORS, strategyKey } from '../core';
import type { MatchReport, Strategy } from '../core';
import {
  RANDOM_SLOT,
  buildMatchConfig,
  configFromReport,
  dedupeNames,
  defaultSetup,
  effectiveSquadSize,
  houseRef,
  resolveSlots,
  sanitizeSetup,
  savedRef,
  squadSizeOptions,
} from './setup';
import type { PoolEntry } from './setup';

function strat(name: string, version = 1): Strategy {
  return {
    schema: 'pit-strategy/2', name, version,
    build: { weapon: 'GREATSWORD', skill: 'DASH', attributes: { vitality: 16, power: 16, agility: 16, perception: 16, armor: 16, haste: 16 } },
    target: '0 - it.distance', behaviours: { brawl: { score: '1', move: [{ seek: 'target', weight: 1 }], attack: 'in_range' } }, commit: 30,
  };
}

const house = ['Gary', 'Brenda', 'Doug', 'Sister Splinter', 'Wet Kevin', 'The Accountant', 'Two Axes Tom', 'Nan'].map((n) => strat(n));
const pool: PoolEntry[] = [
  ...house.map((s) => ({ ref: houseRef(s), label: s.name, source: 'house' as const, strategy: s })),
  { ref: savedRef('mine@v2'), label: 'Mine v2', source: 'saved', strategy: strat('Mine', 2) },
];

describe('buildMatchConfig', () => {
  it('fills a default match with eight different house stacks, reproducibly from the seed', () => {
    const setup = defaultSetup(1234);
    const a = buildMatchConfig(setup, pool);
    const b = buildMatchConfig(setup, pool);
    expect(a.entrants).toHaveLength(8);
    expect(new Set(a.entrants.map((e) => e.strategy.name)).size).toBe(8);
    expect(a.entrants.every((e) => e.strategy.name !== 'Mine')).toBe(true);
    expect(b.entrants.map((e) => e.name)).toEqual(a.entrants.map((e) => e.name));
  });

  it('draws a different line-up for a different seed', () => {
    const a = buildMatchConfig(defaultSetup(1), pool).entrants.map((e) => e.name).join();
    const b = buildMatchConfig(defaultSetup(2), pool).entrants.map((e) => e.name).join();
    expect(a).not.toBe(b);
  });

  it('honours picked slots and fills the rest at random', () => {
    const setup = { ...defaultSetup(7), fighters: 3, slots: [savedRef('mine@v2'), RANDOM_SLOT, houseRef(house[2])] };
    const cfg = buildMatchConfig(setup, pool);
    expect(cfg.entrants[0].strategy.name).toBe('Mine');
    expect(cfg.entrants[2].strategy.name).toBe('Doug');
  });

  it('falls back to a random house stack when a saved strategy was deleted', () => {
    const cfg = buildMatchConfig({ ...defaultSetup(7), fighters: 2, slots: [savedRef('gone'), RANDOM_SLOT] }, pool);
    expect(cfg.entrants).toHaveLength(2);
    expect(house.map((s) => s.name)).toContain(cfg.entrants[0].strategy.name);
  });

  it('gives every FFA fighter its own squad and colour', () => {
    const cfg = buildMatchConfig({ ...defaultSetup(3), fighters: 16 }, pool);
    expect(cfg.entrants.map((e) => e.squad)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(new Set(cfg.entrants.map((e) => e.color)).size).toBe(16);
    expect(cfg.entrants[0].color).toBe(FIGHTER_COLORS[0]);
  });

  it('builds squads from consecutive slots and colours each squad as one team', () => {
    const cfg = buildMatchConfig({ ...defaultSetup(3), format: 'squads', fighters: 8, squadSize: 3 }, pool);
    expect(cfg.entrants.map((e) => e.squad)).toEqual([0, 0, 0, 1, 1, 1, 2, 2]);
    expect(cfg.entrants[0].color).toBe(cfg.entrants[2].color);
    expect(cfg.entrants[0].color).not.toBe(cfg.entrants[3].color);
  });

  it('respects the friendly-fire switch in squads only (in FFA there are no friends)', () => {
    expect(buildMatchConfig({ ...defaultSetup(3), format: 'squads', friendlyFire: false }, pool).friendlyFire).toBe(false);
    expect(buildMatchConfig({ ...defaultSetup(3), format: 'ffa', friendlyFire: false }, pool).friendlyFire).toBe(true);
  });

  it('makes a duel exactly two fighters whatever the slider says', () => {
    expect(buildMatchConfig({ ...defaultSetup(3), format: 'duel', fighters: 12 }, pool).entrants).toHaveLength(2);
  });

  it('uses the default time limit with sudden death on', () => {
    const cfg = buildMatchConfig(defaultSetup(3), pool);
    expect(cfg.timeLimitTicks).toBe(DEFAULT_TIME_LIMIT_TICKS);
    expect(cfg.suddenDeath).toBe(true);
  });

  it('refuses to build a match with no strategies rather than starting an empty arena', () => {
    expect(() => resolveSlots(defaultSetup(1), [])).toThrow();
  });
});

describe('squads', () => {
  it('only offers squad sizes that leave at least two squads', () => {
    expect(squadSizeOptions(8)).toEqual([2, 3, 4]);
    expect(squadSizeOptions(5)).toEqual([2]);
    expect(squadSizeOptions(3)).toEqual([]);
  });

  it('shrinks an oversized squad request instead of putting everyone on one team', () => {
    expect(effectiveSquadSize({ format: 'squads', fighters: 4, squadSize: 4 })).toBe(2);
  });
});

describe('dedupeNames', () => {
  it('numbers mirror-match fighters so the feed can tell them apart', () => {
    expect(dedupeNames(['Gary', 'Brenda', 'Gary', 'Gary'])).toEqual(['Gary', 'Brenda', 'Gary II', 'Gary III']);
  });
});

describe('configFromReport', () => {
  const report: MatchReport = {
    seed: 99, mapId: 'pit', format: 'ffa', ticks: 3000,
    roster: [
      { fighterId: 'f0', entrantId: 'e7', name: 'Doug', strategyName: 'Doug', strategyVersion: 1, strategyKey: 'Doug@v1', weapon: 'GREATSWORD', skill: 'DASH', squad: 0, color: '#111' },
      { fighterId: 'f1', entrantId: 'e2', name: 'Mine', strategyName: 'Mine', strategyVersion: 2, strategyKey: 'Mine@v2', weapon: 'GREATSWORD', skill: 'DASH', squad: 1, color: '#222' },
    ],
    placements: ['f1', 'f0'], kills: [], fighters: [], findings: [],
  };

  it('keeps entrant ids, order, names and colours so the replay is the same fight', () => {
    const cfg = configFromReport(report, [strat('Mine', 2), house[2]]);
    expect(cfg?.seed).toBe(99);
    expect(cfg?.entrants.map((e) => [e.id, e.name, e.color, e.squad, strategyKey(e.strategy)])).toEqual([
      ['e7', 'Doug', '#111', 0, 'Doug@v1'],
      ['e2', 'Mine', '#222', 1, 'Mine@v2'],
    ]);
  });

  it('refuses to guess when a strategy version is missing, rather than replaying a different fight', () => {
    expect(configFromReport(report, [strat('Mine', 1), house[2]])).toBeNull();
  });
});

describe('sanitizeSetup', () => {
  it('survives junk in localStorage', () => {
    const fallback = defaultSetup(5);
    expect(sanitizeSetup('nope', fallback)).toBe(fallback);
    const s = sanitizeSetup({ format: 'battle-royale', fighters: 99, seed: -1, slots: ['x', 3] }, fallback);
    expect(s.format).toBe('ffa');
    expect(s.fighters).toBe(16);
    expect(s.seed).toBe(4294967295);
    expect(s.slots[0]).toBe('x');
    expect(s.slots).toHaveLength(16);
  });
});
