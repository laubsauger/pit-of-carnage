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
 */

// Render code imports three from 'three/webgpu' (WebGPU only, no WebGL fallback) and
// TSL from 'three/tsl'. Never mix in the plain 'three' entry: two three.js copies break node materials.
import type * as THREE from 'three/webgpu';
import type { Decision, GameEvent, MapDef, Vec2, WorldState } from './types';

/** Debug/readability overlays. */
export type OverlayState = {
  cones: 'off' | 'selected' | 'all';
  /** Steering ring and target line for the selected fighter. */
  rings: boolean;
  names: boolean;
  /** Fog of war from the selected fighter's point of view. */
  fog: boolean;
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
  setOverlay(o: OverlayState): void;
  /** Source of steering rings and target lines for the overlays. */
  setDecisionProvider(fn: (fighterId: string) => Decision | null): void;
  /** Fighter id under the given client (CSS pixel) coordinates, or null. */
  pick(clientX: number, clientY: number): string | null;
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
   * Floor-sized render target that the floor's TSL node material multiplies over the floor. FX draw
   * persistent gore (splats, streaks, footprints, scorch) into it. It spans the map with
   * texel (0, 0) at world (0, 0) and `floorSize` world px across.
   */
  floorDecalTarget: THREE.RenderTarget;
  floorSize: Vec2;
  /** Root object of a fighter's visual (for attaching effects), or null if unknown/removed. */
  fighterVisual(id: string): THREE.Object3D | null;
}

export interface FxModule {
  init(ctx: RenderContext): void;
  onEvents(events: GameEvent[], state: WorldState): void;
  /** `frameDt` here is already scaled game time (real seconds x time scale). */
  update(frameDt: number, state: WorldState, alpha: number): void;
  /** Refinement: drop transient particles, popups and decals (new match or seek). */
  reset(): void;
  dispose(): void;
}

/** Height (three.js Y) of each draw layer. Keep effects inside their band. */
export const LAYER_HEIGHT = {
  /** Floor plane with the gore decal target multiplied on top. */
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
