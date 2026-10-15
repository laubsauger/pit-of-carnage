// Owned by: net
// Pure helpers for the Room screen: names, preferences, status and history lines. No React, no DOM.
import type { SavedStrategy } from '../../core';
import type { MatchSummary, RoomView } from '../../net';
import { MAPS } from '../../sim';
import { formatClock } from '../format';

/** Names offered to someone who has not picked one. Ringside regulars, mostly. */
const RINGSIDE = [
  'Ringside Regular', 'Bucket Holder', 'Mop Duty', 'Splash Zone', 'The Bookie', 'Front Row Fern', 'Concessions', 'Sawdust Sam',
  'Towel Thrower', 'Cheap Seats', 'Program Seller', 'Bandage Supplier',
];

export function defaultName(random: () => number = Math.random): string {
  return RINGSIDE[Math.floor(random() * RINGSIDE.length) % RINGSIDE.length]!;
}

/** Latest saved version of each strategy name, names in alphabetical order (what can go in the pool). */
export function latestPerName(saved: readonly SavedStrategy[]): SavedStrategy[] {
  const best = new Map<string, SavedStrategy>();
  for (const s of saved) {
    const b = best.get(s.name);
    if (!b || s.version > b.version) best.set(s.name, s);
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type Tone = 'good' | 'bad' | 'wait' | 'info';

/** One line about the connection, and how it should look. */
export function statusLine(v: Pick<RoomView, 'status' | 'role' | 'code' | 'peers' | 'room'>): { text: string; tone: Tone } {
  const online = v.room ? v.room.members.filter((m) => m.online).length : 0;
  switch (v.status) {
    case 'hosting':
      return { text: online > 1 ? `Hosting. ${online - 1} ${online === 2 ? 'guest' : 'guests'} in the room.` : 'Hosting. Share the code; nobody is here yet.', tone: 'good' };
    case 'connected':
      return { text: `Connected. ${online} in the room.`, tone: 'good' };
    case 'connecting':
      return { text: 'Connecting…', tone: 'wait' };
    case 'looking':
      return { text: v.peers > 0 ? 'Connected to players, waiting for the host to answer…' : `Looking for the host of ${v.code}…`, tone: 'wait' };
    case 'host-gone':
      return { text: 'The host is gone. Waiting in case they come back.', tone: 'bad' };
    case 'refused':
      return { text: 'The host turned you away.', tone: 'bad' };
    case 'closed':
      return { text: 'You left the room.', tone: 'info' };
  }
}

function mapName(id: string): string {
  return (MAPS[id]?.name ?? id).replace(/^The /, 'the ');
}

/** "Gary (Ana's) took the Pit with 3 kills." in the feed's voice. */
export function historyLine(h: MatchSummary): string {
  const where = mapName(h.mapId);
  if (!h.winner) return `Nobody walked out of ${where}.`;
  const who = h.winnerOwner ? `${h.winner} (${h.winnerOwner}'s)` : h.winner;
  if (h.ending === 'judges') return `The judges gave ${where} to ${who}.`;
  const kills = h.winnerKills === 0 ? 'without a kill' : h.winnerKills === 1 ? 'with 1 kill' : `with ${h.winnerKills} kills`;
  return `${who} took ${where} ${kills}.`;
}

/** Match length as m:ss. */
export function matchLength(ticks: number): string {
  return formatClock(Math.max(0, ticks));
}
