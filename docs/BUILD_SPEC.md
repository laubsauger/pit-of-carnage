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

### Sudden death and stalemates (must hold)

The sim already insets the arena walls after the time limit. Make the guarantee complete:

- **The closing wall is solid and it hurts.** Today it is not: movement ignores it, so fighters stand
  behind it and only take a small periodic tick with a 4 px shove. Make it a physical, moving barrier:
  movement and knockback clamp every fighter inside the playable rectangle; the advancing wall pushes
  anyone it reaches inward with a strong knockback impulse every tick of contact, whether they move
  or not (it is impenetrable: push, push, push), with a hard clamp as backstop; touching it deals contact damage every tick of contact (grinding spikes)
  with a visible spark/blood effect; a fighter pinned between the wall and a wall, pillar or prop is
  crushed (big damage, "CRUSHED" stamp). Nobody can ever end up outside it. Test: after sudden death
  starts, no living fighter is ever outside the bounds for more than one tick.
- **Stalemate trigger.** Sudden death also starts early when no fighter has dealt damage for 15 s,
  so hiding forever or getting stuck cannot stall a match.
- **Escalation.** The wall closes to its minimum size; after that, damage outside the safe zone and
  then everywhere ramps up each second, so every match ends with deaths.
- **Absolute cap.** If anyone is still standing at the hard cap (time limit + 60 s), the match ends
  with a "judges' decision": survivors placed by HP fraction, then damage dealt, then kills. Logged in
  the report, never silent.
- **Strategies can respond.** Sensors `sudden_death` (0/1), `zone.distance` (px from me to the
  closing wall), `zone.time_to_reach` (s until the wall reaches me); place `zone_centre`; zone
  `outside_zone`. Documented in the registry and rulebook like everything else.
- **Visible and announced.** The closing wall is unmistakable (grinding spiked wall or a rising
  blood tide), the floor shows a warning band where the wall will be in 3 s, and the feed announces
  it in the broadcast voice ("The walls are closing. Somebody do something.").

### Balance: ranged vs melee (must hold)

Kiting is easy and closing in is hard, so the numbers must make melee worth it. The starting table
above is a first guess (a longbow does about 36 damage per second from 430 px, a greatsword about 43
from 82 px, which favours the bow). Tune `src/core/rules.ts` until the targets below hold.

- **Kiting costs.** Moving away from where you face is slow (speed x 0.55 straight backwards, scaling
  up to full speed moving forwards). Ranged attackers plant to shoot: move speed x 0.3 during windup
  and recovery, and they must face the target within a small angle to release.
- **Shots are not free.** Spread grows with the shooter's speed and with distance; aim prediction is
  imperfect. Point-blank shots (under 80 px) do half damage. Ammo must be picked up again.
- **Melee hits harder up close.** Melee damage per second about 1.5-1.8x ranged; a melee hit
  interrupts a ranged windup (stagger); each melee swing lunges 20-40 px; melee builds move about 10%
  faster; shields in guard stance block projectiles from the front.
- **Measured, not guessed.** A balance harness in the gym runs (a) weapon-vs-weapon duels on the pit
  with comparable house stacks over many seeds and (b) 8-fighter FFAs on the map pool. Targets: every
  duel pairing between 35% and 65%; in FFA each weapon family wins between 0.67x and 1.5x its fair
  share on the pit. Results and the final numbers go to `docs/BALANCE.md`, re-run after any rules
  change.

### Power-ups must matter (must hold)

Today no strategy can even ask for a power-up: the vocabulary knows `shrine` but not the haste and
berserk pickups, and `WorldQuery` has no pickup lookup. Fix the whole chain:

- **Core.** `WorldQuery.nearestPickup(p, kind: 'haste'|'berserk'|'any')` returning position, `ready` and
  seconds until respawn.
- **Vocabulary.** Sensors `pickup.haste.ready`, `pickup.haste.distance`, `pickup.berserk.ready`,
  `pickup.berserk.distance`, `pickup.any.distance`, `pickup.respawn_in`; places `pickup(haste)`,
  `pickup(berserk)`, `nearest_pickup`. Documented in the rulebook with what each power-up does.
