// Owned by: net
/**
 * Opening a room in the browser: the WebRTC transport (loaded on demand, so it is not in the main
 * bundle), the host or peer session, and a ticker that keeps the session pumping (also in a
 * background tab, so the host's matches do not stall when the host looks elsewhere).
 */

import { RoomClient } from './client';
import { RoomHost } from './host';
import type { RoomSession } from './session';
import { startTicker } from './transport';

type KeyValue = { getItem(key: string): string | null; setItem(key: string, value: string): void };

export type OpenRoomOptions = {
  role: 'host' | 'peer';
  /** Canonical room code (see `parseRoomCode`). */
  code: string;
  /** Display name, already cleaned (see `cleanName`). */
  name: string;
  clientId: string;
  /** The host keeps its room here (to reopen it after a reload). */
  storage?: KeyValue | null;
};

/** Pump interval: about 60 Hz, like the sim. */
const PUMP_MS = 16;

export async function openRoom(opts: OpenRoomOptions): Promise<RoomSession> {
  const { trysteroTransport } = await import('./trystero');
  const transport = trysteroTransport(opts.code);
  const now = () => performance.now();
  const session: RoomSession =
    opts.role === 'host'
      ? new RoomHost({ code: opts.code, name: opts.name, clientId: opts.clientId, transport, now, storage: opts.storage ?? null })
      : new RoomClient({ code: opts.code, name: opts.name, clientId: opts.clientId, transport, now });
  const stop = startTicker(() => session.pump(), PUMP_MS);
  const leave = session.leave.bind(session);
  session.leave = () => {
    stop();
    leave();
  };
  return session;
}
