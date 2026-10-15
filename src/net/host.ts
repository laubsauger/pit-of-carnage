// Owned by: net
/**
 * The host of a room. It keeps the members, the pool and the leaderboard, runs back-to-back
 * matches in this browser (host-authoritative: nobody else simulates) and streams them: the match
 * line-up once, then about 20 compact frames a second with the events in between. Its own view
 * watches the same stream, looped back through the codec, so the host sees what the peers see.
 *
 * Everything a peer sends is checked (`parsePeerMessage`), rate-limited, and every strategy goes
 * through the gate with source `network` before it can enter the pool.
 */

import { DEFAULT_FIGHTERS, DEFAULT_TIME_LIMIT_TICKS, FIGHTER_COLORS, MAX_FIGHTERS, MIN_FIGHTERS, Rng, clamp, matchHardCapTicks } from '../core';
import type { GameEvent, MapDef, Match, MatchConfig, Strategy, StrategySource, ValidStrategy } from '../core';
import { FixedStep, TimeDirector } from '../app/time';
import { MAPS, MAP_IDS, createMatch } from '../sim';
import { HOUSE_STACKS, encodeStrategyCode, headlessBrainFactory, loadStrategy } from '../strategy';
import { RoomBoard } from './board';
import type { BoardSeat } from './board';
import { StreamPlayer } from './player';
import { RoomPool, entryKey, pickLineup } from './pool';
import type { PoolEntry, Seat } from './pool';
import { MAX_HISTORY, MAX_MEMBERS, PROTOCOL_VERSION, checkHistory, parseHostMessage, parsePeerMessage } from './protocol';
import type { MatchSummary, PeerMessage, RoomSettings, RoomState } from './protocol';
import { hostStorageKey } from './saved';
import type { SavedRoom } from './saved';
import { ViewState } from './session';
import type { RoomSession, RoomView } from './session';
import { cloneEvent, decodeFrame, encodeFrame, mapFingerprint } from './snapshot';
import type { StreamMatchInfo, WireFrame } from './snapshot';
import type { Transport } from './transport';

export type HostTiming = {
  /** Line-up and countdown before the sim starts stepping (the countdown is its last 3 s). */
  introMs: number;
  /** After the end: the final kill's slow motion and the end card, before the next match. */
  outroMs: number;
  /** Frame interval while the match runs (about 20 a second). */
  frameMs: number;
  /** Frame interval while nothing moves (line-up, end card). */
  idleFrameMs: number;
  /** Shortest gap between two room-state broadcasts. */
  stateMs: number;
};

export const HOST_TIMING: HostTiming = { introMs: 3600, outroMs: 8000, frameMs: 50, idleFrameMs: 400, stateMs: 250 };

/** Messages a peer may send in a burst, and refilled per second (peers talk rarely; this stops floods). */
const RATE_BURST = 20;
const RATE_PER_SECOND = 5;

type KeyValue = { getItem(key: string): string | null; setItem(key: string, value: string): void };

export type HostOptions = {
  code: string;
  /** The host's display name (already cleaned). */
  name: string;
  clientId: string;
  transport: Transport;
  /** Monotonic ms (performance.now in the browser). */
  now: () => number;
  /** Random 32-bit integers for match seeds and line-ups (not the sim's randomness). */
  random?: () => number;
  /** Where the room is kept so the host can reopen it after a reload; null keeps nothing. */
  storage?: KeyValue | null;
  houseStacks?: readonly Strategy[];
  timing?: Partial<HostTiming>;
};

type Member = { id: string; name: string; client: string; peer: string | null; host: boolean };

type Running = {
  info: StreamMatchInfo;
  map: MapDef;
  match: Match;
  /** Seat per roster index. */
  seats: Seat[];
  index: Map<string, number>;
  phase: 'intro' | 'live' | 'outro';
  endedAt: number;
  lastStepAt: number;
  lastFrameAt: number;
  /** Events since the last frame, as plain copies. */
  events: GameEvent[];
  clock: FixedStep;
  director: TimeDirector;
  scale: number;
};



