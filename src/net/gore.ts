// Owned by: net
/**
 * Gore so far, for someone who joins a room mid-match. The arena paints blood, gibs, limbs, soot
 * and bloody footprints from events, and a late joiner never saw the early ones. The host keeps a
 * bounded summary of those events (`GoreLog`) and sends it once after the match announcement; the
 * peer's player puts it in front of its own log, so the arena paints it as catch-up (old events
 * leave their marks but play no sound, flash or camera move).
 *
 * Bounded on both sides: the biggest hits survive when there are too many (the small ones barely
 * stain), and of everything else the latest are kept.
 */

import type { GameEvent } from '../core';
import { BAD, checkEvent, int, isObj } from './check';
import type { Refs } from './check';
import type { StreamMatchInfo } from './snapshot';

/** Events kept per kind. Only these kinds travel in a gore summary. */
export const GORE_LIMITS = {
  hit: 480,
  dismember: 64,
  kill: 32,
  explosion: 48,
  footstep: 160,
  wall_contact: 64,
  sudden_death: 4,
  escalation: 16,
} as const satisfies Partial<Record<GameEvent['type'], number>>;

type GoreKind = keyof typeof GORE_LIMITS;

/** Most events in one summary (the sum of the per-kind limits). */
export const GORE_MAX_EVENTS = Object.values(GORE_LIMITS).reduce((a, b) => a + b, 0);

/** What goes over the wire (sent to one late joiner). */
export type WireGore = { t: 'gore'; m: number; k: number; e: GameEvent[] };

type Kept = { seq: number; e: GameEvent };

function isGore(e: GameEvent): e is Extract<GameEvent, { type: GoreKind }> {
  if (e.type === 'footstep') return e.bloody; // clean footsteps leave nothing
  return Object.hasOwn(GORE_LIMITS, e.type);
}

/** The host's bounded summary of the current match's gore. */
export class GoreLog {
  private readonly kept = new Map<GoreKind, Kept[]>();
  private seq = 0;

  /** Note events as they go out in frames (plain copies; kept as they are). */
  add(events: readonly GameEvent[]): void {
    for (const e of events) {
      if (!isGore(e)) continue;
      const kind = e.type as GoreKind;
      let list = this.kept.get(kind);
      if (!list) this.kept.set(kind, (list = []));
      list.push({ seq: this.seq++, e });
      // Prune in batches: pruning on every event at the cap would sort for each hit.
      if (list.length >= GORE_LIMITS[kind] * 2) this.kept.set(kind, prune(kind, list));
    }
  }

  /** The summary, in the order the events happened, within `GORE_LIMITS`. */
  events(): GameEvent[] {
    const all: Kept[] = [];
    for (const [kind, list] of this.kept) all.push(...(list.length > GORE_LIMITS[kind] ? prune(kind, list) : list));
    return all.sort((a, b) => a.seq - b.seq).map((k) => k.e);
  }

  clear(): void {
    this.kept.clear();
    this.seq = 0;
  }
}

/** Down to the kind's limit: the biggest hits, or the latest of anything else. In event order. */
function prune(kind: GoreKind, list: Kept[]): Kept[] {
  const cap = GORE_LIMITS[kind];
  if (list.length <= cap) return list;
  if (kind !== 'hit') return list.slice(-cap);
  const amount = (k: Kept) => (k.e.type === 'hit' ? k.e.amount : 0);
  return [...list].sort((a, b) => amount(b) - amount(a) || a.seq - b.seq).slice(0, cap).sort((a, b) => a.seq - b.seq);
}

export type DecodedGore = { matchId: number; tick: number; events: GameEvent[] };

/**
 * Check a gore summary against its match. The whole message is refused when it is too big or not
 * for this match; single bad events (or kinds that are not gore) are dropped.
 */
export function decodeGore(v: unknown, info: StreamMatchInfo, cap: number): DecodedGore | null {
  if (!isObj(v) || v.t !== 'gore' || v.m !== info.id) return null;
  const refs: Refs = { fighters: new Set(info.fighters.map((f) => f.id)) };
  const tick = int(0, cap)(v.k, refs);
  if (tick === BAD || !Array.isArray(v.e) || v.e.length > GORE_MAX_EVENTS) return null;
  const events: GameEvent[] = [];
  for (const raw of v.e as unknown[]) {
    const e = checkEvent(raw, refs, { min: 0, max: tick });
    if (e !== BAD && isGore(e)) events.push(e);
  }
  // In order, as the arena expects them (a hostile order would only misplace stains, but sort anyway).
  return { matchId: info.id, tick, events: events.sort((a, b) => a.tick - b.tick) };
}
