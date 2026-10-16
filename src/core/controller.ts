/**
 * What the React UI talks to. The integrator implements `GameController` in `src/app`; the ui
 * builder codes against this interface (and a mock of it) without touching the game loop.
 *
 * React never runs in the per-frame path: the controller owns the loop and notifies subscribers
 * at about 10 Hz. `getSnapshot()` returns the same object between notifications (safe for
 * `useSyncExternalStore`).
 */

import type { MapObjectKind, ViewInsets, ViewSettings } from './render-api';
import type { AggregateReport, CompareRequest, CompareResult, EvolveGeneration, EvolveRequest, EvolveResult, LeaderboardEntry, MatchReport } from './report-types';
import type {
  Decision, FighterState, GameEvent, KnownFighter, MapDef, MatchConfig, MatchEnding, MatchFormat, MatchSignal, Strategy, WorldState,
} from './types';

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
  /**
   * Starts with a countdown once the splash has been entered (see MatchPhase). Leaves a watched
   * stream. `lineup` is the lineup that produced `config` (setup panel, Quick matchup, the editor's
   * "Watch it fight", a gym Watch with the candidate pinned); it becomes the current lineup. Without
   * it the lineup is derived from `config` (`lineupFromConfig`: every entrant kept), because the
   * lineup is always whatever the last match used.
   */
  startMatch(config: MatchConfig, lineup?: Lineup): void;
  /** Replay the current config with the same seed. */
  restart(): void;
  /**
   * "Next match" (end card, setup): the current lineup and rules with a new seed (the next map when
   * `MatchRules.rotateMaps` is on). Pinned fighters stay; the unpinned field stays as drawn (Shuffle
   * redraws it). House stacks fill any slots up to `Lineup.size`.
   */
  nextMatch(): void;
  /** The lineup the next match plays (pinned picks, the drawn field, field size). Same object until it changes. */
  getLineup(): Lineup;
  /** Replace the lineup (setup panel edits, Quick matchup add/remove, pin/unpin). Starts nothing; subscribers are notified. */
  setLineup(lineup: Lineup): void;
  /** "Shuffle field": redraw only the unpinned slots from the house stacks. Pinned fighters keep their slots. */
  shuffleField(): void;
  /** Quick matchup "Fight": `m.lineup` becomes the lineup, `m.rules` the rules, and the match starts with `m.seed`. */
  startMatchup(m: QuickMatchup): void;
  /**
   * Show a room's match (`MatchStream`) instead of the local one, or `null` to go back to the local
   * match and repaint it. While a stream is watched the controller steps no sim of its own: per
   * animation frame it calls `advance(performance.now())` and, when that returns output, on `reset`
   * calls `renderer.setMap(map)` and `renderer.reset()`, then `onEvents(events, curr)` for renderer
   * and audio, `onSignal` for each signal, `setTimeScale(timeScale)`, `audio.update(dt, timeScale)`
   * and `render(prev, curr, alpha, dt)`. The snapshot comes from `view()` (`source` 'room').
   * On attach, and when a renderer is created while watching, it calls `requestReset()`.
   * `startMatch` also leaves the stream.
   */
  watchStream(stream: MatchStream | null): void;
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
  /**
   * The finished match's battle report as LLM-ready text (`reportToText`), or null. For a local
   * match it is built from `lastReport()`; for a room's match it is the host's text
   * (`MatchStream.reportText`), since a guest has no report of its own.
   */
  lastReportText(): string | null;
  /** Put the arena canvas inside `el`. Refinement: returns an unmount function (React effect cleanup). */
  mountCanvas(el: HTMLElement): () => void;
  strategies: StrategyStore;
  gym: GymApi;
}

/**
 * Where a saved version came from; separate from its version number (SPEC "Versions and the
 * library"). `editor`: saved from the gym's editor. `llm-paste`: an LLM's answer pasted in ("New
 * fighter with an LLM", "Improve this with an LLM"). `import`: an imported file, paste or code.
 * `evolution`: an evolution result, with the generation it came from. `room`: taken from a room.
 * `house`: a copy of a house stack.
 */
export type SavedOrigin =
  | { kind: 'editor' }
  | { kind: 'llm-paste' }
  | { kind: 'import' }
  | { kind: 'evolution'; generation: number }
  | { kind: 'room' }
  | { kind: 'house' };

export type SavedOriginKind = SavedOrigin['kind'];

/**
 * One saved version of a strategy, as the library numbers it. Version numbers belong to the library:
 * per name, monotonic from 1, assigned on save. The strategy JSON's own `version` is overwritten on
 * save and never trusted on import (an LLM prompt never sets it), so the editor always shows this
 * number. Origin is separate from version: "Slurpy Hawk v4, evolved from v3, generation 140", never
 * "v140".
 */