- **Library and house stacks.** Starter behaviours `grab_powerup` and `deny_powerup` (camp near one
  that is about to respawn). At least three house stacks use power-ups, including one whose whole plan
  is item control.
- **Worth a detour.** Power-ups are strong, short and visible: glowing pedestal, a ring that fills up
  to show the respawn timer, an announcer line when one comes back ("Berserk is up."). On the pit
  they sit in contested spots so grabbing one is a risk.
- **Reported.** Battle reports count pickups taken and what they bought ("Took berserk 4 times, 3
  kills while berserk"); findings flag strategies that never touch them.

### Core balance and expressiveness pass (after pass 1, before the roster)

The user sees the arcane staff dominate everything: it fires too often and too fast and nobody has
an answer. Treat the current numbers as untested. A dedicated pass, measured with the balance
harness, must:

- **Find the crazy imbalances in the core**, starting with ARCANE_STAFF (cooldown, projectile speed,
  splash, homing-like accuracy, mana regen) and every other weapon, skill, stat formula and hazard.
  Each weapon's damage per second, effective range, time-to-kill and counterplay are written down
  with the reasoning (projectiles can be dodged, blocked and body-blocked; melee cannot be dodged
  once in reach but must close in), in `docs/BALANCE.md`.
- **Give strategies more ways to express ideas**, so an LLM can invent non-standard tactics: consider
  more skills (skill shots, traps, decoys, grabs and throws, a shield bash, a smoke bomb, a taunt),
  per-build traits or perks bought from the point budget, and any sensor or place that a reasonable
  tactic needs but cannot express today. Every addition goes through the registry, rulebook and
  validator like the rest.
- **Bleed as a candidate mechanic** (user is open to it; adopt only if the harness shows it adds
  variety without dominating). Sketch: a lost limb always bleeds; some sources add bleed stacks
  (dagger backstabs, a "serrated" perk bought from the budget); small damage over time per stack;
  shrines cure it. It creates tactics: hit-and-run against a bleeding target, retreat to a shrine when
  bleeding. It ties into fog of war: bleeding fighters leave a drip trail that hunters can follow even
  out of sight (sensors `self.bleeding`, `target.bleeding`; place `blood_trail(target)`).
- **Keep the meta open.** No single build or weapon may win the evolution or the balance harness by
  a wide margin; diversity is measured, not assumed. The meta may evolve later, but it must not start
  converged.
- **Then crystallize the roster** (see "Shipped roster"): an automated, reproducible gym pipeline
  (`npm run roster`) that searches, tests and selects the 16 house strategies and writes
  `docs/ROSTER.md`. The current house stacks are considered untested placeholders.

### Fog of war must hold (must fix)

Fighters currently look omniscient: after losing line of sight they keep turning and aiming at the
enemy. Cause found in the first build: hearing is 360 degrees, works through walls and writes the
exact live position and velocity into the memory record every tick, and fighting counts as loud, so
anyone in a fight is tracked perfectly through walls. Head and torso then follow that record.

- **Hearing is fuzzy.** A heard-only target gives an estimate, not a position: error grows with
  distance (deterministic per pair, refreshed about twice a second), no velocity, no facing, no HP.
  Hearing through a wall uses a smaller radius.
- **Losing sight means losing the target.** Once unseen, the record keeps the last seen position and
  velocity; the estimate does not follow the real fighter. Ranged attacks need a seen target; melee
  may swing blind only at a heard target within reach.
- **Search instead of stare.** The head looks at the last seen spot, then scans. New vocabulary:
  sensors `target.visible`, `target.heard`, `target.last_seen_age` (s); `target.distance` is the
  distance to the current estimate; places `last_seen(target)` and `search_point` (an expanding
  sweep around the last seen spot). Starter behaviour `search`; house stacks use it.
- **Show what they know.** Fog view, aim lines and the inspector reflect the fighter's knowledge:
  a ghost marker at the last seen spot with "lost sight 2.3 s ago", hearing shown as a rough ripple,
  never an exact marker.
- **Tested.** Invariant tests: a target behind a wall beyond hearing range can move freely without
  the record changing; a heard-only estimate is never exact; a fighter never fires a projectile at a
  target it cannot see.

### Shipped roster (after the build, in the gym)

Develop the 16 strategies that ship as house stacks, using the gym rather than guesswork:

- **Diverse by construction.** Cover all six weapons and clearly different plans (ambush from shadow,
  corner holder, third-partier, kiter, power-up controller, shrine camper, brawler, berserker,
  hunter-searcher, bait-and-trap, squad-friendly support ...). Each has a distinct name, colour, glyph
  and voice.
- **Competitive, measured.** Round-robin matrices of duels and many 8-16 fighter FFAs across the map
  pool and seeds. Every roster strategy must hold an average FFA place inside a band around the
  middle and win somewhere; none may dominate (cap its overall win share). Rate with openskill.
- **No convergence.** Use MAP-Elites niches plus hand tuning; reject candidates that behave like an
  existing roster member (compare behaviour-usage profiles, positions held, preferred range). The
  roster must not collapse into one archetype with different names.
- **Documented.** `docs/ROSTER.md`: each strategy's idea, niche, strengths, counters, win rates by map
  and the matrix, regenerated by a script.

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

## Strategy validation and safety

No strategy reaches the brain or the sim without passing one gate. Imported files, pasted JSON,
strategy codes, saved versions, house stacks, evolution children and (later) network peers all go
through the same `loadStrategy(input, source)` and get the same report.

- **One gate, branded result.** `loadStrategy` returns `{ strategy?: ValidStrategy, errors, warnings }`.
  `createBrain` accepts only `ValidStrategy` (a branded type), so unvalidated JSON cannot compile.
- **Errors block loading.** Invalid JSON (with line and column), wrong or missing `schema` version,
  unknown properties anywhere (with "did you mean"), wrong types, out-of-range numbers, non-finite
  numbers, attribute budget overrun, unknown sensors/places/zones/terms/policies, expression syntax
  errors, limits exceeded (behaviours, move terms, memory slots, expression length and AST depth,
  string lengths for names and barks), duplicate names, `keep_range` min above max.
- **Warnings lint but allow.** A behaviour whose score can never win, memory written but never read
  (or read but never written), all move weights zero, a strategy that can never attack, an import that
  shadows a local behaviour, unused imports, expressions that are constant.
- **Precise locations.** Every issue carries a JSON path and, when the input was text, line and column,
  so the editor underlines it and the problem list jumps to it. Messages are one line, plain English,
  with a suggested fix that can be pasted back to an LLM.
- **Static analysis before runtime.** Anything a runtime guard could catch is reported at load time.
  Every sensor declares its range in the registry; the validator propagates value intervals through
  each expression AST and reports: a divisor whose range includes 0, a score or weight whose range
  exceeds the clamp bounds (with the range it can reach), comparisons that are always true or false,
  constant expressions, behaviours whose best score is below another behaviour's worst score
  (unreachable), and the static evaluation cost per think (AST nodes x move terms x behaviours)
  against the budget. Cost over budget is an error, so the runtime cap never fires for a valid
  strategy. The language has no loops or recursion, so a strategy cannot loop forever by construction;
  the rulebook says so.
- **Runtime guards, never silent.** As a second line of defence the evaluator turns NaN and
  infinities into 0, division by zero yields 0, scores and weights are clamped, evaluation cost per
  think is bounded, and the sim never accepts a non-finite heading or speed. Every guard trip is
  counted per fighter and per expression path, shown as a badge in the inspector, listed in the
  battle report ("Guard trips: behaviours.lurk.score hit division by zero 212 times") and included in
  the LLM summary. A guard trip in a strategy that passed static analysis is a validator bug and gets
  a test.
- **Tooling.** The generated JSON Schema is published at `public/pit-strategy-2.schema.json` so editors
  can use `$schema`. `npm run lint:strategy <file>` validates files from the command line (handy in
  an LLM loop). Fuzz tests feed thousands of random and mutated strategies through the gate; every
  accepted one runs a short match without NaN or a crash.
- **Import UI.** Drag and drop or pick `.json` files, paste text or a strategy code; the import dialog
  shows the report before anything is saved; errors block, warnings can be accepted.

## Gym: watch and understand any match (user feedback)

Knowing a strategy lost is useless without seeing why. Every gym match is deterministic, so any of
them can be rebuilt exactly:

- **Watch from anywhere.** Each match row in a batch report and each evolution archive entry has
  Watch (same seed, same fight in the arena). One-click shortcuts: "Watch worst loss", "Watch best
  win", "Watch a typical match" for the selected strategy. Opening a match can jump straight to a
  chosen kill or to the candidate's death, and the timeline is pre-filtered to the candidate.
- **Back to the gym.** The watch view shows which batch it came from and returns to the same report.
- **More numbers per fighter, for humans and LLMs:** distance travelled, attacks, hits, accuracy,
  damage dealt and taken by source and per second while engaged, time to first contact, ticks idle
  or stuck, time in each behaviour, time seen and in shadow, time near walls and in the sudden-death
  zone, pickups and kills while buffed, skill uses and hit rate, parries, kill participation, cause
  of death, and a coarse position heatmap per map (drawn in the UI, summarised in words for the LLM:
  "spent 62% of the match in the dark corners").
- **Compare.** Two strategies or two versions side by side over the same seeds, with the numbers above
  and their heatmaps.

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

### First-look feedback from the user (must fix)

- **Blood must stay on the floor.** Splats appear only occasionally and nothing persists. Every hit
  stamps blood into the floor decal target and it stays visible for the whole match; verify the floor
  material really composites the decal target (screenshot after 30 s of fighting must show red floor).
- **Much more blood, comic exaggeration.** Hits spray, big hits gush, and a death is an explosion:
  gib burst, blood fountain, radial splatter painted far across the floor, screen punch. Cartoon
  excess, not realism.
- **Projectile impacts are colour-coded by projectile.** Each projectile has its own colour and its
  own impact effect, and its trail uses the same colour so a hit reads at a glance: arrows → wood
  splinters + a small spray; thrown axes → metallic sparks + a clang flash; staff orbs → arcane
  burst and ring in the orb colour; kegs → orange fireball + scorch. Never one shared grey smoke puff.

- **Drying blood darkens, never greys.** Dried blood currently turns into grey, thick, patchy blotches
  that look like a bug. Drying shifts toward deep maroon and near-black brown, loses the wet
  highlight and some saturation, and keeps the splat's shape. No grey, no blotchy noise.
- **Kill stamps must be seen.** The user does not see kill announcements such as "BACKSTAB" at all.
  Verify they render on every kill (and respect the View setting), large enough to read at 1x.
- **Kill stamps get out of the way.** Death stamps sit on the kill spot too long and cover the action.
  Smaller text, spawned offset above the spot (not on the body), a quick elastic pop, then within about
  0.6 s they shrink and float upward while fading, gone by about 1.2 s. Several stamps stack upward
  instead of overlapping. Screen-space size cap so zooming in never makes them huge.
- **Overlapping blood turns grey-black (screenshot from the user).** Where splats stack, the floor goes
  to dark grey and black blotches over the red, which reads like dirt or a lighting bug. Likely cause:
  each splat multiplies a dark colour into the decal target, so overlaps compound toward black and
  lose saturation (possibly plus the drying shift and a sheen lit by fighter lights). Fix at the root:
  store blood as data in the decal target (coverage/density and age, accumulated with a clamped or max
  blend), and let the floor shader map density and age through one blood gradient (bright arterial
  red, deep red, dark maroon, never grey or black-grey) with a darkness floor. Verify with a
  screenshot of a heavily overlapped area.
- **Acid reads as acid and hurts (screenshot from the user).** The acid pool is a translucent green
  blob with a glowing rim; blood and floor show through, so it reads as a light, not a pit of acid.
  Make it an opaque, sunken liquid: darker toward the centre, slowly churning surface, bubbles that
  rise and pop, a few bright glints, thin toxic fumes, a corroded scorched rim, only a faint glow.
  Fighters inside visibly suffer: green tint, sizzle smoke, hurt flashes. Gameplay (tuned in the balance
  pass): heavy damage per second plus a slow, so standing in it is an obvious, costly mistake and
  knocking someone into it is a tactic.
- **Carnage is the default blood setting** (`DEFAULT_VIEW_SETTINGS.blood = 'carnage'`): vicious,
  violent splatter out of the box.
- **Blood shading reads from straight above.** Some blood shows odd reflections and a consistent,
  visible noise pattern (repeating texture or a sheen that tiles). From a top-down camera the wet
  highlight must be subtle and view-independent, splat masks must not show a repeating pattern
  (vary mask, rotation, scale per stamp; no screen-aligned noise), and dried blood never looks metallic.
- **Impacts scale with what happened, not with the weapon.** A normal staff hit currently looks like
  fireworks, far bigger than a melee hit, like an ultra gun. Every ordinary hit, melee or ranged,
  gets a similar, modest impact sized by its damage. The big moments are reserved for crits, kills,
  backstabs and explosions, for every weapon: crits get a sharp flash and extra spray, kills the full
  death burst. Spells keep their colour identity, not extra size.
- **Dismemberment bleeds.** When a limb comes off, both pieces spray: the flying limb trails blood
  and the stump spurts. The stump keeps bleeding for several seconds afterwards (pulsing spurts that
  weaken, then a drip trail wherever the fighter walks), so a maimed fighter is easy to read and
  leaves a track. (Optional gameplay follow-up: a small bleed damage over time, decided in the balance pass.)
- **Gibs bleed where they land.** A landed gib, above all intestines, oozes a small pool that grows
  for a second or two under it.
- **Spells differ and leave from the staff.** Staff orbs all share one colour; give each caster a
  distinct spell colour (from the fighter colour or a per-strategy element) with matching trail and
  impact. Every projectile spawns from its weapon's real muzzle point (staff tip, bow string, throwing
  hand), not from the fighter's centre.
