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
 *
 * Beyond the frames: the selected fighter's thinking (`select`, `decision`, `knowledge`, fed by
 * the host's `mind` messages), the gore of a match joined late (`history`), and after the end the
 * battle report as text and, when the host reveals them, the strategies as codes.
 *
 * Whatever the host sends, everything kept here is bounded (frames, events waiting for the arena,
 * the catch-up log, feed lines, timeline marks, minds), so a hostile or broken host cannot grow a
 * guest's memory without limit.
 */

import { LIVE_EVENT_TICKS, PICKUP_RULES, matchWinners } from '../core';
import type {
  Decision, FeedItem, GameEvent, KnownFighter, Limb, MapDef, MatchSignal, MatchStream, StreamOutput, StreamView, TimelineMark, WorldState,
} from '../core';
import { FINAL_SECONDS } from '../app/round';
import { announcements, killLine } from '../sim';
import type { DecodedMind } from './mind';
import type { RevealedStrategy } from './protocol';
import type { DecodedFrame, StreamMatchInfo } from './snapshot';

// What the arena draws and the HUD view of a streamed match are part of the controller contract.
export type { StreamOutput, StreamView } from '../core';

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
  /** Events kept for a catch-up repaint when the arena attaches mid-match (and waiting for an arena). */
  maxLog: 8000,
  /** Feed lines and timeline marks kept per match (oldest go first). */
  maxFeed: 400,
  maxMarks: 600,
  /** Minds of the selected fighter kept (about 2 s at the host's 10 a second). */
  maxMinds: 24,
  /** After a match decided live, the end card shows this long after the final moment began (as in local matches). */
  finalMs: FINAL_SECONDS * 1000,
} as const;

const NO_KNOWLEDGE: readonly KnownFighter[] = Object.freeze([]);

/** A hit at least this big gets a timeline mark (same threshold as the local match session). */
const BIG_HIT_DAMAGE = 45;

const LIMB_WORD: Readonly<Record<Limb, string>> = { armR: 'weapon arm', armL: 'left arm', legL: 'leg', legR: 'leg' };

type Slot = DecodedFrame & { seq: number };