export type StrategyVersion = {
  name: string;
  /** The library's number for this version of `name` (1, 2, 3, ...). */
  version: number;
  /**
   * The version of the same name it was edited, evolved or improved from; null for the first
   * version of a name, or when not recorded (older saves). A copy saved under a new name starts a
   * new lineage (null here); `SavedStrategy.parentId` may still say where it was copied from.
   */
  parentVersion: number | null;
  /** Where this version came from; null when not recorded (older saves). */
  origin: SavedOrigin | null;
  /** Epoch milliseconds (UI and persistence only; never read by the sim). */
  savedAt: number;
  /** Shareable strategy code (see `encodeStrategyCode`). */
  code: string;
};

/** A version in the library: its numbering plus the stored strategy (whose `version` equals `version`). */
export type SavedStrategy = StrategyVersion & {
  /** Library id, `name@vN`. */
  id: string;
  strategy: Strategy;
  /** Id of the version this one was edited or evolved from (any name); null for a new strategy or when not recorded (older saves). */
  parentId: string | null;
};

/**
 * One row of the editor's history panel: a version and the version it came from (when that is still
 * in the library), so the panel can say "v4, evolved from v3, generation 140, 17:42" and diff the
 * two strategies (attributes, behaviours, weights) for "what changed".
 */
export type StrategyHistoryEntry = { saved: SavedStrategy; parent: SavedStrategy | null };

/** Every version of one name, newest first. */
export type StrategyHistory = { name: string; entries: StrategyHistoryEntry[] };

/** Local strategy library with versions (persisted by the integrator). */
export interface StrategyStore {
  list(): SavedStrategy[];
  /**
   * Saves as the next version of `s.name` and returns the stored entry. Version numbers belong to
   * the library: per name, monotonic, assigned here; the JSON's own `version` is overwritten, never
   * trusted. `meta.parentId` is the saved version it was edited or evolved from (`SavedStrategy.id`),
   * `meta.origin` where it came from; both default to null. `parentVersion` follows from `parentId`
   * when the parent has the same name.
   */
  save(s: Strategy, meta?: { parentId?: string | null; origin?: SavedOrigin | null }): SavedStrategy;
  /** All versions of one strategy name, newest first. */
  versions(name: string): SavedStrategy[];
  /** The history panel's rows for one name (newest first), each with its parent resolved. */
  history(name: string): StrategyHistory;
  /** The number the next save under `name` gets: one past the highest ever assigned, deleted versions included. */
  nextVersion(name: string): number;
  remove(id: string): void;
}

// ---------------------------------------------------------------------------------------------
// Lineup and Quick matchup
// ---------------------------------------------------------------------------------------------

/**
 * Where a lineup fighter came from (the setup panel's badge). `house`: a house stack. `library`: a
 * saved version. `file`, `paste`, `code`: Quick matchup's "Add fighter" (a dropped `.json`, pasted
 * JSON, a strategy code). `editor`: "Watch it fight". `gym`: a gym or evolution Watch. `room`: a
 * room's pool. `match`: carried over from a match config that said nothing more.
 */
export type LineupSource = 'house' | 'library' | 'file' | 'paste' | 'code' | 'editor' | 'gym' | 'room' | 'match';

/** One slot of the lineup. */
export type LineupFighter = {
  /** Stable id within the lineup (React key, remove, reorder); not the match's entrant id. */
  key: string;
  /** Already through the gate (`loadStrategy`) when it was added. */
  strategy: Strategy;
  source: LineupSource;
  /** `SavedStrategy.id` when it came from the library, else null. */
  savedId: string | null;
  /**
   * The player's own pick: stays for every next match until removed. Unpinned slots are the field:
   * drawn from the house stacks and redrawn by "Shuffle field".
   */
  pinned: boolean;
};

/**
 * Who plays the next match. "Next match" keeps it (new seed); every way of bringing a fighter into
 * the pit updates it, so the setup panel always shows the lineup that will play next.
 */
export type Lineup = {
  /** Slots in order (squads fill consecutive slots): pinned picks and the drawn field. Never longer than `size`. */
  fighters: LineupFighter[];
  /**
   * Field size: fighters in the match (2..MAX_FIGHTERS; a duel is 2). When `fighters` is shorter,
   * house stacks fill the rest as unpinned slots on start. Set it to the pinned count to play
   * without house stacks.
   */
  size: number;
};

/** The rules next to the lineup (Quick matchup, setup panel). */
export type MatchRules = {
  mapId: string;
  format: MatchFormat;
  /** Fighters per squad in `squads` (shrunk until there are at least two squads). Ignored otherwise. */
  squadSize: number;
  /** Only meaningful in squads; FFA and duels always allow hitting anyone. */
  friendlyFire: boolean;
  timeLimitTicks: number;
  suddenDeath: boolean;
  /** "Next match" moves on to the next map in `MAPS` order. */
  rotateMaps: boolean;
};

