# Architecture

How the code is organised and the rules it follows. What the game does is in [SPEC.md](SPEC.md);
why things are the way they are is in [DECISIONS.md](DECISIONS.md).

## Stack

| Piece | Version | Used for |
| --- | --- | --- |
| Vite | 8 | Dev server, production build to one static page (`dist/`), module worker for the gym. |
| TypeScript | 7, strict | Everything. `npm run typecheck` checks `src` and `scripts`. |
| React | 18.3 | UI shell only (screens, HUD, inspector, editor). Never in the per-frame path. |
| three.js | r186 (`0.186.1`) | Arena rendering. `WebGPURenderer` from `three/webgpu`, TSL from `three/tsl`, post-processing with `RenderPipeline` and TSL display nodes from `three/addons/tsl/display/`. WebGPU only. |
| fflate | 0.8 | Compression of shareable strategy codes (`PIT2.…`). |
| CodeMirror | 6 (`@codemirror/*`, pinned exactly) | The strategy editor's code view: JSON, lint gutter and tooltips, completion, hover cards. Loaded as its own chunk when the code view first opens. |
| trystero | 0.25.4 | Peer-to-peer rooms over WebRTC, found through public Nostr relays. Loaded dynamically when a room opens. |
| openskill | 5 | Ratings (Plackett-Luce over FFA placements). |
| vitest | 5 | Unit tests, colocated `*.test.ts`, node environment. |
| tsx | 4 | Runs the CLI scripts (`scripts/balance.ts`, `scripts/lint-strategy.ts`). |

Plain CSS with variables in `src/ui/theme.css` (no Tailwind). Fonts from Google Fonts: Inter (UI),
JetBrains Mono (numbers and code), Bangers (kill stamps and barks only, never UI chrome).

### three.js rules

- WebGPU only. Never `forceWebGL`, no fallback branches. The UI asks for a WebGPU adapter
  (`useWebGpu` in `src/ui/hooks.ts`, not just `navigator.gpu`) and shows "The arena needs WebGPU"
  when there is none or the renderer fails to start; the Gym and Room keep working.
- Render code imports `three/webgpu` and `three/tsl`, never the plain `three` entry (two copies
  of three break node materials). `src/core` imports three types only (`import type`), so the sim
  and the gym worker never load three.
- No WebGL-only APIs: no GLSL `ShaderMaterial`, no `onBeforeCompile`, no `EffectComposer`.
- `await renderer.init()` before the first frame (`createRenderer` in `src/render/index.ts` is async).
- Use current three.js idioms; check `node_modules/three` when unsure.

## Module map

Owners are builder roles. In a parallel build each role edits only its paths; the integrator
owns `src/core` once modules are built and wires everything together.

