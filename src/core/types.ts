/**
 * Shared data types. Pure types only: no runtime code lives here.
 *
 * World conventions (binding for every module):
 * - Units are pixels. A map spans [0, width] x [0, height] with the origin at its top-left corner,
 *   +x to the east (right) and +y to the south (down on screen).
 * - Angles are radians measured from +x toward +y, i.e. `Math.atan2(dy, dx)`. On screen that turns
 *   clockwise. 0 = east, π/2 = south.
 * - Time is measured in simulation ticks (`TICK_HZ` per second) unless a name says otherwise.
 * - Ids are strings. Fighter ids are unique per match; entrant ids are unique per config.
 */

import type { Rng } from './rng';

export type Vec2 = { x: number; y: number };

/** Axis-aligned rectangle. `x`, `y` is the minimum (top-left) corner; `w`, `h` extend toward +x, +y. */
export type Rect = { x: number; y: number; w: number; h: number };

// ---------------------------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------------------------

export type WeaponId = 'GREATSWORD' | 'WARHAMMER' | 'TWIN_DAGGERS' | 'THROWING_AXES' | 'LONGBOW' | 'ARCANE_STAFF';
export type WeaponFamily = 'melee' | 'ranged';
export type SkillId = 'WHIRLWIND' | 'SHADOWSTEP' | 'DASH' | 'SHOCKWAVE' | 'BLOODRAGE';

/** Six build attributes. Each in [ATTRIBUTE_MIN, ATTRIBUTE_MAX]; the sum may not exceed ATTRIBUTE_BUDGET. */
export type Attributes = {
  vitality: number;
  power: number;
  agility: number;
  perception: number;
  armor: number;
  haste: number;
};

export type Limb = 'armL' | 'armR' | 'legL' | 'legR';

/**
 * How a behaviour moves. `creep` is slow and quiet, `guard` is slow and raises a shield
 * (greatsword and warhammer users block projectiles from the front). See `STANCES` in rules.ts.
 */
export type Stance = 'normal' | 'creep' | 'guard';

// ---------------------------------------------------------------------------------------------
// Strategy language pit-strategy/2
// ---------------------------------------------------------------------------------------------

/**
 * One context-steering term. Each term rates the STEER_DIRS headings in [-1, 1]; the behaviour's
 * terms are summed with their weights. String arguments are place or zone expressions from the
 * brain registry (for example `"target"`, `"behind(target, 40)"`, `"seen_by(enemies)"`).
 */
export type MoveTerm = { weight: number } & (
  | { seek: string }
  | { flee: string }
  | { keep_range: [string, number, number] }
  | { orbit: [string, 'cw' | 'ccw'] }
  | { avoid: string }
  | { prefer: string }
);

/** A named behaviour: when it wins (`score`), how it moves, when it attacks and uses its skill. */
export type Behaviour = {
  /** Expression; the highest-scoring behaviour runs (current one gets COMMIT_BONUS while committed). */
  score: string;
  move: MoveTerm[];
  /** Attack policy: `in_range`, `never`, `if_blocked`, or an expression (truthy = attack). */
  attack: string;
  /** Skill policy expression (truthy = use the skill when ready). Omitted = never. */
  skill?: string;
  /** Memory writes applied each think while this behaviour runs: slot name -> expression. */
  set?: Record<string, string>;
  stance?: Stance;
};

export type BarkKind = 'spawn' | 'kill' | 'hit' | 'low_hp' | 'death' | 'skill' | 'taunt';

export type Strategy = {
  schema: 'pit-strategy/2';
  name: string;
  author?: string;
  /** Version number for the same `name`; defaults to 1. `name@vN` identifies a strategy in reports. */
  version?: number;
  build: { weapon: WeaponId; skill: SkillId; attributes: Attributes };
  /** Target expression, evaluated per known enemy with `it.*` bound to the candidate; highest wins. */
  target: string;
  behaviours: Record<string, Behaviour>;
  /** Names of starter-library behaviours merged in (own behaviours with the same name win). */
  imports?: string[];
  /** Memory slots and their initial values. */
  memory?: Record<string, number>;
  /** Ticks a newly chosen behaviour keeps the COMMIT_BONUS (hysteresis). */
  commit: number;
  barks?: Partial<Record<BarkKind, string[] | string>>;
  look?: { color?: string; glyph?: string };
};