- **Mouse wheel zoom and drag pan.** There is no wheel handler at all. Wheel zooms toward the cursor,
  drag pans, double-click follows a fighter; any manual camera input pauses the director until the
  user presses "Reset camera" (button and key C). Clamp zoom to sensible limits.
- **Fog of war for the selected fighter is on by default** (`DEFAULT_VIEW_SETTINGS.fog = true`).
- **Smooth vision cones.** Cones jitter. Causes to remove: the sim's head angle snaps between scan,
  remembered target and fuzzy hearing estimates, and fixed-count rays pop on and off pillar corners.
  Damp head turning in the sim (deterministic, rate-limited, no snapping on target changes), compute
  the drawn cone as an exact visibility polygon (rays cast to blocker corners plus fan rays) and ease
  the displayed heading on the render side.
- **Screen shake only on kills.** Projectile impacts and ordinary hits currently shake the screen,
  which turns into constant rumbling. Shake is reserved for kills (one short, decaying shake per kill,
  never stacking beyond a cap). Ordinary hits get their weight locally instead: a few frames of local
  hit-stop on the two fighters involved, white flash and squash-and-stretch on the victim, knockback
  slide with dust, a small impact ring on the floor, sparks or spray coloured by the weapon, and an HP
  bar that chips (a pale ghost segment drains after the hit). The camera itself stays calm.

