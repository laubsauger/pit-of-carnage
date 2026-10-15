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

/** `armR` is the weapon arm: losing it drops the weapon and the fighter punches from then on. */
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
  /** One line, plain English, ending with the fix when there is one (pasteable back to an LLM). */
  message: string;
  /** "Did you mean" suggestion for unknown names, when one is close enough. */
  suggestion?: string;
  /** Errors block loading; warnings are lint the player may accept (e.g. a behaviour that can never win). */
  severity: 'error' | 'warning';
  /**
   * 1-based line and column in the source text, present when the input was text (a file or a
   * paste) and the issue maps to a spot in it. For a value issue: the start of the value; for an
   * unknown or missing key: the key (or the object that lacks it); for invalid JSON: where parsing failed.
   */
  line?: number;
  column?: number;
};

/** Result of validating (or decoding) a strategy. `strategy` is present only when `ok`. */
export type ValidationResult = {
  ok: boolean;
  issues: ValidationIssue[];
  /** The normalized strategy (defaults filled, imports kept as names) when there are no errors. */
  strategy?: Strategy;
};

/** Brand carried only by strategies that passed `loadStrategy`. Type-level only: nothing exists at runtime. */
declare const validStrategyBrand: unique symbol;

/**
 * A strategy that passed the one gate (`loadStrategy` in src/strategy) with no errors: normalized,
 * statically analysed, safe to compile. Only `loadStrategy` creates one (by a cast after a clean
 * report), so unvalidated JSON cannot reach `createBrain`. A ValidStrategy is still a plain
 * Strategy object (JSON, structuredClone and postMessage keep the data, not the guarantee: anything
 * that crosses a worker or the network goes through the gate again on the other side).
 */
export type ValidStrategy = Strategy & { readonly [validStrategyBrand]: true };

/**
 * Where a strategy came from. Every source goes through the same gate with the same rules; the
 * source only shapes message wording ("line 4 of the file", "in the pasted text") and logs.
 */
export type StrategySource = 'file' | 'paste' | 'code' | 'saved' | 'house' | 'evolution' | 'config' | 'cli' | 'network' | 'test';

/**
 * Report of the gate. `strategy` is present exactly when `errors` is empty. Errors block loading;
 * warnings never do (the import dialog lets the player accept them). Issues carry `line`/`column`
 * when the input was text.
 */
export type LoadReport = {
  strategy?: ValidStrategy;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
};

/**
 * The gate (implemented as `loadStrategy` in src/strategy). `input` is JSON text, a strategy code
 * (`PIT2.…`) or an already parsed value. Never throws: bad input comes back as errors.
 */
export type LoadStrategy = (input: unknown, source: StrategySource) => LoadReport;

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

/** Spent ammo a fighter can walk over and take back. */
export type AmmoKind = Extract<FloorItemKind, 'arrow' | 'axe'>;

/**
 * A power-up pedestal. `cooldown` counts the ticks until the power-up is (back) on the pedestal:
 * it starts at `PICKUP_RULES[kind].firstSpawnTicks`, is 0 while the power-up is there to take, and
 * is set to `PICKUP_RULES[kind].cooldownTicks` when someone takes it. Respawn progress for the
 * pedestal ring is `1 - cooldown / PICKUP_RULES[kind].cooldownTicks` (firstSpawnTicks never exceeds
 * cooldownTicks, so this also holds before the first spawn). Every appearance on the pedestal
 * (the first one included) emits `pickup_spawn`.
 */
export type PickupState = { id: string; kind: PickupKind; pos: Vec2; cooldown: number };

export type PropState = PropDef & { alive: boolean; hp: number };

/**
 * Live hazard. `pos` is the current position (saws move along `path`). `ttl` counts down for
 * spawned hazards (acid spilled from an amphora) and is null for permanent map hazards.
 */