/** One problem found by the strategy validator. */
export type ValidationIssue = {
  /** JSON-pointer-like path, e.g. `behaviours.kite.move[1].keep_range[0]`. */
  path: string;
  message: string;
  /** "Did you mean" suggestion for unknown names, when one is close enough. */
  suggestion?: string;
  /** Errors make the strategy unusable; warnings are advice (e.g. unspent attribute points). */
  severity: 'error' | 'warning';
};

/** Result of validating (or decoding) a strategy. `strategy` is present only when `ok`. */
export type ValidationResult = {
  ok: boolean;
  issues: ValidationIssue[];
  /** The normalized strategy (defaults filled, imports kept as names) when there are no errors. */
  strategy?: Strategy;
};

// ---------------------------------------------------------------------------------------------
// Match setup
// ---------------------------------------------------------------------------------------------

export type MatchFormat = 'ffa' | 'squads' | 'duel';

/** One slot in a match. In `ffa` every entrant has its own squad number. */
export type Entrant = { id: string; strategy: Strategy; squad: number; name: string; color: string };

export type MatchConfig = {
  seed: number;
  mapId: string;
  format: MatchFormat;
  entrants: Entrant[];
  friendlyFire: boolean;
  timeLimitTicks: number;
  suddenDeath: boolean;
};

// ---------------------------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------------------------

export type LightDef = {
  id: string;
  pos: Vec2;
  /** Distance (px) at which the light's contribution reaches zero. */
  radius: number;
  /** Peak contribution at the light's centre, 0..1 (added to the map's ambient, clamped to 1). */
  intensity: number;
  /** CSS hex colour, e.g. `#ffb26b`. */
  color: string;
  /** Cosmetic flicker amount 0..1 (renderer only; `lightAt` ignores flicker to stay deterministic). */
  flicker: number;
  castsShadow: boolean;
};

export type HazardKind = 'spike' | 'saw' | 'acid' | 'fire';

export type HazardDef = {
  id: string;
  kind: HazardKind;
  pos: Vec2;
  radius: number;
  /** Saw patrol waypoints, travelled in a loop. */
  path?: Vec2[];
  /** Spike cycle length in ticks (defaults to the rule table). */
  period?: number;
};

export type PropKind = 'keg' | 'amphora' | 'crate';
export type PropDef = { id: string; kind: PropKind; pos: Vec2; radius: number };

export type PickupKind = 'haste' | 'berserk';

/**
 * Map data. Walls include the outer boundary (listed explicitly, so LOS, collision and rendering
 * treat every wall the same way). Pillars are free-standing blocks that also block LOS.
 */
export type MapDef = {
  id: string;
  name: string;
  width: number;
  height: number;
  floor: 'sand' | 'stone' | 'flesh';
  /** Base light level everywhere, 0..1. Below `PERCEPTION.shadowLight` counts as shadow. */
  ambient: number;
  walls: Rect[];
  pillars: Rect[];
  lights: LightDef[];
  hazards: HazardDef[];
  props: PropDef[];
  shrines: { id: string; pos: Vec2 }[];
  pickups: { id: string; kind: PickupKind; pos: Vec2 }[];
  spawns: Vec2[];
};

// ---------------------------------------------------------------------------------------------
// World state (owned and mutated by the sim; everyone else reads it)
// ---------------------------------------------------------------------------------------------

export type AnimPhase = 'idle' | 'windup' | 'strike' | 'recovery';

