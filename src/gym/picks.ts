/**
 * "Watch worst loss", "Watch best win", "Watch a typical match": which of a batch's matches to open
 * for one strategy, and where in them to look. Every gym match is deterministic, so the UI rebuilds
 * the chosen report's match (same seed, same lineup) and seeks to `focusTick`.
 *
 * - Worst loss: its lowest finish relative to the field size; ties: the earliest death, then the
 *   least damage dealt. Opens at its death.
 * - Best win: a 1st place with the most kills; ties: the most damage dealt, then the shortest match.
 *   Opens at its last kill.
 * - Typical: the finish closest to its average (relative to the field size); ties: kills closest to
 *   its average, then survival time. Prefers a match other than the two above when there is one.
 *   Opens at its death, or at its first kill when it survived.
 *
 * A strategy with two seats in one match (a mirror) is judged per seat.
 */

import type { MatchReport } from '../core';
import { clock, ordinalPlace, plural } from './format';
import { deathPhrase } from './text';

export type MatchPickKind = 'worst_loss' | 'best_win' | 'typical';

export type MatchPick = {
  kind: MatchPickKind;
  /** Index into the batch's reports (`BatchResult.reports`). */
  reportIndex: number;
  seed: number;
  mapId: string;
  /** The strategy's fighter in that match: select it, follow it, filter the timeline to it. */
  fighterId: string;
  place: number;
  /** The moment to open at (see the module doc); the UI starts a little before it. Null: from the start. */
  focusTick: number | null;
  /** One line for a button's tooltip, e.g. "7th of 8 on the Pit, seed 42: died at 0:14 (SHANKED: TWIN_DAGGERS by Gary)." */
  summary: string;
};

export type MatchPicks = { worstLoss: MatchPick | null; bestWin: MatchPick | null; typical: MatchPick | null };

/** A kill or the death of one fighter in a match, for "jump to a kill or death" lists. */
export type FighterMoment = { tick: number; kind: 'kill' | 'death'; otherId: string | null; label: string };

type Seat = {
  reportIndex: number;
  report: MatchReport;
  fighterId: string;
  place: number;
  /** 0 = won, 1 = last. */
  standing: number;
  kills: number;
  damage: number;
  /** Ticks alive (the match length for a survivor). */
  survived: number;
  died: number | null;
};

function seatsOf(reports: readonly MatchReport[], key: string): Seat[] {
  const seats: Seat[] = [];
  reports.forEach((report, reportIndex) => {
    const n = report.roster.length;
    for (const e of report.roster) {
      if (e.strategyKey !== key) continue;
      const f = report.fighters.find((x) => x.fighterId === e.fighterId);
      if (!f) continue;
      seats.push({
        reportIndex,
        report,
        fighterId: f.fighterId,
        place: f.place,
        standing: n > 1 ? (f.place - 1) / (n - 1) : 0,
        kills: f.kills,
        damage: f.damageDealt,
        survived: f.diedAtTick ?? report.ticks,
        died: f.diedAtTick,
      });
    }
  });
  return seats;
}

/** Sorted copy, best first by `compare`, ties by report order then fighter id. */
function best(seats: readonly Seat[], compare: (a: Seat, b: Seat) => number): Seat | undefined {
  return [...seats].sort((a, b) => compare(a, b) || a.reportIndex - b.reportIndex || (a.fighterId < b.fighterId ? -1 : 1))[0];
}

function nameIn(report: MatchReport): (id: string) => string {
  return (id) => report.roster.find((e) => e.fighterId === id)?.name ?? id;
}

function where(s: Seat, mapName: (id: string) => string): string {
  return `on ${mapName(s.report.mapId)}, seed ${s.report.seed}`;
}

function fate(s: Seat): string {
  const f = s.report.fighters.find((x) => x.fighterId === s.fighterId)!;
  if (s.died === null) return `survived ${clock(s.report.ticks)}`;
  return `died at ${clock(s.died)}${f.death ? ` (${deathPhrase(f.death, nameIn(s.report), s.fighterId)})` : ''}`;
}

