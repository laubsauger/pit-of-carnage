/**
 * What the React UI talks to. The integrator implements `GameController` in `src/app`; the ui
 * builder codes against this interface (and a mock of it) without touching the game loop.
 *
 * React never runs in the per-frame path: the controller owns the loop and notifies subscribers
 * at about 10 Hz. `getSnapshot()` returns the same object between notifications (safe for
 * `useSyncExternalStore`).
 */

import type { ViewSettings } from './render-api';
import type { AggregateReport, EvolveGeneration, EvolveRequest, EvolveResult, LeaderboardEntry, MatchReport } from './report-types';
import type { Decision, FighterState, KnownFighter, MatchConfig, MatchFormat, Strategy } from './types';

export type UiFighter = Pick<
  FighterState,
  'id' | 'name' | 'color' | 'hp' | 'maxHp' | 'alive' | 'kills' | 'weapon' | 'skill' | 'behaviour' | 'place' | 'squad'
>;

export type FeedItem = {
  tick: number;
  /** Broadcast-style line, e.g. "Gary opened Brenda like a letter." */
  text: string;
  /** Event kind for styling: 'kill', 'dismember', 'skill', 'sudden_death', 'info', ... */
  kind: string;
  /** Fighter ids mentioned (for colour and hover). */
  ids: string[];
};

/** Event type of a timeline mark; the timeline draws each as its own shape. */
export type TimelineMarkKind = 'kill' | 'big_hit' | 'dismember' | 'pickup' | 'sudden_death';

/**
 * One explorable moment on the timeline. Built by the session from events; the timeline colours a
 * mark by `actorId`'s fighter colour and filters by fighter and kind. A feed line about the same
 * moment has the same `tick` and lists the same ids, so feed entries link to their marks.
 */
export type TimelineMark = {
  tick: number;
  kind: TimelineMarkKind;
  /**
   * Who caused it: the killer, the attacker of a big hit or lost limb, the fighter who took a
   * power-up. Null for hazards, nobody's keg and sudden death (neutral colour).
   */
  actorId: string | null;
  /** Who it happened to (victim), or null (power-ups, sudden death). */
  targetId: string | null;
  /**
   * The tooltip sentence, names as plain text (the UI colours them via the ids), e.g.
   * "Gary backstabbed Brenda, twin daggers, from shadow." No clock: the UI adds the time.
   */
  text: string;
  /** Behaviours running at that moment (actor's and target's), for the tooltip; null when there is no such fighter. */
  actorBehaviour: string | null;
  targetBehaviour: string | null;
};

export type UiSnapshot = {
  tick: number;
  /** Playback speed multiplier (1 = real time). */
  speed: number;
  paused: boolean;
  mapId: string;
  format: MatchFormat;
  /** Refinement: seed of the current match (shown in setup, needed to reproduce a match). */
  seed: number;
  /** Refinement: ticks before sudden death, for the match clock. */
  timeLimitTicks: number;
  /** Refinement: sudden death is running. */
  suddenDeath: boolean;
  /** Refinement: highest tick simulated so far; the timeline scrubber spans 0..maxTick. */
  maxTick: number;
  fighters: UiFighter[];
  feed: FeedItem[];
  marks: TimelineMark[];
  selectedId: string | null;
  hoveredId: string | null;
  /** Refinement: fighter the camera follows, or null. */
  followId: string | null;
  /** The viewer zoomed or panned the arena: the director is paused until `resetCamera()` (button, key C). */
  cameraManual: boolean;
  /** Current display settings (same value as `GameController.getView()`). */
  view: ViewSettings;
  finished: boolean;
  placements: string[];
  /**
   * Refinement: why the arena could not be shown (for example the WebGPU device failed to start
   * after an adapter was found), or null. The Watch screen shows it instead of a blank arena.
   */
  arenaError: string | null;
};

export interface GameController {
  getSnapshot(): UiSnapshot;
  /** Notifies about 10 Hz while anything changes. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void;
  startMatch(config: MatchConfig): void;
  /** Replay the current config with the same seed. */
  restart(): void;
  setPaused(p: boolean): void;
  /** Advance n ticks while paused (arrow keys). */
  stepTicks(n: number): void;
  setSpeed(s: number): void;
  /** Jump to a tick of the current match (re-simulates deterministically as needed). */
  seek(tick: number): void;
  select(id: string | null): void;
  hover(id: string | null): void;
  /** Refinement: camera follows this fighter (null = director framing). */
  follow(id: string | null): void;
  /** Back to the director's camera after wheel zoom or drag pan: stops following too (button and key C). */
  resetCamera(): void;
  /** Current display settings (loaded from localStorage at startup, DEFAULT_VIEW_SETTINGS otherwise). */
  getView(): ViewSettings;
  /** Change some display settings: merged, persisted, pushed to renderer/fx/audio, then subscribers notified. */
  setView(v: Partial<ViewSettings>): void;
  decision(id: string): Decision | null;
  /** What this fighter knows about its enemies right now (`Match.knowledge`), for the inspector. Read-only; copy what you keep. */
  knowledge(id: string): readonly KnownFighter[];
  /** Refinement: live state of one fighter for the inspector (read-only; copy what you keep). */
  fighter(id: string): FighterState | null;
  /** Refinement: battle report of the current match once it has finished, else null. */
  lastReport(): MatchReport | null;
  /** Put the arena canvas inside `el`. Refinement: returns an unmount function (React effect cleanup). */
  mountCanvas(el: HTMLElement): () => void;
  strategies: StrategyStore;
  gym: GymApi;
}

/** Local strategy library with versions (persisted by the integrator). */
export interface StrategyStore {
  list(): SavedStrategy[];
  /** Saves as the next version of `s.name`; returns the stored entry. */
  save(s: Strategy): SavedStrategy;
  /** All versions of one strategy name, newest first. */
  versions(name: string): SavedStrategy[];
  remove(id: string): void;
}

export type SavedStrategy = {
  id: string;
  name: string;
  version: number;
  /** Epoch milliseconds (UI and persistence only; never read by the sim). */
  savedAt: number;
  strategy: Strategy;
  /** Shareable strategy code (see `encodeStrategyCode`). */
  code: string;
};

/** Headless batch runner. Runs in a Web Worker; one job at a time. */
export interface GymApi {
  runBatch(req: BatchRequest, onProgress?: (done: number, total: number) => void): Promise<BatchResult>;
  /** Refinement: evolve a strategy (see EvolveRequest). `onGeneration` fires after each generation. */
  evolve(req: EvolveRequest, onGeneration?: (gen: EvolveGeneration, done: number, total: number) => void): Promise<EvolveResult>;
  /** Refinement: persistent ratings from every rated batch, best first (Room screen). */
  leaderboard(): LeaderboardEntry[];
  /** Stop the running job; its promise rejects with an Error named 'AbortError'. */
  cancel(): void;
}

/**
 * Each match fills `fighters` slots: every candidate gets one slot, the rest are drawn from
 * `field` with the batch rng. Matches rotate through `mapIds`. Seeds derive from `seed`, so the
 * same request reproduces the same reports.
 */
export type BatchRequest = {
  candidates: Strategy[];
  field: Strategy[];
  mapIds: string[];
  matches: number;
  fighters: number;
  seed: number;
};

export type BatchResult = { reports: MatchReport[]; aggregate: AggregateReport };