export class StreamPlayer implements MatchStream {
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
  /** Frames pushed for the current match (a gore history is only taken before the first). */
  private framesThisMatch = 0;
  /** A late joiner's gore history, waiting for the first frame to name its fighters in the feed. */
  private historyToChronicle: GameEvent[] | null = null;
  private victorySent = false;
  /** Local ms when the finished state was first shown, or null. */
  private finishedAt: number | null = null;
  private endShown = false;
  /** Signals owed to the arena from outside `advance` (the end card going away for a new match). */
  private owed: MatchSignal[] = [];
  private selectedId: string | null = null;
  private minds: DecodedMind[] = [];
  private report_: string | null = null;
  private revealed_: RevealedStrategy[] | null = null;
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
    this.resetMatchExtras();
    this.feed.length = 0;
    this.marks.length = 0;
    this.feed.push({ tick: 0, text: openingLine(info, map), kind: 'info', ids: [] });
    this.view_ = null;
    this.emit();
  }

  /** Everything tied to one match beyond its frames: selection, minds, history, the end, report. */
  private resetMatchExtras(): void {
    this.framesThisMatch = 0;
    this.historyToChronicle = null;
    if (this.endShown) this.owed.push({ type: 'end_card', shown: false, winnerIds: [] });
    this.endShown = false;
    this.victorySent = false;
    this.finishedAt = null;
    // Fighter ids repeat from match to match: an old selection would pick a stranger.
    this.selectedId = null;
    this.minds = [];
    this.report_ = null;
    this.revealed_ = null;
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
    this.resetMatchExtras();
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
    this.framesThisMatch++;
    if (this.historyToChronicle) {
      this.chronicle(this.historyToChronicle, slot.state);
      this.historyToChronicle = null;
    }
    this.chronicle(slot.events, slot.state);
    while (this.frames.length > PLAYER_TIMING.maxFrames) {
      const old = this.frames.shift()!;
      if (old.seq > this.deliveredSeq) {
        for (const e of old.events) this.missed.push(e);
        this.deliveredSeq = old.seq;
      }
    }
    // Nobody is drawing (no arena, or a hidden tab): what waits for it is capped like the log.
    trimFront(this.missed, PLAYER_TIMING.maxLog);
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
    trimFront(this.log, PLAYER_TIMING.maxLog);

    const signals = this.owed;
    this.owed = [];
    for (const s of this.beats(h, nowMs, fresh, target.state, reset)) signals.push(s);
    const alpha = b ? clamp01((h - a.ms) / (b.ms - a.ms)) : 1;
    const timeScale = b ? a.scale + (b.scale - a.scale) * alpha : a.scale;
    const ticked = !this.shown || this.shown.tick !== target.state.tick;
    this.shown = target.state;
    this.lastCursor = h;
    if (ticked || signals.length > 0) this.view_ = null;
    return { prev: a.state, curr: target.state, alpha, events, signals, timeScale, reset };
  }

  /**
   * Countdown, FIGHT, the final kill and the victory, each once, when they happen in real time;
   * and the end card whenever it comes or goes (again after a reset, which wipes the arena).
   */
  private beats(h: number, nowMs: number, fresh: readonly GameEvent[], state: WorldState, reset: boolean): MatchSignal[] {
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
      if (e.type === 'match_end' && !this.victorySent && e.tick >= state.tick - LIVE_EVENT_TICKS) {
        this.victorySent = true;
        out.push({ type: 'victory', winnerIds: matchWinners(state), ending: e.ending });
      }
    }
    if (state.finished && this.finishedAt === null) this.finishedAt = nowMs;
    // Decided live: the final moment first. Joined on a decided match: the end card at once.
    const shown = this.finishedAt !== null && (!this.victorySent || nowMs - this.finishedAt >= PLAYER_TIMING.finalMs);
    if (shown !== this.endShown || (reset && shown)) {
      this.endShown = shown;
      out.push({ type: 'end_card', shown, winnerIds: shown ? matchWinners(state) : [] });
    }
    return out;
  }

  /** The end card is up for the match on screen (see the `end_card` signal). */
  get endCardShown(): boolean {
    return this.endShown;
  }

  // -------------------------------------------------------------------------------------------
  // The selected fighter's thinking (opt-in: the host sends minds only for a selected fighter)
  // -------------------------------------------------------------------------------------------

  /** The inspector shows `id` (null: nobody). Unknown ids select nobody. */
  select(id: string | null): void {
    const next = id !== null && this._info?.fighters.some((f) => f.id === id) ? id : null;
    if (next === this.selectedId) return;
    this.selectedId = next;
    this.minds = [];
  }

  /** The fighter whose thinking this viewer asks the host for, or null. */
  get selected(): string | null {
    return this.selectedId;
  }

  /** A checked mind from the host; kept only when it is about the selected fighter of this match. */
  pushMind(m: DecodedMind): void {
    if (!this._info || m.matchId !== this._info.id || m.fighterId !== this.selectedId) return;
    const last = this.minds.at(-1);
    if (last && m.ms <= last.ms) return;
    this.minds.push(m);
    trimFront(this.minds, PLAYER_TIMING.maxMinds);
  }

  /** The newest mind at or before what is on screen (minds run on the frames' clock). */
  private mindShown(id: string): DecodedMind | null {
    if (id !== this.selectedId) return null;
    for (let i = this.minds.length - 1; i >= 0; i--) if (this.minds[i]!.ms <= this.lastCursor) return this.minds[i]!;
    return null;
  }

  /** The selected fighter's latest decision as shown, or null (other fighters: always null). */
  decision(id: string): Decision | null {
    return this.mindShown(id)?.decision ?? null;
  }

  /** What the selected fighter knows about the others as shown (other fighters: nothing). */
  knowledge(id: string): readonly KnownFighter[] {
    return this.mindShown(id)?.knowledge ?? NO_KNOWLEDGE;
  }

  // -------------------------------------------------------------------------------------------
  // A late joiner's gore, and what comes after the end
  // -------------------------------------------------------------------------------------------

  /**
   * The gore of the current match before this viewer joined (checked `gore` events, in order).
   * Taken only before the first frame, so nothing is painted twice; returns whether it was taken.
   */
  history(matchId: number, events: readonly GameEvent[]): boolean {
    if (!this._info || matchId !== this._info.id || this.framesThisMatch > 0 || this.historyToChronicle || events.length === 0) return false;
    const kept = events.slice(-PLAYER_TIMING.maxLog);
    this.log = [...kept, ...this.log];
    trimFront(this.log, PLAYER_TIMING.maxLog);
    this.historyToChronicle = kept;
    this.needsReset = true;
    return true;
  }

  /** The battle report of the current match as text (from the host, after the end). */
  setReport(matchId: number, text: string): void {
    if (this._info && matchId === this._info.id) this.report_ = text;
  }

  /** "Copy report" for the match on screen: its battle report as text, or null until the host sends it. */
  reportText(): string | null {
    return this.report_;
  }

  /** The strategies of the current match as codes, when the host reveals them. */
  setRevealed(matchId: number, list: readonly RevealedStrategy[]): void {
    if (!this._info || matchId !== this._info.id) return;
    const ids = new Set(this._info.fighters.map((f) => f.id));
    this.revealed_ = list.filter((r) => ids.has(r.fighterId));
  }

  /** Revealed strategies of the match on screen (fighter id and code), or null when the host keeps them. */
  revealed(): readonly RevealedStrategy[] | null {
    return this.revealed_;
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
  private chronicle(events: readonly GameEvent[], state: WorldState): void {
    const name = (fid: string | null) => state.fighters.find((x) => x.id === fid)?.name ?? '';
    const behaviour = (fid: string | null) => state.fighters.find((x) => x.id === fid)?.behaviour || null;
    const said = announcements(events, state);
    for (const line of said) this.feed.push(line);
    for (const e of events) {
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
    trimFront(this.feed, PLAYER_TIMING.maxFeed);
    trimFront(this.marks, PLAYER_TIMING.maxMarks);
  }
}

/** Drop the oldest entries beyond `max`. */
function trimFront<T>(list: T[], max: number): void {
  if (list.length > max) list.splice(0, list.length - max);
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
