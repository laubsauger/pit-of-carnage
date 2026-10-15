# Status

Rewritten after every pass. Last update: 2026-10-15, after pass 2 (round framing, solid wall, blood
as data, editor, rooms).
Typecheck (`src` and `scripts`), 1136 tests and the build (also with `BASE_PATH=/pit-of-carnage/`)
pass; determinism holds on all four maps (two seeds each, replayed and seeked; no `Math.random`).

## Built

| Area | State |
| --- | --- |
| Match flow | Splash with real loading stages, then "Enter the pit" (starts sound). Nothing simulates or sounds behind the splash. Every match opens with "3, 2, 1, FIGHT!" (2.4 s, sim held at tick 0, rings and sound per beat). The final kill gets ultra slow motion, the camera easing in and a WINNER stamp; the end card slides in after 3 s. Space or a click skips either beat. A gym match opened at a kill or death starts there with no countdown. |
| Sim | Deterministic 60 Hz sim, four maps, full combat, fuzzy hearing, search, power-ups, hazards, props, stalemate trigger, escalation, judges. Solid closing wall: contact damage every tick, a push back in, crushing against walls, pillars and props (CRUSHED), and a test that nobody is ever outside it for more than a tick. Projectiles leave from the muzzle (staff tip, bow string, throwing hand). Acid slows. Shrine heals get a feed line. |
| Brain, strategy gate | Registry, expression compiler, context steering, guard trips; `loadStrategy` everywhere; rulebook and LLM prompt describe the solid wall and the acid slow from `src/core/rules.ts`. |
| Gym | Worker batches, battle reports and findings, `reportToText`, ratings, MAP-Elites evolution, balance harness. New: per-fighter stats (distance, accuracy, engaged rates, first contact, idle vs stuck, near walls, outside the zone, assists), heatmaps in words, habit findings, worst loss / best win / typical picks, paired "Compare two", the running job for the top-bar chip. |
| Render | WebGPU only; light field; cut-out fighters; fog-of-war visuals; closing-wall visuals. New: camera framing inside the uncovered part of the canvas (view insets), map-object picking with corpses never picked, shrine heartbeat and recharge, spike warning ring, opaque churning acid with fighters sizzling green in it, staff tip in the caster's colour, projectiles drawn from the muzzle, a kill punch that stays calm at 4x, countdown rings, the long final-kill camera. Loads as its own chunk with three.js. |
| FX | Blood stored as data with one gradient (no grey overlaps, dries toward maroon, red on every floor), impacts sized by damage, flying limbs that bleed and stumps that spurt for 4.6 s, kill stamps 40-60 px gone at 1.2 s, damage numbers and bark bubbles that never overlap or jump, heal bursts with "+N", sparks and blood on the wall, acid sizzle. |
| Audio | Procedural cues; a crowd that breathes with the action, re-seeded every round, with sparse gasps, whistles, boos and chants; rebuilt impacts, reverb and a glue compressor; countdown beats, FIGHT, the final sting, a grind loop on the wall, CRUSHED. Levels measured offline. |
| UI | Watch HUD with resizable, collapsible panes floating over the arena; colour-coded attributes and a taller chart; solid timeline marks; map-object hover cards; countdown and WINNER overlays; full-screen fighter overview (I) with a picture-in-picture arena; end card with strategy sheets for every fighter; top-bar jobs chip; gym Watch shortcuts, Watch at any kill or death, back to the same report row, stats grids, heatmaps, Compare two; Codex from the top bar, `?` and `#codex/<kind>/<word>` links. |
| Strategy editor | CodeMirror 6 with highlighting and word badges, lint icons, underlines and tooltips with one-click fixes, hover cards for every word, slot-aware completion; a two-way visual builder (Visual / Split / Code); the Codex. |
| Rooms | Peer-to-peer prototype over Trystero: 5-letter codes and invite links, a gated strategy pool, host-run back-to-back matches streamed to everyone, a room leaderboard, message checks and rate limits, host reopen and guest rejoin. Rooms play in the full arena ("Watch in the arena") with the same countdown, final moment and end card. |
| Deploy | GitHub Pages workflow on every push to `main`. Main JS chunk 0.4 MB; renderer, CodeMirror, Codex and rooms load on demand. |