function cryptoRandom(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]!;
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI'];

/** Mirror names get numerals ("Gary II"), as in local matches. */
function dedupeNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = (seen.get(n) ?? 0) + 1;
    seen.set(n, k);
    return k === 1 ? n : `${n} ${ROMAN[k] ?? k}`;
  });
}

export class RoomHost implements RoomSession {
  readonly role = 'host' as const;
  readonly code: string;
  readonly player = new StreamPlayer();
  private readonly t: Transport;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly storage: KeyValue | null;
  private readonly timing: HostTiming;
  private readonly house: { strategy: ValidStrategy; key: string }[];
  private readonly members = new Map<string, Member>();
  private readonly pool = new RoomPool();
  private board = new RoomBoard();
  private settings: RoomSettings = { fighters: DEFAULT_FIGHTERS, mapId: 'rotate', fillWithHouse: true, running: true };
  private history: MatchSummary[] = [];
  private running: Running | null = null;
  private matchCount = 0;
  private mapTurn = 0;
  private nextMember = 1;
  private waiting: string | null = null;
  private closed = false;
  private dirty = true;
  private lastStateAt = -Infinity;
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  /** Peers that behave like a host of this room (warned about once each). */
  private readonly rivals = new Set<string>();
  private readonly view: ViewState;

  constructor(opts: HostOptions) {
    this.code = opts.code;
    this.t = opts.transport;
    this.now = opts.now;
    this.random = opts.random ?? cryptoRandom;
    this.storage = opts.storage ?? null;
    this.timing = { ...HOST_TIMING, ...opts.timing };
    this.house = (opts.houseStacks ?? HOUSE_STACKS).flatMap((s) => {
      const r = loadStrategy(s, 'house');
      return r.strategy ? [{ strategy: r.strategy, key: entryKey(r.strategy) }] : [];
    });
    this.members.set('m0', { id: 'm0', name: opts.name, client: opts.clientId, peer: this.t.selfId, host: true });
    this.view = new ViewState(() => this.buildView());
    this.restore();
    // The host may come back under another name; its strategies follow.
    this.pool.renameOwner('m0', opts.name);

    this.t.onMessage = (raw, from) => this.receive(raw, from);
    this.t.onPeerLeave = (peer) => this.peerLeft(peer);
    this.t.onPeerJoin = () => this.view.changed();
    this.t.onError = (line) => this.view.say(line, 'bad');
  }

  getView(): RoomView {
    return this.view.get();
  }

  subscribe(fn: () => void): () => void {
    return this.view.subscribe(fn);
  }

  // -------------------------------------------------------------------------------------------
  // Pool and settings (the host's own controls)
  // -------------------------------------------------------------------------------------------

  add(input: unknown, source: StrategySource): { ok: boolean; line: string } {
    const r = loadStrategy(input, source);
    if (!r.strategy) return { ok: false, line: firstError(r.errors) };
    const host = this.members.get('m0')!;
    const out = this.pool.add(r.strategy, host.id, host.name);
    if (out.ok && out.fresh) this.touch(true);
    return { ok: out.ok, line: out.line };
  }

  remove(entryId: string): void {
    if (this.pool.remove(entryId, 'm0', true)) this.touch(true);
  }

  setSettings(patch: Partial<RoomSettings>): void {
    this.settings = sanitizeSettings(this.settings, patch);
    this.touch(true);
  }

  leave(): void {
    if (this.closed) return;
    this.closed = true;
    this.save();
    this.t.send({ t: 'bye', reason: 'The host closed the room.' });
    this.t.leave();
    this.running = null;
    this.view.changed();
  }

  // -------------------------------------------------------------------------------------------
  // Time
  // -------------------------------------------------------------------------------------------

  pump(): void {
    if (this.closed) return;
    const now = this.now();
    this.runMatch(now);
    if (this.dirty && now - this.lastStateAt >= this.timing.stateMs) {
      this.dirty = false;
      this.lastStateAt = now;
      this.t.send({ t: 'state', state: this.publicState() });
    }
  }

