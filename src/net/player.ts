// Owned by: net
/**
 * Plays a streamed match (`StreamPlayer`): frames arrive about 20 times a second, a little ahead of
 * when they are shown (a short jitter buffer), and every animation frame the arena asks for the two
 * states around "now", the interpolation alpha, the events that became due, the match signals
 * (countdown, FIGHT, final kill) and the host's time scale (its slow motion). The same player serves
 * peers (frames from the network) and the host's own view (frames looped back through the codec).
 *
 * Feed lines and timeline marks are built from the events with the sim's own copy (`killLine`,
 * `announcements`), so a streamed match reads like a local one.
 */

import { LIVE_EVENT_TICKS, PICKUP_RULES } from '../core';
import type { FeedItem, GameEvent, Limb, MapDef, MatchSignal, TimelineMark, UiFighter, WorldState } from '../core';
import { announcements, killLine } from '../sim';
import type { DecodedFrame, StreamMatchInfo } from './snapshot';

/** What the arena draws this animation frame. */
export type StreamOutput = {
  prev: WorldState;
  curr: WorldState;
  /** 0..1 from `prev` to `curr`. */
  alpha: number;
  /** Events that became due, in order, with `curr` as their state. After a reset: the match so far first (catch-up). */
  events: GameEvent[];
  /** Match-flow beats that happened since the last call (real time; never for catch-up). */
  signals: MatchSignal[];
  /** The host's game-time factor (its slow motion; 0 in hit-stop). */
  timeScale: number;
  /** A new match, or the arena was (re)attached: call `setMap(map)` and `reset()` before the events. */
  reset: boolean;
};

/** The streamed match as the HUD needs it (same fields as `UiSnapshot` where they overlap). */
export type StreamView = {
  matchId: number;
  mapId: string;
  seed: number;
  format: StreamMatchInfo['format'];
  timeLimitTicks: number;
  tick: number;
  suddenDeath: boolean;
  fighters: UiFighter[];
  feed: FeedItem[];
  marks: TimelineMark[];
  finished: boolean;
  placements: string[];
  /** 3, 2, 1 before the fight, 0 for FIGHT! (about 0.6 s), else null. */
  countdown: number | null;
  /** Room member who brought each fighter's strategy (fighter id -> name; null = house stack). */
  owners: Readonly<Record<string, string | null>>;
};

export const PLAYER_TIMING = {
  /** How far behind the newest frame playback runs, to ride out network jitter. */
  delayMs: 150,
  /** Most extra delay added when frames keep arriving late. */
  maxExtraDelayMs: 450,
  /** Extra delay given back per frame that arrives with headroom (2 ms per 50 ms frame: 4% faster). */
  catchUpMsPerFrame: 2,
  /** Frames kept; older ones (a hidden tab stops drawing) hand their events to the next call. */
  maxFrames: 120,
  /** FIGHT! shows this long after the countdown. */
  fightFlashMs: 600,
  /** Events kept for a catch-up repaint when the arena attaches mid-match. */
  maxLog: 8000,
} as const;

/** A hit at least this big gets a timeline mark (same threshold as the local match session). */
const BIG_HIT_DAMAGE = 45;

const LIMB_WORD: Readonly<Record<Limb, string>> = { armR: 'weapon arm', armL: 'left arm', legL: 'leg', legR: 'leg' };

type Slot = DecodedFrame & { seq: number };

export class StreamPlayer {
  private _info: StreamMatchInfo | null = null;
  private _map: MapDef | null = null;
  private frames: Slot[] = [];
  private seq = 0;
  private deliveredSeq = -1;
  /** local ms - host ms, fixed per match once the first frame arrives. */
  private offset = 0;
  private extraDelay = 0;
  private synced = false;
  private missed: GameEvent[] = [];
  private log: GameEvent[] = [];
  private needsReset = true;
  private lastBeat: number | null = null;
  private fought = false;
  private shown: WorldState | null = null;
  private lastCursor = 0;
  private owners: Record<string, string | null> = {};
  readonly feed: FeedItem[] = [];
  readonly marks: TimelineMark[] = [];
  private listeners = new Set<() => void>();
  private view_: StreamView | null = null;
  /** Frames and events refused by the codec (shown in the room's diagnostics). */
  dropped = 0;

  get info(): StreamMatchInfo | null {
    return this._info;
  }

  get map(): MapDef | null {
    return this._map;
  }

