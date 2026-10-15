/**
 * Contracts between the app loop, the world renderer (`src/render`) and the effects module
 * (`src/render/fx`). Type-only imports of three keep this file free of runtime dependencies,
 * so the sim and the gym worker can import `src/core` without pulling three.js in.
 *
 * Coordinate mapping (binding for render and fx):
 * - World (x, y) maps to three.js (x, height, y): three's X = world x, three's Z = world y,
 *   three's Y is height above the floor. Use `toThree()`.
 * - The orthographic camera looks straight down (-Y) with `camera.up = (0, 0, -1)`, so world +y
 *   (south) is down on screen, matching the world convention in types.ts.
 * - Draw order is by height, see `LAYER_HEIGHT`: gore and decals live on the floor layer, fighters
 *   are always above every floor effect, and overlays/popups sit on top.
 *
 * Time (binding):
 * - The app loop is the time director: it steps the sim at TICK_HZ, applies playback speed,
 *   pause, hit-stop and kill slow-motion, and calls `setTimeScale(s)` with the combined factor
 *   (0 while paused or in hit-stop).
 * - `render(..., frameDt)` receives real wall-clock seconds since the last frame. Camera easing
 *   uses it directly (so the camera still settles while paused); FX multiply it by the time scale.
 * - The renderer is the camera director: framing, follow, zoom toward big moments, capped shake.
 *   Manual input (`zoomAt`, `panBy`) takes the camera from the director until `resetCamera()`;
 *   follow still works at the viewer's zoom, and seeks keep the viewer's view.
 */

// Render code imports three from 'three/webgpu' (WebGPU only, no WebGL fallback) and
// TSL from 'three/tsl'. Never mix in the plain 'three' entry: two three.js copies break node materials.
import type * as THREE from 'three/webgpu';
import type { Decision, GameEvent, KnownFighter, MapDef, MatchSignal, Vec2, WorldState } from './types';

/**
 * How much of the canvas the UI covers on each side, in CSS px (inspector on the right, timeline
 * at the bottom, scoreboard and clock at the top, ...). The camera frames the action inside the
 * uncovered rectangle: framing, follow, moments and "Reset camera" centre on what the viewer can
 * actually see. All zero = the whole canvas is visible. Never negative.
 */
export type ViewInsets = { left: number; right: number; top: number; bottom: number };

export const NO_VIEW_INSETS: Readonly<ViewInsets> = { left: 0, right: 0, top: 0, bottom: 0 };

/** Map objects that have a hover card (see `GameController.objectInfo`). */
export type MapObjectKind = 'shrine' | 'pickup' | 'hazard' | 'prop';

/** Everything the pointer can pick in the arena. */
export type PickKind = 'fighter' | MapObjectKind;

/**
 * What is under the pointer. `id` is the live object's id: `FighterState.id`,
 * `WorldState.shrines[].id`, `PickupState.id` (the pedestal, whether or not its power-up is there),
 * `HazardState.id` (spilled acid included) or `PropState.id`.
 */
export type PickedObject = { kind: PickKind; id: string };

/**
 * Stages `createRenderer` reports through `RendererOptions.onProgress`, in this order, each once:
 * `renderer` = WebGPU device and three.js renderer initialised; `shaders` = node materials and
 * pipelines compiled (warm-up, so the first match frame does not hitch); `ready` = the renderer is
 * returned and can draw. A failure rejects the promise instead (no stage after it).
 */
export type RenderInitStage = 'renderer' | 'shaders' | 'ready';

/** Options for `createRenderer(canvas, fx, options)` in src/render. */
export type RendererOptions = {
  /** Called as each init stage completes (for the splash's progress bar). */
  onProgress?: (stage: RenderInitStage) => void;
};

export type ConeMode = 'off' | 'selected' | 'all';
/** `key` = only `BARK_RULES.keyKinds` (spawn, kill, low HP, skill, death). */
export type BarkMode = 'off' | 'key' | 'all';
export type ShakeMode = 'off' | 'kills';
/** Scales how much gore fx paint and spray (cosmetic only; the sim is unaffected). */
export type BloodAmount = 'light' | 'normal' | 'carnage';

