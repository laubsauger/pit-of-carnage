# Pit of Carnage — Build Spec

Source of truth for the first build. The full design brief lives in the claude.ai doc
"Pit of Carnage — Design Brief" (https://claude.ai/code/artifact/540265cf-9782-4fb6-9fd2-1a83e0a63814).
This file condenses what builders need. Reference prototypes are in `docs/sample/`:
`(5).html` is older (better bodies, skills, gore, barks), `(6).html` adds vision cones, fog, maps and
props, `(7).html` is the newest and has more character ideas. They are concept references only, not
a style guide and not code to port. Many of their systems are broken or fake: evolution and ELO do
not work (ratings stall at one value while new mutants keep spawning), several controls are unwired.
Never copy their code or structure. Take ideas, then build each system properly, to a professional,
shippable standard. Where you can make something look or read better, innovate.

## Product

An autoplaying gladiator arena. Players never steer fighters. They write strategies (by hand or with
an outside LLM), test them in a private gym against built-in "house stacks", and send them into
free-for-all brawls. Every match produces a battle report used to improve the next strategy.
Tone: comedic slapstick violence, never grimdark. Visual target: reads like a battle-bot or
wrestling broadcast — you always see who hits whom, what happened, and who died.

## Quality bar (non-negotiable)

- **Readable hits.** Every attack telegraphs (windup pose + glow), lands with an impact flash,
  hit-stop, knockback, HP bar drop, sound and blood. A death is an event: slow motion, kill stamp,
  gore burst, crowd reaction.
- **Reasonable speed.** Fixed 60 Hz simulation independent of display refresh. At 1x a fighter
  needs roughly 8-10 seconds to cross the default arena. Director slow-motion around kills.
- **Free-for-all by default**, 8 fighters, on the default pit map.
- **Quiet UI.** Dark stone neutrals, one blood-red accent. Saturated colour only on fighters.
- **Glorious effects on a simple world.** Light, shadow, blood, impact. Effects never hide who
  fights whom: gore lives on the floor layer, fighters always on top with outlines.
- **Performance.** 60 fps with 16 fighters on a laptop. No allocations in per-frame hot paths
  (reuse vectors, pools, instanced meshes).
- **Determinism.** Simulation and brain use only `core/rng.ts`. No `Math.random`, `Date`,
  `performance.now` in `src/sim`, `src/brain`, `src/strategy`. Same config + seed gives the same
  match in the same browser. Rendering may use any randomness (cosmetic only).

## Stack

- Vite + TypeScript (strict) + React 18 for the UI shell only. React never runs in the per-frame path;
  the UI polls/subscribes to a controller at about 10 Hz.
- three.js r186, WebGPU only: `WebGPURenderer` from `three/webgpu`, no WebGL fallback path anywhere
  (never `forceWebGL`, no fallback branches). Without `navigator.gpu` the app shows a clear "WebGPU
  required" message instead of the arena. TSL node materials and shaders from `three/tsl`,
  post-processing with `RenderPipeline` and TSL display nodes (`three/addons/tsl/display/`, e.g.
  BloomNode). Orthographic top-down camera, real shadow maps. Never use WebGL-only APIs: no GLSL
  `ShaderMaterial`, no `onBeforeCompile`, no `EffectComposer`. Never import the plain `three` entry in
  render code (two copies of three break node materials). Call `await renderer.init()` before the
  first frame. Use the most modern three.js idioms; check `node_modules/three` when unsure.
- `fflate` for strategy codes, `openskill` for ratings, `vitest` for tests.
- Plain CSS with variables in `src/ui/theme.css`. No Tailwind.
- Fonts (Google Fonts): Inter (UI), JetBrains Mono (numbers), Bangers (kill stamps and barks only).

## Directory ownership

| Path | Owner | Contents |
| --- | --- | --- |
| `src/core/` | architect, then integrator | Shared types, rng, math, constants, game rules tables, API interfaces. Frozen while modules are built in parallel. |
| `src/sim/` | sim | Deterministic headless simulation: world, maps, combat, perception, hazards, match flow. |
| `src/brain/` | ai | Strategy runtime: registry of sensors/places/zones/move terms, expression parser, evaluator, steering. |
| `src/strategy/` | ai | Validator, JSON Schema + rulebook generation, starter behaviour library, house stacks, strategy codes, LLM prompt builder. |
| `src/render/` (except `fx/`) | render-world | three.js renderer: arena, walls, lights and shadows, fighters, projectiles, camera director, post effects, picking. |
| `src/render/fx/` | render-fx | Gore decals, blood particles, limb streaks, footprints, gibs, sparks, explosions, popups, barks. |
| `src/ui/` | ui | React shell: Watch, Gym, Room screens; HUD; inspector; timeline; strategy editor; match setup. |
| `src/gym/` | gym | Headless batch runner (Web Worker), match recorder, battle reports, ratings, evolution. |
| `src/app/` | integrator | Game loop, controller implementation, wiring, persistence. |
| `src/net/` | later | Multiplayer (Trystero rooms). Not in the first build. |

## Core contracts (`src/core`)

The architect writes these as real TypeScript. Names below are binding; details may be refined.

```ts
// constants.ts
export const TICK_HZ = 60;
export const THINK_EVERY_TICKS = 6;       // brain runs at 10 Hz
export const STEER_DIRS = 16;
export const ATTRIBUTE_BUDGET = 100;
export const ATTRIBUTE_MIN = 4, ATTRIBUTE_MAX = 40;
export const MAX_FIGHTERS = 16;
export const DEFAULT_FIGHTERS = 8;
export const SPEED_SCALE = 0.65;          // global movement slow-down for readability (tunable)

// rng.ts — deterministic, seedable, forkable (sfc32 or mulberry32)
export class Rng { constructor(seed: number); next(): number; range(a: number, b: number): number;
  int(a: number, b: number): number; chance(p: number): boolean; pick<T>(xs: readonly T[]): T;
  fork(label: string): Rng; get state(): number[]; }

// math.ts — Vec2 helpers that write into out-params for hot paths, angle helpers, segment/AABB tests.

// rules.ts — the gameplay tables (see "Gameplay numbers"), each entry with a `doc` string so the
// rulebook generator can document it. WEAPONS, SKILLS, HAZARD_RULES, derived-stat functions.

// types.ts
type Vec2 = { x: number; y: number };
type WeaponId = 'GREATSWORD'|'WARHAMMER'|'TWIN_DAGGERS'|'THROWING_AXES'|'LONGBOW'|'ARCANE_STAFF';
type WeaponFamily = 'melee'|'ranged';
type SkillId = 'WHIRLWIND'|'SHADOWSTEP'|'DASH'|'SHOCKWAVE'|'BLOODRAGE';
type Attributes = { vitality; power; agility; perception; armor; haste: number };
type Limb = 'armL'|'armR'|'legL'|'legR';

// Strategy language pit-strategy/2 (see section below)
type MoveTerm = { weight: number } & (
  { seek: string } | { flee: string } | { keep_range: [string, number, number] } |
  { orbit: [string, 'cw'|'ccw'] } | { avoid: string } | { prefer: string });
type Behaviour = { score: string; move: MoveTerm[]; attack: string; skill?: string;
  set?: Record<string, string>; stance?: 'normal'|'creep'|'guard' };
type BarkKind = 'spawn'|'kill'|'hit'|'low_hp'|'death'|'skill'|'taunt';
type Strategy = { schema: 'pit-strategy/2'; name: string; author?: string; version?: number;
  build: { weapon: WeaponId; skill: SkillId; attributes: Attributes };
  target: string; behaviours: Record<string, Behaviour>; imports?: string[];
  memory?: Record<string, number>; commit: number;
  barks?: Partial<Record<BarkKind, string[] | string>>; look?: { color?: string; glyph?: string } };

type MatchFormat = 'ffa'|'squads'|'duel';
type Entrant = { id: string; strategy: Strategy; squad: number; name: string; color: string };
type MatchConfig = { seed: number; mapId: string; format: MatchFormat; entrants: Entrant[];
  friendlyFire: boolean; timeLimitTicks: number; suddenDeath: boolean };

type Rect = { x: number; y: number; w: number; h: number };
type LightDef = { id: string; pos: Vec2; radius: number; intensity: number; color: string;
  flicker: number; castsShadow: boolean };
type HazardDef = { id: string; kind: 'spike'|'saw'|'acid'|'fire'; pos: Vec2; radius: number;
  path?: Vec2[]; period?: number };
type PropDef = { id: string; kind: 'keg'|'amphora'|'crate'; pos: Vec2; radius: number };
type MapDef = { id: string; name: string; width: number; height: number; floor: 'sand'|'stone'|'flesh';
  ambient: number; walls: Rect[]; pillars: Rect[]; lights: LightDef[]; hazards: HazardDef[];
  props: PropDef[]; shrines: { id: string; pos: Vec2 }[];
  pickups: { id: string; kind: 'haste'|'berserk'; pos: Vec2 }[]; spawns: Vec2[] };

type AnimPhase = 'idle'|'windup'|'strike'|'recovery';
type FighterState = { id: string; entrantId: string; squad: number; name: string; color: string;
  weapon: WeaponId; skill: SkillId; attributes: Attributes;
  pos: Vec2; vel: Vec2; facing: number; headAngle: number; radius: number;
  hp: number; maxHp: number; alive: boolean; diedAtTick: number | null;
  anim: { phase: AnimPhase; t: number; dur: number }; walkPhase: number;
  attackCd: number; skillCd: number; parryTicks: number; parryCd: number; stunTicks: number;
  ammo: number; maxAmmo: number; buffs: { haste: number; berserk: number; slow: number };
  limbs: Record<Limb, boolean>; helmet: boolean; inShadow: boolean; hitFlash: number; eyePop: number;
  behaviour: string; targetId: string | null; kills: number; damageDealt: number; damageTaken: number;
  lastHitBy: string | null; place: number | null };
type ProjectileState = { id: string; ownerId: string; weapon: WeaponId; pos: Vec2; vel: Vec2; ttl: number };
type FloorItem = { id: string; kind: 'arrow'|'axe'|'weapon'|'helmet'; pos: Vec2; ownerId: string | null };
type PropState = PropDef & { alive: boolean };
type HazardState = HazardDef & { phase: number; active: boolean; pos: Vec2 };
type WorldState = { tick: number; mapId: string; fighters: FighterState[];
  projectiles: ProjectileState[]; floor: FloorItem[]; props: PropState[]; hazards: HazardState[];
  shrines: { id: string; pos: Vec2; cooldown: number }[];
  suddenDeath: { active: boolean; inset: number }; finished: boolean; placements: string[] };

type KillCause = 'weapon'|'skill'|'hazard'|'keg'|'friendly'|'sudden_death';
type GameEvent = { tick: number } & (
  | { type: 'swing'; fighterId: string; weapon: WeaponId }
  | { type: 'hit'; attackerId: string; victimId: string; amount: number; pos: Vec2; dir: number;
      crit: boolean; backstab: boolean; weapon: WeaponId | null; knockback: number }
  | { type: 'parry'; fighterId: string; attackerId: string; pos: Vec2 }
  | { type: 'projectile'; projectileId: string; ownerId: string; weapon: WeaponId; pos: Vec2; dir: number }
  | { type: 'projectile_end'; projectileId: string; pos: Vec2; hitId: string | null }
  | { type: 'dismember'; victimId: string; limb: Limb; pos: Vec2; vel: Vec2 }
  | { type: 'kill'; killerId: string | null; victimId: string; cause: KillCause; pos: Vec2; dir: number;
      title: string; killerBehaviour: string | null; victimBehaviour: string }
  | { type: 'explosion'; pos: Vec2; radius: number }
  | { type: 'skill'; fighterId: string; skill: SkillId; pos: Vec2 }
  | { type: 'bark'; fighterId: string; text: string }
  | { type: 'footstep'; fighterId: string; pos: Vec2; bloody: boolean }
  | { type: 'pickup'; fighterId: string; kind: string; pos: Vec2 }
  | { type: 'heal'; fighterId: string; amount: number; pos: Vec2 }
  | { type: 'hazard'; hazardId: string; victimId: string | null; pos: Vec2 }
  | { type: 'sudden_death' }
  | { type: 'match_end'; placements: string[] });

// Sim -> brain
type KnownFighter = { id: string; squad: number; pos: Vec2; vel: Vec2; facing: number; hp: number;
  maxHp: number; weapon: WeaponId; family: WeaponFamily; seen: boolean; heard: boolean;
  lastSeenTick: number; lastSeenPos: Vec2; fighting: boolean; ammo: number };
interface WorldQuery {
  map: MapDef;
  losBlocked(a: Vec2, b: Vec2): boolean;           // walls and pillars
  lightAt(p: Vec2): number;                         // 0 dark .. 1 fully lit, from map lights + LOS
  inVisionOf(observer: KnownFighter | FighterState, p: Vec2): boolean;
  wallDanger(from: Vec2, dirX: number, dirY: number, lookahead: number): number; // 0..1
  hazardDanger(from: Vec2, dirX: number, dirY: number, lookahead: number): number;
  coverFrom(from: Vec2, threat: Vec2, maxDist: number): Vec2 | null;
  nearestShrine(p: Vec2): { pos: Vec2; ready: boolean } | null;
  nearestFloorItem(p: Vec2, kinds: string[]): Vec2 | null;
  nearestProp(p: Vec2, kind: string): Vec2 | null;
  fightsNear(p: Vec2, r: number): number;
}
type PerceptionView = { tick: number; self: FighterState; known: KnownFighter[];
  allies: KnownFighter[]; lastAttackerId: string | null; world: WorldQuery };
type Decision = { behaviour: string; scores: Record<string, number>; targetId: string | null;
  heading: number; speed: number; ring: number[];
  terms: { label: string; ratings: number[] }[];
  attack: boolean; parry: boolean; useSkill: boolean; bark?: string };
interface Brain { think(view: PerceptionView, rng: Rng): Decision; readonly memory: Record<string, number> }
type BrainFactory = (strategy: Strategy) => Brain;

// Sim API
interface Match { readonly config: MatchConfig; readonly map: MapDef; readonly state: WorldState;
  readonly isOver: boolean; step(): GameEvent[]; lastDecision(fighterId: string): Decision | null;
  result(): MatchResult; }
type MatchResult = { seed: number; mapId: string; ticks: number; placements: string[];
  fighters: { id: string; entrantId: string; name: string; place: number; kills: number;
    damageDealt: number; damageTaken: number; diedAtTick: number | null }[] };
// createMatch(config, brainFactory): Match; stateHash(state): string; MAPS: Record<string, MapDef>

// render-api.ts
interface GameRenderer { setMap(map: MapDef): void;
  render(prev: WorldState, curr: WorldState, alpha: number, frameDt: number): void;
  onEvents(events: GameEvent[], state: WorldState): void;
  setSelected(id: string | null): void; setHovered(id: string | null): void;
  setOverlay(o: { cones: 'off'|'selected'|'all'; rings: boolean; names: boolean; fog: boolean }): void;
  setDecisionProvider(fn: (fighterId: string) => Decision | null): void;
  pick(clientX: number, clientY: number): string | null;
  setTimeScale(s: number): void;  // lets fx slow down with the director
  resize(w: number, h: number): void; captureStream(fps: number): MediaStream; dispose(): void }
interface RenderContext { renderer: THREE.WebGPURenderer; scene: THREE.Scene; camera: THREE.Camera;
  map: MapDef; floorDecalTarget: THREE.RenderTarget; floorSize: Vec2;
  fighterVisual(id: string): THREE.Object3D | null; }
interface FxModule { init(ctx: RenderContext): void; onEvents(events: GameEvent[], state: WorldState): void;
  update(frameDt: number, state: WorldState, alpha: number): void; dispose(): void }

// controller.ts — what the UI talks to (integrator implements; ui builds a mock)
interface GameController {
  getSnapshot(): UiSnapshot; subscribe(fn: () => void): () => void;   // notifies ~10 Hz
  startMatch(config: MatchConfig): void; restart(): void;
  setPaused(p: boolean): void; stepTicks(n: number): void; setSpeed(s: number): void;
  seek(tick: number): void; select(id: string | null): void; hover(id: string | null): void;
  setOverlay(o: Partial<{ cones: 'off'|'selected'|'all'; rings: boolean; names: boolean; fog: boolean }>): void;
  decision(id: string): Decision | null; mountCanvas(el: HTMLElement): void;
  strategies: StrategyStore; gym: GymApi; }
type UiSnapshot = { tick: number; speed: number; paused: boolean; mapId: string; format: MatchFormat;
  fighters: Pick<FighterState,'id'|'name'|'color'|'hp'|'maxHp'|'alive'|'kills'|'weapon'|'skill'|'behaviour'|'place'|'squad'>[];
  feed: { tick: number; text: string; kind: string; ids: string[] }[];
  marks: { tick: number; kind: 'kill'|'big_hit'|'dismember' }[];
  selectedId: string | null; hoveredId: string | null; finished: boolean; placements: string[] };
interface StrategyStore { list(): SavedStrategy[]; save(s: Strategy): SavedStrategy;
  versions(name: string): SavedStrategy[]; remove(id: string): void; }
type SavedStrategy = { id: string; name: string; version: number; savedAt: number; strategy: Strategy; code: string };
interface GymApi { runBatch(req: BatchRequest, onProgress?: (done: number, total: number) => void): Promise<BatchResult>; cancel(): void }
type BatchRequest = { candidates: Strategy[]; field: Strategy[]; mapIds: string[]; matches: number;
  fighters: number; seed: number };
type BatchResult = { reports: MatchReport[]; aggregate: AggregateReport };
// MatchReport / AggregateReport are defined in core/report-types.ts (see "Battle reports").
```

## Gameplay numbers (starting values, from the older sample)

Movement is in px per tick at 60 Hz, multiplied by `SPEED_SCALE`.

- Max HP = 150 + vitality x 8.5. Radius = 15.5 + vitality x 0.18 + armor x 0.14.
- Move speed = (2.2 + agility x 0.068 - armor x 0.015) x SPEED_SCALE px/tick.
- Turn rate = (2.4 + agility x 0.145 - armor x 0.032) rad/s, clamped 1.6-7.4.
- Armor mitigation 1.6% per point, cap 48%. Power: +2.4% damage per point.
- Vision range = 255 + perception x 9.5 + weapon vision bonus. FOV 1.35-2.55 rad.
  Hearing radius = 115 + perception x 4.2 (x1.15 if target moves fast, x0.72 if slow/creeping).
- A target in shadow (light < 0.35) is seen only within 45% of normal vision range.
- Backstab: hit within 1.05 rad of the victim's back, x1.45 (daggers x2.35).
- Crit: 25% chance on hits >= 28 damage, x1.35.
- Parry: lasts 30 ticks, cooldown 135, reflects 65% damage, stuns the attacker 40 ticks.

| Weapon | Family | Range px | Damage | Cooldown ticks | Windup ticks | Special |
| --- | --- | --- | --- | --- | --- | --- |
| GREATSWORD | melee | 82 | 30 | 42 | 14 | arc 2.35 rad, cleaves |
| WARHAMMER | melee | 70 | 26 | 44 | 15 | stun 34, big knockback |
| TWIN_DAGGERS | melee | 56 | 16 | 18 | 6 | backstab x2.35 |
| THROWING_AXES | ranged | 265 | 21 | 26 | 8 | speed 10.6, 4 axes, must pick up |
| LONGBOW | ranged | 430 | 20 | 33 | 11 | speed 12.2, slow 75, 10 arrows, must pick up |
| ARCANE_STAFF | ranged | 375 | 25 | 43 | 12 | speed 9.6, splash 72, mana regen instead of ammo |

Projectiles stop at the first wall, pillar, prop or fighter in their path (any fighter, so crowds
take stray shots). Shields: WARHAMMER and GREATSWORD users in `guard` stance block arrows from the front.

| Skill | Effect |
| --- | --- |
| WHIRLWIND | radius 92, damage 25 + power x 0.55 to everyone around |
| SHADOWSTEP | teleport 36 px behind the target |
| DASH | impulse 14 plus haste for 65 ticks |
| SHOCKWAVE | parry 48 + stun 36 + 19 damage in a cone |
| BLOODRAGE | berserk + haste for 145 ticks |

Skill cooldown = 205 - haste x 3.1 ticks.

Hazards: shrine heals 42% max HP, cooldown 320. Haste pickup x1.45 speed 200 ticks. Berserk +35%
damage 200 ticks. Spike 36 damage at 0.88 of its period. Saw 22 damage every 12 ticks. Keg blast
38 damage radius 106, knockback, sets `explosion`. Acid pool 11 damage every 24 ticks, lasts 400.

Dismemberment: a hit of >= 24 damage on a fighter below 50% HP has a 30% chance to sever a limb.
No weapon arm: punches for 6. No leg: speed x0.55 and a hop animation. Death throws 8-10 gibs
(skull, jaw, ribcage, heart, 2 eyeballs, intestine, leg, boot, weapon arm).

Match flow: placement = reverse order of death; last fighter standing is 1st. After
`timeLimitTicks` (default 90 s) sudden death starts: the arena wall insets inward over time and
saws speed up. Friendly fire on by default in squads.

## Maps (first build)

- `pit` (default, balanced): mirrored on both axes. Lit centre with shrine (open sand); ring of 8
  pillars around it; open lanes along the top and bottom edges (ranged); gate halls with doorways on
  the left and right (melee); dark corner alcoves with a torch at each mouth (stealth). Kegs near the
  pillar ring. Spawns evenly between pillar ring and walls. 1360 x 860.
- `pillar_forest`: dense pillars, short sightlines (ambush).
- `catacombs`: dark rooms joined by corridors, torch pools (stealth, hearing).
- `meat_grinder`: narrow corridors and doorways, moving saws (melee).

## Strategy language (pit-strategy/2)

A strategy is a set of behaviours composed from documented primitives. No black-box verbs.

Each think tick (every 6 ticks): perception updates what the fighter knows; every behaviour's
`score` expression is evaluated; the current behaviour gets +0.25 until `commit` ticks have passed
since it started (hysteresis); the highest score wins. Its move terms each rate 16 directions in
[-1, 1]; the weighted sum minus wall/hazard danger picks the heading (context steering, smoothed).
Its `attack` and `skill` policies decide actions. Parry is automatic: chance per tick =
clamp(score of `parry` policy) when the target winds up within reach — keep it simple: behaviours may
set `"parry": "<expr>"` in a later version; for now parry chance = 0.35 x perception/40 when facing the attacker.

- Expressions: numbers, sensor paths, `+ - * /`, comparisons, `and or not`, `min max clamp abs`,
  parentheses. Booleans are 1/0. Parsed once to an AST, evaluated without `eval`. Unknown names are
  validation errors with "did you mean" suggestions.
- Target expression is evaluated per known enemy with `it.*` bound to that candidate; highest wins.
- Sensors (initial set, all documented in the registry with unit and range):
  `self.hp` (0-1), `self.hp_abs`, `self.ammo`, `self.in_shadow` (0/1), `self.light` (0-1),
  `self.speed`, `self.stunned`, `self.seen` (anyone sees me), `self.limbs`, `skill.ready`,
  `attack.ready`, `target.distance` (px), `target.hp`, `target.facing_away` (0/1),
  `target.sees_me`, `target.family_ranged` (0/1), `target.winding_up`, `target.ammo`,
  `target.fighting`, `enemies_seen`, `enemies_known`, `enemies_near` (within 200 px),
  `fights_nearby`, `allies_alive`, `shrine.ready`, `shrine.distance`, `time` (seconds),
  `sudden_death`, `since_hit` (ticks since I was hit), memory slots by name.
  In target expressions: `it.distance`, `it.hp`, `it.facing_away`, `it.sees_me`, `it.ranged`,
  `it.fighting`, `it.last_attacker`, `it.kills`.
- Places: `target`, `nearest_enemy`, `last_attacker`, `behind(X, d)`, `side(X, deg, d)`,
  `cover_from(X)`, `shrine`, `ammo`, `last_seen(X)`, `centre`, `ally`, `nearest_keg`,
  `hazard_near(X)`.
- Zones: `shadow`, `lit`, `seen_by(X)`, `seen_by(enemies)`, `hazards`, `open`, `walls`.
- Move terms: `seek P`, `flee P`, `keep_range [P, min, max]`, `orbit [P, cw|ccw]`, `avoid Z`,
  `prefer Z` (exact definitions in the brief; the registry is the source of truth).
- Attack policies: `in_range`, `never`, `if_blocked`, or any expression.
- Limits: at most 8 behaviours, 6 move terms each, 12 memory slots.
- One registry in `src/brain/registry.ts` defines every sensor, place, zone and term with doc, unit
  and range. `src/strategy` generates the JSON Schema, the validator vocabulary and the LLM rulebook
  from it.
- Starter library (written in the language itself): `lurk`, `kite`, `backstab`, `brawl`, `heal`,
  `bait`, `guard_corner`, `third_party`. House stacks: at least 8 distinct strategies covering every
  weapon and several play styles, each with a funny name and barks.

## Battle reports (`src/core/report-types.ts`, built by gym)

- `MatchReport`: seed, mapId, roster (entrant, strategy name + version, weapon), placements,
  duration, kills (killer, victim, weapon, tick, pos, cause, flags, killerBehaviour, victimBehaviour),
  per-fighter behaviour usage (ticks per behaviour, behaviours that never won), exposure (ticks seen,
  ticks in shadow), damage by source.
- `AggregateReport` per strategy: placement histogram, average place, win rate by map and by
  opponent, killed-most-by, findings (plain sentences computed in code), openskill rating.
- `reportToText()`: compact plain-text summary for pasting into an LLM, followed by JSON.

## Rendering direction

- Orthographic camera looking straight down, slight perspective feel through shadows only.
  Camera director: frames the action, follows the selected fighter on demand, eases zoom toward
  big moments, subtle shake capped and decaying.
- Floor: plane with subtle procedural stone/sand texture + the gore decal render target composited
  on top (multiply). Walls and pillars: low extruded boxes with bevel-ish shading, cast shadows.
- Lights: dim ambient + map torches (PointLight, few casting shadows, flicker). Explosions flash.
- Fighters: top-down bodies in the older sample's style — striding boots, torso ellipse in team
  colour, pauldrons by armor, head circle, class helmet, eyes that pop, oversized weapon with
  four-phase animation (windup/strike/recovery/idle). Dark outline for readability. Name tag and
  thin HP bar above each fighter. Hit flash white. Built from simple meshes or canvas-drawn sprite
  atlases; must stay crisp at any zoom.
- Overlays: vision cones (soft, low alpha), steering ring for the selected fighter, target line.
- Post: bloom on emissive (fire, sparks, staff orbs), vignette, kill punch (brief chromatic/colour
  grade), optional film grain, all as TSL nodes in one `RenderPipeline`.
- Particles: TSL compute (`renderer.compute`) with storage buffers.
- FX: blood multiplied into the floor (maroon to arterial red, wet highlight), splat masks with
  random rotation/scale/stretch, droplets as instanced particles that splat on landing, limb
  streaks stamped along the slide path thinning with speed, stump spurts, bloody footprints, gibs
  drawn as their part with spin and bounce, sparks on parry, dust on footsteps, Bangers kill stamps
  with elastic overshoot, barks in speech bubbles.

## UI direction

- Screens: Watch (arena full-bleed, thin overlays), Gym (strategy editor, batch runs, reports),
  Room (placeholder for multiplayer: leaderboard from local results).
- Watch HUD: top-left scoreboard (alive first, dead greyed with place), top-centre match clock and
  speed, right-side kill feed (short, fades), bottom timeline scrubber with kill marks, hover card,
  pinned inspector panel (behaviours with live score bars, steering ring, sensors, damage stats),
  keyboard: Tab cycle, F follow, Space pause, arrows step, 1-5 speed presets.
- Match setup: map, fighter count (2-16), format (FFA default / squads with size / duel), which
  strategies fill the slots, seed.
- Strategy editor: JSON with live validation errors, point budget meter, "Copy LLM prompt"
  (rulebook + strategy + last report), import/export strategy code, save version.
- Palette: stone neutrals (#0e0d0c, #161412, #1f1c19, #2a2622, #3a352f, text #e8e2d9 / #a39a8e),
  accent blood red #c4302b. Fighter colours: 16 distinct, high-chroma, colour-blind-aware set.

## Copy and voice

The samples' copy ("GEN N BREAKTHROUGH — WATCH THE META SHIFT!", "obliterated" as the only kill verb,
emoji everywhere) reads generic. Write like a dry, funny sports broadcast:

- Specific over hype: "Apologetic Gary takes the Pit — 4 kills, never seen once." beats "VICTORY!!".
- Vary kill lines by cause and weapon: "Gary opened Brenda like a letter.", "Brenda tripped into the saw.",
  "Doug was hit by his own keg. Classic Doug." (fighters are named by their strategy name).
- Evolution and meta updates name what changed: "New contender: Lurking Daggers v3 beats the
  house stacks 7 of 10 on the Pit." Not "META SHIFT".
- Interface labels are plain and short ("Fight", "Next match", "Copy for LLM"). No emoji in UI chrome.
- Kill stamps (Bangers) are 1-3 words: "BACKSTAB", "SPLIT", "SAWED", "OWN GOAL", "DOUBLE KILL".

## Rules for every builder

- Edit only your owned paths. `src/core` is frozen during the parallel build: if you need a change
  there, define a local type and list the requested change in your final report.
- Do not run `npm install` or edit `package.json`; dependencies are fixed. List missing deps in your report.
- Do not commit. Never run `git checkout`, `git reset`, `git stash` or any destructive git command.
- Tests: vitest, colocated `*.test.ts`. Tests must state why a behaviour matters (comment or name)
  and must be able to fail when the logic changes.
- `npx tsc --noEmit` may show errors from other modules still in progress; fix only yours.
- Keep code simple and direct; no speculative abstraction. Match the style of existing files.
