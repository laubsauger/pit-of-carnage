# Status

Rewritten after every pass. Last update: 2026-10-15, after pass 1 (first playable version).
Typecheck, 770 tests and the build pass; determinism holds on all four maps.

## Built

| Area | State |
| --- | --- |
| Sim | Deterministic 60 Hz sim, four maps, full combat (backpedal, plant-to-shoot, spread, point blank, lunge, interrupt, shields), fuzzy hearing, search, power-ups, hazards, props, stalemate trigger, escalation, judges' decision. |
| Brain | Registry (82 sensors, 16 places, 7 zones, 6 move terms), expression compiler without eval, context steering, guard trips. |
| Strategy gate | `loadStrategy` on configs, store, import, codes, gym and CLI; static analysis; JSON Schema published (and tested); `npm run lint:strategy`; fuzz tests; 15 starter behaviours; 13 house stacks. |
| Gym | Worker batches, battle reports and findings, `reportToText`, openskill ratings and leaderboard, MAP-Elites evolution, balance harness writing `docs/BALANCE.md`. |
| Render | WebGPU only; light field with 2D wall shadows; projected body, weapon and projectile shadows; cut-out fighters with local hit weight; exact visibility-polygon cones; fog-of-war knowledge visuals (ghosts, ripples, aim line); closing-wall visuals with warning band; kill-only shake; wheel zoom, drag pan, double-click follow, Reset camera. |
| FX | Persistent carnage blood, GPU particles, exploding deaths, gibs (oozing where they land, in code but not yet reviewed), stump spurts and drips, colour-coded impacts (orbs in the caster's colour), damage numbers, kill stamps, rare small barks. |
| Audio | Procedural cues, crowd and wall drone; starts on the first gesture; slow-motion pitch. Nobody has listened yet. |
| UI | Watch HUD (scoreboard, clock, feed, timeline with colours, shapes, hover sentences, lanes and Back to live; inspector with "What it knows" and guard trips; hover card); View popover with persisted settings, shortcuts and toasts; match setup; end card; gym editor, import dialog with line and column, batch and evolve panes, Watch per match row; Room leaderboard; WebGPU-required message. |
| Deploy | GitHub Pages workflow (test, build with `BASE_PATH`, deploy) on every push to `main`. |

## Known issues

- The closing wall is not solid: fighters can stand outside it, taking only periodic damage and a
  4 px shove. No clamp, push, contact damage, crushing or test.
- Projectiles spawn from the fighter's centre, not the weapon's muzzle.
- Balance targets unmet (1 of 3 in `docs/BALANCE.md`): duels 3 of 15 in band; on the pit the melee
  family wins 1.42x its fair share and ranged 0.51x (integrator's latest run: 1.38x and 0.55x);
  melee/ranged DPS 1.07x against a 1.5-1.8x guideline. Across maps the warhammer wins 2.37x its share
  and throwing axes 0.15x; guard-stance warhammer stacks won 18 of 30 pit matches. The user saw the
  arcane staff dominate earlier.
- Acid is a translucent green light, does too little damage and does not slow.
- Blood: overlapping splats turn grey-black (user screenshot); drying changes only the wet sheen,
  never the colour; blood barely shows on the dark Catacombs floor.
- Kill stamps are big (13% of the view height) and stay 2.15 s.
- Impacts are sized by weapon type, not by event; staff hits are too boomy.
- Stump spurts last about 1 s; a flying limb does not spray in flight.
- At 4x the kill punch tints the screen red (its red edge bleed).
- The staff's tip glow is a fixed purple instead of the caster's spell colour.
- The inspector covers the right side of the arena; camera framing ignores it.
- Damage numbers of victims standing close together can overlap.
- Bark bubbles jump when they dodge.
- Timeline: the power-up mark is a ring, and lanes draw hollow marks, against the "solid marks" rule.
- Audio never listened to. The user finds the crowd murmur too loud, constant and identical every
  round (the babble is generated once per audio context, not per round).
- GPU frame time and 60 fps with 16 fighters never measured.
- The main JS chunk is 1.66 MB with no code splitting.
- Gate source labels are off: the editor passes `paste` (there is no `editor` source), gym batches
  label candidates and field `evolution`, and house stacks never use `house`.
- `headlessBrainFactory` exists twice (`src/strategy/load.ts`, `src/gym/runner.ts`).
- `src/gym/balance.ts` writes "Targets come from the build spec" into `docs/BALANCE.md`; it should
  point to `docs/SPEC.md` ("Balance: ranged vs melee").

## Next

Pass 2, in priority order:

1. Solid closing wall: clamp, push, contact damage, crushing with a CRUSHED stamp, and the
   "never outside for more than one tick" test.
2. Core balance and expressiveness pass with the harness: arcane staff first, then every weapon,
   skill, formula and hazard (acid damage and slow); projectiles from the muzzle; more skills and
   per-build traits; decide on bleed; keep the meta open. Write the analysis into `docs/BALANCE.md`.
3. Blood and impacts: blood stored as density and age with one gradient (no grey overlaps, drying
   toward maroon, readable on dark floors); impacts sized by event; kill stamps smaller and gone in
   about 1.2 s; dismemberment spray from both pieces and longer stump bleeding; acid look; staff tip
   colour; no red kill punch at 4x; damage-number and bark-bubble overlap fixes.
4. Audio: listen to it; make the crowd quieter, driven by intensity, seeded per round, with sparse
   reactions.
5. Match framing: round-start countdown, final-kill ultra slow motion with a WINNER stamp, end card
   after about 3 s that slides in from the side.
6. Inspection: camera framing that respects the inspector; full-screen fighter overview (key I);
   click any fighter on the end card for its strategy sheet.
7. Gym: Watch from evolution entries, "worst loss / best win / typical", jump to a kill or death,
   pre-filtered timeline, back to the gym; richer per-fighter stats, heatmaps, side-by-side compare.
8. Strategy editor: CodeMirror 6 with lint tooltips and registry autocompletion and hover docs; then
   the two-way visual builder, highlighting with word chips, hover cards and the Codex.
9. Layout: resizable, collapsible panes; colour-coded attributes and a taller attribute chart; solid
   timeline marks.
10. Performance: measure GPU frame time and 60 fps with 16 fighters; split the main chunk.
11. Cleanups: an `editor` gate source and correct labels, one `headlessBrainFactory`, the BALANCE.md
    spec reference.
12. Shipped roster: `npm run roster` selecting the 16 house strategies and writing `docs/ROSTER.md`
    (after the balance pass).
13. Peer-to-peer rooms prototype (Trystero, host-authoritative).
14. First impression: splash and loading screen with real progress, "Enter the pit" (starts audio),
    favicons and share tags; shrine and map-object readability with hover cards; no hover cards on
    dead fighters; a top-bar chip for running evolutions and batches.

## Later

- A room setting for revealing rivals' strategies after a match (the reveal stays behind one flag).
- A `parry` expression per behaviour (parry is automatic today).
- Server-backed multiplayer, only if the prototype shows it is worth it.
