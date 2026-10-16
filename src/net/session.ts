// Owned by: net
/**
 * What the Room screen talks to: one `RoomSession`, either the host (`RoomHost`) or a peer
 * (`RoomClient`). Both expose the same view, so the screen does not care which side it is on.
 */

import type { SkillId, StrategySource, WeaponId } from '../core';
import type { StreamPlayer } from './player';
import type { RoomSettings, RoomState } from './protocol';

export type RoomRole = 'host' | 'peer';

/**
 * - `connecting`: the transport is starting.
 * - `looking`: a peer in the room, waiting for the host to answer.
 * - `connected`: a peer with a host.
 * - `hosting`: this browser runs the room.
 * - `host-gone`: the host left or closed the room (it may come back with the same code).
 * - `refused`: the host turned this peer away (full room, other game version).
 * - `closed`: this browser left.
 */
export type RoomStatus = 'connecting' | 'looking' | 'connected' | 'hosting' | 'host-gone' | 'refused' | 'closed';

export type Notice = { id: number; tone: 'info' | 'good' | 'bad'; text: string };

export type RoomView = {
  role: RoomRole;
  code: string;
  status: RoomStatus;
  /** Our member id once the host knows us (`m0` for the host). */
  me: string | null;
  /** The public room as last received (host: as it is). Null until a host answers. */
  room: RoomState | null;
  /** Latest things worth saying, oldest first (at most `MAX_NOTICES`). */
  notices: Notice[];
  /** Messages from other browsers that failed validation and were dropped. */
  rejected: number;
  /** Browsers connected to us right now. */
  peers: number;
  /** Host: why no match is running right now, or null. */
  waiting: string | null;
};

export const MAX_NOTICES = 6;

/** Finished matches whose report and revealed strategies are kept (newest first). */
export const MAX_EXTRAS = 4;

/** One fighter of a finished match with its strategy as a code (`RoomSettings.revealStrategies`). */
export type RevealedFighter = { fighterId: string; name: string; owner: string | null; weapon: WeaponId; skill: SkillId; code: string };

/** What a finished match left behind for the room screen: its battle report and, if revealed, its strategies. */
export type MatchExtras = {
  matchId: number;
  /** The battle report as text (`reportToText`), or null until the host sends it. */
  report: string | null;
  /** Null while the host keeps the strategies to itself. */
  revealed: RevealedFighter[] | null;
};

export interface RoomSession {
  readonly role: RoomRole;
  readonly code: string;
  /** The room's match stream (the host's own view goes through it too). */
  readonly player: StreamPlayer;
  /** Same object until something changes (safe for `useSyncExternalStore`). */
  getView(): RoomView;
  subscribe(fn: () => void): () => void;
  /**
   * Put a strategy in the pool: a library strategy object, pasted JSON or a strategy code, gated
   * here with `source` first. A peer's strategy is gated again by the host (source `network`), whose
   * answer arrives as a notice.
   */
  add(input: unknown, source: StrategySource): { ok: boolean; line: string };
  /** Take an entry out of the pool (your own; the host may take any). */
  remove(entryId: string): void;
  /** Host only; ignored on a peer. */
  setSettings(patch: Partial<RoomSettings>): void;
  /** Time-based work (matches, frames, timeouts), and telling subscribers what changed. Called about 60 times a second while the room is open. */
  pump(): void;
  leave(): void;
  /** The report and revealed strategies of a recently finished match (see `MAX_EXTRAS`), or null. */
  extras(matchId: number): MatchExtras | null;
}

/** Keep `x` as the newest of a match's extras, at most `MAX_EXTRAS` matches. */
export function keepExtras(list: MatchExtras[], x: MatchExtras): MatchExtras[] {
  return [x, ...list.filter((e) => e.matchId !== x.matchId)].slice(0, MAX_EXTRAS);
}

/**
 * Shared notice list and listener plumbing for both sides. Changes are collected and told to
 * subscribers once per `flush` (every pump), so a burst of messages (a flood of bad ones from a
 * hostile browser, say) costs one screen update, not one per message.
 */
export class ViewState {
  notices: Notice[] = [];
  rejected = 0;
  private nextNotice = 1;
  private listeners = new Set<() => void>();
  private cached: RoomView | null = null;
  private pending = false;

  constructor(private readonly build: () => RoomView) {}

  get(): RoomView {
    return (this.cached ??= this.build());
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Something changed: the next `get` rebuilds the view, the next `flush` tells subscribers. */
  changed(): void {
    this.cached = null;
    this.pending = true;
  }

  /** Tell subscribers, once, if anything changed since the last flush. */
  flush(): void {
    if (!this.pending) return;
    this.pending = false;
    for (const fn of this.listeners) fn();
  }

  say(text: string, tone: Notice['tone'] = 'info'): void {
    this.notices = [...this.notices, { id: this.nextNotice++, tone, text }].slice(-MAX_NOTICES);
    this.changed();
  }

  reject(): void {
    this.rejected++;
    this.changed();
  }
}
