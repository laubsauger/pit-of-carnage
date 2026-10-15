// Owned by: net
/**
 * The room leaderboard, kept by the host: openskill (Plackett-Luce) over every room match's
 * finishing order, the same model as the gym's rating book (mu 25, sigma 25/3, sorted by
 * mu - 3 sigma), but keyed by `entryKey` so two different strategies with the same name do not
 * share a rating. Plain data in and out (`toJSON` / `fromJSON`) so the host can keep it.
 */

import { rate } from 'openskill';
import { RATING_MU, RATING_SIGMA, toRating } from '../gym/ratings';
import { MAX_BOARD } from './protocol';
import type { BoardRow } from './protocol';

/** One fighter's result in a rated room match. `place` 1 is the winner. */
export type BoardSeat = { key: string; name: string; version: number; owner: string | null; place: number; kills: number };

type Record_ = BoardRow & { placeSum: number };

export class RoomBoard {
  private readonly records = new Map<string, Record_>();

  /** Update every seat of one finished FFA match (each fighter its own team). Needs two seats. */
  rate(seats: readonly BoardSeat[]): void {
    if (seats.length < 2) return;
    const priors = seats.map((s) => this.records.get(s.key) ?? null);
    const teams = priors.map((p) => [{ mu: p?.mu ?? RATING_MU, sigma: p?.sigma ?? RATING_SIGMA }]);
    const updated = rate(teams, { rank: seats.map((s) => s.place) });
    // A strategy seated twice would get two updates; sum its shifts like the gym's book does.
    const merged = new Map<string, { seat: BoardSeat; dMu: number; sigma: number; places: number[]; kills: number }>();
    seats.forEach((s, i) => {
      const prior = teams[i]![0]!;
      const post = updated[i]![0]!;
      const m = merged.get(s.key);
      if (m) {
        m.dMu += post.mu - prior.mu;
        m.sigma = Math.min(m.sigma, post.sigma);
        m.places.push(s.place);
        m.kills += s.kills;
      } else merged.set(s.key, { seat: s, dMu: post.mu - prior.mu, sigma: post.sigma, places: [s.place], kills: s.kills });
    });
    for (const [key, m] of merged) {
      const prev = this.records.get(key);
      const matches = (prev?.matches ?? 0) + 1;
      const placeSum = (prev?.placeSum ?? 0) + m.places.reduce((a, b) => a + b, 0) / m.places.length;
      this.records.set(key, {
        key,
        name: m.seat.name,
        version: m.seat.version,
        owner: m.seat.owner ?? prev?.owner ?? null,
        mu: (prev?.mu ?? RATING_MU) + m.dMu,
        sigma: m.sigma,
        matches,
        wins: (prev?.wins ?? 0) + (m.places.includes(1) ? 1 : 0),
        placeSum,
        avgPlace: Math.round((placeSum / matches) * 100) / 100,
        kills: (prev?.kills ?? 0) + m.kills,
      });
    }
    this.trim();
  }

  /** Best first: by ordinal (mu - 3 sigma), then more matches, then key. */
  rows(): BoardRow[] {
    return [...this.records.values()]
      .sort((a, b) => toRating(b.mu, b.sigma).ordinal - toRating(a.mu, a.sigma).ordinal || b.matches - a.matches || (a.key < b.key ? -1 : 1))
      .map(({ placeSum: _, ...row }) => row);
  }

  get size(): number {
    return this.records.size;
  }

  toJSON(): Record_[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  /** Rebuild from `toJSON()` output; malformed rows are skipped. */
  static fromJSON(json: unknown): RoomBoard {
    const board = new RoomBoard();
    if (!Array.isArray(json)) return board;
    for (const r of json as Partial<Record_>[]) {
      if (typeof r?.key !== 'string' || typeof r.name !== 'string' || !Number.isFinite(r.mu) || !(Number(r.sigma) > 0)) continue;
      const matches = Number.isInteger(r.matches) ? r.matches! : 0;
      const placeSum = Number.isFinite(r.placeSum) ? r.placeSum! : 0;
      board.records.set(r.key, {
        key: r.key, name: r.name, version: Number.isInteger(r.version) ? r.version! : 1, owner: typeof r.owner === 'string' ? r.owner : null,
        mu: r.mu!, sigma: r.sigma!, matches, wins: Number.isInteger(r.wins) ? r.wins! : 0, placeSum,
        avgPlace: matches > 0 ? Math.round((placeSum / matches) * 100) / 100 : 0, kills: Number.isInteger(r.kills) ? r.kills! : 0,
      });
    }
    board.trim();
    return board;
  }

  /** Keep the board bounded: drop the least-played rows first (then the lowest rated). */
  private trim(): void {
    if (this.records.size <= MAX_BOARD) return;
    const drop = [...this.records.values()]
      .sort((a, b) => a.matches - b.matches || toRating(a.mu, a.sigma).ordinal - toRating(b.mu, b.sigma).ordinal)
      .slice(0, this.records.size - MAX_BOARD);
    for (const r of drop) this.records.delete(r.key);
  }
}
