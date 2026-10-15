// Owned by: net
/**
 * The room pool (strategies people brought) and how a match line-up is drawn from it.
 *
 * Every strategy in the pool passed the gate on the host. Entries are keyed by content
 * (`entryKey`), so the same strategy added twice, or by two people, is one entry and one
 * leaderboard row; two different strategies that share a name and version stay apart.
 */

import { hashString, strategyKey } from '../core';
import type { Rng, SkillId, Strategy, ValidStrategy, WeaponId } from '../core';
import { MAX_ENTRIES_PER_MEMBER, MAX_POOL } from './protocol';
import type { PoolEntryInfo } from './protocol';

export type PoolEntry = {
  id: string;
  /** Member who added it (null for house stacks, which never sit in the pool). */
  member: string | null;
  owner: string | null;
  strategy: ValidStrategy;
  key: string;
  /** Room matches played. */
  matches: number;
};

/** One seat of a match line-up. */
export type Seat = { strategy: ValidStrategy; key: string; owner: string | null; entryId: string | null };

/** `name@vN#hash`: a strategy's identity in a room (its content, not just its label). */
export function entryKey(s: Strategy): string {
  return `${strategyKey(s)}#${(hashString(JSON.stringify(s)) >>> 0).toString(36)}`;
}

export type AddOutcome = { ok: true; entry: PoolEntry; fresh: boolean; line: string } | { ok: false; line: string };

export class RoomPool {
  private list: PoolEntry[] = [];
  private nextId = 1;

  get entries(): readonly PoolEntry[] {
    return this.list;
  }

  /** Add a gated strategy for `member`. Refuses past the per-member and pool limits. */
  add(strategy: ValidStrategy, member: string, owner: string): AddOutcome {
    const key = entryKey(strategy);
    const label = `${strategy.name} v${strategy.version ?? 1}`;
    const same = this.list.find((e) => e.key === key);
    if (same) return { ok: true, entry: same, fresh: false, line: `${label} is already in the pool${same.owner ? ` (${same.owner} brought it)` : ''}.` };
    if (this.list.filter((e) => e.member === member).length >= MAX_ENTRIES_PER_MEMBER) {
      return { ok: false, line: `You already have ${MAX_ENTRIES_PER_MEMBER} strategies in the pool. Remove one first.` };
    }
    if (this.list.length >= MAX_POOL) return { ok: false, line: `The pool is full (${MAX_POOL} strategies).` };
    const entry: PoolEntry = { id: `e${this.nextId++}`, member, owner, strategy, key, matches: 0 };
    this.list.push(entry);
    return { ok: true, entry, fresh: true, line: `${label} joined the pool.` };
  }

  /** Remove an entry. Members may remove their own; the host may remove any. */
  remove(entryId: string, by: string, isHost: boolean): boolean {
    const i = this.list.findIndex((e) => e.id === entryId);
    if (i < 0) return false;
    if (!isHost && this.list[i]!.member !== by) return false;
    this.list.splice(i, 1);
    return true;
  }

  /** Count a played match for these entries. */
  played(entryIds: readonly string[]): void {
    for (const e of this.list) if (entryIds.includes(e.id)) e.matches++;
  }

  /** Rename the owner on every entry of `member` (a member came back under a new name). */
  renameOwner(member: string, owner: string): void {
    for (const e of this.list) if (e.member === member) e.owner = owner;
  }

  info(): PoolEntryInfo[] {
    return this.list.map((e) => ({
      id: e.id, member: e.member, owner: e.owner, name: e.strategy.name, version: e.strategy.version ?? 1,
      weapon: e.strategy.build.weapon as WeaponId, skill: e.strategy.build.skill as SkillId, matches: e.matches,
    }));
  }

  /** Restore entries (from the host's saved room), keeping their ids. */
  restore(entries: PoolEntry[], nextId: number): void {
    this.list = entries.slice(0, MAX_POOL);
    this.nextId = Math.max(nextId, ...this.list.map((e) => Number(e.id.slice(1)) + 1).filter(Number.isFinite), 1);
  }

  get nextEntryId(): number {
    return this.nextId;
  }
}

/**
 * Seats for the next match: pool entries first, those with the fewest room matches first (ties
 * drawn at random), so everyone's strategy gets its turn when the pool is bigger than a match.
 * With `fill`, empty seats go to house stacks not already seated. Never seats one strategy twice.
 * Returns fewer than 2 seats when no match can be made.
 */
export function pickLineup(
  pool: readonly PoolEntry[],
  house: readonly { strategy: ValidStrategy; key: string }[],
  fighters: number,
  fill: boolean,
  rng: Rng,
): Seat[] {
  const order = rng.shuffle([...pool]).sort((a, b) => a.matches - b.matches);
  const seats: Seat[] = [];
  const taken = new Set<string>();
  for (const e of order) {
    if (seats.length >= fighters) break;
    if (taken.has(e.key)) continue;
    taken.add(e.key);
    seats.push({ strategy: e.strategy, key: e.key, owner: e.owner, entryId: e.id });
  }
  if (fill) {
    for (const h of rng.shuffle([...house])) {
      if (seats.length >= fighters) break;
      if (taken.has(h.key)) continue;
      taken.add(h.key);
      seats.push({ strategy: h.strategy, key: h.key, owner: null, entryId: null });
    }
  }
  // Seat order decides colours and spawn slots: mix pool and house so nobody always gets slot one.
  return rng.shuffle(seats);
}