export type HazardState = HazardDef & {
  /**
   * Where the hazard is in its cycle, 0..1: spikes report the fraction of their `period` (they thrust
   * at `HAZARD_RULES.spike.triggerAt`), saws the fraction of their track travelled. Others stay 0.
   */
  phase: number;
  active: boolean;
  pos: Vec2;
  ttl: number | null;
};

/** Why sudden death started: the time limit ran out, or nobody dealt damage for `MATCH_RULES.stalemateTicks`. */
export type SuddenDeathReason = 'time' | 'stalemate';

/**
 * How a match ended:
 * - `elimination`: one squad (or fighter) left standing;
 * - `time`: the bell at the time limit, only in matches with sudden death off (placed by standing);
 * - `judges`: someone was still standing at the hard cap (time limit + `MATCH_RULES.hardCapExtraTicks`),
 *   survivors placed by `JUDGES_ORDER` (a `judges_decision` event explains it);
 * - `capped`: the gym's safety stop for a stalled sim. Never happens in a healthy sim; reports flag it.
 */
export type MatchEnding = 'elimination' | 'time' | 'judges' | 'capped';

/**
 * The closing arena ("zone"). Before sudden death `bounds`, `warning` and the whole map are the same
 * rectangle. Once active the wall closes in by `inset` px from every side at
 * `MATCH_RULES.suddenDeathInsetPerTick`, clamped per axis at `final`, so draw the wall from
 * `bounds`, never from `inset`. Pure helpers in rules.ts answer questions about it
 * (`zoneBoundsAfter`, `zoneTicksToReach`, `zoneEdgeDistance`); brains, render and UI use those
 * instead of re-deriving the wall's motion.
 */
export type SuddenDeathState = {
  active: boolean;
  /** Why it started; null before. */
  reason: SuddenDeathReason | null;
  /** Tick it started; -1 before. */
  startedAtTick: number;
  inset: number;
  /** Current playable rectangle (the whole map until sudden death starts). */
  bounds: Rect;
  /**
   * Where `bounds` will be in `MATCH_RULES.warningTicks` (3 s). The floor's warning band is the
   * area inside `bounds` but outside `warning`. Equal to `bounds` before sudden death and once closed.
   */
  warning: Rect;
  /** The smallest playable rectangle: where the wall stops. Fixed per map; centred on the map. */
  final: Rect;
  /** Tick the wall reached `final`; -1 while it is still moving (or before sudden death). */
  closedAtTick: number;
  /**
   * Escalation level: 0 until the wall stops, then 1 + one per `MATCH_RULES.escalationStepTicks`.
   * Damage outside `bounds` is `suddenDeathDamage + escalationDamage x level` per wall-damage tick.
   */
  escalation: number;
  /**
   * The escalated damage (`escalationDamage x level`) now also hits fighters inside the zone
   * (from `MATCH_RULES.escalationEverywhereTicks` after the wall stops).
   */
  everywhere: boolean;
};

