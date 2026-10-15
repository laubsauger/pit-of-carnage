import { describe, expect, it } from 'vitest';
import { Rng } from '../core';
import type { ValidStrategy } from '../core';
import { HOUSE_STACKS, loadStrategy } from '../strategy';
import { RoomBoard } from './board';
import { RoomPool, entryKey, pickLineup } from './pool';
import { MAX_ENTRIES_PER_MEMBER, MAX_POOL } from './protocol';
import { broughtStrategy } from './testkit';

function valid(s: unknown): ValidStrategy {
  const r = loadStrategy(s, 'test');
  if (!r.strategy) throw new Error(`test strategy invalid: ${r.errors[0]?.message}`);
  return r.strategy;
}

const house = HOUSE_STACKS.map((s) => {
  const v = valid(s);
  return { strategy: v, key: entryKey(v) };
});

describe('room pool', () => {
  it('keys entries by content, not just by label', () => {
    // Two people can both call their strategy "Gary v1"; they are different fighters with
    // different ratings. The same strategy brought twice is one entry.
    const pool = new RoomPool();
    const a = valid(broughtStrategy('Gary', 0));
    const b = valid(broughtStrategy('Gary', 1));
    expect(entryKey(a)).not.toBe(entryKey(b));
    expect(pool.add(a, 'm1', 'Flo').ok).toBe(true);
    expect(pool.add(b, 'm2', 'Ana').ok).toBe(true);
    const again = pool.add(valid(broughtStrategy('Gary', 0)), 'm2', 'Ana');
    expect(again).toMatchObject({ ok: true, fresh: false });
    expect(pool.entries).toHaveLength(2);
  });

  it('limits each member and the whole pool', () => {
    const pool = new RoomPool();
    for (let i = 0; i < MAX_ENTRIES_PER_MEMBER; i++) expect(pool.add(valid(broughtStrategy(`Mine ${i}`)), 'm1', 'Flo').ok).toBe(true);
    const over = pool.add(valid(broughtStrategy('One too many')), 'm1', 'Flo');
    expect(over.ok).toBe(false);
    expect(over.line).toMatch(/already have 3/);
    let m = 2;
    while (pool.entries.length < MAX_POOL) {
      expect(pool.add(valid(broughtStrategy(`Other ${pool.entries.length}`)), `m${m}`, 'x').ok).toBe(true);
      if (pool.entries.filter((e) => e.member === `m${m}`).length === MAX_ENTRIES_PER_MEMBER) m++;
    }
    expect(pool.add(valid(broughtStrategy('Late')), 'm99', 'Late').line).toMatch(/full/);
  });

  it('lets members remove only their own entries, the host any', () => {
    const pool = new RoomPool();
    const mine = pool.add(valid(broughtStrategy('Mine')), 'm1', 'Flo');
    const theirs = pool.add(valid(broughtStrategy('Theirs')), 'm2', 'Ana');
    if (!mine.ok || !theirs.ok) throw new Error('setup');
    expect(pool.remove(theirs.entry.id, 'm1', false)).toBe(false);
    expect(pool.remove(mine.entry.id, 'm1', false)).toBe(true);
    expect(pool.remove(theirs.entry.id, 'm0', true)).toBe(true);
    expect(pool.entries).toHaveLength(0);
  });
});

describe('match line-up', () => {
  const rng = () => new Rng(42);

  it('fills empty seats with house stacks and never seats a strategy twice', () => {
    const pool = new RoomPool();
    pool.add(valid(broughtStrategy('Gary')), 'm1', 'Flo');
    pool.add(house[0]!.strategy, 'm2', 'Ana'); // someone brought a house stack: it must not play twice
    const seats = pickLineup(pool.entries, house, 8, true, rng());
    expect(seats).toHaveLength(8);
    expect(new Set(seats.map((s) => s.key)).size).toBe(8);
    expect(seats.filter((s) => s.entryId !== null)).toHaveLength(2);
    expect(seats.find((s) => s.strategy.name === 'Gary')?.owner).toBe('Flo');
  });

  it('makes no match from fewer than two strategies when filling is off', () => {
    const pool = new RoomPool();
    expect(pickLineup(pool.entries, house, 8, false, rng())).toHaveLength(0);
    pool.add(valid(broughtStrategy('Lonely')), 'm1', 'Flo');
    expect(pickLineup(pool.entries, house, 8, false, rng()).length).toBeLessThan(2);
    pool.add(valid(broughtStrategy('Company')), 'm2', 'Ana');
    expect(pickLineup(pool.entries, house, 8, false, rng())).toHaveLength(2);
  });

  it("gives everyone's strategy its turn when the pool is bigger than a match", () => {
    // 12 strategies, 4 seats: over three matches every one must play exactly once.
    const pool = new RoomPool();
    for (let i = 0; i < 12; i++) pool.add(valid(broughtStrategy(`S${i}`)), `m${Math.floor(i / 3)}`, `P${i}`);
    const r = new Rng(7);
    const played = new Map<string, number>();
    for (let match = 0; match < 3; match++) {
      const seats = pickLineup(pool.entries, house, 4, true, r);
      expect(seats.every((s) => s.entryId !== null)).toBe(true);
      pool.played(seats.map((s) => s.entryId!));
      for (const s of seats) played.set(s.entryId!, (played.get(s.entryId!) ?? 0) + 1);
    }
    expect(played.size).toBe(12);
    expect([...played.values()].every((n) => n === 1)).toBe(true);
  });
});

describe('room leaderboard', () => {
  const seat = (key: string, place: number, kills = 0) => ({ key, name: key, version: 1, owner: null, place, kills });

  it('moves the winner above the losers after every match', () => {
    const board = new RoomBoard();
    board.rate([seat('a', 1, 3), seat('b', 2), seat('c', 3)]);
    let rows = board.rows();
    expect(rows.map((r) => r.key)).toEqual(['a', 'b', 'c']);
    expect(rows[0]).toMatchObject({ matches: 1, wins: 1, kills: 3, avgPlace: 1 });
    const muBefore = (k: string) => rows.find((r) => r.key === k)!.mu;
    const [aMu, cMu] = [muBefore('a'), muBefore('c')];
    board.rate([seat('c', 1), seat('b', 2), seat('a', 3)]);
    rows = board.rows();
    // Ratings move with every result: the new winner climbs, the new last place drops.
    expect(muBefore('c')).toBeGreaterThan(cMu);
    expect(muBefore('a')).toBeLessThan(aMu);
    expect(rows.find((r) => r.key === 'a')!).toMatchObject({ matches: 2, wins: 1, avgPlace: 2 });
    // Uncertainty shrinks with evidence: two matches in, every sigma is below the prior.
    expect(rows.every((r) => r.sigma < 25 / 3)).toBe(true);
  });

  it('ignores a match with fewer than two fighters', () => {
    const board = new RoomBoard();
    board.rate([seat('a', 1)]);
    expect(board.size).toBe(0);
  });

  it('survives a round trip through storage and skips malformed rows', () => {
    const board = new RoomBoard();
    board.rate([seat('a', 1), seat('b', 2)]);
    const json = JSON.parse(JSON.stringify(board.toJSON()));
    expect(RoomBoard.fromJSON(json).rows()).toEqual(board.rows());
    expect(RoomBoard.fromJSON([...json, { key: 'x', name: 'x', mu: 'high', sigma: 1 }, null, 7]).size).toBe(2);
    expect(RoomBoard.fromJSON('garbage').size).toBe(0);
  });
});