/**
 * The viewer's display and readability settings (the Watch screen's "View" popover). Cosmetic
 * only: nothing here reaches the sim. The controller owns the current value, persists it in
 * localStorage, and pushes the full object to the renderer (which forwards it to fx) and the
 * volume to audio whenever any field changes.
 */
export type ViewSettings = {
  /** Damage popups, coloured by the attacker; crits bigger, backstabs labelled. */
  damageNumbers: boolean;
  barks: BarkMode;
  /** Bangers kill stamps ("BACKSTAB", "SAWED"). */
  killStamps: boolean;
  nameTags: boolean;
  hpBars: boolean;
  /** Vision cones. */
  cones: ConeMode;
  /** Steering ring and target line for the selected fighter. */
  rings: boolean;
  /** Fog of war from the selected fighter's point of view (what it sees, hears and remembers). */
  fog: boolean;
  /** Hearing ripples: rough rings where the selected fighter hears enemies (never an exact marker). */
  hearing: boolean;
  /** Screen shake: only on kills, or never. Ordinary hits never shake the camera. */
  shake: ShakeMode;
  blood: BloodAmount;
  /** Master volume 0..1. */
  volume: number;
};

export const DEFAULT_VIEW_SETTINGS: Readonly<ViewSettings> = {
  damageNumbers: true,
  barks: 'key',
  killStamps: true,
  nameTags: true,
  hpBars: true,
  cones: 'selected',
  rings: true,
  /** On by default: selecting a fighter shows the pit through its eyes (user request). */
  fog: true,
  hearing: true,
  shake: 'kills',
  /** Carnage by default: vicious, violent splatter is the point (user request). */
  blood: 'carnage',
  volume: 0.7,
};

export interface GameRenderer {
  setMap(map: MapDef): void;
  /**
   * Draw one frame. `prev` and `curr` are consecutive sim states; `alpha` in [0, 1] interpolates
   * between them. `frameDt` is real seconds since the last frame (see the time notes above).
   */
  render(prev: WorldState, curr: WorldState, alpha: number, frameDt: number): void;
  /** Events from the latest sim steps, in order, with the state right after them. Forwarded to fx. */
  onEvents(events: GameEvent[], state: WorldState): void;
  setSelected(id: string | null): void;
  setHovered(id: string | null): void;
  /** Refinement: camera follows this fighter (null = director framing). */
  setFollow(id: string | null): void;
  /**
   * Mouse wheel: zoom by `factor` (> 1 zooms in) toward the client (CSS pixel) point, keeping the
   * world point under it in place. Clamped to sensible limits. Takes the camera from the director.
   */
  zoomAt(clientX: number, clientY: number, factor: number): void;
  /** Drag: move the view by CSS pixels (the world follows the pointer). Takes the camera from the director. */
  panBy(dx: number, dy: number): void;
  /** Give the camera back to the director (framing, moments). */
  resetCamera(): void;
  /** Display settings (full object, already merged). The renderer forwards it to fx via `FxModule.setView`. */
  setView(v: ViewSettings): void;
  /** Source of steering rings and target lines for the overlays. */
  setDecisionProvider(fn: (fighterId: string) => Decision | null): void;
  /**
   * Source of a fighter's knowledge (`Match.knowledge`) for fog view, ghost markers at last seen
   * spots ("lost sight 2.3 s ago"), hearing ripples (circle of `estimateError` around the
   * estimate) and aim lines (to the record's `pos`, never the live fighter).
   */
  setKnowledgeProvider(fn: (fighterId: string) => readonly KnownFighter[]): void;
  /** Living fighter id under the given client (CSS pixel) coordinates, or null. Dead fighters are never picked. */
  pick(clientX: number, clientY: number): string | null;
  /**
   * What is under the given client (CSS pixel) coordinates, for hover cards and clicks, or null.
   * A living fighter wins over a map object under it (someone standing on the shrine is picked, not
   * the shrine); among objects the nearest wins. Dead fighters, broken props and empty floor are
   * never returned (a corpse shows nothing).
   */
  pickObject(clientX: number, clientY: number): PickedObject | null;
  /**
   * Parts of the canvas covered by UI panels (CSS px). The camera frames the living fighters,
   * follow targets and moments inside the uncovered rectangle; manual zoom and pan are unaffected.
   * May arrive at any time (panels open, close, resize); the camera eases to the new framing.
   */
  setViewInsets(insets: ViewInsets): void;
  /** Match-flow beats from the controller (countdown, FIGHT, final kill); see `MatchSignal`. */
  onSignal(signal: MatchSignal): void;
  /** Combined game-time factor from the app loop (speed x slow-mo; 0 when paused). */
  setTimeScale(s: number): void;
  /** CSS pixel size of the canvas; the renderer applies devicePixelRatio itself. */
  resize(w: number, h: number): void;
  captureStream(fps: number): MediaStream;
  /** Clear all transient state (fx, decals, camera) before a new match or a seek. */
  reset(): void;
  dispose(): void;
}