## Known issues

- Balance: 1 of 3 targets hold (`docs/BALANCE.md`, regenerated after the sim landed). Duels in band:
  5 of 15 (twin daggers win 98% against throwing axes and 95% against the staff). On the pit melee
  wins 1.44x its fair share, ranged 0.49x; melee/ranged DPS 1.07x against a 1.5-1.8x guideline.
  Across maps the warhammer wins 2.55x its share, the staff 1.76x, throwing axes 0.16x. The core
  balance pass did not run in pass 2. Staff orbs now start at the tip (about 80 px ahead) and hit
  anyone inside that reach, so the staff got a little stronger up close. Acid damage is unchanged.
- Nobody has listened to the audio; every judgement so far comes from offline measurements.
- GPU frame time and 60 fps with 16 fighters are still unmeasured.
- Victory moment: no winner pose, spotlight or dimming yet, and the crowd keeps murmuring on the end
  card.
- "Next match" restarts from the saved setup, so a fighter brought in from the gym drops out.
- Ratings still show a bare "?" for provisional ones.
- Watch on an evolution archive entry plays a fresh match against the run's field, not the
  generation's own match (generation reports do not record their matches).
- Fighter overview: the target-score column needs per-enemy scores no `Decision` carries; damage by
  source appears only once the battle report exists.
- Rooms: the inspector has no decisions or knowledge for a streamed match; a guest who joins
  mid-match sees no earlier gore; no TURN relay; tested only with two tabs on one machine; a streamed
  match has no battle report, so its end card cannot copy one; no reveal setting.
- Editor: numbers scrub only in the visual builder; behaviours and move terms cannot be reordered;
  no "New fighter with an LLM" / "Improve this with an LLM" buttons; saves record their origin but
  not their parent; the editor's side panel has no resize handle.
- The Codex is not linked from map-object cards, inspector rows or attribute charts.
- Watch panels float over the canvas and report insets instead of resizing it (see DECISIONS); the
  user has not confirmed this reading of the spec.
- Contracts outside `src/core`: `GymApi` has no `compare` (the UI feature-detects the gym's
  `GymService`), the compare types live in `src/gym`, and `MatchStream` plus `watchStream` live in
  `src/net/watch.ts` (feature-detected by `canWatchStreams`). The muzzle offsets (`src/sim/combat.ts`)
  and the acid reach share (`src/render/fighters.ts`) mirror other modules by hand.
- Wall deaths credit nobody (the `CREDIT_WINDOW_TICKS` comment says hazards or the wall; the code
  credits hazards only). The wall does not break the props it passes over.
- The keg blast's dust ring reads as grey haze on stone floors.
- The renderer chunk (three.js included) is 0.98 MB.

## Next

Pass 3, in priority order:

1. Core balance and expressiveness pass with the harness: staff, daggers and axes first, the bow's
   ammo economy (stuck arrows), acid damage, more skills or per-build perks, a decision on bleed;
   keep the meta open. Then `npm run tune` and the shipped roster (`npm run roster`, `docs/ROSTER.md`).
2. Listen to the audio with the user and tune it; the victory moment (pose, spotlight, quiet end card).
3. Performance: measure GPU frame time with 16 fighters and fix what it shows.
4. Lineup and library: "Next match" keeps the lineup, Quick matchup, versions with parents and
   history, the two LLM buttons.
5. Viewing: the cinematic view, Codex links from every card, the rating display, the editor panel
   handle, scrubbing in the code view.
6. Rooms: decisions and knowledge in the stream, gore history for late joiners, a TURN option, the
   reveal setting, a test across two machines.
7. Contract cleanups: `GymApi.compare` and the compare types in `src/core`; `MatchStream` and
   `watchStream` in the controller contract; one muzzle table and one acid reach in `src/core`.

## Later

- A room setting for revealing rivals' strategies after a match (the reveal stays behind one flag).
- A `parry` expression per behaviour (parry is automatic today).
- Server-backed multiplayer, only if the prototype shows it is worth it.
