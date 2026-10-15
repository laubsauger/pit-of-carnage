/**
 * What the React UI talks to. The integrator implements `GameController` in `src/app`; the ui
 * builder codes against this interface (and a mock of it) without touching the game loop.
 *
 * React never runs in the per-frame path: the controller owns the loop and notifies subscribers
 * at about 10 Hz. `getSnapshot()` returns the same object between notifications (safe for
 * `useSyncExternalStore`).
 */

import type { OverlayState } from './render-api';
import type { AggregateReport, EvolveGeneration, EvolveRequest, EvolveResult, LeaderboardEntry, MatchReport } from './report-types';
import type { Decision, FighterState, MatchConfig, MatchFormat, Strategy } from './types';

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

export type TimelineMark = { tick: number; kind: 'kill' | 'big_hit' | 'dismember' };

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
  /** Refinement: current overlay toggles. */
  overlay: OverlayState;
  finished: boolean;
  placements: string[];
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
  setOverlay(o: Partial<OverlayState>): void;
  decision(id: string): Decision | null;
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