| Path | Owner | Responsibility |
| --- | --- | --- |
| `src/core/` | architect, then integrator | Shared contracts: types, constants, rules tables, rng, math, API interfaces. No dependencies; type-only imports of three. |
| `src/sim/` | sim | Deterministic headless simulation. `match.ts` (`createMatch`, tick order, placements, judges), `perception.ts` (vision, fuzzy hearing, memory records), `movement.ts` (steering to motion, head, lunge, planting, collisions), `combat.ts` (attack cycle, parry, projectiles, splash, shields, skills), `damage.ts` (every damage source: knockback, stun, interrupt, dismemberment, kill credit, stamps, barks), `world.ts` (hazards, props, shrines, pickups, floor ammo, sudden-death wall), `query.ts` (`WorldQuery`), `geometry.ts` (cached LOS blockers, light grid, cover), `maps.ts` (four maps), `copy.ts` (kill stamps, feed lines, announcer lines). |
| `src/brain/` | ai | Strategy runtime. `registry.ts` (the whole vocabulary), `expr.ts` (tokenizer, parser, closure compiler), `compile.ts` (strategy to closures, cost pricing, guard counters), `brain.ts` (`createBrain`: target, scoring with commit, steering, actions, memory), `steering.ts` (16-direction context steering), `guards.ts`, `tuning.ts` (steering and guard constants), `mapinfo.ts`, `suggest.ts` ("did you mean"). |
| `src/strategy/` | ai | The gate and everything generated from the registry. `load.ts` (`loadStrategy`, `gatedBrainFactory`), `validate.ts` (structure, compile, analysis passes; `LIMITS`), `analyze.ts` (interval analysis, cost budget), `json.ts` (strict JSON reader with positions), `schema.ts`, `rulebook.ts`, `prompt.ts` (LLM prompt), `code.ts` (`PIT2.` codes), `library.ts` (starter behaviours), `house.ts` (house stacks). |
| `src/render/` (except `fx/`) | render-world | three.js WebGPU renderer. `index.ts` (`createRenderer`, event routing, signals, hosts fx), `hud.ts` (picking: `pick`, `pickObject`), `camera.ts` (director, follow, moments, view insets, manual zoom/pan, kill shake), `punch.ts` (kill punch envelope in real time), `lightfield.ts` + `lightmath.ts` (TSL compute light field matching the sim's `lightAt`), `floor.ts` (procedural floor; gore through fx's `goreFloor`), `walls.ts`, `arena.ts` (props, hazards, shrines, pedestals, floor items), `fighters.ts` + `rig.ts` + `parts.ts` + `cutout.ts` (instanced vector cut-out fighters, local hit weight), `shadows.ts` (projected soft shadows), `projectiles.ts`, `overlays.ts` + `vision.ts` (cones, fog, ghosts, ripples, steering ring, aim line), `tags.ts` + `labels.ts` (name tags, HP bars, "lost sight" labels), `zone.ts` (closing wall, warning band, blood tide), `post.ts` (`RenderPipeline`). |
| `src/render/fx/` | render-fx | Effects behind `FxModule`. `decals.ts` + `masks.ts` + `palette.ts` (gore stamped into the floor target as data: densities, wetness, soot) + `goreFloor.ts` (the floor's gore composite in TSL, one blood gradient), `particles.ts` (TSL compute particles), `pieces.ts` + `pieceRender.ts` + `atlas.ts` + `parts.ts` (gibs, limbs, dropped gear), `bleeders.ts` (stump spurts, fountains, pools), `streaks.ts`, `density.ts` (blood grid, boot prints), `impacts.ts` (projectile colour code, spell colours), `shapes.ts` (flashes, fireballs, rings), `popups.ts` + `stampLayout.ts` (kill stamps with screen-size cap and stacking, bark bubbles), `numbers.ts` + `numberLayout.ts` (damage numbers), `barks.ts`, `splatter.ts` (blood amount). |
| `src/audio/` | audio | Procedural WebAudio behind `AudioModule`. `index.ts` (`createAudio`: the AudioContext's life), `driver.ts` (`SoundDriver`: everything between the game and the engine, also driven offline), `cues.ts` (event and signal to cue, level trims), `crowd.ts` (per-round crowd profile, `CrowdDirector`: intensity, tension, sparse reactions), `engine.ts` (mixer, buses, reverb, glue compressor, limiter), `synth.ts` (recipes, noise, crowd babble), `mix.ts` (voice limits, ducking, slow-motion pitch, pause detector), `analyze.ts` (level and spectrum measurement for the offline checks). |
| `src/ui/` | ui-shell, ui-editor, net | React shell. `App.tsx` (hash tabs Watch / Gym / Room, the top-bar jobs chip, the Codex over any screen), `SplashScreen.tsx` + `splash.ts` (drives the static splash in `index.html`), `watch/` (arena mount, scoreboard, clock, kill feed, timeline, inspector, hover and map-object cards, countdown and WINNER overlays, view menu, match setup, end card, `FighterOverview` + `overview.ts` full-screen overview and strategy sheet), `gym/` (library rail, strategy editor, `CodeArea` on CodeMirror, import dialog, batch, compare and evolve panes, report view), `editor/` (ui-editor: `lexicon` every word as a card, `language` slots and lexer, `jsontext` lenient path-aware scanner, `cm` + `theme` CodeMirror extensions, `edit` minimal text edits, `exprtext` sums and scrubbing, `Builder`, `fields`, `WordCard`), `codex/` (ui-editor: `sections`, `markdown`, `Codex`), `room/` (net: lobby, in-room screen, radar, pool, room board, local leaderboard), pure models next to them (`hud.ts`, `keys.ts`, `view.ts`, `setup.ts`, `editor.ts`, `importer.ts`, `reports.ts`, `panes.ts`, `attrs.ts`, `codexLink.ts`), `theme.css`. |
| `src/gym/` | gym | Headless matches and everything learned from them. `worker.ts` + `jobs.ts` (module Web Worker, one job at a time), `index.ts` (`createGymApi`, persistent rating book), `batch.ts`, `runner.ts` (headless runner with safety cap), `recorder.ts` (`MatchRecorder`: events to `MatchReport`), `aggregate.ts`, `findings.ts`, `text.ts` (`reportToText`, `compareToText`), `heatmap.ts` (heatmaps in words), `picks.ts` (worst loss, best win, typical match; a fighter's moments), `compare.ts` (paired comparison on the same seeds), `ratings.ts` (openskill `RatingBook`), `evolve.ts` + `mutate.ts` (MAP-Elites), `balance.ts` (balance harness plan, analysis, Markdown). |
| `src/net/` | net | Peer-to-peer rooms. `room.ts` (opens a room; loads trystero), `host.ts` (`RoomHost`: pool, line-up, back-to-back matches, the stream, the room board), `client.ts` (`RoomClient`), `player.ts` (`StreamPlayer`: jitter buffer, interpolation, events once, signals, HUD view), `watch.ts` (`MatchStream`, what the controller draws), `snapshot.ts` (compact frames), `protocol.ts` + `check.ts` (every message checked), `pool.ts`, `board.ts` (openskill per room), `session.ts`, `saved.ts`, `transport.ts` + `trystero.ts`, `code.ts` (room codes). |
| `src/app/` | integrator | `controller.ts` (the real `GameController`: rAF loop, wiring, input on the canvas, gym jobs, room streams via `watchStream`), `round.ts` (`RoundFlow`: splash, countdown, final moment, end card, match signals), `objects.ts` (map-object hover cards), `session.ts` (`MatchSession`: sim, recorder, feed, timeline marks, seek), `time.ts` (fixed step, time director), `store.ts` (strategy library), `view.ts` (view settings persistence), `copy.ts` (state copy for interpolation), `main.tsx`. |
| `scripts/` | integrator | `balance.ts` (`npm run balance`, worker threads), `lint-strategy.ts` (`npm run lint:strategy`, `--write-schema`). |

Persistence (localStorage unless noted): `pit-of-carnage/strategies` (library), `pit-of-carnage/view`
(view settings), `pit-of-carnage/gym-ratings` (rating book and leaderboard), plus UI conveniences
under `poc.*` (match setup, gym tab, editor draft and `poc.editor.view`, batch and evolve forms,
`poc.gym.testMode`, `poc.gym.compare.v1`, timeline filters and lanes, pane widths `poc.pane.<id>`),
and rooms: `poc.room.name.v1`, `poc.room.last.v1`, `poc.room.host.<CODE>` (a hosted room's pool and
board) and, in sessionStorage, `poc.room.client.v1` (one tab is one member). Every stored strategy is
gated again when it is read back.

Dev harnesses, not part of the build: `render-dev.html` runs the renderer on a fake world
(`src/render/dev`), `ui-dev.html` runs the real App on a mock controller (`src/ui/dev`, URL switches
`?nogpu`, `?end`, `?select`, `?late`, `?paused`, `?crash`, `?splash`), and
`/src/audio/dev/audio-dev.html` renders every cue, the crowd bed and a scripted match offline through
the real `SoundDriver` (`?check` runs everything and leaves `window.__audioReport`).

## Core contracts (`src/core`)

`src/core` is the shared contract. Import from `src/core` (the barrel), not from single files.
Pure types live in `types.ts`; everything with runtime code is small and dependency-free.

| File | Contents |
| --- | --- |
| `constants.ts` | Structural constants: `TICK_HZ` 60, `TICK_DT`, `THINK_EVERY_TICKS` 6, `STEER_DIRS` 16, `ATTRIBUTE_BUDGET` 100, `ATTRIBUTE_MIN` 4, `ATTRIBUTE_MAX` 40, `MIN_FIGHTERS` 2, `MAX_FIGHTERS` 16, `DEFAULT_FIGHTERS` 8, `SPEED_SCALE` 0.65, `DEFAULT_TIME_LIMIT_TICKS` (90 s), `DEFAULT_MAP_ID` `pit`, `STRATEGY_SCHEMA` `pit-strategy/2`, `MAX_BEHAVIOURS` 8, `MAX_MOVE_TERMS` 6, `MAX_MEMORY_SLOTS` 12, `COMMIT_BONUS` 0.25, `FIGHTER_COLORS` (16, colour-blind-aware, no blood red). |
| `rules.ts` | Every gameplay number, each with a doc string the rulebook prints: `WEAPONS`, `SKILLS`, `COMBAT`, `PERCEPTION`, `STANCES`, `HAZARD_RULES`, `PICKUP_RULES`, `PROP_RULES`, `MATCH_RULES` (incl. the solid wall: `wallContactDamage`, `wallPushKnockback`, `wallCrushDamage`), `JUDGES_ORDER`, `BARK_RULES`; `HazardRule.slowTicks` (acid); derived-stat functions (`maxHp`, `moveSpeed`, `facingMoveMul`, `shotSpread`, `resolveDamage`, `visionRange`, `hearingRadius`, `parryChance`, `deriveStats`, ...); sudden-death zone helpers (`initialSuddenDeathState`, `zoneBoundsAfter`, `zoneTicksToReach`, `zoneEdgeDistance`, `matchHardCapTicks`). |
| `rng.ts` | `Rng`: sfc32 seeded through splitmix32, 32-bit integer ops only; `fork(label)`, `fromState`, `hashString` (FNV-1a). |
| `math.ts` | `Vec2` helpers that write into an `out` parameter (no allocation in hot paths), angle helpers (`wrapAngle`, `angleDiff`, `stepAngle`), `STEER_COS`/`STEER_SIN`, segment/rect/circle tests. |
| `types.ts` | Builds (`WeaponId`, `SkillId`, `Attributes`, `Limb`, `Stance`); the strategy language (`Strategy`, `Behaviour`, `MoveTerm`, `BarkKind`); the gate (`ValidationIssue`, `ValidStrategy` brand, `StrategySource` incl. `editor` and `house`, `LoadReport`, `LoadStrategy`); match setup (`MatchFormat`, `Entrant`, `MatchConfig`); maps (`MapDef`, `LightDef`, `HazardDef`, `PropDef`); world state (`WorldState`, `FighterState`, `ProjectileState` with its muzzle `origin`, `FloorItem`, `PickupState`, `HazardState`, `SuddenDeathState`, `MatchEnding`); `GameEvent` (all event kinds, incl. `wall_contact`, `kill.final`, the `crushed` flag, `heal.shrineId`); `MatchSignal` (countdown, FIGHT, final kill: app beats, never sim events); sim to brain (`KnownFighter`, `WorldQuery`, `PickupInfo`, `PerceptionView`, `Decision`, `GuardTrip`, `Brain`, `BrainFactory`); sim API (`Match`, `MatchResult`). |
| `render-api.ts` | `GameRenderer` (incl. `pickObject`, `setViewInsets`, `onSignal`), `RendererOptions` (`onProgress` with `RenderInitStage`), `ViewInsets`, `PickedObject`, `MapObjectKind`, `RenderContext` (incl. the floor decal render target and its data layout), `FxModule`, `ViewSettings` and `DEFAULT_VIEW_SETTINGS`, `LIVE_EVENT_TICKS` (90), `LAYER_HEIGHT` draw layers, `toThree`. |
| `audio-api.ts` | `AudioModule`: `init` (from a user gesture), `startRound(seed)`, `onEvents`, `onSignal`, `update(dt, timeScale)`, `setVolume`, `dispose`. |
| `controller.ts` | What the UI talks to: `GameController` (incl. `enter`, `skip`, `objectInfo`, `setViewInsets`), `UiSnapshot` (incl. `phase`, `countdown`, `loading`, `jobs`, `hoveredObject`, `ending`, `source` local or room), `MatchPhase`, `LoadingStage` and `LOADING_STAGES`, `BackgroundJob`, `ObjectInfo`, `UiFighter`, `FeedItem`, `TimelineMark`, `StrategyStore`, `SavedStrategy` (with `parentId` and `SavedOrigin`), `GymApi`, `BatchRequest`, `BatchResult`. |
| `report-types.ts` | Battle reports and ratings: `MatchReport` (incl. `judges`), `FighterReport` (incl. `stats: FighterStats`, `death: DeathRecord`, `heatmap`), `KillRecord`, `AggregateReport` (incl. `endings`, `suddenDeath`, `judges`), `StrategyAggregate` (incl. averaged `stats`, `heatmaps` per map, `suddenDeath`, `judges`), `REPORT_STATS` (how stats are measured), `Heatmap` with `createHeatmap`, `addToHeatmap`, `mergeHeatmap`, `emptyFighterStats`, `Rating`, `displayRating`, `LeaderboardEntry`, `strategyKey` (`name@vN`), evolution types (`EvolveRequest`, `EvolveGeneration`, `EvolveResult`). |

Module entry points: `createMatch`, `stateHash`, `MAPS` (`src/sim`); `createBrain` (`src/brain`);
`loadStrategy`, `gatedBrainFactory`, `generateJsonSchema`, `generateRulebook`, `buildLlmPrompt`,
`encodeStrategyCode`/`decodeStrategyCode` (`src/strategy`); `createGymApi`, `reportToText`
(`src/gym`); `createRenderer` (`src/render`); `createFx` (`src/render/fx`); `createAudio`
(`src/audio`); `createController` (`src/app`).

## Data flow

```
MatchConfig ──loadStrategy (gate)──> createMatch(config, gatedBrainFactory)
                                          │
   every tick (60 Hz):  sim perception ──> PerceptionView ──> Brain.think (every 6 ticks, staggered)
                        Decision ──> sim movement, combat, world ──> WorldState + GameEvent[]
                                          │
app loop (src/app/controller.ts), per animation frame:
   RoundFlow (splash, countdown, final moment) ──> may the sim step?
   TimeDirector (slow-mo) x speed ──> FixedStep ──> whole ticks ──> MatchSession.step
   events ──> renderer.onEvents ──> fx.onEvents          (persistent gore, transient effects)
          ──> audio.onEvents                             (cues)
          ──> session feed + timeline marks + MatchRecorder (battle report)
   match signals (countdown, fight, final_kill) ──> renderer.onSignal, audio.onSignal
   renderer.render(prev, curr, alpha, frameDt)           (interpolated frame)
   subscribers notified at ~10 Hz (at once on a phase or beat change) ──> React reads getSnapshot()

   watching a room instead: MatchStream.advance(now) ──> prev, curr, alpha, events, signals,
   the host's time scale ──> the same renderer and audio calls; the snapshot from stream.view()

Gym: GymApi (main thread) ──postMessage──> module Web Worker (src/gym/worker.ts)
   worker gates every strategy again, runs headless matches, records reports,
   aggregates, rates (openskill) ──> BatchResult / EvolveResult ──> UI
```

- The sim owns `WorldState` and mutates it in place; everyone else reads it. The controller copies
  the previous tick for interpolation (`src/app/copy.ts`).
- The renderer is the camera director and hosts fx: it builds the `RenderContext` on `setMap` and
  forwards events, view settings and scaled time to fx.
- Fog of war reaches the screen through `Match.knowledge(id)`: the renderer (fog view, ghosts,
  hearing ripples, aim lines) and the inspector read the same records the brain reads.
- Events older than `LIVE_EVENT_TICKS` (90) relative to the state they arrive with are catch-up from
  a seek: they leave persistent marks (floor gore, pieces at rest) but play no transient effects,
  camera moves, flashes or sounds.
- Seeking (`MatchSession`): forward steps the sim on headless; backward rebuilds the match from its
  config and re-simulates from tick 0 (no snapshots). The sim is deterministic, so tick N is always
  the same tick N. The battle report survives seeks.
- A gym match is replayed in the arena by rebuilding its `MatchConfig` from the report
  (`configFromReport` in `src/ui/setup.ts`); the gym plays gated strategies, so it is the same fight.
  Opening it at a moment calls `startMatch`, then `skip()` and `seek(tick)`: the seek drops the
  queued FIGHT beat, so a replayed death never opens with a countdown.
- A room's match reaches the arena through `controller.watchStream(stream)` (`MatchStream`,
  `src/net/watch.ts`): the controller routes what the stream says to draw and steps no sim of its
  own; `startMatch` or `watchStream(null)` returns to the local match and repaints it.

## Determinism

- `src/sim`, `src/brain` and `src/strategy` take all randomness from `Rng`. Never `Math.random`,
  `Date` or `performance.now` there. A test (`src/sim/match.test.ts`) spies on all three and fails if
  a match touches them.
- Each independent consumer gets its own stream with `fork(label)` at setup (one per fighter brain,
  one for combat rolls, ...), so a consumer drawing more numbers cannot shift another's results.
- Same config and seed give the same match in the same browser. Across browsers, float functions
  such as `Math.sin` may differ in the last bit, so matches are not guaranteed identical across
  engines (this is why multiplayer is host-authoritative, not lockstep).
- `stateHash(state)` fingerprints a state for determinism tests.
- Rendering, fx and audio are cosmetic and may use any randomness. Nothing cosmetic feeds back into
  the sim. Display settings (`ViewSettings`) never reach the sim.
- Anything that crosses a worker or the network is plain data: it goes through `loadStrategy`
  again on the other side (the `ValidStrategy` brand does not survive `postMessage`).

## Time model

- The sim always steps at `TICK_HZ` = 60, independent of display refresh. Units in the sim are
  ticks and px per tick; `SPEED_SCALE` 0.65 slows every walking speed, dash and projectile for
  readability (an average build crosses the pit in about 8-10 s at 1x; a test guards it).
- Brains think every `THINK_EVERY_TICKS` = 6 ticks (10 Hz). Fighter i thinks when
  `(tick + i) % 6 === 0`, so the cost spreads across ticks.
- The app loop (`src/app/time.ts`) is the time director:
  - `FixedStep` turns real frame time x rate into whole ticks and keeps the remainder as the
    interpolation `alpha`. Frames longer than 0.25 s are capped (a hidden tab does not fast-forward).
  - Playback speed 0.25, 0.5, 1, 2, 4 (keys 1-5); pause; step (arrow keys).
  - `TimeDirector` slows time around moments, in real seconds: kill 0.07 s freeze then x0.3 for
    0.35 s; final kill 0.12 s freeze then x0.12 for 2.1 s (ultra slow motion, back to speed just
    before the end card); dismemberment x0.5 for 0.2 s; parry 0.04 s freeze then x0.65 for 0.1 s;
    then recovers at 1.4 per second. Overlapping moments take the slowest scale and the longest
    hold, never more. Room hosts use the same director, so their slow motion is in the stream.
  - `RoundFlow` (`src/app/round.ts`) frames the round in real seconds: nothing steps behind the
    splash (time factor 0); a 2.4 s countdown holds the sim at tick 0 (the arena breathes at speed);
    FIGHT! shows 0.6 s; a match decided live gets `FINAL_SECONDS` (3) before the end card. The
    countdown waits out a pause; the final moment runs in real time. Beats go out as `MatchSignal`s
    after the frame's events.
  - The combined factor (speed x slow-mo, 0 while paused or frozen) goes to
    `renderer.setTimeScale` and `audio.update`. Camera easing uses real `frameDt`, so the camera
    settles while paused; fx multiply by the time scale.
- The sim only advances while an arena renderer is attached; leaving the Watch screen pauses.

## Coordinates

- World units are px. A map spans `[0, width] x [0, height]`, origin top-left, +x east, +y south.
- Angles are radians from +x toward +y (`Math.atan2(dy, dx)`): 0 east, π/2 south, clockwise on
  screen. Steering direction i points at `i x 2π / 16`.
- Rects are `{ x, y, w, h }` with `x, y` the top-left corner.
- three.js: world (x, y) maps to three (x, height, y) via `toThree`. The orthographic camera looks
  straight down (-Y) with `camera.up = (0, 0, -1)`, so world +y is down on screen.
- Draw order is by height (`LAYER_HEIGHT`): floor 0, floor fx 0.5, floor items 1, props 2,
  fighters 10, air 30, walls 48, overlays 60, popups 70. Gore stays on the floor layer; fighters are
  always above every floor effect.
- The floor decal target spans the map with texel (0, 0) at world (0, 0); the floor samples it at
  `uv = world / floorSize`. Under WebGPU render-target UVs are not flipped: uv.y = 0 is the top edge.
  It holds data, not colour: r = exp(-blood density), g = exp(-wet density), b = exp(-tone-weighted
  density), a = soot; cleared to (1, 1, 1, 0). `goreFloor` (render-fx) turns it into colour.

## Performance rules

- Target: 60 fps with 16 fighters on a laptop (not measured yet; see STATUS).
- No allocations in per-frame hot paths: reuse vectors (out-parameter math), pools and instanced or
  batched meshes.
- React never runs per frame. The controller notifies at about 10 Hz (`NOTIFY_MS` 100) and
  `getSnapshot()` returns the same object between notifications (safe for `useSyncExternalStore`).

## Testing

- vitest, colocated `*.test.ts` under `src/`, node environment. `npm test` runs them all.
- Tests encode intent: the name or a comment says why the behaviour matters, and the test must be
  able to fail when that logic changes. Example: "nobody fires while seeing no enemy" across whole
  matches, not "fire() returns false".
- Every loop that waits for something has a hard bound (tick or iteration cap) and fails with a
  clear message when the bound is hit. A test must never hang. (Pass 1 lost minutes to
  `while (no projectile yet) run(1)` after a rule change meant the archer never fired.)
- Invariants worth a test get one: determinism (same seed, same `stateHash`; no `Math.random`),
  fog of war (no shots at unseen targets, heard estimates never exact), the strategy gate (fuzz
  tests; a guard trip in a valid strategy is a validator bug), seeking lands on the right tick.
- Test-only helpers live in `testkit.ts` / `test-world.ts` files next to the code they serve.
- Stylesheets load empty under vitest, except `src/ui/theme.css` (`test.css.include` in
  `vite.config.ts`), which tests read as text (`theme.css?raw`) to keep its tokens equal to the code.

## Build and deploy

- `npm run build` typechecks, then `vite build` into `dist/`: one `index.html`, a main JS chunk
  (about 0.4 MB: React, the shell, sim, gym API), lazy chunks for the renderer with three.js (loaded
  when the arena mounts), CodeMirror (the editor's code view), the Codex and rooms (trystero), one
  worker chunk, CSS, `public/brand/` and `pit-strategy-2.schema.json` copied from `public/`.
- `vite.config.ts` sets `base` from the `BASE_PATH` environment variable (default `/`).
- GitHub Pages: `.github/workflows/deploy.yml` runs on every push to `main` (and by hand):
  `npm ci`, `npm test`, `npm run build` with `BASE_PATH=/<repo name>/`, then uploads `dist` and
  deploys. A newer push cancels a deployment still in progress. Live at
  https://laubsauger.github.io/pit-of-carnage/.
- `public/pit-strategy-2.schema.json` is generated from the registry
  (`npx tsx scripts/lint-strategy.ts --write-schema`) so editors can use `$schema`.
- `docs/BALANCE.md` is generated by `npm run balance`; do not edit it by hand.

## Working rules

For anyone changing the code, human or agent:

- Keep code simple and direct; no speculative abstraction. Match the style of the files around you.
- New gameplay numbers go into `src/core/rules.ts` with a doc string. New vocabulary goes into
  `src/brain/registry.ts` with doc, unit and range; the validator, schema and rulebook follow.
- When several builders work in parallel, each edits only the paths it owns (module map above) and
  `src/core` is frozen: a builder that needs a core change defines a local type and lists the
  requested change in its report; the integrator applies it.
- Dependencies are fixed: do not run `npm install <pkg>` or edit `package.json` without the user's
  say-so. List a missing dependency in your report instead.
- Do not commit unless asked. Never run `git checkout`, `git reset`, `git stash` or any other
  destructive git command.
- `npx tsc --noEmit` may show errors from modules still in progress during a parallel build; fix
  only your own.
- Re-run `npm run balance` after any change to `src/core/rules.ts`.
- One GPU-heavy browser session at a time, machine-wide (the GPU is shared with other projects):
  run `node scripts/gpu-lock.mjs acquire <who>` before opening any page that runs the renderer,
  keep the session short, close the tab, then `node scripts/gpu-lock.mjs release <who>`. Never leave
  a requestAnimationFrame stand-in pumping in a background tab.