- **Fighters cast shadows.** Walls and pillars cast torch shadows but fighters, weapons, gibs and
  projectiles do not. Every body casts a soft shadow from nearby lights (give fighters enough height
  and `castShadow`), so they sit in the world like the environment does.

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

### Timeline (user feedback, must do)

The timeline and click-to-replay are liked; make them explorable:

- **Colour-coded.** Each mark carries the colour of the fighter who caused it (killer for kills,
  attacker for big hits); event type is the mark's shape (kill, dismember, big hit, power-up, sudden
  death). Dense moments cluster without overlapping.
- **Hover tells the story.** A tooltip shows time and the event in a sentence with names in their
  fighter colours ("0:42 Gary backstabbed Brenda, twin daggers, from shadow"), plus each side's
  behaviour at that moment.
- **Break it down.** Filter by fighter (click a name in the scoreboard to show only their events, or
  one lane per fighter when expanded) and by event type. Kill feed entries link to the same marks.
- **Markers always readable.** Every mark is solid and filled with the fighter colour, has a dark
  outline that separates it from the track, sits above the track line, and has a minimum size; no
  hollow rings or tiny dots inside circles. Shapes stay distinguishable at a glance. The expanded
  per-fighter lanes view is liked: keep it.
- **Always a way back.** After seeking, a clear "Back to live" button (and End key) returns to the
  live edge; the playhead shows whether you are live or replaying. Seeking must be reliable: every
  click lands on the right tick, every time (add a test).

