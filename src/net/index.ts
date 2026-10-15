// Owned by: net
/**
 * Peer-to-peer rooms (prototype). Host-authoritative over WebRTC (Trystero, no backend): the host
 * keeps the pool and the leaderboard, runs back-to-back matches and streams them; peers add
 * strategies and watch. See SPEC "Multiplayer prototype" and `docs/ARCHITECTURE.md`.
 *
 * - `openRoom` (browser): host or join a room by code; returns a `RoomSession` for the Room screen.
 * - `RoomHost`, `RoomClient`: the two sides, transport-agnostic (tests use `createMemoryHub`).
 * - `StreamPlayer` / `MatchStream`: what the arena draws for a streamed match.
 */

export { CODE_ALPHABET, CODE_LENGTH, codeFromSearch, newClientId, newRoomCode, parseRoomCode, roomLink } from './code';
export { RoomClient, HOST_SEARCH_MS } from './client';
export { HOST_TIMING, RoomHost } from './host';
export { hostStorageKey, hostedRooms } from './saved';
export type { HostedRoom } from './saved';
export { PLAYER_TIMING, StreamPlayer } from './player';
export type { StreamOutput, StreamView } from './player';
export { MAX_ENTRIES_PER_MEMBER, MAX_MEMBERS, MAX_MEMBER_NAME, MAX_POOL, PROTOCOL_VERSION, cleanName } from './protocol';
export type { BoardRow, MatchSummary, PoolEntryInfo, RoomMember, RoomSettings, RoomState } from './protocol';
export { openRoom } from './room';
export type { OpenRoomOptions } from './room';
export type { Notice, RoomRole, RoomSession, RoomStatus, RoomView } from './session';
export { createMemoryHub } from './transport';
export type { Transport } from './transport';
export { canWatchStreams } from './watch';
export type { MatchStream, StreamWatcher } from './watch';