export type FighterState = {
  id: string;
  entrantId: string;
  squad: number;
  name: string;
  color: string;
  weapon: WeaponId;
  skill: SkillId;
  attributes: Attributes;
  pos: Vec2;
  /** px per tick. */
  vel: Vec2;
  /** Body facing (radians). */
  facing: number;
  /** Head angle relative to the world (radians); the vision cone follows the head. */
  headAngle: number;
  radius: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  diedAtTick: number | null;
  /** Weapon animation: `t` counts ticks into the current phase, `dur` is that phase's length. */
  anim: { phase: AnimPhase; t: number; dur: number };
  /** Walk cycle phase in radians, advanced with distance travelled (drives boots and bob). */
  walkPhase: number;
  attackCd: number;
  skillCd: number;
  parryTicks: number;
  parryCd: number;
  stunTicks: number;
  ammo: number;
  maxAmmo: number;
  /** Remaining ticks of each timed effect (0 = inactive). */
  buffs: { haste: number; berserk: number; slow: number };
  /** true = limb attached. */
  limbs: Record<Limb, boolean>;
  helmet: boolean;
  inShadow: boolean;
  /** Refinement: true when at least one enemy currently sees this fighter (drives `self.seen`, exposure stats). */
  seen: boolean;
  /** Refinement: stance of the running behaviour. */
  stance: Stance;
  /** Ticks of white hit flash left (cosmetic, set by the sim so replays match). */
  hitFlash: number;
  /** Ticks of eye-pop left (cosmetic). */
  eyePop: number;
  /** Name of the running behaviour. */
  behaviour: string;
  targetId: string | null;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  lastHitBy: string | null;
  /** Refinement: tick of the last damage taken, null if never hit (drives `since_hit`). */
  lastHitTick: number | null;
  /** Final placement (1 = winner); null while still in contention. */
  place: number | null;
};

export type ProjectileState = { id: string; ownerId: string; weapon: WeaponId; pos: Vec2; vel: Vec2; ttl: number };

export type FloorItemKind = 'arrow' | 'axe' | 'weapon' | 'helmet';
export type FloorItem = { id: string; kind: FloorItemKind; pos: Vec2; ownerId: string | null };

export type PropState = PropDef & { alive: boolean; hp: number };

/**
 * Live hazard. `pos` is the current position (saws move along `path`). `ttl` counts down for
 * spawned hazards (acid spilled from an amphora) and is null for permanent map hazards.
 */
export type HazardState = HazardDef & { phase: number; active: boolean; pos: Vec2; ttl: number | null };

export type WorldState = {
  tick: number;
  mapId: string;
  fighters: FighterState[];
  projectiles: ProjectileState[];
  floor: FloorItem[];
  props: PropState[];
  hazards: HazardState[];
  shrines: { id: string; pos: Vec2; cooldown: number }[];
  /** Refinement: pickups with their respawn cooldown (0 = available). */
  pickups: { id: string; kind: PickupKind; pos: Vec2; cooldown: number }[];
  /** While active, the arena boundary is inset by `inset` px on every side. */
  suddenDeath: { active: boolean; inset: number };
  finished: boolean;
  /** Fighter ids in final order (1st first). Filled when the match ends. */
  placements: string[];
};

// ---------------------------------------------------------------------------------------------
// Events (emitted by `Match.step()`; consumed by renderer, fx, controller feed and reports)
// ---------------------------------------------------------------------------------------------

export type KillCause = 'weapon' | 'skill' | 'hazard' | 'keg' | 'friendly' | 'sudden_death';

/** What dealt a point of damage. Used for hit events and the reports' damage-by-source tables. */
export type DamageSource = 'weapon' | 'punch' | 'skill' | 'reflect' | 'hazard' | 'keg' | 'sudden_death';

/**
 * Facts about a kill the sim knows at the moment it happens. `unseen` = the victim had not seen the
 * killer in the last second; `revenge` = the victim had killed one of the killer's squad or had hit
 * the killer last; `multi` = the killer's second+ kill within 3 s.
 */