export type WorldState = {
  tick: number;
  mapId: string;
  fighters: FighterState[];
  projectiles: ProjectileState[];
  floor: FloorItem[];
  props: PropState[];
  hazards: HazardState[];
  shrines: { id: string; pos: Vec2; cooldown: number }[];
  /** Power-up pedestals (see PickupState for the respawn ring). */
  pickups: PickupState[];
  /** The closing arena. Use `initialSuddenDeathState(map)` to build the pre-start value. */
  suddenDeath: SuddenDeathState;
  finished: boolean;
  /** How the match ended; null while it runs. */
  ending: MatchEnding | null;
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
  | {
      type: 'dismember';
      /** Who landed the blow that took the limb; null for hazards, kegs nobody broke and sudden death. */
      attackerId: string | null;
      victimId: string;
      limb: Limb;
      pos: Vec2;
      vel: Vec2;
    }
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
      /** Refinement: kind of hazard that landed the kill (also when a squadmate gets the blame), else null. */
      hazard: HazardKind | null;
    }
  | { type: 'explosion'; pos: Vec2; radius: number }
  /**
   * `pos` is where the fighter stood when it used the skill. A SHADOWSTEP moves the fighter on the
   * same tick, so its new position is only in the state (renderers snap instead of interpolating).
   */
  | { type: 'skill'; fighterId: string; skill: SkillId; pos: Vec2 }
  /**
   * A line said. The sim enforces `BARK_RULES.cooldownTicks` per fighter (kill and death lines
   * included) and emits every line it allows; fx decide what to show (`ViewSettings.barks`,
   * `BARK_RULES.keyKinds`, `BARK_RULES.maxVisible`). Lines a brain sets via `Decision.bark` are `taunt`.
   */
  | { type: 'bark'; fighterId: string; kind: BarkKind; text: string }
  | { type: 'footstep'; fighterId: string; pos: Vec2; bloody: boolean }
  /** A fighter took a power-up from its pedestal (`haste`, `berserk`) or spent ammo off the floor. */
  | { type: 'pickup'; fighterId: string; kind: PickupKind | AmmoKind; pos: Vec2 }
  /** A power-up appeared on its pedestal: its first appearance (after `firstSpawnTicks`) and every respawn. */
  | { type: 'pickup_spawn'; pickupId: string; kind: PickupKind; pos: Vec2 }
  | { type: 'heal'; fighterId: string; amount: number; pos: Vec2 }
  | { type: 'hazard'; hazardId: string; victimId: string | null; pos: Vec2 }
  /** Refinement: a prop broke (keg also emits `explosion`; amphora spills acid). */
  | { type: 'prop_break'; propId: string; kind: PropKind; pos: Vec2 }
  | { type: 'sudden_death'; reason: SuddenDeathReason }
  /**
   * The ramp after the wall stopped went up one level (first at the stop, then every
   * `MATCH_RULES.escalationStepTicks`). `damage` is what one wall-damage tick now deals outside the
   * zone; `everywhere` = the escalated part now also hits fighters inside it (true from the first
   * level at which that applies onward).
   */
  | { type: 'escalation'; level: number; damage: number; everywhere: boolean }
  /**
   * The hard cap was reached with fighters still standing. `survivors` in their judged order (1st
   * first), with the numbers the judges used (`JUDGES_ORDER`). `match_end` follows on the
   * same tick.
   */
  | { type: 'judges_decision'; survivors: JudgedFighter[] }
  | { type: 'match_end'; placements: string[]; ending: MatchEnding }
);

/** One survivor's scorecard in a judges' decision. */
export type JudgedFighter = { id: string; hpFraction: number; damageDealt: number; kills: number };

export type GameEventType = GameEvent['type'];

// ---------------------------------------------------------------------------------------------
// Sim -> brain
// ---------------------------------------------------------------------------------------------

/**
 * What one fighter knows about another (fog of war). Enemy records are the observer's own memory,
 * never a window onto the live fighter:
 *
 * - Seen this tick (`seen`): `pos`, `vel`, `facing`, `hp`, `maxHp`, `ammo`, `kills`, `windingUp`
 *   are exact and live; `estimateError` is 0; `lastSeenTick`/`lastSeenPos` are now.
 * - Heard only (`heard`, not seen): `pos` is a fuzzy estimate, never the exact position. The sim
 *   offsets it from the truth by a deterministic per-pair amount between half and all of
 *   `estimateError` (which grows with distance, see `PERCEPTION.hearingError*`), refreshed every
 *   `PERCEPTION.hearingRefreshTicks`. Hearing reveals nothing else: `vel`, `facing`, `hp`,
 *   `maxHp`, `ammo`, `kills` keep their values from the last sighting, `windingUp` is false.
 * - Neither (remembered for up to `PERCEPTION.memoryTicks`): nothing changes. `pos` stays where
 *   it was last seen or heard and does not follow the real fighter.
 *
 * `vel`, `facing`, `hp`, `ammo`, `kills` are therefore "as of `lastSeenTick`" whenever `seen` is
 * false (zero velocity and spawn values if never seen). Ally records are always exact (`seen` true,
 * `estimateError` 0).
 *
 * Consequences the sim enforces: a ranged attack only releases at a target seen this tick; melee
 * may swing at a heard-only target only when its estimate is within reach. Head and torso follow
 * the record, never the live fighter.
 */
