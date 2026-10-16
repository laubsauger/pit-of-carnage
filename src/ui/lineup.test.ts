import { describe, expect, it } from 'vitest';
import { MAX_FIGHTERS, strategyKey } from '../core';
import type { Lineup, LineupFighter, MatchConfig, Strategy } from '../core';
import { DEFAULT_MATCH_RULES, fillLineup } from '../app/lineup';
import { HOUSE_STACKS } from '../strategy';
import {
  DEFAULT_RULES,
  addFighter,
  clearField,
  defaultMatchup,
  lineupForWatch,
  lineupOfStored,
  lineupSummary,
  pinnedCount,
  playingFighters,
  removeFighter,
  resizeLineup,
  sanitizeMatchup,
  storeMatchup,
  togglePin,
} from './lineup';

const house = HOUSE_STACKS;
const named = (name: string): Strategy => ({ ...house[0]!, name });
const field = (i: number): LineupFighter => ({ key: `f${i}`, strategy: house[i % house.length]!, source: 'house', savedId: null, pinned: false });
const drawn = (n: number): Lineup => ({ fighters: Array.from({ length: n }, (_, i) => field(i)), size: n });

describe('addFighter', () => {
  it('takes an open slot first, pinned, so it plays every next match', () => {
    const next = addFighter({ fighters: [], size: 8 }, named('Mine'), 'file')!;
    expect(next.size).toBe(8);
    expect(next.fighters).toHaveLength(1);
    expect(next.fighters[0]).toMatchObject({ pinned: true, source: 'file' });
  });

  // The player's fighters are the point; house stacks are filler that makes room.
  it('replaces a field slot when the lineup is full, keeping picks ahead of the field', () => {
    const start = addFighter(drawn(4), named('A'), 'library')!;
    expect(start.size).toBe(4);
    expect(start.fighters.map((f) => f.pinned)).toEqual([true, false, false, false]);
    const two = addFighter(start, named('B'), 'paste')!;
    expect(two.fighters.map((f) => f.strategy.name).slice(0, 2)).toEqual(['A', 'B']);
    expect(two.fighters).toHaveLength(4);
  });

  it('grows the lineup when every slot is a pick, and stops at sixteen', () => {
    let l: Lineup | null = { fighters: [], size: 2 };
    for (let i = 0; i < MAX_FIGHTERS; i++) l = addFighter(l!, named(`P${i}`), 'code');
    expect(l!.fighters).toHaveLength(MAX_FIGHTERS);
    expect(addFighter(l!, named('One too many'), 'code')).toBeNull();
  });

  it('gives every added slot a key of its own', () => {
    let l: Lineup = drawn(3);
    for (let i = 0; i < 5; i++) l = addFighter(l, named(`P${i}`), 'code')!;
    expect(new Set(l.fighters.map((f) => f.key)).size).toBe(l.fighters.length);
  });
});

describe('editing the lineup', () => {
  it('removing a pick keeps the size, so a house stack fills the gap at Fight', () => {
    const l = addFighter(drawn(4), named('A'), 'file')!;
    const removed = removeFighter(l, l.fighters[0]!.key);
    expect(removed.size).toBe(4);
    expect(pinnedCount(removed)).toBe(0);
  });

  it('pinning a field fighter keeps it through Shuffle; unpinning lets it go', () => {
    const l = togglePin(drawn(3), 'f1');
    expect(l.fighters[1]!.pinned).toBe(true);
    expect(togglePin(l, 'f1').fighters[1]!.pinned).toBe(false);
    expect(clearField(l).fighters.map((f) => f.key)).toEqual(['f1']);
  });

  it('shrinking drops field slots and never a pick', () => {
    const l = togglePin(drawn(8), 'f7');
    const small = resizeLineup(l, 3);
    expect(small.size).toBe(3);
    expect(small.fighters.map((f) => f.key)).toEqual(['f0', 'f1', 'f7']);
    const picks = { fighters: [0, 1, 2, 3].map((i) => ({ ...field(i), pinned: true })), size: 4 };
    expect(resizeLineup(picks, 2).size).toBe(4);
  });

  it('says how the lineup splits between the player and the house', () => {
    expect(lineupSummary(drawn(8), 'ffa')).toBe('8 house stacks');
    expect(lineupSummary(togglePin(drawn(8), 'f0'), 'ffa')).toBe('1 of yours, 7 from the house');
    expect(lineupSummary(togglePin(togglePin(drawn(8), 'f0'), 'f1'), 'duel')).toBe('2 of yours, no house stacks');
  });
});

