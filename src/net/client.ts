// Owned by: net
/**
 * A peer in a room: says hello to everyone, takes the first browser that answers as its host, and
 * from then on accepts host messages only from that browser. Every message is checked; frames are
 * decoded against the announced match and fed to the stream player.
 *
 * Trust: the room trusts its host for which match it shows (the host simulates; that is the point
 * of host-authoritative), never for the shape of what it sends.
 */

import type { StrategySource } from '../core';
import { encodeStrategyCode, loadStrategy } from '../strategy';
import { isObj } from './check';
import { StreamPlayer } from './player';
import { PROTOCOL_VERSION, parseHostMessage, parsePeerMessage } from './protocol';
import type { RoomSettings, RoomState } from './protocol';
import { ViewState } from './session';
import type { RoomSession, RoomStatus, RoomView } from './session';
import { decodeFrame, parseMatchInfo } from './snapshot';
import type { StreamMatchInfo } from './snapshot';
import type { Transport } from './transport';
import type { MapDef } from '../core';

/** After this long without a host, the room says what might be wrong. */
export const HOST_SEARCH_MS = 12_000;

export type ClientOptions = {
  code: string;
  name: string;
  clientId: string;
  transport: Transport;
  now: () => number;
};

export class RoomClient implements RoomSession {
  readonly role = 'peer' as const;
  readonly code: string;
  readonly player = new StreamPlayer();
  private readonly t: Transport;
  private readonly now: () => number;
  private readonly hello: { t: 'hello'; v: number; name: string; client: string };
  private host: string | null = null;
  private status: RoomStatus = 'looking';
  private me: string | null = null;
  private room: RoomState | null = null;
  private match: { info: StreamMatchInfo; map: MapDef } | null = null;
  private searchingSince: number;
  private warned = false;
  private readonly view: ViewState;

  constructor(opts: ClientOptions) {
    this.code = opts.code;
    this.t = opts.transport;
    this.now = opts.now;
    this.hello = { t: 'hello', v: PROTOCOL_VERSION, name: opts.name, client: opts.clientId };
    this.searchingSince = this.now();
    this.view = new ViewState(() => this.buildView());
    this.t.onMessage = (raw, from) => this.receive(raw, from);
    // Whoever turns up might be the host (or the host coming back): introduce ourselves.
    this.t.onPeerJoin = (peer) => {
      if (this.status !== 'closed' && this.status !== 'refused' && this.host === null) this.t.send(this.hello, peer);
      this.view.changed();
    };
    this.t.onPeerLeave = (peer) => this.peerLeft(peer);
    this.t.onError = (line) => this.view.say(line, 'bad');
    this.t.send(this.hello);
  }

  getView(): RoomView {
    return this.view.get();
  }

  subscribe(fn: () => void): () => void {
    return this.view.subscribe(fn);
  }

  add(input: unknown, source: StrategySource): { ok: boolean; line: string } {
    // Checked here first for a quick answer (and so nothing broken goes out); the host checks again.
    const r = loadStrategy(input, source);
    if (!r.strategy) {
      const e = r.errors[0];
      return { ok: false, line: e ? `${e.path ? `${e.path}: ` : ''}${e.message}` : 'invalid strategy.' };
    }
    if (!this.host) return { ok: false, line: 'No host yet. Wait until the room is connected.' };
    this.t.send({ t: 'add', strategy: encodeStrategyCode(r.strategy) }, this.host);
    return { ok: true, line: `Sent ${r.strategy.name} v${r.strategy.version ?? 1} to the host.` };
  }

  remove(entryId: string): void {
    if (this.host) this.t.send({ t: 'remove', entry: entryId }, this.host);
  }

  setSettings(_patch: Partial<RoomSettings>): void {
    // Only the host changes the room.
  }

  pump(): void {
    if (this.status !== 'looking' || this.warned) return;
    if (this.now() - this.searchingSince < HOST_SEARCH_MS) return;
    this.warned = true;
    const peers = this.t.peers().length;
    this.view.say(
      peers === 0
        ? `Nobody is in room ${this.code} yet. Check the code with the host. If it is right, one of your networks may block direct connections (this prototype has no TURN relay).`
        : `Connected to ${peers} ${peers === 1 ? 'player' : 'players'}, but no host answered. The host may have closed the room.`,
      'bad',
    );
  }

  leave(): void {
    if (this.status === 'closed') return;
    this.status = 'closed';
    this.host = null;
    this.t.leave();
    this.view.changed();
  }

  private receive(raw: unknown, from: string): void {
    if (this.status === 'closed') return;
    if (isObj(raw) && raw.t === 'frame') {
      if (from !== this.host || !this.match) return this.view.reject();
      const frame = decodeFrame(raw, this.match.info, this.match.map);
      if (!frame) return this.view.reject();
      this.player.push(frame, this.now());
      return;
    }
    const msg = parseHostMessage(raw);
    if (!msg) {
      // Other peers' hellos reach us too; they are not for us.
      if (!parsePeerMessage(raw)) this.view.reject();
      return;
    }
    if (msg.t === 'you') {
      if (this.host !== null && this.host !== from) return this.view.reject();
      if (msg.v !== PROTOCOL_VERSION) {
        this.status = 'refused';
        this.view.say(`The host runs another version of the game (room protocol ${msg.v}, yours ${PROTOCOL_VERSION}). Both of you reload the page.`, 'bad');
        return;
      }
      const back = this.status === 'host-gone';
      this.host = from;
      this.me = msg.member;
      this.status = 'connected';
      this.view.say(back ? 'The host is back.' : `Connected to room ${this.code}.`, 'good');
      return;
    }
    if (from !== this.host) {
      // A refusal can come before we have a host (full room, wrong version).
      if (msg.t === 'refused' && this.host === null) {
        this.status = 'refused';
        this.view.say(msg.reason, 'bad');
        return;
      }
      return this.view.reject();
    }
    switch (msg.t) {
      case 'state':
        this.room = msg.state.code === this.code ? msg.state : this.room;
        this.view.changed();
        break;
      case 'match': {
        const r = parseMatchInfo(msg.info);
        if ('problem' in r) {
          this.match = null;
          if (r.problem === 'malformed') this.view.reject();
          else this.view.say('The host is on another version of the game (its arena differs from yours). Both of you reload the page.', 'bad');
          return;
        }
        this.match = r;
        this.player.begin(r.info, r.map);
        this.view.changed();
        break;
      }
      case 'added':
        this.view.say(msg.line, msg.ok ? 'good' : 'bad');
        break;
      case 'refused':
        this.status = 'refused';
        this.view.say(msg.reason, 'bad');
        break;
      case 'bye':
        this.lostHost(msg.reason);
        break;
      default:
        break;
    }
  }

  private peerLeft(peer: string): void {
    if (peer === this.host) this.lostHost('The host left. The room waits in case they come back.');
    else this.view.changed();
  }

  private lostHost(reason: string): void {
    this.host = null;
    this.match = null;
    this.player.clear();
    this.status = 'host-gone';
    this.searchingSince = this.now();
    this.view.say(reason, 'bad');
  }

  private buildView(): RoomView {
    return {
      role: 'peer',
      code: this.code,
      status: this.status,
      me: this.me,
      room: this.room,
      notices: this.view.notices,
      rejected: this.view.rejected,
      peers: this.status === 'closed' ? 0 : this.t.peers().length,
      waiting: null,
    };
  }
}
