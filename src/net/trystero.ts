// Owned by: net
/**
 * The real transport: WebRTC data channels between every browser in the room, found through
 * Trystero's default public Nostr relays (no server of our own). This file is imported dynamically
 * when a room opens, so the WebRTC code is not part of the main bundle.
 *
 * Limits, shown to players in the Room screen: there is no session browser (the code is the only
 * way in), and peers behind strict NATs or firewalls cannot connect without a TURN relay, which
 * this prototype does not configure.
 */

import { joinRoom, selfId } from 'trystero';
import type { JsonValue } from 'trystero';
import type { Transport } from './transport';

/** Separates our rooms from every other Trystero app on the same relays. Bump with incompatible changes. */
export const APP_ID = 'pit-of-carnage-rooms-1';

/** Join room `code` (already normalised). The code doubles as the password that encrypts the WebRTC handshake. */
export function trysteroTransport(code: string): Transport {
  const room = joinRoom({ appId: APP_ID, password: `pit:${code}` }, `room-${code}`, {
    onJoinError: (d) => {
      t.onError?.(`Could not connect to a player (${d.error}). Strict networks can block direct connections; this prototype has no TURN relay.`);
    },
  });
  const action = room.makeAction<JsonValue>('pit');
  let gone = false;

  const t: Transport = {
    selfId,
    onMessage: null,
    onPeerJoin: null,
    onPeerLeave: null,
    onError: null,
    send(msg, to) {
      if (gone) return;
      action.send(msg as JsonValue, to === undefined ? undefined : { target: to }).catch((err: unknown) => {
        // A peer that left mid-send rejects; the leave event says the rest.
        console.warn('Room message not delivered.', err);
      });
    },
    peers: () => Object.keys(room.getPeers()),
    leave() {
      if (gone) return;
      gone = true;
      void room.leave();
    },
  };

  action.onMessage = (data, ctx) => t.onMessage?.(data, ctx.peerId);
  room.onPeerJoin = (peerId) => t.onPeerJoin?.(peerId);
  room.onPeerLeave = (peerId) => t.onPeerLeave?.(peerId);
  return t;
}