  private runMatch(now: number): void {
    const m = this.running;
    if (!m) {
      if (this.settings.running) this.tryStart(now);
      return;
    }
    if (m.phase === 'intro') {
      if (now >= m.info.fightAt) {
        m.phase = 'live';
        m.lastStepAt = m.info.fightAt;
      } else if (now - m.lastFrameAt >= this.timing.idleFrameMs) this.sendFrame(m, now);
    }
    if (m.phase === 'live') {
      const dt = Math.max(0, now - m.lastStepAt) / 1000;
      m.lastStepAt = now;
      m.scale = m.director.update(dt);
      const steps = m.clock.advance(dt, m.scale);
      for (let i = 0; i < steps && !m.match.isOver; i++) {
        const events = m.match.step();
        for (const e of events) m.events.push(cloneEvent(e));
        m.director.onEvents(events);
      }
      if (m.match.isOver) {
        this.sendFrame(m, now);
        this.finish(m, now);
      } else if (m.match.state.tick > matchHardCapTicks(m.info.timeLimitTicks) + 600) {
        // The sim always ends by the hard cap; this only stops a broken one from running forever.
        this.view.say('That match would not end, so it was called off. Nobody was rated.', 'bad');
        this.running = null;
        this.touch(false);
      } else if (now - m.lastFrameAt >= this.timing.frameMs) this.sendFrame(m, now);
      return;
    }
    if (m.phase === 'outro') {
      // Slow motion winds down after the final kill; frames carry it.
      m.scale = m.director.update(Math.max(0, now - m.lastStepAt) / 1000);
      m.lastStepAt = now;
      if (now - m.endedAt >= this.timing.outroMs) {
        this.running = null;
        this.touch(false);
      } else if (now - m.lastFrameAt >= (m.scale < 1 ? this.timing.frameMs : this.timing.idleFrameMs)) this.sendFrame(m, now);
    }
  }

  private tryStart(now: number): void {
    const rng = new Rng(this.random());
    const seats = pickLineup(this.pool.entries, this.house, this.settings.fighters, this.settings.fillWithHouse, rng);
    if (seats.length < 2) {
      const why = this.settings.fillWithHouse
        ? 'Waiting for the house stacks (none could be loaded).'
        : 'Waiting for strategies: a match needs two in the pool (or turn on "Fill with house stacks").';
      if (this.waiting !== why) {
        this.waiting = why;
        this.view.changed();
      }
      return;
    }
    this.waiting = null;
    const mapId = this.settings.mapId === 'rotate' ? MAP_IDS[this.mapTurn++ % MAP_IDS.length]! : this.settings.mapId;
    const names = dedupeNames(seats.map((s) => s.strategy.name));
    const config: MatchConfig = {
      seed: rng.nextU32(),
      mapId,
      format: 'ffa',
      entrants: seats.map((s, i) => ({ id: `e${i}`, strategy: s.strategy, squad: i, name: names[i]!, color: FIGHTER_COLORS[i % FIGHTER_COLORS.length]! })),
      friendlyFire: true,
      timeLimitTicks: DEFAULT_TIME_LIMIT_TICKS,
      suddenDeath: true,
    };
    let match: Match;
    try {
      match = createMatch(config, headlessBrainFactory);
    } catch (err) {
      this.view.say(`A match could not start: ${err instanceof Error ? err.message : String(err)}`, 'bad');
      this.settings = { ...this.settings, running: false };
      this.touch(false);
      return;
    }
    const map = match.map;
    const info: StreamMatchInfo = {
      id: ++this.matchCount,
      mapId: map.id,
      mapHash: mapFingerprint(map),
      seed: config.seed,
      format: config.format,
      timeLimitTicks: config.timeLimitTicks,
      suddenDeath: config.suddenDeath,
      friendlyFire: config.friendlyFire,
      fightAt: now + this.timing.introMs,
      fighters: match.state.fighters.map((f, i) => ({
        id: f.id, entrantId: f.entrantId, squad: f.squad, name: f.name, color: f.color, weapon: f.weapon, skill: f.skill,
        attributes: { ...f.attributes }, radius: f.radius, owner: seats[i]!.owner,
      })),
    };
    this.running = {
      info, map, match, seats, index: new Map(match.state.fighters.map((f, i) => [f.id, i])), phase: 'intro', endedAt: 0,
      lastStepAt: now, lastFrameAt: -Infinity, events: [], clock: new FixedStep(), director: new TimeDirector(), scale: 1,
    };
    this.t.send({ t: 'match', info });
    this.player.begin(info, map);
    this.sendFrame(this.running, now);
    this.touch(false);
  }