/**
 * Quick matchup: set up a fight from files on disk, pastes, codes, saved or house strategies, with
 * the rules next to the lineup. "Fight" = `GameController.startMatchup`.
 */
export type QuickMatchup = { lineup: Lineup; rules: MatchRules; seed: number };

/**
 * The lineup a match config implies when nothing better is known: every entrant in slot order,
 * pinned (the lineup is whatever the last match used), source `match`, field size = entrants.
 */
export function lineupFromConfig(config: MatchConfig): Lineup {
  return {
    fighters: config.entrants.map((e) => ({ key: e.id, strategy: e.strategy, source: 'match' as const, savedId: null, pinned: true })),
    size: config.entrants.length,
  };
}

/**
 * The winning side of a decided match (the `victory` and `end_card` signals): the 1st-placed
 * fighter, then its squadmates still standing. Empty when nobody won.
 */
export function matchWinners(state: WorldState): string[] {
  const first = state.fighters.find((f) => f.id === state.placements[0]);
  if (!first) return [];
  return [first.id, ...state.fighters.filter((f) => f !== first && f.alive && f.squad === first.squad).map((f) => f.id)];
}

/** The rules of a match config (squad size read off the entrants; `rotateMaps` off). */
export function rulesFromConfig(config: MatchConfig): MatchRules {
  const firstSquad = config.entrants[0]?.squad;
  const squadSize = config.format === 'squads' ? Math.max(1, config.entrants.filter((e) => e.squad === firstSquad).length) : 1;
  return {
    mapId: config.mapId,
    format: config.format,
    squadSize,
    friendlyFire: config.friendlyFire,
    timeLimitTicks: config.timeLimitTicks,
    suddenDeath: config.suddenDeath,
    rotateMaps: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Room streams
// ---------------------------------------------------------------------------------------------

/** What the arena draws this animation frame from a streamed match (`MatchStream.advance`). */
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
  format: MatchFormat;
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

/**
 * A room's match as the arena shows it (`GameController.watchStream`); `StreamPlayer` in src/net
 * implements it.
 */
export interface MatchStream {
  /** Map of the streamed match (our own copy, checked against the host's fingerprint). */
  readonly map: MapDef | null;
  /** What to draw at `nowMs` (monotonic ms), or null before the first frame. Takes the due events. */
  advance(nowMs: number): StreamOutput | null;
  /** The arena (re)attached: the next `advance` resets it and repaints the match so far. */
  requestReset(): void;
  /** HUD data for the match as last shown, or null before the first frame. */
  view(): StreamView | null;
  /** Live state of one fighter as last shown (the inspector). */
  fighter(id: string): FighterState | null;
  /** The inspector shows `id` (null: nobody): the host then streams that fighter's thinking. */
  select(id: string | null): void;
  /** The selected fighter's last decision as the host streamed it, or null. */
  decision(id: string): Decision | null;
  /** What the selected fighter knows about its enemies, as the host streamed it (empty when unknown). */
  knowledge(id: string): readonly KnownFighter[];
  /** The host's battle report of the match on screen as text (`reportToText`), once it has one. */
  reportText(): string | null;
  /** Strategy codes per fighter when the host reveals them after the match, else null. */
  revealed(): readonly { fighterId: string; code: string }[] | null;
  /** The end card is up for the match on screen (the stream sends the `end_card` signal itself). */
  readonly endCardShown: boolean;
}

/** The part of the controller that shows streams (every `GameController` has it). */
export type StreamWatcher = Pick<GameController, 'watchStream'>;

// ---------------------------------------------------------------------------------------------
// Gym
// ---------------------------------------------------------------------------------------------

/** Headless batch runner. Runs in a Web Worker; one job at a time. */
export interface GymApi {
  runBatch(req: BatchRequest, onProgress?: (done: number, total: number) => void): Promise<BatchResult>;
  /** Refinement: evolve a strategy (see EvolveRequest). `onGeneration` fires after each generation. */
  evolve(req: EvolveRequest, onGeneration?: (gen: EvolveGeneration, done: number, total: number) => void): Promise<EvolveResult>;
  /**
   * Two strategies or two versions side by side over the same seeds ("Compare two"; see
   * `CompareRequest`). Not rated. `onProgress` counts matches over both sides (total = 2 x matches).
   * One job at a time like the others; `cancel()` rejects it with an AbortError.
   */
  compare(req: CompareRequest, onProgress?: (done: number, total: number) => void): Promise<CompareResult>;
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
