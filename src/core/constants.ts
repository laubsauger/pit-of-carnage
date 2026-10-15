/**
 * Structural constants every module is shaped around: tick rate, limits, ids, palettes.
 * Gameplay tuning (damage, speeds, ranges) lives in `rules.ts` so the rulebook can document it.
 */

/** Simulation ticks per second. The sim always steps at this rate, independent of display refresh. */
export const TICK_HZ = 60;
/** Seconds of game time per simulation tick. */
export const TICK_DT = 1 / TICK_HZ;

/**
 * Brains think every N ticks (10 Hz). The sim staggers fighters across ticks
 * (fighter i thinks when `(tick + i) % THINK_EVERY_TICKS === 0`) so thinking cost is spread evenly.
 */
export const THINK_EVERY_TICKS = 6;

/**
 * Number of candidate headings rated by context steering. Direction i points at angle
 * `i * 2π / STEER_DIRS` in world space (0 = +x / east, π/2 = +y / south). See `STEER_COS`/`STEER_SIN` in math.ts.
 */
export const STEER_DIRS = 16;

/** Attribute points a build may spend in total (sum of all six attributes must not exceed this). */
export const ATTRIBUTE_BUDGET = 100;
/** Lowest value any single attribute may take. */
export const ATTRIBUTE_MIN = 4;
/** Highest value any single attribute may take. */
export const ATTRIBUTE_MAX = 40;

/** Most fighters a single match supports (performance target: 60 fps at this count). */
export const MAX_FIGHTERS = 16;
/** Fewest fighters a match can start with. */
export const MIN_FIGHTERS = 2;
/** Fighter count for a default free-for-all. */
export const DEFAULT_FIGHTERS = 8;

/**
 * Global movement slow-down applied to every walking speed, dash impulse and projectile speed,
 * so fights stay readable. At 1x an average build needs roughly 8-10 s to cross the pit.
 */
export const SPEED_SCALE = 0.65;

/** Default match length before sudden death starts (90 s). */
export const DEFAULT_TIME_LIMIT_TICKS = 90 * TICK_HZ;
/** Map used when none is chosen. */
export const DEFAULT_MAP_ID = 'pit';

/** Schema id every strategy document must carry. */
export const STRATEGY_SCHEMA = 'pit-strategy/2';
/** Most behaviours one strategy may define (after imports are merged). */
export const MAX_BEHAVIOURS = 8;
/** Most move terms one behaviour may list. */
export const MAX_MOVE_TERMS = 6;
/** Most named memory slots one strategy may declare. */
export const MAX_MEMORY_SLOTS = 12;
/**
 * Hysteresis: the active behaviour's score gets this bonus until `strategy.commit` ticks have passed
 * since it started, so fighters do not flicker between two nearly equal behaviours.
 */
export const COMMIT_BONUS = 0.25;

/**
 * Sixteen fighter colours, saturated and readable on dark stone. The first eight follow the
 * Okabe-Ito colour-blind-safe hues (brightened for a dark floor) and include a bone white, so a
 * default 8-fighter match stays distinguishable under the common colour-vision deficiencies.
 * The last eight vary lightness as well as hue. No pure blood red: blood owns that colour.
 */
export const FIGHTER_COLORS: readonly string[] = [
  '#F2A541', // orange
  '#56B4E9', // sky blue
  '#F0E442', // yellow
  '#1FC79A', // bluish green
  '#E87BC0', // reddish purple
  '#4C7DFF', // blue
  '#FF6A3D', // vermillion
  '#EDE6D6', // bone
  '#9BE53B', // lime
  '#2CD3E1', // cyan
  '#FF8FA3', // salmon pink
  '#B79CFF', // lavender
  '#C58B4E', // copper
  '#3FA66B', // forest green
  '#8C6BFF', // violet
  '#FFD8A8', // peach
];
