/**
 * Numbers that shape how a strategy turns into movement and actions. The rulebook prints every
 * one of them with its doc, so players (and the LLMs writing for them) see the exact rules.
 */

import { MAX_FIGHTERS, STEER_DIRS, WEAPONS } from '../core';
import type { DocsFor, FloorItemKind, WeaponId } from '../core';

export const STEERING = {
  sampleNear: 40,
  sampleFar: 96,
  arriveRamp: 40,
  fighterStop: 22,
  pointStop: 6,
  leadMaxTicks: 30,
  rangeRamp: 40,
  orbitTilt: 0.2,
  behindSwingDeg: 60,
  behindClearance: 80,
  coverSearch: 300,
  wallLookahead: 30,
  hazardLookahead: 70,
  whiskerSide: 0.8,
  momentum: 0.04,
  smoothing: 0.35,
  throttleDead: 0.06,
  throttleFull: 0.3,
  slideOpen: 0.1,
  bodyAllowance: 18,
  blockedHalfArcDeg: 35,
  blockedReachRanged: 140,
  parryMargin: 20,
  fightsRadius: 450,
  freshTicks: 120,
  shadowSoft: 0.15,
  wallsRadius: 80,
  wallsGain: 0.6,
  hazardFade: 30,
  spotGrid: 40,
  spotFit: 24,
  cornerGrid: 16,
  cornerReach: 64,
  cornerSeparation: 120,
  searchGrowth: 35,
  searchMax: 200,
  searchSpin: 0.6,
  searchMargin: 30,
  zoneFade: 40,
  far: 9999,
  farSeconds: 999,
} as const;

export const STEERING_DOCS: DocsFor<typeof STEERING> = {
  sampleNear: 'avoid/prefer look at the zone this far (px) along each direction...',
  sampleFar: '...and this far (px); the two samples are averaged.',
  arriveRamp: 'seek eases off over the last this-many px before its stop distance.',
  fighterStop: 'seek on a fighter stops at your body radius + this (px) from its centre (bodies touching).',
  pointStop: 'seek on a point stops this close (px).',
  leadMaxTicks: 'seek on a fighter you can see aims where it will be, at most this many ticks ahead.',
  rangeRamp: 'keep_range pulls or pushes at full strength once you are this far (px) outside the band.',
  orbitTilt: 'orbit tilts its tangent this much (radians) toward the centre so the circle does not drift outward.',
  behindSwingDeg: 'behind(X, d): if you are not behind X yet, the point sits at most this many degrees further around X from you.',
  behindClearance: 'behind(X, d): while swinging around X, the point keeps at least this distance (px) from it.',
  coverSearch: 'cover_from(X) looks for hiding spots within this distance (px) of you.',
  wallLookahead: 'Wall danger is measured this far (px) past your body edge in each direction.',
  hazardLookahead: 'Hazard danger is measured this far (px) past your body edge in each direction.',
  whiskerSide: 'Danger is checked along three rays per direction: from the front of your body and from its two sides, this fraction of your radius out from the centre line, so your whole width clears corners.',
  momentum: 'Bonus for the direction you are already moving in, so near-ties do not make you dither.',
  smoothing: 'Share of the previous think\'s steering kept each think (the rest is the new one).',
  throttleDead: 'If the best direction rates at or below this, you stand still.',
  throttleFull: 'If the best direction rates at or above this, you move at full speed (linear between).',
  slideOpen: 'Sliding: a direction counts as open when its danger is within this of the safest direction.',
  bodyAllowance: 'Melee reach counts this many px of the victim\'s body (reach = weapon range + this).',
  blockedHalfArcDeg: 'if_blocked: an enemy counts as in your way within this many degrees either side of your heading.',
  blockedReachRanged: 'if_blocked with a ranged weapon: an enemy counts as in your way within this many px.',
  parryMargin: 'Parry reflex: a melee enemy winding up while you stand within its reach + this (px) and inside its swing becomes your target for that think (unless you are attacking), so you face it.',
  fightsRadius: 'fights_nearby counts fights within this distance (px).',
  freshTicks: 'An enemy you see or hear right now, or saw within this many ticks, counts for seen_by(enemies) and cover_from(enemies).',
  shadowSoft: 'The shadow zone ramps from 1 at light (shadow threshold - this) to 0 at (shadow threshold + this).',
  wallsRadius: 'The walls zone counts every wall or pillar within this distance (px).',
  wallsGain: 'The walls zone adds this x (1 - distance / wallsRadius) per wall or pillar, capped at 1.',
  hazardFade: 'The hazards zone fades from 1 at a hazard\'s edge to 0 this far (px) outside it.',
  spotGrid: 'dark_spot candidates sit on a grid this fine (px).',
  spotFit: 'A spot only counts if a circle this big (px) fits there, clear of walls, pillars, props and hazards.',
  cornerGrid: 'corner candidates sit on a grid this fine (px).',
  cornerReach: 'corner: a wall must be within this distance (px) both along x and along y.',
  cornerSeparation: 'corner: spots closer than this (px) count as the same corner; only the tightest is kept.',
  searchGrowth: 'search_point: the sweep around the last known spot widens by this many px per second since you last saw the target...',
  searchMax: '...up to this radius (px).',
  searchSpin: 'search_point: the sweep turns around the last known spot at this rate (radians per second).',
  searchMargin: 'search_point stays at least this far (px) inside the playable area.',
  zoneFade: 'The outside_zone zone fades from 1 at the edge of the 3-second warning strip to 0 this far (px) inside it.',
  far: 'Distance sensors read this when there is nothing to measure to.',
  farSeconds: 'Time sensors in seconds read this when the thing never happened or never will (never seen, no wall coming).',
};

