// Owned by: net
/**
 * Room messages. Peers talk only to the host; the host answers, broadcasts the public room state
 * and streams the match. Every message is checked on arrival (`parsePeerMessage`,
 * `parseHostMessage`); anything malformed is dropped and counted, never half-used.
 *
 * Strategies travel only from a peer to the host, as a strategy code, and are gated there with
 * source `network`. Other peers see a strategy's name, version, weapon and skill, never its text.
 */

import { MAX_FIGHTERS, MIN_FIGHTERS } from '../core';
import type { SkillId, WeaponId } from '../core';
import { MAX_STRATEGY_TEXT } from '../strategy';
import { BAD, CONTROL, MATCH_ENDINGS, NO_REFS, SKILL_IDS, WEAPON_IDS, bool, id, int, isObj, listOf, nullable, num, oneOf, shape, text } from './check';
import type { Bad, Check } from './check';
import { MAX_NAME } from './snapshot';

/** Bumped whenever a message or frame layout changes; a mismatched peer is refused with a reason. */
export const PROTOCOL_VERSION = 1;

/** Room size: the host plus seven. The host uploads every frame to every peer. */
export const MAX_MEMBERS = 8;
/** Strategies one member may have in the pool at once, and the pool's size. */
export const MAX_ENTRIES_PER_MEMBER = 3;
export const MAX_POOL = 24;
/** Rows kept on the room leaderboard and matches kept in the history. */
export const MAX_BOARD = 96;
export const MAX_HISTORY = 12;
/** Longest display name a member may pick. */
export const MAX_MEMBER_NAME = 24;

export type RoomMember = {
  /** Host-assigned and stable across a member's leave and rejoin (`m0` is the host). */
  id: string;
  name: string;
  online: boolean;
  host: boolean;
};

/** A strategy in the pool as everyone sees it (the strategy itself stays with the host). */
export type PoolEntryInfo = {
  id: string;
  /** Member who added it; null for a house stack. */
  member: string | null;
  owner: string | null;
  name: string;
  version: number;
  weapon: WeaponId;
  skill: SkillId;
  /** Room matches it has played. */
  matches: number;
};

/** One room leaderboard row: openskill over the room's matches (see `RoomBoard`). */
export type BoardRow = {
  key: string;
  name: string;
  version: number;
  /** Member name who brought it (the latest one, if several did), or null for a house stack. */
  owner: string | null;
  mu: number;
  sigma: number;
  matches: number;
  wins: number;
  avgPlace: number;
  kills: number;
};

export type RoomSettings = {
  /** Fighters per match, MIN_FIGHTERS..MAX_FIGHTERS. Fewer play when the pool is small and filling is off. */
  fighters: number;
  /** A map id, or `rotate` to go through every map in turn. */
  mapId: string;
  /** Fill empty seats with house stacks (and play house-only warm-ups while the pool is empty). */
  fillWithHouse: boolean;
  /** Matches keep coming. Off: the current match finishes, then the room waits. */
  running: boolean;
};

export type MatchSummary = {
  id: number;
  mapId: string;
  ending: (typeof MATCH_ENDINGS)[number];
  ticks: number;
  fighters: number;
  winner: string | null;
  winnerOwner: string | null;
  winnerKills: number;
};

/** The public room: what every member sees. */
export type RoomState = {
  code: string;
  members: RoomMember[];
  entries: PoolEntryInfo[];
  board: BoardRow[];
  settings: RoomSettings;
  history: MatchSummary[];
  /** The match being played (or about to start), or null between matches. */
  match: { id: number; mapId: string; fighters: number } | null;
};

/** Peer to host. */
export type PeerMessage =
  | { t: 'hello'; v: number; name: string; client: string }
  /** A strategy code (`PIT2.…`) or JSON text; the host gates it with source `network`. */
  | { t: 'add'; strategy: string }
  | { t: 'remove'; entry: string };

/** Host to peer (frames are checked separately against their match, see `decodeFrame`). */
export type HostMessage =
  | { t: 'you'; v: number; member: string }
  | { t: 'state'; state: RoomState }
  | { t: 'match'; info: unknown }
  /** Reply to `add`: one plain line, ok or the reason it was refused. */
  | { t: 'added'; ok: boolean; line: string }
  | { t: 'refused'; reason: string }
  | { t: 'bye'; reason: string };

const ownerName = text(MAX_NAME, 1);
/** Client ids are random secrets made by `newClientId`. */
const clientId: Check<string> = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(v) ? v : BAD);
const line = text(400);

