/**
 * Runtime context of one match: the public WorldState plus everything the sim keeps privately
 * (brains, perception memory, timers). Every phase function takes this context.
 *
 * Determinism: all randomness comes from forks of one seeded Rng, each consumer with its own
 * stream (`combat`, `barks`, `copy`, `spawn`, one per brain), so adding a draw in one place never
 * shifts another consumer's numbers.
 */

import type {
  BarkKind,
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
  Rect,
  Rng,
  SkillId,
  Strategy,
  Vec2,
  WeaponId,
  WorldState,
} from '../core';
import type { StaticGeo } from './geometry';

export type BarkLines = Partial<Record<BarkKind, readonly string[]>>;

export type FighterRt = {
  f: FighterState;
  idx: number;
  strategy: Strategy;
  brain: Brain;
  rng: Rng;
  decision: Decision | null;
  /** Reused view handed to `brain.think` (valid only during that call). */
  view: PerceptionView;
  known: KnownFighter[];
  allies: KnownFighter[];
  /** Perception memory of enemies, indexed by fighter index (null = never perceived). Mutated in place. */
  mem: (KnownFighter | null)[];
  /** Tick this fighter last perceived each other fighter (seen or heard), -1 = never. */
  memTick: Int32Array;
  /** Tick the heard-only estimate of each other fighter was last refreshed. */
  heardAt: Int32Array;
  /** Ally records (squadmates are always fully known), indexed by fighter index. */
  allyMem: (KnownFighter | null)[];
  // Derived stats, fixed for the match.
  baseSpeed: number;
  turn: number;
  vision: number;
  fov: number;
  hearing: number;
  parryChance: number;
  /** Light level at the fighter's position this tick. */
  light: number;
  /** Leg heading (radians); turns toward the decision heading faster than the torso. */
  moveDir: number;
  /** Tick of the last attack start or damage taken (drives `fighting` and noise). */
  lastCombatTick: number;
  /** Tick of the last damage dealt by another fighter (hazard kill credit window). */
  hitByTick: number;
  /** Target locked when the current attack started (fighter index, -1 = none). */
  attackTarget: number;
  /** The current swing is a punch (weapon arm gone, or a ranged weapon out of ammo). */
  punching: boolean;
  /** Ticks a finished ranged windup has waited for the shooter to face its target. */
  holdTicks: number;
  /** Where and how this fighter started: what others know of someone they never saw. */
  spawnPos: Vec2;
  spawnFacing: number;
  barks: BarkLines;
  lastBarkTick: number;
  lowHpBarked: boolean;
  spawnBarkTick: number;
  lastKillTick: number;
  /** Kills inside the multi-kill window, counting the latest. */
  killStreak: number;
  /** Squads this fighter has killed members of (for the `revenge` kill flag). */
  killedSquads: number[];
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
  /** Fighter index of the attacker (or whoever broke the keg), -1 for none. */
  attacker: number;
  source: DamageSource;
  /** Weapon that dealt it (null for punches, skills, hazards, kegs, sudden death). */
  weapon: WeaponId | null;
  skill: SkillId | null;
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
  reflect: boolean;
  /** Set for hazard damage, so kill stamps can name it. */
  hazardKind: HazardKind | null;
  /** The closing wall pinned the victim against a wall, pillar or prop (kill flag `crushed`). */
  crushed: boolean;
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
  copyRng: Rng;
  hazardRts: HazardRt[];
  /** Counter for projectile, floor item and spawned hazard ids. */
  nextId: number;
  /** Ring buffer of gore spots (x, y pairs); walking through one bloodies boots. */
  gore: Float32Array;
  goreCount: number;
  goreNext: number;
  /** Fighter indices that died this tick (placed at the end of the tick). */
  diedThisTick: number[];
  /** Number of fighters not yet placed. */
  unplaced: number;
  /** Current playable rectangle (the whole map until sudden death insets it). Same object as `state.suddenDeath.bounds`. */
  bounds: Rect;
  /** Kegs and amphoras broken this tick, waiting to resolve (chains resolve in order). */
  breakQueue: { prop: number; by: number }[];
  /** Tick of the last low-priority bark (hit, taunt), across all fighters. */
  lastChatterTick: number;
  /** Tick a fighter last damaged another fighter (hazards and the wall do not count): drives the stalemate. */
  lastFighterDamageTick: number;
  /** Per-match salt for the heard-only position estimates (deterministic per seed and pair). */
  hearingSalt: number;
  /** Ids of projectiles released at a target closer than COMBAT.pointBlankRange (reduced damage). */
  pointBlank: Set<string>;
};
