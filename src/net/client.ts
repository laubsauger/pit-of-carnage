// Owned by: net
/**
 * A peer in a room: says hello to everyone, takes the first browser that answers as its host, and
 * from then on accepts host messages only from that browser. Every message is checked; frames are
 * decoded against the announced match and fed to the stream player.
 *
 * Trust: the room trusts its host for which match it shows (the host simulates; that is the point
 * of host-authoritative), never for the shape of what it sends, nor for how much or how often:
 * every browser's messages are rate-limited here too, and everything kept is bounded (see
 * `StreamPlayer`), so a hostile host can neither freeze a guest nor grow its memory without limit.
 */

import { matchHardCapTicks } from '../core';
import type { MapDef, StrategySource } from '../core';
import { encodeStrategyCode, loadStrategy } from '../strategy';
import { isObj } from './check';
import { decodeGore } from './gore';
import { decodeMind } from './mind';
import { StreamPlayer } from './player';
import { PROTOCOL_VERSION, parseHostMessage, parsePeerMessage } from './protocol';
import type { HostMessage, RoomSettings, RoomState } from './protocol';
import { ViewState, keepExtras } from './session';
import type { MatchExtras, RoomSession, RoomStatus, RoomView } from './session';
import { decodeFrame, parseMatchInfo } from './snapshot';
import type { StreamMatchInfo } from './snapshot';
import type { Transport } from './transport';

/** After this long without a host, the room says what might be wrong. */
export const HOST_SEARCH_MS = 12_000;

/**
 * Messages one browser may send us in a burst, and refilled per second. A host sends about 20
 * frames, 10 minds and 4 room states a second; anything far beyond that is dropped unread.
 */
export const INBOUND_BURST = 240;
export const INBOUND_PER_SECOND = 120;

/** Shortest gap between two `watch` messages (the inspector's selection; the latest one wins). */
const WATCH_MS = 250;

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
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  /** The selection last told to the host (match id -1: not yet told this host anything). */
  private sentWatch: { match: number; fighter: string | null } = { match: -1, fighter: null };
  private lastWatchAt = -Infinity;
  private extrasList: MatchExtras[] = [];

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
    this.syncWatch();
    this.searchTimeout();
    this.view.flush();
  }

  extras(matchId: number): MatchExtras | null {
    return this.extrasList.find((x) => x.matchId === matchId) ?? null;
  }

  private searchTimeout(): void {
    if (this.status !== 'looking' || this.warned) return;
    if (this.now() - this.searchingSince < HOST_SEARCH_MS) return;
    this.warned = true;
    const peers = this.t.peers().length;
    this.view.say(
      peers === 0
        ? `Nobody is in room ${this.code} yet. Check the code with the host. If it is right, one of your networks may block direct connections: a TURN relay (Network settings in the lobby) gets through.`
        : `Connected to ${peers} ${peers === 1 ? 'player' : 'players'}, but no host answered. The host may have closed the room.`,
      'bad',
    );
  }

  /** Tell the host which fighter the inspector shows, when that changed (at most every `WATCH_MS`). */
  private syncWatch(): void {
    const match = this.player.info?.id;
    if (!this.host || match === undefined) return;
    const fighter = this.player.selected;
    const sent = this.sentWatch;
    if (sent.match === match && sent.fighter === fighter) return;
    // A new match starts with nobody selected on both sides: nothing to say.
    if (sent.match !== match && fighter === null) {
      this.sentWatch = { match, fighter };
      return;
    }
    const now = this.now();
    if (now - this.lastWatchAt < WATCH_MS) return;
    this.lastWatchAt = now;
    this.sentWatch = { match, fighter };
    this.t.send({ t: 'watch', match, fighter }, this.host);
  }

  leave(): void {
    if (this.status === 'closed') return;
    this.status = 'closed';
    this.host = null;
    this.t.leave();
    this.view.changed();
    this.view.flush(); // the pump stops with the room
  }

  /** Token bucket per sender: a flood is dropped (and counted) before anything parses it. */
  private allow(from: string): boolean {
    const now = this.now();
    const b = this.buckets.get(from) ?? { tokens: INBOUND_BURST, at: now };
    b.tokens = Math.min(INBOUND_BURST, b.tokens + ((now - b.at) / 1000) * INBOUND_PER_SECOND);
    b.at = now;
    this.buckets.set(from, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private receive(raw: unknown, from: string): void {
    if (this.status === 'closed') return;
    if (!this.allow(from)) return this.view.reject();
    if (isObj(raw) && (raw.t === 'frame' || raw.t === 'mind' || raw.t === 'gore')) {
      if (from !== this.host || !this.match) return this.view.reject();
      if (!this.matchData(raw)) this.view.reject();
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
      this.sentWatch = { match: -1, fighter: null }; // a host (maybe reopened) that knows nothing of us yet
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
      case 'report':
      case 'reveal':
        this.afterMatch(msg);
        break;
      default:
        break;
    }
  }

  /** A frame, a mind or a gore summary of the current match, checked against it. False when refused. */
  private matchData(raw: Record<string, unknown>): boolean {
    const { info, map } = this.match!;
    const cap = matchHardCapTicks(info.timeLimitTicks) + 600;
    if (raw.t === 'frame') {
      const frame = decodeFrame(raw, info, map);
      if (frame) this.player.push(frame, this.now());
      return frame !== null;
    }
    if (raw.t === 'mind') {
      const mind = decodeMind(raw, info, cap);
      if (mind) this.player.pushMind(mind);
      return mind !== null;
    }
    const gore = decodeGore(raw, info, cap);
    if (gore) this.player.history(gore.matchId, gore.events);
    return gore !== null;
  }

  /** The report or the revealed strategies of the match that just ended (each kept once per match). */
  private afterMatch(msg: Extract<HostMessage, { t: 'report' | 'reveal' }>): void {
    const info = this.match?.info;
    if (!info || msg.match !== info.id) return this.view.reject();
    const had = this.extras(info.id) ?? { matchId: info.id, report: null, revealed: null };
    if (msg.t === 'report') {
      if (had.report !== null) return;
      this.player.setReport(info.id, msg.text);
      this.extrasList = keepExtras(this.extrasList, { ...had, report: msg.text });
    } else {
      if (had.revealed !== null) return;
      this.player.setRevealed(info.id, msg.list);
      // Names and builds from the match announcement; the codes are gated by whoever uses them.
      const revealed = msg.list.flatMap((r) => {
        const f = info.fighters.find((x) => x.id === r.fighterId);
        return f ? [{ ...r, name: f.name, owner: f.owner, weapon: f.weapon, skill: f.skill }] : [];
      });
      this.extrasList = keepExtras(this.extrasList, { ...had, revealed });
    }
    this.view.changed();
  }

  private peerLeft(peer: string): void {
    this.buckets.delete(peer);
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