  private sendFrame(m: Running, now: number): void {
    const frame: WireFrame = encodeFrame(m.info.id, now, m.scale, m.match.state, m.events, m.index);
    m.events = [];
    m.lastFrameAt = now;
    this.t.send(frame);
    // The host watches exactly what the peers get: the same frame, through JSON and the same checks.
    const decoded = decodeFrame(JSON.parse(JSON.stringify(frame)), m.info, m.map);
    if (decoded) this.player.push(decoded, now);
    else this.player.dropped++;
  }

  private finish(m: Running, now: number): void {
    m.phase = 'outro';
    m.endedAt = now;
    const state = m.match.state;
    const n = state.fighters.length;
    const seats: BoardSeat[] = state.fighters.map((f, i) => {
      const seat = m.seats[i]!;
      const place = f.place ?? (state.placements.indexOf(f.id) + 1 || n);
      return { key: seat.key, name: seat.strategy.name, version: seat.strategy.version ?? 1, owner: seat.owner, place, kills: f.kills };
    });
    this.board.rate(seats);
    this.pool.played(m.seats.flatMap((s) => (s.entryId ? [s.entryId] : [])));
    const wi = state.fighters.findIndex((f) => f.id === state.placements[0]);
    const winner = wi >= 0 ? state.fighters[wi]! : null;
    this.history = [
      {
        id: m.info.id, mapId: m.info.mapId, ending: state.ending ?? 'capped', ticks: state.tick, fighters: n,
        winner: winner?.name ?? null, winnerOwner: wi >= 0 ? m.seats[wi]!.owner : null, winnerKills: winner?.kills ?? 0,
      },
      ...this.history,
    ].slice(0, MAX_HISTORY);
    this.touch(true);
  }

  // -------------------------------------------------------------------------------------------
  // Peers
  // -------------------------------------------------------------------------------------------

  private receive(raw: unknown, from: string): void {
    if (this.closed) return;
    if (!this.allow(from)) return;
    const msg = parsePeerMessage(raw);
    if (!msg) {
      // Another browser answering hellos with this code: two hosts would split the room.
      const other = parseHostMessage(raw);
      if (other && (other.t === 'you' || other.t === 'state') && !this.rivals.has(from)) {
        this.rivals.add(from);
        this.view.say(`Another browser is also hosting room ${this.code}. Close one of them: guests stay with whichever host answered them first.`, 'bad');
        return;
      }
      this.view.reject();
      return;
    }
    if (msg.t === 'hello') {
      this.hello(msg, from);
      return;
    }
    const member = this.memberOf(from);
    if (!member) {
      this.view.reject(); // must say hello first
      return;
    }
    if (msg.t === 'add') this.peerAdd(member, msg.strategy, from);
    else if (msg.t === 'remove' && this.pool.remove(msg.entry, member.id, false)) this.touch(true);
  }