  /** How far behind the host playback runs right now (ms): the buffer plus what late frames added. */
  get lagMs(): number {
    return Math.round(PLAYER_TIMING.delayMs + this.extraDelay);
  }

  /** Newest state received (no interpolation), for previews such as the room's radar. */
  get latest(): WorldState | null {
    return this.frames.at(-1)?.state ?? this.shown;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** A new match: everything from the previous one is dropped. */
  begin(info: StreamMatchInfo, map: MapDef): void {
    this._info = info;
    this._map = map;
    this.frames = [];
    this.deliveredSeq = this.seq - 1;
    this.synced = false;
    this.extraDelay = 0;
    this.missed = [];
    this.log = [];
    this.needsReset = true;
    this.lastBeat = null;
    this.fought = false;
    this.shown = null;
    this.owners = Object.fromEntries(info.fighters.map((f) => [f.id, f.owner]));
    this.feed.length = 0;
    this.marks.length = 0;
    this.feed.push({ tick: 0, text: openingLine(info, map), kind: 'info', ids: [] });
    this.view_ = null;
    this.emit();
  }

  /** No match any more (the host left): previews and the arena get nothing until the next `begin`. */
  clear(): void {
    this._info = null;
    this._map = null;
    this.frames = [];
    this.missed = [];
    this.log = [];
    this.shown = null;
    this.view_ = null;
    this.feed.length = 0;
    this.marks.length = 0;
    this.emit();
  }

  /** The arena (re)attached: the next `advance` resets it and repaints the match so far. */
  requestReset(): void {
    this.needsReset = true;
  }

  /** Add a checked frame of the current match (others are ignored). */
  push(frame: DecodedFrame, nowMs: number): void {
    if (!this._info || frame.matchId !== this._info.id) return;
    const last = this.frames.at(-1);
    if (last && frame.ms <= last.ms) return; // late duplicate or out of order: the newer state already arrived
    this.dropped += frame.droppedEvents;
    const slot: Slot = { ...frame, seq: this.seq++ };
    if (!this.synced) {
      this.offset = nowMs - frame.ms;
      this.synced = true;
    } else {
      // Arrived after it should have been shown: play further behind from now on, far enough that
      // frames on this slower route again arrive a full buffer ahead of their turn.
      const late = nowMs - (frame.ms + this.offset + PLAYER_TIMING.delayMs + this.extraDelay);
      if (late > 0) this.extraDelay = Math.min(PLAYER_TIMING.maxExtraDelayMs, this.extraDelay + late + PLAYER_TIMING.delayMs);
      // Arrived with more than a full buffer to spare: creep back toward live (a few percent faster
      // playback, too little to see), so one bad spike does not leave everyone behind for good.
      else if (-late > PLAYER_TIMING.delayMs) this.extraDelay = Math.max(0, this.extraDelay - PLAYER_TIMING.catchUpMsPerFrame);
    }
    this.frames.push(slot);
    this.chronicle(slot);
    while (this.frames.length > PLAYER_TIMING.maxFrames) {
      const old = this.frames.shift()!;
      if (old.seq > this.deliveredSeq) {
        for (const e of old.events) this.missed.push(e);
        this.deliveredSeq = old.seq;
      }
    }
    const finished = frame.state.finished && !last?.state.finished;
    if (finished) this.emit();
  }

  /** Host stream time being shown at local time `nowMs`. */
  private cursor(nowMs: number): number {
    return nowMs - this.offset - PLAYER_TIMING.delayMs - this.extraDelay;
  }

  /** The two frames around the cursor: `a` at or before it, `b` after it (null when holding). */
  private around(h: number): { a: Slot; b: Slot | null } | null {
    const fs = this.frames;
    if (fs.length === 0) return null;
    let bi = fs.findIndex((f) => f.ms > h);
    if (bi === 0) return { a: fs[0]!, b: null }; // before the first frame: hold it
    if (bi < 0) bi = fs.length;
    return { a: fs[bi - 1]!, b: fs[bi] ?? null };
  }

  /** What to draw at `nowMs`, without taking any events (for previews). */
  sample(nowMs: number): { prev: WorldState; curr: WorldState; alpha: number } | null {
    const at = this.around(this.cursor(nowMs));
    if (!at) return null;
    const { a, b } = at;
    if (!b) return { prev: a.state, curr: a.state, alpha: 1 };
    return { prev: a.state, curr: b.state, alpha: clamp01((this.cursor(nowMs) - a.ms) / (b.ms - a.ms)) };
  }

  /** What the arena draws at `nowMs` (monotonic ms), or null before the first frame of a match. */
  advance(nowMs: number): StreamOutput | null {
    if (!this._info) return null;
    const h = this.cursor(nowMs);
    const at = this.around(h);
    if (!at) return null;
    const { a, b } = at;
    const target = b ?? a;

    const fresh: GameEvent[] = this.missed;
    this.missed = [];
    for (const f of this.frames) {
      if (f.seq > target.seq) break;
      if (f.seq <= this.deliveredSeq) continue;
      for (const e of f.events) fresh.push(e);
    }
    this.deliveredSeq = Math.max(this.deliveredSeq, target.seq);
    // Frames before `a` are spent.
    const ai = this.frames.indexOf(a);
    if (ai > 0) this.frames.splice(0, ai);

    const reset = this.needsReset;
    this.needsReset = false;
    const events = reset ? [...this.log, ...fresh] : fresh;
    for (const e of fresh) this.log.push(e);
    if (this.log.length > PLAYER_TIMING.maxLog) this.log.splice(0, this.log.length - PLAYER_TIMING.maxLog);

    const signals = this.beats(h, fresh, target.state);
    const alpha = b ? clamp01((h - a.ms) / (b.ms - a.ms)) : 1;
    const timeScale = b ? a.scale + (b.scale - a.scale) * alpha : a.scale;
    const ticked = !this.shown || this.shown.tick !== target.state.tick;
    this.shown = target.state;
    this.lastCursor = h;
    if (ticked || signals.length > 0) this.view_ = null;
    return { prev: a.state, curr: target.state, alpha, events, signals, timeScale, reset };
  }

  /** Countdown, FIGHT and the final kill, each once, when they happen in real time. */
  private beats(h: number, fresh: readonly GameEvent[], state: WorldState): MatchSignal[] {
    const info = this._info!;
    const out: MatchSignal[] = [];
    const remaining = info.fightAt - h;
    if (remaining > 0) {
      const beat = Math.min(3, Math.ceil(remaining / 1000));
      if (beat !== this.lastBeat) out.push({ type: 'countdown', value: beat });
      this.lastBeat = beat;
    } else if (!this.fought) {
      this.fought = true;
      // Joined long after the start: no FIGHT for a fight already under way.
      if (-remaining < PLAYER_TIMING.fightFlashMs * 2) out.push({ type: 'fight' });
    }
    for (const e of fresh) {
      if (e.type === 'kill' && e.final && e.tick >= state.tick - LIVE_EVENT_TICKS) {
        out.push({ type: 'final_kill', killerId: e.killerId, victimId: e.victimId, pos: { ...e.pos } });
      }
    }
    return out;
  }

  /** 3, 2, 1 before the fight, 0 for FIGHT!, else null (at the last `advance`). */
  countdown(): number | null {
    if (!this._info || !this.synced) return null;
    return beatOf(this._info.fightAt - this.lastCursor);
  }

  /** The countdown beat at local time `nowMs`, without taking anything (previews). */
  countdownAt(nowMs: number): number | null {
    if (!this._info || !this.synced) return null;
    return beatOf(this._info.fightAt - this.cursor(nowMs));
  }

  /** The match as last shown by `advance` (null before the first frame). Same object until it changes. */
  view(): StreamView | null {
    const info = this._info;
    const s = this.shown;
    if (!info || !s) return null;
    if (this.view_ && this.view_.tick === s.tick) return this.view_;
    this.view_ = {
      matchId: info.id,
      mapId: info.mapId,
      seed: info.seed,
      format: info.format,
      timeLimitTicks: info.timeLimitTicks,
      tick: s.tick,
      suddenDeath: s.suddenDeath.active,
      fighters: s.fighters.map((f) => ({
        id: f.id, name: f.name, color: f.color, hp: f.hp, maxHp: f.maxHp, alive: f.alive, kills: f.kills, weapon: f.weapon, skill: f.skill,
        behaviour: f.behaviour, place: f.place, squad: f.squad,
      })),
      feed: this.feed.filter((f) => f.tick <= s.tick),
      marks: this.marks.filter((m) => m.tick <= s.tick),
      finished: s.finished,
      placements: s.placements.slice(),
      countdown: this.countdown(),
      owners: this.owners,
    };
    return this.view_;
  }

  /** Live state of one fighter as last shown (read-only). */
  fighter(id: string): WorldState['fighters'][number] | null {
    return this.shown?.fighters.find((f) => f.id === id) ?? null;
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Feed lines and timeline marks for one frame's events (the UI shows those up to the shown tick). */
  private chronicle(f: DecodedFrame): void {
    const state = f.state;
    const name = (fid: string | null) => state.fighters.find((x) => x.id === fid)?.name ?? '';
    const behaviour = (fid: string | null) => state.fighters.find((x) => x.id === fid)?.behaviour || null;
    const said = announcements(f.events, state);
    for (const line of said) this.feed.push(line);
    for (const e of f.events) {
      switch (e.type) {
        case 'kill': {
          const text = killLine(e, state);
          this.feed.push({ tick: e.tick, text, kind: 'kill', ids: e.killerId ? [e.killerId, e.victimId] : [e.victimId] });
          this.marks.push({ tick: e.tick, kind: 'kill', actorId: e.killerId, targetId: e.victimId, text, actorBehaviour: e.killerBehaviour, targetBehaviour: e.victimBehaviour });
          break;
        }
        case 'dismember': {
          const what = LIMB_WORD[e.limb];
          const text = e.attackerId ? `${name(e.attackerId)} took ${name(e.victimId)}'s ${what}.` : `${name(e.victimId)} lost the ${what}.`;
          this.feed.push({ tick: e.tick, text, kind: 'dismember', ids: e.attackerId ? [e.attackerId, e.victimId] : [e.victimId] });
          this.marks.push({ tick: e.tick, kind: 'dismember', actorId: e.attackerId, targetId: e.victimId, text, actorBehaviour: behaviour(e.attackerId), targetBehaviour: behaviour(e.victimId) });
          break;
        }
        case 'hit':
          if (e.attackerId && e.amount >= BIG_HIT_DAMAGE) {
            const text = `${name(e.attackerId)} hit ${name(e.victimId)} for ${Math.round(e.amount)}.`;
            this.marks.push({ tick: e.tick, kind: 'big_hit', actorId: e.attackerId, targetId: e.victimId, text, actorBehaviour: behaviour(e.attackerId), targetBehaviour: behaviour(e.victimId) });
          }
          break;
        case 'pickup': {
          if (e.kind !== 'haste' && e.kind !== 'berserk') break;
          const text = `${name(e.fighterId)} took the ${PICKUP_RULES[e.kind].name.toLowerCase()}.`;
          this.feed.push({ tick: e.tick, text, kind: 'pickup', ids: [e.fighterId] });
          this.marks.push({ tick: e.tick, kind: 'pickup', actorId: e.fighterId, targetId: null, text, actorBehaviour: behaviour(e.fighterId), targetBehaviour: null });
          break;
        }
        case 'sudden_death': {
          const text = said.find((l) => l.kind === 'sudden_death')?.text ?? 'The walls are closing.';
          this.marks.push({ tick: e.tick, kind: 'sudden_death', actorId: null, targetId: null, text, actorBehaviour: null, targetBehaviour: null });
          break;
        }
        case 'match_end': {
          const winner = state.fighters.find((x) => x.id === e.placements[0]);
          const owner = winner ? this.owners[winner.id] : null;
          const kills = winner ? (winner.kills === 1 ? 'with 1 kill' : winner.kills === 0 ? 'without a single kill' : `with ${winner.kills} kills`) : '';
          const where = this._map ? this._map.name.replace(/^The /, 'the ') : 'the arena';
          const text = winner ? `${winner.name}${owner ? ` (${owner}'s)` : ''} takes ${where} ${kills}.` : `Nobody leaves ${where}.`;
          this.feed.push({ tick: e.tick, text, kind: 'info', ids: winner ? [winner.id] : [] });
          break;
        }
        default:
          break;
      }
    }
  }
}

/** Countdown beat for `remaining` ms until the fight: 3, 2, 1, then 0 while FIGHT! shows, then null. */
function beatOf(remaining: number): number | null {
  if (remaining > 0) return Math.min(3, Math.ceil(remaining / 1000));
  return -remaining < PLAYER_TIMING.fightFlashMs ? 0 : null;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 1;
}

function openingLine(info: StreamMatchInfo, map: MapDef): string {
  const where = map.name.replace(/^The /, 'the ');
  const brought = info.fighters.filter((f) => f.owner !== null).length;
  const house = info.fighters.length - brought;
  if (brought === 0) return `${info.fighters.length} house fighters warm up ${where}.`;
  return `${info.fighters.length} fighters in ${where}: ${brought} from the room${house > 0 ? `, ${house} from the house` : ''}.`;
}