### View settings and readability aids (user feedback, must do)

- **A calm settings spot.** A small "View" button (gear) in a quiet corner of the Watch screen opens a
  popover; never in the way of the arena. Settings persist in localStorage. Toggles:
  damage numbers, barks (off / key moments / all), kill stamps, name tags, HP bars, vision cones
  (off / selected / all), steering ring and target line, fog of war, hearing ripples, screen shake
  (off / kills), blood amount (light / normal / carnage), sound volume. Each shows its keyboard
  shortcut where it has one.
- **Shortcuts match the word.** H toggles hearing ripples (the user expects it), B toggles HP bars,
  O fog, T name tags. The View popover lists every shortcut, and pressing one shows a short toast
  ("Hearing ripples on").
- **Damage numbers are back** (on by default): small, short-lived, coloured by the attacker, crits
  bigger, backstabs labelled, stacked so they never overlap the fighter's name tag.
- **Barks are rarer and smaller.** Default "key moments": spawn, kill, low HP, skill, death. At most one
  bark per fighter every 8 s and at most two on screen at once; lines are truncated to about five
  words; small bubbles that fade in about 1.5 s and dodge each other and the name tags.

### Full-screen fighter overview (user feedback)

The sidebar inspector is right for watching; reviewing a strategy needs a full view. An "Expand"
button on the inspector (and key I) opens a full-screen overview of the selected fighter, reusing the
inspector's parts in a roomier layout:

- Every behaviour with its live score bar and a short score history (sparkline over the last
  ~10 s), the winning one marked, commit timer visible.
- Large steering ring with each move term drawn as its own ring, plus the combined result.
- Target scoring: every known enemy with its target score and whether it is seen, heard or remembered.
- All sensors with live value, unit and range; memory slots; guard trips.
- Perception: vision and hearing ranges, last-seen ghosts, current zone and power-up info.
- Attributes chart, build, damage dealt and taken by source, the fighter's own event log.
- A picture-in-picture arena view that follows the fighter, so the match stays visible; Esc closes.

### Strategy editor diagnostics (user feedback)

Problems must be connected to their place in the code without manual matching:

- Hovering a gutter marker or the squiggly underline shows that issue's message and suggested fix
  in a tooltip at the spot; several issues on one line stack in one tooltip. Errors and warnings
  differ in colour and icon. Clicking an entry in the problem list jumps to and flashes the spot.
- Use CodeMirror 6 for the editor (`@codemirror/lang-json`, `@codemirror/lint` for gutter markers,
  underlines and hover tooltips) instead of a hand-made textarea overlay. Add autocompletion and hover
  docs for vocabulary words (sensors, places, zones, terms, policies) straight from the brain
  registry, so the editor teaches the language.

### Match framing and crowd (user feedback)

- **Round start.** A short "3, 2, 1, FIGHT!" countdown (about 2.5 s) with the fighters' names and
  glyphs flashing at their spawns; the sim holds until FIGHT. Matches never just start mid-air.