export type KillFlag = 'backstab' | 'crit' | 'unseen' | 'ranged' | 'splash' | 'reflect' | 'multi' | 'revenge' | 'overkill';

export type GameEvent = { tick: number } & (
  | { type: 'swing'; fighterId: string; weapon: WeaponId }
  | {
      type: 'hit';
      /** null for hazards and sudden death. */
      attackerId: string | null;
      victimId: string;
      amount: number;
      pos: Vec2;
      /** Direction the blow travelled (radians), i.e. the knockback direction. */
      dir: number;
      crit: boolean;
      backstab: boolean;
      weapon: WeaponId | null;
      knockback: number;
      /** Refinement: what dealt the damage. */
      source: DamageSource;
    }
  | { type: 'parry'; fighterId: string; attackerId: string; pos: Vec2 }
  | { type: 'projectile'; projectileId: string; ownerId: string; weapon: WeaponId; pos: Vec2; dir: number }
  | { type: 'projectile_end'; projectileId: string; pos: Vec2; hitId: string | null }
  | { type: 'dismember'; victimId: string; limb: Limb; pos: Vec2; vel: Vec2 }
  | {
      type: 'kill';
      killerId: string | null;
      victimId: string;
      cause: KillCause;
      pos: Vec2;
      dir: number;
      /** Kill stamp, 1-3 words (e.g. "BACKSTAB", "SAWED", "OWN GOAL"). */
      title: string;
      killerBehaviour: string | null;
      victimBehaviour: string;
      /** Refinement: weapon that landed the kill, null for hazards/keg/sudden death. */
      weapon: WeaponId | null;
      /** Refinement: facts for kill stamps, feed lines and reports. */
      flags: KillFlag[];
    }
  | { type: 'explosion'; pos: Vec2; radius: number }
  | { type: 'skill'; fighterId: string; skill: SkillId; pos: Vec2 }
  | { type: 'bark'; fighterId: string; text: string }
  | { type: 'footstep'; fighterId: string; pos: Vec2; bloody: boolean }
  | { type: 'pickup'; fighterId: string; kind: string; pos: Vec2 }
  | { type: 'heal'; fighterId: string; amount: number; pos: Vec2 }
  | { type: 'hazard'; hazardId: string; victimId: string | null; pos: Vec2 }
  /** Refinement: a prop broke (keg also emits `explosion`; amphora spills acid). */
  | { type: 'prop_break'; propId: string; kind: PropKind; pos: Vec2 }
  | { type: 'sudden_death' }
  | { type: 'match_end'; placements: string[] }
);

export type GameEventType = GameEvent['type'];

// ---------------------------------------------------------------------------------------------
// Sim -> brain
// ---------------------------------------------------------------------------------------------

/** What a fighter knows about another fighter (enemy or ally). Positions are as last perceived. */
export type KnownFighter = {
  id: string;
  squad: number;
  pos: Vec2;
  vel: Vec2;
  facing: number;
  hp: number;
  maxHp: number;
  weapon: WeaponId;
  family: WeaponFamily;
  /** In vision this tick. */
  seen: boolean;
  /** Heard this tick (within hearing radius, not seen). */
  heard: boolean;
  lastSeenTick: number;
  lastSeenPos: Vec2;
  /** Attacked or was hit within `PERCEPTION.fightingWindowTicks`. */
  fighting: boolean;
  ammo: number;
  /** Refinement: kill count (drives `it.kills`). */
  kills: number;
  /** Refinement: currently in the windup phase (drives `target.winding_up` and auto-parry). */
  windingUp: boolean;
};