describe('playingFighters', () => {
  // The dialog must show exactly who the controller will put in the pit.
  it('shows the same fighters the controller plays, picks first in a duel', () => {
    const l: Lineup = { fighters: [field(0), { ...field(1), pinned: true }, field(2), { ...field(3), pinned: true }], size: 4 };
    for (const format of ['duel', 'ffa'] as const) {
      const shown = playingFighters(l, format).map((f) => f.key);
      const played = fillLineup(l, { format }, house, 1).fighters.slice(0, shown.length).map((f) => f.key);
      expect(shown).toEqual(played);
    }
    expect(playingFighters(l, 'duel').map((f) => f.key)).toEqual(['f1', 'f3']);
  });
});

describe('lineupForWatch', () => {
  const config: MatchConfig = {
    seed: 1, mapId: 'pit', format: 'ffa', friendlyFire: true, timeLimitTicks: 5400, suddenDeath: true,
    entrants: [named('Candidate'), house[1]!, named('Some gym field entry')].map((strategy, i) => ({ id: `e${i}`, strategy, squad: i, name: strategy.name, color: '#fff' })),
  };

  // "Next match" after watching a gym match keeps the strategy under test, not the whole batch field.
  it('pins only the strategies under test, in entrant order', () => {
    const l = lineupForWatch(config, new Set([strategyKey(named('Candidate'))]), 'gym', house);
    expect(l.fighters.map((f) => f.pinned)).toEqual([true, false, false]);
    expect(l.fighters.map((f) => f.source)).toEqual(['gym', 'house', 'gym']);
    expect(l.size).toBe(3);
  });
});

describe('the stored matchup', () => {
  it('round-trips the player picks and rules, without the drawn field', () => {
    const l = addFighter(drawn(6), named('Keeper'), 'library', 'Keeper@v2')!;
    const stored = storeMatchup(l, { ...DEFAULT_RULES, mapId: 'catacombs', rotateMaps: true });
    const back = sanitizeMatchup(JSON.parse(JSON.stringify(stored)), defaultMatchup());
    expect(back.rules).toMatchObject({ mapId: 'catacombs', rotateMaps: true });
    expect(back.size).toBe(6);
    expect(lineupOfStored(back).fighters.map((f) => [f.strategy.name, f.savedId, f.pinned])).toEqual([['Keeper', 'Keeper@v2', true]]);
  });

  // A stored strategy is never trusted: it goes through the gate again on the way back in.
  it('drops picks the gate refuses and repairs malformed rules', () => {
    const bad = { rules: { mapId: 'gone_map', format: 'battle royale', timeLimitTicks: -5 }, size: 'x', picks: [{ strategy: { name: 'Broken' } }, 'nope'] };
    const back = sanitizeMatchup(bad, defaultMatchup());
    expect(back.picks).toEqual([]);
    expect(back.rules.mapId).toBe(DEFAULT_RULES.mapId);
    expect(back.rules.format).toBe('ffa');
    expect(back.rules.timeLimitTicks).toBeGreaterThan(0);
    expect(back.size).toBe(defaultMatchup().size);
    expect(sanitizeMatchup(null, defaultMatchup())).toEqual(defaultMatchup());
  });

  it('starts from the same rules as the controller, so a fresh install and "Next match" agree', () => {
    expect(DEFAULT_RULES).toEqual(DEFAULT_MATCH_RULES);
  });
});
