/**
 * Strategy ratings: openskill (Weng-Lin, Plackett-Luce model) over match placements.
 *
 * Every rated match updates every participant from its finishing order, so ratings move after each
 * match and settle as evidence piles up (sigma shrinks toward openskill's tau floor). This replaces
 * the prototypes' hand-assigned numbers, which stalled at one value.
 *
 * - FFA and duel: each fighter is its own team, ranked by place.
 * - Squads: each squad is a team, ranked by its best-placed member (the squad that lasted longest).
 * - Mirror entries (one strategy in several seats) are rated as separate players from the same
 *   prior; the strategy then takes the sum of their mean shifts (each seat is real evidence) and the
 *   smallest resulting sigma. Overwriting with the last seat would throw the other seats away.
 *
 * The book is plain data: `toJSON()` / `RatingBook.fromJSON()` round-trip through JSON for storage.
 */

import { rate } from 'openskill';
import { makeRating } from '../core';
import type { LeaderboardEntry, MatchReport, Rating } from '../core';

export const RATING_MU = 25;
export const RATING_SIGMA = 25 / 3;
const SCHEMA = 'pit-ratings/1';

export type RatingRecord = {
  key: string;
  name: string;
  version: number;
  mu: number;
  sigma: number;
  /** Rated matches this strategy took part in (a mirror match counts once). */
  matches: number;
  /** Matches where one of its fighters (or its squad) placed 1st. */
  wins: number;
  /** Sum of its mean place per match; avgPlace = placeSum / matches. */
  placeSum: number;
  /** Epoch ms of the last rated match (0 when unknown). */
  lastPlayedAt: number;
};

export type RatingBookJson = { schema: typeof SCHEMA; records: RatingRecord[] };

/** A core `Rating` (ordinal and provisional flag included) from openskill's mu and sigma. */
export function toRating(mu: number, sigma: number): Rating {
  return makeRating(mu, sigma);
}

export const DEFAULT_RATING: Rating = toRating(RATING_MU, RATING_SIGMA);

type Seat = { key: string; name: string; version: number; place: number; team: number };

export class RatingBook {
  private readonly records = new Map<string, RatingRecord>();

  /** Rebuild from `toJSON()` output. Malformed records are skipped, not guessed at. */
  static fromJSON(json: unknown): RatingBook {
    const book = new RatingBook();
    const records = (json as Partial<RatingBookJson> | null)?.records;
    if (!Array.isArray(records)) return book;
    for (const r of records as Partial<RatingRecord>[]) {
      if (typeof r?.key !== 'string' || !Number.isFinite(r.mu) || !Number.isFinite(r.sigma) || !(r.sigma! > 0)) continue;
      book.records.set(r.key, {
        key: r.key,
        name: typeof r.name === 'string' ? r.name : r.key,
        version: Number.isFinite(r.version) ? r.version! : 1,
        mu: r.mu!,
        sigma: r.sigma!,
        matches: Number.isFinite(r.matches) ? r.matches! : 0,
        wins: Number.isFinite(r.wins) ? r.wins! : 0,
        placeSum: Number.isFinite(r.placeSum) ? r.placeSum! : 0,
        lastPlayedAt: Number.isFinite(r.lastPlayedAt) ? r.lastPlayedAt! : 0,
      });
    }
    return book;
  }

  toJSON(): RatingBookJson {
    const records = [...this.records.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { schema: SCHEMA, records: records.map((r) => ({ ...r })) };
  }

  get size(): number {
    return this.records.size;
  }

  /** Current rating; unrated strategies get the openskill prior (mu 25, sigma 25/3, ordinal 0). */
  get(key: string): Rating {
    const r = this.records.get(key);
    return r ? toRating(r.mu, r.sigma) : DEFAULT_RATING;
  }

  record(key: string): RatingRecord | null {
    const r = this.records.get(key);
    return r ? { ...r } : null;
  }

  /** Update every participant of one finished match from its placements. */
  rate(report: MatchReport, playedAt = 0): void {
    const seats = seatsOf(report);
    const teamCount = seats.reduce((m, s) => Math.max(m, s.team + 1), 0);
    if (teamCount < 2) return;

    const teams: { mu: number; sigma: number }[][] = Array.from({ length: teamCount }, () => []);
    const teamRank = new Array<number>(teamCount).fill(Infinity);
    const slot: { team: number; index: number }[] = [];
    for (const s of seats) {
      const prior = this.get(s.key);
      const team = teams[s.team]!;
      slot.push({ team: s.team, index: team.length });
      team.push({ mu: prior.mu, sigma: prior.sigma });
      teamRank[s.team] = Math.min(teamRank[s.team]!, s.place);
    }
    const updated = rate(teams, { rank: teamRank });

    const merged = new Map<string, { seat: Seat; dMu: number; sigma: number; places: number[]; won: boolean }>();
    seats.forEach((s, i) => {
      const { team, index } = slot[i]!;
      const prior = this.get(s.key);
      const post = updated[team]![index]!;
      const won = teamRank[team] === 1;
      const m = merged.get(s.key);
      if (m) {
        m.dMu += post.mu - prior.mu;
        m.sigma = Math.min(m.sigma, post.sigma);
        m.places.push(s.place);
        m.won ||= won;
      } else {
        merged.set(s.key, { seat: s, dMu: post.mu - prior.mu, sigma: post.sigma, places: [s.place], won });
      }
    });

    for (const [key, m] of merged) {
      const prev = this.records.get(key);
      const prior = this.get(key);
      this.records.set(key, {
        key,
        name: m.seat.name,
        version: m.seat.version,
        mu: prior.mu + m.dMu,
        sigma: m.sigma,
        matches: (prev?.matches ?? 0) + 1,
        wins: (prev?.wins ?? 0) + (m.won ? 1 : 0),
        placeSum: (prev?.placeSum ?? 0) + m.places.reduce((a, b) => a + b, 0) / m.places.length,
        lastPlayedAt: Math.max(prev?.lastPlayedAt ?? 0, playedAt),
      });
    }
  }

  /** Best first: by ordinal, then more matches, then key. */
  leaderboard(): LeaderboardEntry[] {
    return [...this.records.values()]
      .map((r) => ({
        key: r.key,
        name: r.name,
        version: r.version,
        rating: toRating(r.mu, r.sigma),
        matches: r.matches,
        wins: r.wins,
        avgPlace: r.matches > 0 ? Math.round((r.placeSum / r.matches) * 100) / 100 : 0,
        lastPlayedAt: r.lastPlayedAt,
      }))
      .sort((a, b) => b.rating.ordinal - a.rating.ordinal || b.matches - a.matches || (a.key < b.key ? -1 : 1));
  }
}

/** One seat per fighter with its team index (FFA: own team; squads: one team per squad). */
function seatsOf(report: MatchReport): Seat[] {
  const placeOf = new Map(report.fighters.map((f) => [f.fighterId, f.place]));
  const squadTeam = new Map<number, number>();
  return report.roster.map((r, i) => {
    const place = placeOf.get(r.fighterId) || report.placements.indexOf(r.fighterId) + 1 || report.roster.length;
    let team = i;
    if (report.format === 'squads') {
      if (!squadTeam.has(r.squad)) squadTeam.set(r.squad, squadTeam.size);
      team = squadTeam.get(r.squad)!;
    }
    return { key: r.strategyKey, name: r.strategyName, version: r.strategyVersion, place, team };
  });
}