- **Round end.** The final kill plays in ultra slow motion with the camera easing onto it, then a
  "WINNER" / game-over stamp in the broadcast voice. The end card appears only after the moment has
  been admired (about 3 s), slides in from the side and never covers the kill spot. Skippable with
  Space or a click.
- **Crowd that breathes.** The murmur is too loud, constant and identical every round. Make the bed
  much quieter, let it swell with action intensity (hits, low-HP fighters, close fights) and fall
  nearly silent in lulls; vary its texture, density and pitch per round (seeded); add occasional
  sparse reactions (gasps, whistles, boos at campers, chants on a streak) instead of a loop. Kills and
  the final kill get the big roars.

### End card: inspect the winner and everyone else (user feedback)

On the end card (and the scoreboard after a match), click any fighter, the winner first in line, to
open its full strategy sheet: the full-screen fighter overview from this match (stats, behaviour
usage, heatmap, kills) plus the strategy itself (visual view and JSON) with "Copy strategy code" and
"Open in gym". Visible to everyone for now, for debugging and learning. Later, rooms get a setting
for whether rivals' strategies are revealed after a match (strategy theft is a real concern); keep
the reveal behind one flag so that decision stays cheap.

### Strategy builder: visual and code, both ways (user feedback)

- **Two-way editing.** A visual editor and the code editor edit the same strategy; a change in either
  updates the other immediately. Visual parts: attribute sliders with the budget meter and colour
  coding, weapon and skill pickers with their stats, one card per behaviour (score expression, move
  terms as rows with a weight slider and a place/zone picker, attack and skill policy), target
  preferences, memory slots, barks. Numbers inside expressions can be scrubbed with a slider.
- **Syntax highlighting and recognised words as chips.** JSON plus the expression language are
  highlighted; every recognised vocabulary word (sensor, place, zone, move term, policy, attribute,
  weapon, skill) renders as a subtle badge.
- **Hover cards for everything.** Every property, object and vocabulary word shows a neat card on
  hover, IntelliSense-style: what it is, type, unit, range, what values it takes, its effect (for
  attributes: the exact formulas and what +10 changes), an example, and related words. Same source as
  the LLM rulebook (the registry and rules docs), so nothing can disagree.
- **Codex.** A browsable, pretty reference of everything the LLM prompt contains: how a fighter
  thinks, every sensor, place, zone, term, policy, attribute, weapon, skill, map, limit and formula,
  searchable, with the starter library as worked examples. Learning the game should be fun.

### Peer-to-peer rooms prototype (user request, before any server work)

A WebRTC peer-to-peer prototype (Trystero, no backend) to find out whether multiplayer is worth more
time: create a room, share a 4-6 letter code, friends join, everyone drops strategies into the pool,
the host runs back-to-back matches and streams state, peers watch, a per-room leaderboard. Keep it
small and honest about limits (no session browser, TURN may be needed on strict networks).

### Resizable panes (user feedback)

Side panels (scoreboard, inspector, editor, gym panels) get drag handles on their inner edge to
resize, with min and max widths so nothing wraps badly; double-click a handle to reset; widths
persist per screen in localStorage. Panels can collapse to a thin rail. The arena canvas resizes
live with them (renderer.resize), without a frame of stretched content.

### Attribute display (user feedback)

- **Colour-coded attributes.** Each of the six attributes has one fixed, muted hue used everywhere
  it appears (inspector, hover card, editor budget meter, roster cards, reports): vitality red,
  power orange, agility green, perception cyan, armor steel, haste amber. Labels stay readable
  without colour (name plus number). Muted so fighter colours still dominate the arena.
- **Taller distribution chart.** The attribute view is a thin strip today, so builds look alike.
  Give it enough height (about 60-80 px for bars, values on hover) that two builds' distributions
  differ at a glance; compare against the 40-point maximum, not the build's own maximum.

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
- Every loop in a test that waits for something has a hard bound (a tick or iteration cap) and
  fails with a clear message when the bound is hit. A test must never hang: pass 1 lost minutes to
  `while (no projectile yet) run(1)` after a rule change meant the archer never fired.
- Keep code simple and direct; no speculative abstraction. Match the style of existing files.