export type KnownFighter = {
  id: string;
  squad: number;
  /** Best estimate of where the fighter is now (exact when seen; see above). */
  pos: Vec2;
  /** Velocity at the last sighting (px/tick). Hearing never updates it. */
  vel: Vec2;
  facing: number;
  hp: number;
  maxHp: number;
  weapon: WeaponId;
  family: WeaponFamily;
  /** In vision this tick. */
  seen: boolean;
  /** Heard this tick and not seen. */
  heard: boolean;
  /**
   * Radius (px) of uncertainty around `pos`: 0 while seen; while heard, the fuzz radius for this
   * distance (the truth is between half and all of it away from `pos`); while only remembered,
   * the value from the last perception.
   */
  estimateError: number;
  /** Tick of the last sighting; -1 if this fighter has only ever been heard. */
  lastSeenTick: number;
  /** Where it was last seen (the spawn-time position if never seen; check `lastSeenTick`). */
  lastSeenPos: Vec2;
  /** Attacked or was hit within `PERCEPTION.fightingWindowTicks`, as of the last time seen or heard. */
  fighting: boolean;
  ammo: number;
  /** Refinement: kill count (drives `it.kills`). */
  kills: number;
  /** Refinement: in the windup phase and seen this tick (drives `target.winding_up` and auto-parry). */
  windingUp: boolean;
};

/** Answer of `WorldQuery.nearestPickup`. */
export type PickupInfo = {
  id: string;
  kind: PickupKind;
  pos: Vec2;
  /** On its pedestal right now. */
  ready: boolean;
  /** Seconds until it is back on its pedestal (0 when ready). */
  respawnIn: number;
};

/** Spatial queries the sim answers for brains. All results are deterministic. */
export interface WorldQuery {
  map: MapDef;
  /** Walls and pillars (and the sudden-death boundary) block the segment a-b. */
  losBlocked(a: Vec2, b: Vec2): boolean;
  /** 0 dark .. 1 fully lit, from map ambient + lights whose LOS reaches p. */
  lightAt(p: Vec2): number;
  /**
   * Would `observer` see point p (range, FOV, LOS, shadow rule)?
   * - `observer` is the asking fighter's own FighterState: its true position and head.
   * - `observer` is a KnownFighter (a record from the asker's view, e.g. for `seen_by(target)` or
   *   `target.sees_me`): the answer must use what the asker perceives, never the observer's live
   *   state: the record's `pos` (the estimate) and `facing` (as last seen) for the cone. A record
   *   never seen (`lastSeenTick` < 0) has no known facing: the cone test is skipped (range, LOS and
   *   shadow only). Range and FOV come from the observer's build (weapon and attributes are not secret).
   */
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
  /**
   * Refinement: the hazard nearest p, with its current position (saws move) and radius (drives the
   * `hazard_near(X)` place and the `hazards` zone). The answer is only valid until the next call.
   */
  nearestHazard(p: Vec2): { pos: Vec2; radius: number } | null;
  /**
   * The power-up pedestal of that kind (`any` = either kind) nearest p by straight-line distance,
   * whether or not its power-up is there right now (so a brain can camp one about to respawn), or
   * null when the map has none. Pedestals are map data, so this is not fog-limited. The answer is
   * only valid until the next call.
   */
  nearestPickup(p: Vec2, kind: PickupKind | 'any'): PickupInfo | null;
  /** Number of fighters within r of p that are currently fighting. */
  fightsNear(p: Vec2, r: number): number;
}

