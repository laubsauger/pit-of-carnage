// Owned by: net
/**
 * How a host keeps its room in the browser (localStorage), so it can reopen it after a reload or a
 * crash with the same code, pool and leaderboard. Small on purpose: the lobby reads it without
 * loading the room code itself.
 */

import type { MatchSummary, RoomSettings } from './protocol';

export type SavedRoom = {
  v: 1;
  /** Wall-clock ms of the last save (for "rooms you hosted"). */
  savedAt: number;
  settings: RoomSettings;
  members: { id: string; name: string; client: string }[];
  entries: { id: string; member: string | null; owner: string | null; code: string; matches: number }[];
  nextEntry: number;
  nextMember: number;
  board: unknown;
  history: MatchSummary[];
  matchCount: number;
  mapTurn: number;
};

const HOST_KEY_PREFIX = 'poc.room.host.';

export function hostStorageKey(code: string): string {
  return `${HOST_KEY_PREFIX}${code}`;
}

/** A room this browser hosted and can reopen, newest first in `hostedRooms`. */
export type HostedRoom = { code: string; savedAt: number; strategies: number; matches: number };

/** Rooms kept in `storage` by earlier hosts in this browser, newest first. Unreadable ones are skipped. */
export function hostedRooms(storage: { length: number; key(i: number): string | null; getItem(k: string): string | null }): HostedRoom[] {
  const out: HostedRoom[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(HOST_KEY_PREFIX)) continue;
    const code = key.slice(HOST_KEY_PREFIX.length);
    if (!/^[A-Z]{4,6}$/.test(code)) continue;
    try {
      const raw = JSON.parse(storage.getItem(key) ?? 'null') as Partial<SavedRoom> | null;
      if (raw?.v !== 1) continue;
      out.push({
        code,
        savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt! : 0,
        strategies: Array.isArray(raw.entries) ? raw.entries.length : 0,
        matches: Number.isInteger(raw.matchCount) ? raw.matchCount! : 0,
      });
    } catch {
      // A broken entry is just not offered.
    }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}
