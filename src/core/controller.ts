/**
 * What the React UI talks to. The integrator implements `GameController` in `src/app`; the ui
 * builder codes against this interface (and a mock of it) without touching the game loop.
 *
 * React never runs in the per-frame path: the controller owns the loop and notifies subscribers
 * at about 10 Hz. `getSnapshot()` returns the same object between notifications (safe for
 * `useSyncExternalStore`).
 */

import type { MapObjectKind, ViewInsets, ViewSettings } from './render-api';
import type { AggregateReport, EvolveGeneration, EvolveRequest, EvolveResult, LeaderboardEntry, MatchReport } from './report-types';
import type { Decision, FighterState, KnownFighter, MatchConfig, MatchEnding, MatchFormat, Strategy } from './types';

/**
 * Where the Watch screen is in the life of the app and the current match:
 *
 * - `loading`: the splash shows real progress (`UiSnapshot.loading`); no match is visible yet.
 * - `splash`: everything is loaded; the splash waits for "Enter the pit" (`GameController.enter`).
 *   Without WebGPU (`arenaError`, or no adapter) the splash shows the message instead of the button.
 * - `countdown`: "3, 2, 1" (`UiSnapshot.countdown`); the sim holds at tick 0. Every new match,
 *   restart and gym match opened in the arena starts here once the splash has been entered.
 * - `live`: the match runs (paused, stepping, seeking and replaying included). FIGHT! shows during
 *   its first moment (`countdown` 0).
 * - `final`: the match is decided: the final kill in ultra slow motion with the WINNER stamp (or the
 *   judges' decision). The end card is not shown yet. Lasts about 3 s; `skip()` ends it.
 * - `ended`: the end card is up (`finished` is true).
 *
 * Seeking back into a decided match returns to `live`; reaching the end again goes straight to
 * `ended` (the moment was already admired).
 */
export type MatchPhase = 'loading' | 'splash' | 'countdown' | 'live' | 'final' | 'ended';

/**
 * Real loading stages, in order: the JS bundle loaded, a WebGPU adapter found, the renderer
 * initialised, shaders warmed up, the sound module ready (its AudioContext still waits for "Enter
 * the pit"), the first match built.
 */
export type LoadingStageId = 'bundle' | 'webgpu' | 'renderer' | 'shaders' | 'audio' | 'match';

/** One row of the splash's progress: `label` is plain and short ("Warming up shaders"). */
export type LoadingStage = { id: LoadingStageId; label: string; done: boolean };

/** Every loading stage in order with its label; controllers build `UiSnapshot.loading` from this. */
export const LOADING_STAGES: readonly { readonly id: LoadingStageId; readonly label: string }[] = [
  { id: 'bundle', label: 'Loading the game' },
  { id: 'webgpu', label: 'Checking for WebGPU' },
  { id: 'renderer', label: 'Starting the renderer' },
  { id: 'shaders', label: 'Warming up shaders' },
  { id: 'audio', label: 'Tuning the crowd' },
  { id: 'match', label: 'Setting up the match' },
];

/**
 * A gym job running in the background, for the top-bar chip on every screen. Clicking the chip
 * returns to the Gym's Test (`batch`) or Evolve (`evolve`) tab. `done` of `total` drive the progress
 * ring (matches for a batch, generations for an evolution). Gone from the list when it finishes,
 * fails or is cancelled.
 */
export type BackgroundJob = {
  id: number;
  kind: 'batch' | 'evolve';
  /** Chip text, e.g. "Evolving: gen 4 of 20", "Testing: 37 of 100 matches". */
  label: string;
  done: number;
  total: number;
};

/**
 * Hover-card data for a map object, built from the rules and the live state.
 * `name`: "Shrine", "Haste charm", "Powder keg", "Saw blade", "Acid pool", ...
 * `description`: what it does, one or two plain sentences with the real numbers ("Heals 42% of max
 * HP on touch, then recharges for 5.3 s.").
 * `state`: the live state in a few words ("Ready", "Recharging, 3.2 s", "Back in 7.5 s",
 * "Thrusts in 0.8 s", "18 of 32 HP", "Dries up in 4.1 s"), or null when it has none.
 */
