// Owned by: net
/**
 * The real transport: WebRTC data channels between every browser in the room, found through
 * Trystero's default public Nostr relays (no server of our own). This file is imported dynamically
 * when a room opens, so the WebRTC code is not part of the main bundle.
 *
 * Limits, shown to players in the Room screen: there is no session browser (the code is the only
 * way in), and peers behind strict NATs or firewalls connect only through a TURN relay, which the
 * player enters in the Room screen (`./turn`); without one they cannot connect.
 */

import { joinRoom, selfId } from 'trystero';
import type { JsonValue } from 'trystero';
import type { Transport } from './transport';
import { roomJoinConfig } from './turn';
import type { TurnConfig } from './turn';

export { APP_ID } from './turn';

/** Join room `code` (already normalised), relaying through `turn` when one is set. */
export function trysteroTransport(code: string, turn: TurnConfig | null = null): Transport {
  const room = joinRoom(roomJoinConfig(code, turn), `room-${code}`, {
    onJoinError: (d) => {
      t.onError?.(
        turn
          ? `Could not connect to a player (${d.error}), even through your TURN relay. Check its address and credentials.`
          : `Could not connect to a player (${d.error}). Strict networks block direct connections; a TURN relay (Network settings in the Room lobby) gets through them.`,
      );
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
