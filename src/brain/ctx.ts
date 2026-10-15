/**
 * Everything a sensor, place or zone may read during one think. One context lives per brain and
 * is refilled at the start of every think, so evaluating a strategy allocates almost nothing.
 *
 * KnownFighter records belong to the sim and are reused between thinks: hold them only for the
 * duration of a think, and remember fighters across thinks by id.
 */

import { COMBAT, WEAPONS, moveSpeed } from '../core';
import type { FighterState, KnownFighter, PerceptionView, Vec2, WorldQuery } from '../core';
import { mapInfo } from './mapinfo';
import type { MapInfo } from './mapinfo';
import { SENSORS } from './registry';
import { STEERING, weaponReach } from './tuning';

export type ThinkCtx = {
  view: PerceptionView;
  self: FighterState;
  world: WorldQuery;
  info: MapInfo;
  tick: number;
  /** Target chosen this think (null until target selection has run, or when nobody is known). */
  target: KnownFighter | null;
  /** Id of the target chosen on the previous think (drives `is_target`). */
  prevTargetId: string | null;
  /** Candidate bound to `it.*` while the target expression runs. */
  it: KnownFighter | null;
  lastAttacker: KnownFighter | null;
  /** Enemies seen or heard now, or seen within STEERING.freshTicks (refilled each think). */
  fresh: KnownFighter[];
  memory: Record<string, number>;
  /** One draw from the brain's rng per think (the `random` sensor). */
  random: number;
  /** Current attack reach in px (weapon, or punch when disarmed or out of ammo). */
  reach: number;
  /** Own weapon is ranged and has ammo (attacks fly; LOS matters). */
  shooting: boolean;
  /** Walking speed (px/tick) before stance and buffs. */
  baseSpeed: number;
  /** Think counter; sensor values cached at this stamp are current. */
  stamp: number;
  cache: Float64Array;
  cacheAt: Float64Array;
  /** Scratch point for zone and place queries. */
  tmp: Vec2;
  /** Evaluation units spent this think (see GUARDS.costBudget). */
  cost: number;
  /** The power-up `nearest_pickup` and the `pickup.any.*` sensors describe, worked out once per think. */
  pick: PickedPickup;
};

export type PickedPickup = {
  /** Stamp of the think it was worked out for (-1 = never). */
  at: number;
  found: boolean;
  x: number;
  y: number;
  ready: boolean;
  /** Seconds until it is back (0 when ready). */
  respawnIn: number;
};

/**
 * Refill (or first build) a brain's context for one think: who is known and fresh, reach, a new
 * stamp so cached sensors recompute. `random` and `target` are the brain's to set afterwards.
 */
export function prepareContext(prev: ThinkCtx | null, view: PerceptionView, memory: Record<string, number>, prevTargetId: string | null): ThinkCtx {
  const c: ThinkCtx = prev ?? {
    view, self: view.self, world: view.world, info: mapInfo(view.world.map), tick: view.tick,
    target: null, prevTargetId: null, it: null, lastAttacker: null, fresh: [],
    memory, random: 0, reach: 0, shooting: false,
    baseSpeed: moveSpeed(view.self.attributes, view.self.weapon),
    stamp: 0, cache: new Float64Array(SENSORS.length), cacheAt: new Float64Array(SENSORS.length).fill(-1),
    tmp: { x: 0, y: 0 }, cost: 0,
    pick: { at: -1, found: false, x: 0, y: 0, ready: false, respawnIn: 0 },
  };
  c.view = view;
  c.self = view.self;
  c.world = view.world;
  if (c.info.map !== view.world.map) c.info = mapInfo(view.world.map);
  c.tick = view.tick;
  c.stamp++;
  c.cost = 0;
  c.target = null;
  c.it = null;
  c.prevTargetId = prevTargetId;
  c.lastAttacker = null;
  c.fresh.length = 0;
  for (const f of view.known) {
    if (f.id === view.lastAttackerId) c.lastAttacker = f;
    if (f.seen || f.heard || (f.lastSeenTick >= 0 && view.tick - f.lastSeenTick <= STEERING.freshTicks)) c.fresh.push(f);
  }
  const self = view.self;
  const w = WEAPONS[self.weapon];
  // Assumption shared with the sim: the right arm holds the weapon.
  const armed = self.limbs.armR && (w.family === 'melee' || self.ammo > 0);
  c.reach = armed ? weaponReach(self.weapon) : COMBAT.punchRange + STEERING.bodyAllowance;
  c.shooting = armed && w.family === 'ranged';
  return c;
}
