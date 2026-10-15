/**
 * Numbers that shape how a strategy turns into movement and actions. The rulebook prints every
 * one of them with its doc, so players (and the LLMs writing for them) see the exact rules.
 */

import { WEAPONS } from '../core';
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
  momentum: 0.04,
  smoothing: 0.35,
  throttleDead: 0.06,
  throttleFull: 0.3,
  bodyAllowance: 18,
  blockedArcDeg: 60,
  blockedReachRanged: 140,
  fightsRadius: 450,
  freshTicks: 120,
  wallsRadius: 80,
  wallsGain: 0.6,
  hazardFade: 30,
  hazardRadiusGuess: 45,
  far: 9999,
} as const;

export const STEERING_DOCS: DocsFor<typeof STEERING> = {
  sampleNear: 'avoid/prefer look at the zone this far (px) along each direction...',
  sampleFar: '...and this far (px); the two samples are averaged.',
  arriveRamp: 'seek slows down over the last this-many px before its stop distance.',
  fighterStop: 'seek on a fighter stops at your body radius + this (px) from its centre (bodies touching).',
  pointStop: 'seek on a point stops this close (px).',
  leadMaxTicks: 'seek on a fighter you can see or hear aims where it will be, at most this many ticks ahead.',
  rangeRamp: 'keep_range pulls or pushes at full strength once you are this far (px) outside the band.',
  orbitTilt: 'orbit tilts its tangent this much (radians) toward the centre so the circle does not drift outward.',
  behindSwingDeg: 'behind(X, d): if you are not behind X yet, the point sits at most this many degrees further around X from you.',
  behindClearance: 'behind(X, d): while swinging around X, the point keeps at least this distance (px) from it.',
  coverSearch: 'cover_from(X) looks for hiding spots within this distance (px) of you.',
  wallLookahead: 'Wall danger is measured this far (px) past your body edge in each direction.',
  hazardLookahead: 'Hazard danger is measured this far (px) past your body edge in each direction.',
  momentum: 'Bonus for the direction you are already moving in, so near-ties do not make you dither.',
  smoothing: 'Share of the previous steering ring kept each think (the rest is the new one).',
  throttleDead: 'If the best direction rates at or below this, you stand still.',
  throttleFull: 'If the best direction rates at or above this, you move at full speed (linear between).',
  bodyAllowance: 'Melee reach counts this many px of the victim\'s body (reach = weapon range + this).',
  blockedArcDeg: 'if_blocked: an enemy counts as in your way within this many degrees of your heading.',
  blockedReachRanged: 'if_blocked with a ranged weapon: an enemy counts as in your way within this many px.',
  fightsRadius: 'fights_nearby counts fights within this distance (px).',
  freshTicks: 'An enemy seen or heard within this many ticks counts for seen_by(enemies) and cover_from(enemies).',
  wallsRadius: 'The walls zone counts every wall or pillar within this distance (px).',
  wallsGain: 'The walls zone adds this x (1 - distance / wallsRadius) per wall or pillar, capped at 1.',
  hazardFade: 'The hazards zone fades from 1 at a hazard\'s edge to 0 this far (px) outside it.',
  hazardRadiusGuess: 'Radius (px) assumed for a hazard whose size the map does not list (moving saws, spilled acid).',
  far: 'Distance sensors read this when there is nothing to measure to.',
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
