// Owned by: net
/**
 * The optional TURN relay. Peers on strict networks (offices, schools, many mobile carriers) cannot
 * reach each other directly; a TURN server relays their traffic. This prototype has none of its own,
 * so a player may enter one (a URL and its credentials). It is kept in this browser only and handed
 * to WebRTC when a room opens; it never goes to the host or anyone else in the room.
 *
 * Trystero takes it as `turnConfig`, which it appends to its default STUN servers to build the
 * `RTCConfiguration.iceServers` (`rtcConfig.iceServers` would replace the STUN list instead).
 * Nothing here imports trystero, so it is testable without WebRTC.
 */

import { CONTROL } from './check';

/** Separates our rooms from every other Trystero app on the same relays. Bump with incompatible changes. */
export const APP_ID = 'pit-of-carnage-rooms-1';

/** Where the relay is kept (localStorage). */
export const TURN_KEY = 'poc.room.turn.v1';

/** Longest URL, user name or credential accepted. */
const MAX_FIELD = 256;

export type TurnConfig = {
  /** `turn:host:port` or `turns:host:port`, optionally with `?transport=tcp`. */
  url: string;
  username: string;
  credential: string;
};

/** The relay as the WebRTC stack wants it (trystero's `TurnServerConfig`). */
export type TurnServer = { urls: string; username?: string; credential?: string };

/** What joining a room passes to trystero's `joinRoom`. */
export type RoomJoinConfig = { appId: string; password: string; turnConfig?: TurnServer[] };

const TURN_URL = /^turns?:[A-Za-z0-9.-]+(?::\d{1,5})?(?:\?transport=(?:udp|tcp))?$/;

/** Why `url` is not a TURN URL (one plain sentence), or null when it is. */
export function turnUrlProblem(url: string): string | null {
  const u = url.trim();
  if (u === '') return 'Enter the relay address, for example turn:relay.example.com:3478.';
  if (u.length > MAX_FIELD) return 'That address is too long.';
  if (!/^turns?:/.test(u)) return 'A TURN address starts with "turn:" or "turns:" (a STUN or web address will not relay anything).';
  if (!TURN_URL.test(u)) return 'That does not look like a TURN address. Use turn:host:port, for example turn:relay.example.com:3478.';
  return null;
}

const field = (v: unknown): string | null => (typeof v === 'string' && v.length <= MAX_FIELD && !CONTROL.test(v) ? v : null);

/** A TURN config from anywhere untrusted (storage, a form), trimmed; null when it is not usable. */
export function checkTurnConfig(raw: unknown): TurnConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const url = field(r.url)?.trim() ?? null;
  const username = field(r.username ?? '');
  const credential = field(r.credential ?? '');
  if (url === null || username === null || credential === null || turnUrlProblem(url) !== null) return null;
  return { url, username: username.trim(), credential };
}

type KeyValue = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };

/** The relay this browser keeps, or null (none, or something unusable was stored). */
export function readTurn(storage: Pick<KeyValue, 'getItem'> | null): TurnConfig | null {
  try {
    const text = storage?.getItem(TURN_KEY);
    return text ? checkTurnConfig(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

/** Keep `turn` in this browser, or forget it (null). False when storage refused. */
export function writeTurn(storage: KeyValue | null, turn: TurnConfig | null): boolean {
  if (!storage) return false;
  try {
    if (turn) storage.setItem(TURN_KEY, JSON.stringify(turn));
    else storage.removeItem(TURN_KEY);
    return true;
  } catch {
    return false;
  }
}

/** The `joinRoom` config for room `code`. The code doubles as the password that encrypts the WebRTC handshake. */
export function roomJoinConfig(code: string, turn: TurnConfig | null): RoomJoinConfig {
  const config: RoomJoinConfig = { appId: APP_ID, password: `pit:${code}` };
  if (turn) {
    const server: TurnServer = { urls: turn.url };
    if (turn.username) server.username = turn.username;
    if (turn.credential) server.credential = turn.credential;
    config.turnConfig = [server];
  }
  return config;
}

/** The host part of a TURN URL, for "Relaying through relay.example.com" (credentials never shown). */
export function turnHost(turn: TurnConfig): string {
  return turn.url.replace(/^turns?:/, '').replace(/\?.*$/, '');
}