  /** Token bucket per peer: a flood is dropped, not processed. */
  private allow(peer: string): boolean {
    const now = this.now();
    const b = this.buckets.get(peer) ?? { tokens: RATE_BURST, at: now };
    b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.at) / 1000) * RATE_PER_SECOND);
    b.at = now;
    this.buckets.set(peer, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private memberOf(peer: string): Member | null {
    for (const m of this.members.values()) if (m.peer === peer && !m.host) return m;
    return null;
  }

  private hello(msg: Extract<PeerMessage, { t: 'hello' }>, from: string): void {
    if (msg.v !== PROTOCOL_VERSION) {
      this.t.send({ t: 'refused', reason: `The host runs another version of the game (room protocol ${PROTOCOL_VERSION}, yours ${msg.v}). Both of you reload the page.` }, from);
      return;
    }
    let m = [...this.members.values()].find((x) => x.client === msg.client) ?? null;
    if (m?.host) {
      this.t.send({ t: 'refused', reason: 'That is the host of this room in another tab.' }, from);
      return;
    }
    if (!m) {
      const online = [...this.members.values()].filter((x) => x.host || x.peer !== null).length;
      if (online >= MAX_MEMBERS) {
        this.t.send({ t: 'refused', reason: `The room is full (${MAX_MEMBERS} people).` }, from);
        return;
      }
      m = { id: `m${this.nextMember++}`, name: msg.name, client: msg.client, peer: null, host: false };
      this.members.set(m.id, m);
    }
    // One member per peer: a peer that said hello as someone else before is that someone no more.
    for (const other of this.members.values()) if (other !== m && other.peer === from && !other.host) other.peer = null;
    m.peer = from;
    m.name = this.uniqueName(msg.name, m.id);
    this.pool.renameOwner(m.id, m.name);
    this.t.send({ t: 'you', v: PROTOCOL_VERSION, member: m.id }, from);
    this.t.send({ t: 'state', state: this.publicState() }, from);
    if (this.running) this.t.send({ t: 'match', info: this.running.info }, from);
    this.touch(true);
  }

  private peerAdd(member: Member, text: string, from: string): void {
    const r = loadStrategy(text, 'network');
    if (!r.strategy) {
      this.t.send({ t: 'added', ok: false, line: `The host's gate refused it: ${firstError(r.errors)}` }, from);
      return;
    }
    const out = this.pool.add(r.strategy, member.id, member.name);
    this.t.send({ t: 'added', ok: out.ok, line: out.line }, from);
    if (out.ok && out.fresh) {
      this.view.say(`${member.name} added ${r.strategy.name} v${r.strategy.version ?? 1}.`, 'good');
      this.touch(true);
    }
  }

  private peerLeft(peer: string): void {
    this.buckets.delete(peer);
    const m = this.memberOf(peer);
    if (m) {
      m.peer = null;
      this.touch(false);
    } else this.view.changed();
  }

  private uniqueName(name: string, memberId: string): string {
    const taken = new Set([...this.members.values()].filter((m) => m.id !== memberId).map((m) => m.name));
    if (!taken.has(name)) return name;
    for (let i = 2; i < 100; i++) if (!taken.has(`${name} ${i}`)) return `${name} ${i}`;
    return `${name} ${memberId}`;
  }

  // -------------------------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------------------------

  private publicState(): RoomState {
    const r = this.running;
    return {
      code: this.code,
      members: [...this.members.values()].map((m) => ({ id: m.id, name: m.name, online: m.host || m.peer !== null, host: m.host })),
      entries: this.pool.info(),
      board: this.board.rows(),
      settings: { ...this.settings },
      history: this.history.map((h) => ({ ...h })),
      match: r ? { id: r.info.id, mapId: r.info.mapId, fighters: r.info.fighters.length } : null,
    };
  }

  private buildView(): RoomView {
    return {
      role: 'host',
      code: this.code,
      status: this.closed ? 'closed' : 'hosting',
      me: 'm0',
      room: this.publicState(),
      notices: this.view.notices,
      rejected: this.view.rejected,
      peers: this.closed ? 0 : this.t.peers().length,
      waiting: this.waiting,
    };
  }

  /** Something public changed: broadcast soon, refresh the view, and keep the room when asked. */
  private touch(persist: boolean): void {
    this.dirty = true;
    if (persist) this.save();
    this.view.changed();
  }

  private save(): void {
    if (!this.storage) return;
    const saved: SavedRoom = {
      v: 1,
      savedAt: Date.now(),
      settings: this.settings,
      members: [...this.members.values()].filter((m) => !m.host).map((m) => ({ id: m.id, name: m.name, client: m.client })),
      entries: this.pool.entries.map((e) => ({ id: e.id, member: e.member, owner: e.owner, code: encodeStrategyCode(e.strategy), matches: e.matches })),
      nextEntry: this.pool.nextEntryId,
      nextMember: this.nextMember,
      board: this.board.toJSON(),
      history: this.history,
      matchCount: this.matchCount,
      mapTurn: this.mapTurn,
    };
    try {
      this.storage.setItem(hostStorageKey(this.code), JSON.stringify(saved));
    } catch {
      // Storage full or blocked: the room just will not survive a reload.
    }
  }

  /** Reopen a room this browser hosted before. Stored strategies pass the gate again. */
  private restore(): void {
    let raw: Partial<SavedRoom> | null = null;
    try {
      const text = this.storage?.getItem(hostStorageKey(this.code));
      raw = text ? (JSON.parse(text) as Partial<SavedRoom>) : null;
    } catch {
      raw = null;
    }
    if (!raw || raw.v !== 1) return;
    if (raw.settings) this.settings = sanitizeSettings(this.settings, raw.settings);
    for (const m of Array.isArray(raw.members) ? raw.members : []) {
      if (typeof m?.id === 'string' && /^m\d+$/.test(m.id) && m.id !== 'm0' && typeof m.name === 'string' && typeof m.client === 'string') {
        this.members.set(m.id, { id: m.id, name: m.name, client: m.client, peer: null, host: false });
      }
    }
    const entries: PoolEntry[] = [];
    for (const e of Array.isArray(raw.entries) ? raw.entries : []) {
      if (typeof e?.id !== 'string' || typeof e.code !== 'string') continue;
      const r = loadStrategy(e.code, 'saved');
      if (!r.strategy) continue;
      entries.push({
        id: e.id, member: typeof e.member === 'string' ? e.member : null, owner: typeof e.owner === 'string' ? e.owner : null, strategy: r.strategy,
        key: entryKey(r.strategy), matches: Number.isInteger(e.matches) ? e.matches : 0,
      });
    }
    this.pool.restore(entries, Number.isInteger(raw.nextEntry) ? raw.nextEntry! : 1);
    this.board = RoomBoard.fromJSON(raw.board);
    this.history = checkHistory(raw.history);
    this.matchCount = Number.isInteger(raw.matchCount) ? raw.matchCount! : 0;
    this.mapTurn = Number.isInteger(raw.mapTurn) ? raw.mapTurn! : 0;
    const ids = [...this.members.keys()].map((k) => Number(k.slice(1)));
    this.nextMember = Math.max(Number.isInteger(raw.nextMember) ? raw.nextMember! : 1, ...ids.map((x) => x + 1));
    const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
    this.view.say(`Reopened room ${this.code}: ${n(entries.length, 'strategy', 'strategies')} in the pool, ${n(this.board.size, 'row', 'rows')} on the board.`);
  }
}

/** Settings with a patch applied, every field kept in range (unknown map ids are ignored). */
export function sanitizeSettings(base: RoomSettings, patch: Partial<RoomSettings>): RoomSettings {
  const s = { ...base };
  if (typeof patch.fighters === 'number' && Number.isFinite(patch.fighters)) s.fighters = clamp(Math.round(patch.fighters), MIN_FIGHTERS, MAX_FIGHTERS);
  if (typeof patch.mapId === 'string' && (patch.mapId === 'rotate' || Object.hasOwn(MAPS, patch.mapId))) s.mapId = patch.mapId;
  if (typeof patch.fillWithHouse === 'boolean') s.fillWithHouse = patch.fillWithHouse;
  if (typeof patch.running === 'boolean') s.running = patch.running;
  return s;
}

function firstError(errors: readonly { path: string; message: string }[]): string {
  const e = errors[0];
  return e ? `${e.path ? `${e.path}: ` : ''}${e.message}` : 'invalid strategy.';
}