/** A display name as typed, trimmed and squeezed; null when nothing usable is left. */
export function cleanName(raw: string): string | null {
  const s = raw.replace(/\s+/g, ' ').replace(new RegExp(CONTROL.source, 'g'), '').trim().slice(0, MAX_MEMBER_NAME).trim();
  return s.length > 0 ? s : null;
}

export function parsePeerMessage(v: unknown): PeerMessage | null {
  if (!isObj(v)) return null;
  const r = NO_REFS;
  switch (v.t) {
    case 'hello': {
      const ver = int(0, 1e6)(v.v, r);
      const n = typeof v.name === 'string' ? cleanName(v.name) : null;
      const client = clientId(v.client, r);
      return ver === BAD || n === null || client === BAD ? null : { t: 'hello', v: ver, name: n, client };
    }
    case 'add':
      return typeof v.strategy === 'string' && v.strategy.length > 0 && v.strategy.length <= MAX_STRATEGY_TEXT ? { t: 'add', strategy: v.strategy } : null;
    case 'remove': {
      const entry = id(v.entry, r);
      return entry === BAD ? null : { t: 'remove', entry };
    }
    default:
      return null;
  }
}

const member = shape<RoomMember>({ id, name: ownerName, online: bool, host: bool });
const entry = shape<PoolEntryInfo>({
  id, member: nullable(id), owner: nullable(ownerName), name: ownerName, version: int(1, 1e9), weapon: oneOf(WEAPON_IDS), skill: oneOf(SKILL_IDS),
  matches: int(0, 1e9),
});
const boardRow = shape<BoardRow>({
  key: text(200, 1), name: ownerName, version: int(1, 1e9), owner: nullable(ownerName), mu: num(-1e4, 1e4), sigma: num(0, 1e4),
  matches: int(0, 1e9), wins: int(0, 1e9), avgPlace: num(0, 64), kills: int(0, 1e9),
});
const settings = shape<RoomSettings>({ fighters: int(MIN_FIGHTERS, MAX_FIGHTERS), mapId: id, fillWithHouse: bool, running: bool });
const summary = shape<MatchSummary>({
  id: int(0, 1e9), mapId: id, ending: oneOf(MATCH_ENDINGS), ticks: int(0, 1e9), fighters: int(0, 64), winner: nullable(ownerName),
  winnerOwner: nullable(ownerName), winnerKills: int(0, 1000),
});
/** Match history from anywhere untrusted (the wire, or the host's own storage); bad input gives []. */
export function checkHistory(v: unknown): MatchSummary[] {
  const r = listOf(summary, MAX_HISTORY)(Array.isArray(v) ? v.slice(0, MAX_HISTORY) : v, NO_REFS);
  return r === BAD ? [] : r;
}

const currentMatch = nullable(shape<{ id: number; mapId: string; fighters: number }>({ id: int(0, 1e9), mapId: id, fighters: int(0, 64) }));

const roomState: Check<RoomState> = shape<RoomState>({
  code: (v) => (typeof v === 'string' && /^[A-Z]{4,6}$/.test(v) ? v : BAD),
  members: listOf(member, MAX_MEMBERS * 4),
  entries: listOf(entry, MAX_POOL + 32),
  board: listOf(boardRow, MAX_BOARD),
  settings,
  history: listOf(summary, MAX_HISTORY),
  match: currentMatch,
});

/** A host message other than a frame, or null. Frames (`t: 'frame'`) go to `decodeFrame`. */
export function parseHostMessage(v: unknown): HostMessage | null {
  if (!isObj(v)) return null;
  const r = NO_REFS;
  const ok = <T>(x: T | Bad): x is T => x !== BAD;
  switch (v.t) {
    case 'you': {
      const ver = int(0, 1e6)(v.v, r);
      const m = id(v.member, r);
      return ok(ver) && ok(m) ? { t: 'you', v: ver, member: m } : null;
    }
    case 'state': {
      const s = roomState(v.state, r);
      return ok(s) ? { t: 'state', state: s } : null;
    }
    case 'match':
      return isObj(v.info) ? { t: 'match', info: v.info } : null;
    case 'added': {
      const good = bool(v.ok, r);
      const l = line(v.line, r);
      return ok(good) && ok(l) ? { t: 'added', ok: good, line: l } : null;
    }
    case 'refused':
    case 'bye': {
      const reason = line(v.reason, r);
      return ok(reason) ? { t: v.t, reason } : null;
    }
    default:
      return null;
  }
}