/**
 * The runtime guards and the limits the validator proves against them. A strategy that passes the
 * gate never trips a guard: the validator works out, before the match, the range of every
 * expression from the ranges the sensors declare, and turns anything a guard would have to catch
 * into an error. The guards stay as a second line of defence and every trip is counted.
 */
export const GUARDS = {
  scoreLimit: 100,
  weightLimit: 5,
  memoryLimit: 1_000_000,
  costBudget: 4000,
  costKnown: MAX_FIGHTERS - 1,
  zoneSamples: 1 + 2 * STEER_DIRS,
} as const;

export const GUARDS_DOCS: DocsFor<typeof GUARDS> = {
  scoreLimit: 'Behaviour scores are cut to -this..this. The validator rejects a score that could leave that range (it shows the range it can reach).',
  weightLimit: 'Move term weights are 0..this.',
  memoryLimit: 'Memory slots hold values between -this and this; a write outside is cut to the edge. Starting values must be inside.',
  costBudget: 'Evaluation budget per think, in units: one unit per expression node evaluated, and per place or zone node looked up. The validator adds up the worst case of a think and rejects a strategy over budget.',
  costKnown: 'The worst case counts the target expression once per enemy you could know: at most this many.',
  zoneSamples: 'avoid and prefer look up their zone this many times per think (where you stand, then two points along each direction); seen_by(enemies) also costs one unit per enemy, counted as costKnown.',
};

/** Floor items a weapon can pick up as ammo. */
export const AMMO_KINDS: Readonly<Record<WeaponId, readonly FloorItemKind[]>> = {
  GREATSWORD: [],
  WARHAMMER: [],
  TWIN_DAGGERS: [],
  THROWING_AXES: ['axe'],
  LONGBOW: ['arrow'],
  ARCANE_STAFF: [],
};

/** Read by ammo sensors for weapons that never run out (melee). */
export const UNLIMITED_AMMO = 99;

/**
 * How far a weapon reaches, as the brain judges it. Melee: weapon range plus a typical body
 * (the sim measures to the victim's edge, the brain only knows centres). Ranged: weapon range.
 */
export function weaponReach(weapon: WeaponId): number {
  const w = WEAPONS[weapon];
  return w.family === 'melee' ? w.range + STEERING.bodyAllowance : w.range;
}