/** What the world renderer hands to the fx module in `FxModule.init`. */
export interface RenderContext {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  map: MapDef;
  /**
   * Floor-sized render target holding persistent gore as data, not colour. FX draw it (splats,
   * streaks, footprints, scorch; src/render/fx/decals.ts); the floor's TSL material turns it into
   * lit colour with `goreFloor` (src/render/fx/goreFloor.ts), one blood gradient for every floor.
   * Per texel: r = exp(-blood density), g = exp(-wet density) (wet coverage = 1 - g), b =
   * exp(-tone-weighted density), a = soot 0..1. Cleared to (1, 1, 1, 0) = no blood, no soot (never
   * to black, which would read as blood everywhere). It spans the map with
   * texel (0, 0) at world (0, 0) and `floorSize` world px across; the floor samples it at
   * `uv = world / floorSize`. Under WebGPU three.js does not flip render-target UVs, so uv.y = 0
   * (texel row 0) is the TOP edge of the target: a decal camera must put world y = 0 at NDC y = +1.
   */
  floorDecalTarget: THREE.RenderTarget;
  floorSize: Vec2;
  /** Root object of a fighter's visual (for attaching effects), or null if unknown/removed. */
  fighterVisual(id: string): THREE.Object3D | null;
}

export interface FxModule {
  init(ctx: RenderContext): void;
  onEvents(events: GameEvent[], state: WorldState): void;
  /**
   * Display settings (damage numbers, barks, kill stamps, blood amount). May arrive before `init`
   * and at any time after; applies to effects started from then on.
   */
  setView(v: ViewSettings): void;
  /** `frameDt` here is already scaled game time (real seconds x time scale). */
  update(frameDt: number, state: WorldState, alpha: number): void;
  /** Refinement: drop transient particles, popups and decals (new match or seek). */
  reset(): void;
  dispose(): void;
}

/**
 * Events more than this many ticks older than the state they arrive with are catch-up (a seek
 * replays a whole stretch of match in one batch): they leave persistent marks (floor gore, pieces at
 * rest) but play no transient effects, camera moves or flashes.
 */
export const LIVE_EVENT_TICKS = 90;

/** Height (three.js Y) of each draw layer. Keep effects inside their band. */
export const LAYER_HEIGHT = {
  /** Floor plane with the gore decal target composited in (blood replaces the floor by coverage). */
  floor: 0,
  /** Floor-hugging transient effects: blood pools growing, dust, footprint fade-ins. */
  floorFx: 0.5,
  /** Floor items: dropped arrows, axes, weapons, helmets, settled gibs. */
  floorItems: 1,
  /** Hazards and props bodies start here. */
  props: 2,
  /** Fighters (bodies, weapons). Always above anything on the floor. */
  fighters: 10,
  /** Airborne effects: flying gibs, droplets, sparks, projectiles. */
  air: 30,
  /** Walls and pillars tops (cast shadows). */
  walls: 48,
  /** Vision cones, rings, target lines, name tags, HP bars. */
  overlay: 60,
  /** Kill stamps, damage popups, bark bubbles. */
  popups: 70,
} as const;

/** Write world point (x, y) at `height` into a three.js vector: (x, height, y). */
export function toThree(out: THREE.Vector3, x: number, y: number, height = 0): THREE.Vector3 {
  return out.set(x, height, y);
}