function killTicks(s: Seat): number[] {
  return s.report.kills.filter((k) => k.killerId === s.fighterId && k.victimId !== s.fighterId).map((k) => k.tick);
}

function pick(kind: MatchPickKind, s: Seat, focusTick: number | null, summary: string): MatchPick {
  return { kind, reportIndex: s.reportIndex, seed: s.report.seed, mapId: s.report.mapId, fighterId: s.fighterId, place: s.place, focusTick, summary };
}

/** The worst loss, best win and a typical match of strategy `key` in a batch's reports. */
export function pickMatches(reports: readonly MatchReport[], key: string, opts: { mapName?: (mapId: string) => string } = {}): MatchPicks {
  const mapName = opts.mapName ?? ((id: string) => id);
  const seats = seatsOf(reports, key);
  const of = (s: Seat) => `${ordinalPlace(s.place)} of ${s.report.roster.length}`;

  const lossSeat = best(
    seats.filter((s) => s.place > 1),
    (a, b) => b.standing - a.standing || (a.died ?? Infinity) - (b.died ?? Infinity) || a.damage - b.damage,
  );
  const worstLoss = lossSeat ? pick('worst_loss', lossSeat, lossSeat.died, `${of(lossSeat)} ${where(lossSeat, mapName)}: ${fate(lossSeat)}.`) : null;

  const winSeat = best(
    seats.filter((s) => s.place === 1),
    (a, b) => b.kills - a.kills || b.damage - a.damage || a.report.ticks - b.report.ticks,
  );
  const bestWin = winSeat
    ? pick(
        'best_win',
        winSeat,
        killTicks(winSeat).at(-1) ?? null,
        `Won ${where(winSeat, mapName)}: ${winSeat.kills} ${plural(winSeat.kills, 'kill')} and ${Math.round(winSeat.damage)} damage in ${clock(winSeat.report.ticks)}.`,
      )
    : null;

  let typical: MatchPick | null = null;
  if (seats.length > 0) {
    const mean = (f: (s: Seat) => number) => seats.reduce((t, s) => t + f(s), 0) / seats.length;
    const standing = mean((s) => s.standing);
    const kills = mean((s) => s.kills);
    const survived = mean((s) => s.survived);
    const taken = new Set([lossSeat, winSeat].filter((s): s is Seat => s !== undefined).map((s) => s.reportIndex));
    const others = seats.filter((s) => !taken.has(s.reportIndex));
    const s = best(
      others.length > 0 ? others : seats,
      (a, b) =>
        Math.abs(a.standing - standing) - Math.abs(b.standing - standing) ||
        Math.abs(a.kills - kills) - Math.abs(b.kills - kills) ||
        Math.abs(a.survived - survived) - Math.abs(b.survived - survived),
    )!;
    const killed = s.kills > 0 ? `${s.kills} ${plural(s.kills, 'kill')}, ` : '';
    typical = pick('typical', s, s.died ?? killTicks(s)[0] ?? null, `${of(s)} ${where(s, mapName)}: ${killed}${fate(s)}.`);
  }
  return { worstLoss, bestWin, typical };
}

/** Every kill and the death of one fighter in a match, in time order, each with a short label. */
export function fighterMoments(report: MatchReport, fighterId: string): FighterMoment[] {
  const name = nameIn(report);
  const out: FighterMoment[] = [];
  for (const k of report.kills) {
    if (k.killerId === fighterId && k.victimId !== fighterId) {
      out.push({ tick: k.tick, kind: 'kill', otherId: k.victimId, label: `Killed ${name(k.victimId)}${k.weapon ? ` (${k.weapon})` : ''}` });
    } else if (k.victimId === fighterId) {
      const f = report.fighters.find((x) => x.fighterId === fighterId);
      out.push({ tick: k.tick, kind: 'death', otherId: k.killerId === fighterId ? null : k.killerId, label: f?.death ? `Died: ${deathPhrase(f.death, name, fighterId)}` : 'Died' });
    }
  }
  return out.sort((a, b) => a.tick - b.tick);
}