/** Spatial queries the sim answers for brains. All results are deterministic. */
export interface WorldQuery {
  map: MapDef;
  /** Walls and pillars (and the sudden-death boundary) block the segment a-b. */
  losBlocked(a: Vec2, b: Vec2): boolean;
  /** 0 dark .. 1 fully lit, from map ambient + lights whose LOS reaches p. */
  lightAt(p: Vec2): number;
  /** Would `observer` see point p (range, FOV, LOS, shadow rule)? The sim uses true stats by id. */
  inVisionOf(observer: KnownFighter | FighterState, p: Vec2): boolean;
  /** 0..1 danger of walking from `from` in direction (dirX, dirY) for `lookahead` px into a wall. */
  wallDanger(from: Vec2, dirX: number, dirY: number, lookahead: number): number;
  /** 0..1 danger of walking into an active hazard (or outside the sudden-death boundary). */
  hazardDanger(from: Vec2, dirX: number, dirY: number, lookahead: number): number;
  /** Nearest point within `maxDist` hidden from `threat` by a wall or pillar, or null. */
  coverFrom(from: Vec2, threat: Vec2, maxDist: number): Vec2 | null;
  nearestShrine(p: Vec2): { pos: Vec2; ready: boolean } | null;
  nearestFloorItem(p: Vec2, kinds: string[]): Vec2 | null;
  nearestProp(p: Vec2, kind: string): Vec2 | null;
  /** Refinement: current position of the active hazard nearest p (drives the `hazard_near(X)` place). */
  nearestHazard(p: Vec2): Vec2 | null;
  /** Number of fighters within r of p that are currently fighting. */
  fightsNear(p: Vec2, r: number): number;
}

export type PerceptionView = {
  tick: number;
  self: FighterState;
  /** Known enemies (seen, heard, or remembered for `PERCEPTION.memoryTicks`). */
  known: KnownFighter[];
  allies: KnownFighter[];
  lastAttackerId: string | null;
  /** Refinement: sudden death is running (drives the `sudden_death` sensor). */
  suddenDeath: boolean;
  world: WorldQuery;
};

/**
 * One think result. Also the inspector's data source, so it carries the full reasoning:
 * every behaviour's score, the steering ring and each term's ratings.
 */
export type Decision = {
  behaviour: string;
  scores: Record<string, number>;
  targetId: string | null;
  /** Chosen heading (radians). */
  heading: number;
  /** Throttle 0..1 of the fighter's move speed. */
  speed: number;
  /** STEER_DIRS final ratings after danger, index i = angle i * 2π / STEER_DIRS. */
  ring: number[];
  terms: { label: string; ratings: number[] }[];
  attack: boolean;
  /**
   * Parry permission. The sim does the timing: when an enemy within reach starts a windup aimed at
   * this fighter, the fighter faces it, `parry` is true and `parryCd` is 0, the sim rolls
   * `parryChance(attributes)` once for that windup.
   */
  parry: boolean;
  useSkill: boolean;
  /** Refinement: stance of the chosen behaviour (the sim applies its speed/noise/shield rules). */
  stance: Stance;
  /** Refinement: sensor values from this think, for the inspector (name -> value). */
  sensors: Record<string, number>;
  bark?: string;
};

/** `rng` is the fighter's own fork; brains must use it (never Math.random) to stay deterministic. */
export interface Brain {
  think(view: PerceptionView, rng: Rng): Decision;
  readonly memory: Record<string, number>;
}
export type BrainFactory = (strategy: Strategy) => Brain;

// ---------------------------------------------------------------------------------------------
// Sim API
// ---------------------------------------------------------------------------------------------

export interface Match {
  readonly config: MatchConfig;
  readonly map: MapDef;
  /** Live state, mutated in place by `step()`. Copy it if you need the previous tick. */
  readonly state: WorldState;
  readonly isOver: boolean;
  /** Advance one tick (1 / TICK_HZ s) and return the events it produced. */
  step(): GameEvent[];
  lastDecision(fighterId: string): Decision | null;
  result(): MatchResult;
}

export type MatchResult = {
  seed: number;
  mapId: string;
  ticks: number;
  placements: string[];
  fighters: {
    id: string;
    entrantId: string;
    name: string;
    place: number;
    kills: number;
    damageDealt: number;
    damageTaken: number;
    diedAtTick: number | null;
  }[];
};