export type PerceptionView = {
  tick: number;
  self: FighterState;
  /** Known enemies (seen, heard, or remembered for `PERCEPTION.memoryTicks`). See KnownFighter. */
  known: KnownFighter[];
  allies: KnownFighter[];
  lastAttackerId: string | null;
  /** Refinement: sudden death is running (drives the `sudden_death` sensor). Same as `zone.active`. */
  suddenDeath: boolean;
  /** Refinement: current playable rectangle (the whole map until the sudden-death wall closes in). Same object as `zone.bounds`. */
  arena: Rect;
  /**
   * The closing arena, live and read-only (the same object as `WorldState.suddenDeath`). Drives
   * `zone.distance` (`zoneEdgeDistance`), `zone.time_to_reach` (`zoneTicksToReach`), the
   * `zone_centre` place (centre of `zone.final`) and the `outside_zone` zone (outside `zone.bounds`,
   * or outside `zone.warning` to include the strip the wall reaches within 3 s).
   */
  zone: Readonly<SuddenDeathState>;
  world: WorldQuery;
};

/**
 * What a runtime guard caught: `nan` = NaN or ±Infinity turned into 0; `div_zero` = a division by
 * zero turned into 0; `clamped` = a score or move weight outside its bounds was clamped;
 * `cost` = the per-think evaluation budget ran out and the rest of the think was cut short.
 * A trip in a strategy that passed the gate is a validator bug (it should have been an error).
 */
export type GuardTripKind = 'nan' | 'div_zero' | 'clamped' | 'cost';

/** Trips of one kind at one expression path, e.g. `behaviours.lurk.score` hit `div_zero` 212 times. */
export type GuardTrip = { path: string; kind: GuardTripKind; count: number };

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
  /**
   * Attack permission against `targetId`. The sim still refuses what fog forbids: a ranged shot
   * needs the target seen this tick, a blind melee swing needs a heard target whose estimate is in reach.
   */
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
  /**
   * Runtime guard trips of this brain since the match began: running totals per path and kind
   * (`count` summed over every think so far), so the latest decision always carries the full tally
   * for the inspector badge and the battle report. Empty when clean. A fresh array each think
   * (old decisions keep their numbers).
   */
  guardTrips: GuardTrip[];
  /**
   * Optional line to say. The sim owns barks (spawn, kill, taunts with a global chatter limit), so
   * brains normally leave this unset; a brain bark bypasses the chatter limit (never the
   * per-fighter `BARK_RULES.cooldownTicks`) and counts as a `taunt`.
   */
  bark?: string;
};

/** `rng` is the fighter's own fork; brains must use it (never Math.random) to stay deterministic. */
export interface Brain {
  think(view: PerceptionView, rng: Rng): Decision;
  readonly memory: Record<string, number>;
}

/**
 * What the sim calls once per entrant. The sim hands over `Entrant.strategy` as configured; the
 * factory is the gate's last line: production factories run it through `loadStrategy` and pass
 * only the resulting `ValidStrategy` to `createBrain` (see `gatedBrainFactory` in src/strategy),
 * throwing a clear error for an invalid one. Test factories with scripted brains may skip that.
 */
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
  /**
   * The enemies this fighter currently knows about: the same records its brain reads (see
   * KnownFighter), for fog view, ghost markers, hearing ripples, aim lines and the inspector.
   * Read-only, valid until the next `step()`; empty for an unknown id.
   */
  knowledge(fighterId: string): readonly KnownFighter[];
  result(): MatchResult;
}

export type MatchResult = {
  seed: number;
  mapId: string;
  ticks: number;
  placements: string[];
  ending: MatchEnding;
  fighters: {
    id: string;
    entrantId: string;
    name: string;
    place: number;
    kills: number;
    damageDealt: number;
    damageTaken: number;
    diedAtTick: number | null;
    /** Guard-trip totals of this fighter's brain over the match (`Decision.guardTrips` of its last think). */
    guardTrips: GuardTrip[];
  }[];
};
