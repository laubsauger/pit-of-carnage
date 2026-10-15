/**
 * Runtime context of one match: the public WorldState plus everything the sim keeps privately
 * (brains, perception memory, timers). Every phase function takes this context.
 *
 * Determinism: all randomness comes from forks of one seeded Rng, each consumer with its own
 * stream (`combat`, `barks`, `spawn`, one per brain), so adding a draw in one place never shifts
 * another consumer's numbers.
 */

import type {
  Brain,
  DamageSource,
  Decision,
  FighterState,
  GameEvent,
  HazardKind,
  KillCause,
  KnownFighter,
  MapDef,
  MatchConfig,
  PerceptionView,
  Rng,
  Strategy,
  WeaponId,
  WorldQuery,
  WorldState,
} from '../core';
import type { StaticGeo } from './geometry';

export type FighterRt = {
  f: FighterState;
  idx: number;
  strategy: Strategy;
  brain: Brain;
  rng: Rng;
  decision: Decision | null;
  /** Reused view handed to `brain.think` (valid only during that call). */
  view: PerceptionView;
  /** Perception memory indexed by fighter index (null = unknown). Records are mutated in place. */
  mem: (KnownFighter | null)[];
  /** Tick this fighter last perceived each other fighter (seen or heard). */
  memTick: Int32Array;
  /** Leg heading (radians); turns toward the decision heading faster than the torso. */
  moveDir: number;
  /** Tick of the last attack start or damage taken (drives `fighting`). */
  lastCombatTick: number;
  /** Target locked when the current attack started (fighter index, -1 = none). */
  attackTarget: number;
  /** The current swing is a punch (weapon arm gone, or a ranged weapon out of ammo). */
  punching: boolean;
  /** Aim point the torso turns toward this tick (valid when `hasAim`). */
  aimX: number;
  aimY: number;
  hasAim: boolean;
  lastBarkTick: number;
  lowHpBarked: boolean;
  spawnBarkTick: number;
  lastKillTick: number;
  killStreak: number;
  /** Footsteps left that print blood. */
  bloodySteps: number;
  /** floor(walkPhase / π) at the last footstep. */
  stepCount: number;
  /** Ticks until the staff regains a charge. */
  ammoRegen: number;
};

export type HazardRt = {
  /** Distance travelled along a saw's path loop. */
  travelled: number;
  pathLength: number;
  /** Per fighter: earliest tick this hazard may damage them again. */
  nextHit: Int32Array;
  /** Spike phase offset (ticks), so neighbouring traps alternate. */
  offset: number;
};

export type DamageInfo = {
  /** Fighter index of the attacker, -1 for none. */
  attacker: number;
  source: DamageSource;
  /** Weapon that dealt it (null for skills, hazards, kegs, sudden death). */
  weapon: WeaponId | null;
  /** Direction the blow travelled (radians). */
  dir: number;
  /** Knockback impulse before COMBAT.knockbackScale. */
  knockback: number;
  crit: boolean;
  backstab: boolean;
  stunTicks: number;
  slowTicks: number;
  ranged: boolean;
  splash: boolean;
  /** Set for hazard damage, so kill stamps can name it. */
  hazardKind: HazardKind | null;
  /** Kill cause if this blow is fatal (friendly fire is detected on top). */
  cause: KillCause;
};

export type SimCtx = {
  config: MatchConfig;
  map: MapDef;
  geo: StaticGeo;
  state: WorldState;
  rts: FighterRt[];
  byId: Map<string, number>;
  /** Events of the current step (a fresh array every step). */
  events: GameEvent[];
  combatRng: Rng;
  barkRng: Rng;
  query: WorldQuery;
  hazardRts: HazardRt[];
  /** Counter for projectile, floor item and spawned hazard ids. */
  nextId: number;
  /** Flat x, y list of gore spots (deaths and severed limbs); walking through one bloodies boots. */
  gore: number[];
  /** Fighter indices that died this tick (placed at the end of the tick). */
  diedThisTick: number[];
  /** Number of fighters not yet placed. */
  unplaced: number;
  /** Tick the sudden-death wall stopped moving, or -1. */
  closedAtTick: number;
  /** Kegs and amphoras broken this tick, waiting to resolve (chains resolve in order). */
  breakQueue: { prop: number; by: number }[];
  /** Tick of the last bark of a low-priority kind (hit, taunt), across all fighters. */
  lastChatterTick: number;
};
