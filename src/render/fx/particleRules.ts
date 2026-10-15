// Owned by: render-fx
/**
 * Kinds and motion constants of the GPU particle system, shared by the TSL compute kernel and the
 * CPU code that predicts where blood drops land (so footprints know where the floor got wet before
 * the GPU even stamps it). Pure, no three.js.
 */

export const PK = {
  dead: 0,
  /** Blood drop: ballistic, stamps a splat where it lands. */
  blood: 1,
  /** Blood mist: hangs, spreads and fades. */
  mist: 2,
  /** Spark: hot, additive, bounces once. */
  spark: 3,
  /** Dust puff: rises a little, spreads and fades. */
  dust: 4,
  /** Debris chip (wood, clay, stone): falls and bounces. */
  debris: 5,
  /** Ember / magic mote: additive, floats down slowly. */
  ember: 6,
} as const;

export type ParticleKind = (typeof PK)[keyof typeof PK];

/** Downward acceleration per kind (px/s^2). Negative rises. */
export const GRAVITY: Readonly<Record<ParticleKind, number>> = {
  [PK.dead]: 0,
  [PK.blood]: 980,
  [PK.mist]: 25,
  [PK.spark]: 520,
  [PK.dust]: -14,
  [PK.debris]: 900,
  [PK.ember]: 140,
};

/** Horizontal drag per kind (1/s, exponential). Blood has none, so landing is predictable. */
export const DRAG: Readonly<Record<ParticleKind, number>> = {
  [PK.dead]: 0,
  [PK.blood]: 0,
  [PK.mist]: 3.2,
  [PK.spark]: 1.1,
  [PK.dust]: 2.6,
  [PK.debris]: 0.4,
  [PK.ember]: 1.6,
};

/** Size growth per second for puffs (fraction). */
export const GROWTH: Readonly<Record<ParticleKind, number>> = {
  [PK.dead]: 0,
  [PK.blood]: 0,
  [PK.mist]: 1.1,
  [PK.spark]: 0,
  [PK.dust]: 1.4,
  [PK.debris]: 0,
  [PK.ember]: 0,
};

/**
 * Where and when a drag-free blood drop launched from height `z` lands. Writes the landing point to
 * `out` and returns the flight time (s).
 */
export function bloodLanding(out: { x: number; y: number }, x: number, y: number, z: number, vx: number, vy: number, vz: number): number {
  const g = GRAVITY[PK.blood];
  const t = (vz + Math.sqrt(vz * vz + 2 * g * Math.max(0, z))) / g;
  out.x = x + vx * t;
  out.y = y + vy * t;
  return t;
}