export type ObjectInfo = { kind: MapObjectKind; id: string; name: string; description: string; state: string | null };

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
  /** Where the Watch screen is: splash, countdown, live match, final moment, end card. See MatchPhase. */
  phase: MatchPhase;
  /**
   * The countdown beat to show: 3, 2, 1 during `countdown`; 0 for "FIGHT!" during the first moment
   * of `live` (about 0.6 s); null otherwise.
   */
  countdown: number | null;
  /** Loading stages for the splash, always in `LoadingStageId` order. All done once past `loading`. */
  loading: LoadingStage[];
  /** Gym jobs running in the background (a batch or an evolution), for the top-bar chip. */
  jobs: BackgroundJob[];
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
  /** Fighter under the pointer (arena: living only) or hovered in the scoreboard, feed or end card. */
  hoveredId: string | null;
  /** Map object under the pointer in the arena (shrine, pedestal, hazard, prop), or null. See `objectInfo`. */
  hoveredObject: { kind: MapObjectKind; id: string } | null;
  /** Refinement: fighter the camera follows, or null. */
  followId: string | null;
  /** The viewer zoomed or panned the arena: the director is paused until `resetCamera()` (button, key C). */
  cameraManual: boolean;
  /** Current display settings (same value as `GameController.getView()`). */
  view: ViewSettings;
  finished: boolean;
  placements: string[];
  /**
   * How the match ended (`WorldState.ending`), null while it runs. The final moment's stamp reads
   * it: WINNER for an elimination, the judges' decision for a judged ending.
   */
  ending: MatchEnding | null;
  /**
   * Where the match on screen comes from: `local` (simulated here; pause, speed, seek and replay
   * work) or `room` (a room's stream, watched live: playback controls do nothing).
   */
  source: 'local' | 'room';
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
  /**
   * "Enter the pit" (button, Enter or Space on the splash). Call it synchronously inside that user
   * gesture: it starts audio (browsers refuse sound otherwise), leaves the splash and starts the
   * current match's countdown. Safe to call again (no-op after the first time).
   */
  enter(): void;
  /**
   * Skip the current beat: during `countdown` the fight starts now; during `final` the end card
   * shows now (Space or a click). No-op in other phases.
   */
  skip(): void;
  /** Starts with a countdown once the splash has been entered (see MatchPhase). */
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
  /**
   * Hover-card data for a map object of the current match (live state included), or null when
   * there is no such object (a broken prop, dried acid, no match). Poll it while the card is open.
   */
  objectInfo(kind: MapObjectKind, id: string): ObjectInfo | null;
  /**
   * Which parts of the arena the UI's panels cover (CSS px from each canvas edge; inspector,
   * timeline, ...). Forwarded to the renderer so the camera frames the action in the visible part.
   * Report again whenever a panel opens, closes or resizes.
   */
  setViewInsets(insets: ViewInsets): void;
  /** Refinement: battle report of the current match once it has finished, else null. */
  lastReport(): MatchReport | null;
  /** Put the arena canvas inside `el`. Refinement: returns an unmount function (React effect cleanup). */
  mountCanvas(el: HTMLElement): () => void;
  strategies: StrategyStore;
  gym: GymApi;
}

/**
 * Where a saved version came from; separate from its version number (SPEC "Versions and the
 * library"). `editor`: saved from the gym's editor. `import`: an imported file, paste or code.
 * `evolution`: an evolution result, with the generation it came from. `room`: taken from a room.
 */
export type SavedOrigin = { kind: 'editor' } | { kind: 'import' } | { kind: 'evolution'; generation: number } | { kind: 'room' };

/** Local strategy library with versions (persisted by the integrator). */
export interface StrategyStore {
  list(): SavedStrategy[];
  /**
   * Saves as the next version of `s.name` and returns the stored entry. Version numbers belong to
   * the library: per name, monotonic, assigned here; the JSON's own `version` is overwritten, never
   * trusted. `meta.parentId` is the saved version it was edited or evolved from (`SavedStrategy.id`),
   * `meta.origin` where it came from; both default to null.
   */
  save(s: Strategy, meta?: { parentId?: string | null; origin?: SavedOrigin | null }): SavedStrategy;
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
  /** Id of the version this one was edited or evolved from; null for a new strategy or when not recorded (older saves). */
  parentId: string | null;
  /** Where this version came from; null when not recorded (older saves). */
  origin: SavedOrigin | null;
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
