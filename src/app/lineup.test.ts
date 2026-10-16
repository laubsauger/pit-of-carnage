import { describe, expect, it } from 'vitest';
import { MAX_FIGHTERS, strategyKey } from '../core';
import type { Lineup, LineupFighter, MatchRules, Strategy } from '../core';
import { createMatch, MAPS } from '../sim';
import { HOUSE_STACKS, gatedBrainFactory } from '../strategy';
import { DEFAULT_MATCH_RULES, configFromLineup, emptyLineup, fillLineup, nextMapId, planMatch, shuffleLineup, uniqueNames } from './lineup';
import { validatedConfig } from './session';

const house = HOUSE_STACKS;
const mine = (s: Strategy, key: string): LineupFighter => ({ key, strategy: { ...s, name: `Mine ${key}` }, source: 'library', savedId: `${key}@v1`, pinned: true });
const rules = (patch: Partial<MatchRules> = {}): MatchRules => ({ ...DEFAULT_MATCH_RULES, ...patch });

describe('fillLineup', () => {
  // "Next match" must never drop the player's own fighters: they are why the match is worth watching.
  it('keeps pinned picks in their slots and fills the rest from the house stacks', () => {
    const lineup: Lineup = { fighters: [mine(house[0]!, 'a'), mine(house[1]!, 'b')], size: 8 };
    const filled = fillLineup(lineup, rules(), house, 42);
    expect(filled.fighters).toHaveLength(8);
    expect(filled.fighters.slice(0, 2)).toEqual(lineup.fighters);
    for (const f of filled.fighters.slice(2)) {
      expect(f.pinned).toBe(false);
      expect(f.source).toBe('house');
    }
  });

  it('draws different house stacks while there are enough, so the field is not eight Garys', () => {
    const filled = fillLineup(emptyLineup(8), rules(), house, 7);
    const keys = filled.fighters.map((f) => strategyKey(f.strategy));
    expect(new Set(keys).size).toBe(Math.min(8, house.length));
  });

  // Same lineup and seed must give the same fight (Quick matchup's seed promise).
  it('draws the same field from the same seed and a different one from another seed', () => {
    const a = fillLineup(emptyLineup(8), rules(), house, 1).fighters.map((f) => f.strategy.name);
    const b = fillLineup(emptyLineup(8), rules(), house, 1).fighters.map((f) => f.strategy.name);
    const seeds = [2, 3, 4, 5, 6].map((s) => fillLineup(emptyLineup(8), rules(), house, s).fighters.map((f) => f.strategy.name).join());
    expect(a).toEqual(b);
    expect(seeds.some((x) => x !== a.join())).toBe(true);
  });

  it('keeps the field already drawn (Next match repeats it; only Shuffle redraws)', () => {
    const first = fillLineup(emptyLineup(6), rules(), house, 3);
    const again = fillLineup(first, rules(), house, 99);
    expect(again.fighters).toEqual(first.fighters);
  });

  it('plays a duel with the pinned picks first when the lineup is larger', () => {
    const field = fillLineup(emptyLineup(4), rules(), house, 5).fighters;
    const lineup: Lineup = { fighters: [field[0]!, mine(house[2]!, 'x'), field[1]!, mine(house[3]!, 'y')], size: 4 };
    const duel = fillLineup(lineup, rules({ format: 'duel' }), house, 5);
    expect(duel.size).toBe(2);
    expect(duel.fighters.map((f) => f.key)).toEqual(['x', 'y']);
  });

  it('never makes a lineup longer than the maximum, however big the size asked for', () => {
    expect(fillLineup(emptyLineup(99), rules(), house, 1).fighters).toHaveLength(MAX_FIGHTERS);
  });

  it('gives every drawn slot its own key (the setup panel keys its rows on them)', () => {
    const filled = fillLineup(emptyLineup(16), rules(), house, 11);
    expect(new Set(filled.fighters.map((f) => f.key)).size).toBe(16);
  });
});

describe('shuffleLineup', () => {
  it('redraws only the unpinned slots; pinned fighters keep their slot', () => {
    const base = fillLineup({ fighters: [mine(house[0]!, 'a')], size: 8 }, rules(), house, 1);
    const withMid: Lineup = { ...base, fighters: base.fighters.map((f, i) => (i === 4 ? mine(house[1]!, 'mid') : f)) };
    let changed = false;
    for (let seed = 2; seed < 8 && !changed; seed++) {
      const shuffled = shuffleLineup(withMid, rules(), house, seed);
      expect(shuffled.fighters[0]!.key).toBe('a');
      expect(shuffled.fighters[4]!.key).toBe('mid');
      expect(shuffled.fighters).toHaveLength(8);
      changed = shuffled.fighters.some((f, i) => !f.pinned && f.strategy.name !== withMid.fighters[i]!.strategy.name);
    }
    expect(changed).toBe(true);
  });
});

describe('configFromLineup', () => {
  it('plays slot i as entrant e<i>, so the UI can find a fighter strategy by position', () => {
    const plan = planMatch({ fighters: [mine(house[0]!, 'a')], size: 4 }, rules(), house, 9);
    expect(plan.config.entrants.map((e) => e.id)).toEqual(['e0', 'e1', 'e2', 'e3']);
    expect(plan.config.entrants.map((e) => e.strategy)).toEqual(plan.lineup.fighters.map((f) => f.strategy));
    expect(plan.config.seed).toBe(9);
  });

  // Who is on whose side is the first thing a viewer reads in a team fight.
  it('puts consecutive slots in a squad with one shared colour, and shrinks squads to leave two', () => {
    const filled = fillLineup(emptyLineup(6), rules({ format: 'squads', squadSize: 5 }), house, 2);
    const config = configFromLineup(filled, rules({ format: 'squads', squadSize: 5 }), 2);
    expect(config.entrants.map((e) => e.squad)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(new Set(config.entrants.slice(0, 3).map((e) => e.color)).size).toBe(1);
    expect(config.entrants[0]!.color).not.toBe(config.entrants[3]!.color);
  });

  it('allows friendly fire outside squads whatever the switch says (FFA hits anyone)', () => {
    const filled = fillLineup(emptyLineup(4), rules(), house, 2);
    expect(configFromLineup(filled, rules({ friendlyFire: false }), 2).friendlyFire).toBe(true);
    expect(configFromLineup(filled, rules({ format: 'squads', friendlyFire: false }), 2).friendlyFire).toBe(false);
  });

  it('names mirror matches apart and refuses a lineup of one', () => {
    expect(uniqueNames(['Gary', 'Gary', 'Brenda', 'Gary'])).toEqual(['Gary', 'Gary II', 'Brenda', 'Gary III']);
    expect(() => configFromLineup({ fighters: [mine(house[0]!, 'a')], size: 1 }, rules(), 1)).toThrow(/at least 2/);
  });

  it('builds a config the gate and the sim accept, on every map', () => {
    for (const mapId of Object.keys(MAPS)) {
      const plan = planMatch({ fighters: [mine(house[0]!, 'a')], size: 8 }, rules({ mapId }), house, 4);
      const m = createMatch(validatedConfig(plan.config), gatedBrainFactory);
      expect(m.state.fighters).toHaveLength(8);
    }
  });
});

describe('nextMapId', () => {
  it('walks every map once before coming back (map rotation)', () => {
    const ids = Object.keys(MAPS);
    const seen = [ids[0]!];
    for (let i = 1; i < ids.length; i++) seen.push(nextMapId(seen[i - 1]!));
    expect(new Set(seen).size).toBe(ids.length);
    expect(nextMapId(seen[seen.length - 1]!)).toBe(ids[0]);
  });
});
