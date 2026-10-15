// Owned by: net
/**
 * What the Room screen talks to: one `RoomSession`, either the host (`RoomHost`) or a peer
 * (`RoomClient`). Both expose the same view, so the screen does not care which side it is on.
 */

import type { StrategySource } from '../core';
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
  /** Time-based work (matches, frames, timeouts). Called about 60 times a second while the room is open. */
  pump(): void;
  leave(): void;
}

/** Shared notice list and listener plumbing for both sides. */
export class ViewState {
  notices: Notice[] = [];
  rejected = 0;
  private nextNotice = 1;
  private listeners = new Set<() => void>();
  private cached: RoomView | null = null;

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

  changed(): void {
    this.cached = null;
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
