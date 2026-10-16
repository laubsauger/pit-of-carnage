# Status

Rewritten after every pass. Last update: 2026-10-16, after pass 3 (stuck ammo, hand weapons, two
new skills, the first balance round, the victory moment, lineups and Quick matchup, library
versions, the cinematic view, room hardening).
Typecheck (`src` and `scripts`), 1316 tests in 113 files (none skipped) and the build (also with
`BASE_PATH=/pit-of-carnage/`) pass. One muted browser session checked the local arena, the end card,
Next match, Quick matchup, the cinematic view, the view shortcuts, the editor and the gym's ratings
(screenshots `docs/screenshots/pass3-*.png`).

## Built

| Area | State |
| --- | --- |
| Match flow | Splash, "Enter the pit", "3, 2, 1, FIGHT!", ultra slow motion on the final kill, then the victory moment: the camera frames the winners, who raise their weapons and hop under a warm spotlight while the arena dims, one crowd roar, then quiet under the end card (`victory` and `end_card` signals; a seek onto the end poses the winner at once). Seen in the browser. |
| Lineup | The controller owns the lineup: "Next match" repeats it with a new seed (optional map rotation), the player's picks stay pinned, "Shuffle field" redraws only the house slots (seeded). Quick matchup (top bar, end card "Change it", dropping `.json` files on the arena) replaces the old setup dialog: saved versions, house stacks, files, pasted JSON or codes, each through the gate. Gym, compare, evolution and editor Watch pin only the strategies under test. Pinning and Next match seen in the browser. |
| Sim | Deterministic 60 Hz sim, four maps, full combat, fuzzy hearing, solid closing wall, power-ups, hazards, props. New: arrows and axes stick in walls, props and bodies and are taken back from there; bodies drop theirs on death (`src/sim/stuck.ts`). Hand weapons (axes keep a hatchet, the staff whacks). The bow's quiver refills one arrow per 240 ticks. Skills HOOK and SECOND_WIND. Bleed implemented behind `BLEED_RULES.enabled`, off. |
| Balance | First round done (`docs/TUNING.md`): 2 of 3 targets hold in `docs/BALANCE.md`, 13 of 15 duel pairings inside 35-65%, pit FFAs melee 1.07x and ranged 0.92x of fair share, melee DPS 1.41x ranged. Shrine recharge 900. The balance workbench is `scripts/balance-search.ts`. |
| Brain, strategy gate | Registry, expression compiler, context steering, guard trips; `loadStrategy` everywhere. Rulebook and LLM prompt describe stuck ammo, hand weapons and the two new skills (`ammo.distance` and the `ammo` place see stuck ammo); bleed stays out while it is off. |
| Gym | Worker batches, reports, findings, ratings, MAP-Elites evolution, balance harness, Compare two. New: `npm run tune` (per-strategy tuner, JSON only, deterministic for any thread count); evolution generations record their matches, so Watch on an archive entry or generation shows the match it really played; `GymApi.compare` is in the contract. |
| Ratings | "1240 ±85" in aligned digits with a "new" marker and a hover card for provisional ratings, in the gym report and the room leaderboards. Seen in the browser. |
| Render | WebGPU only; light field, cut-out fighters, fog of war, closing wall, view insets. New: `AmmoLayer` (stuck arrows and axes riding bodies, quivering on impact, falling when dropped, owner-coloured fletching), the victory pose and spotlight, blood that ages from deep red to maroon-brown, a warm soot keg ring, staff orbs in the caster's colour, HOOK and SECOND_WIND effects. One muzzle table and one hazard reach shared with the sim (`src/core/rules.ts`). |
| Audio | Procedural cues, a breathing crowd, reverb and glue compressor, round beats, wall grind. New: the victory roar and the hush under the end card (about -61.5 dB RMS offline), stuck-ammo yank and clatter, HOOK and SECOND_WIND cues. Levels measured offline. |
| UI | Watch HUD with floating, collapsible panes; cinematic view (V) folds panels to thin edges and gives the camera the whole canvas; vision cones moved to E, every letter has one meaning, a keyboard card lists them all; the kill feed folds to a tab; narrow screens start folded. Codex links from attribute bars, weapon and skill names, sensor rows, derived stats, the strategy sheet and the end card; map objects open their entry on click. Cinematic view and shortcuts seen in the browser. |
| Strategy editor | CodeMirror 6, visual builder (Visual / Split / Code). New: the header states the base version ("Editing My Gladiator, based on v1 (saved 01:16)"), "Save as v2", a toast ("Saved as My Gladiator v2 (from v1)."), a History panel (origin, parent, a short diff, open, delete, compare any two), name-collision choices, "New fighter with an LLM" and "Improve this with an LLM" (copy the prompt, paste the reply into a box), dragging numbers in the code view, behaviour and move-term reordering, a resizable side panel. Header, Save, toast, history and both LLM buttons seen in the browser. |
| Library | Version numbers per name, monotonic, never reused; parent and origin recorded; entries that stop validating are hidden, not dropped. |
| Rooms | Peer-to-peer over Trystero, host-run matches streamed to everyone, room leaderboard. New: protocol version 2; capped guest buffers and a message budget per sender; the selected fighter's decisions and knowledge stream to the arena's inspector; late joiners get the gore so far; a TURN relay option; a reveal flag for rivals' codes (off by default); the host's battle report reaches the end card's "Copy report for LLM"; stuck ammo and bleed in the frames. |
| Deploy | GitHub Pages workflow on every push to `main`. Main JS chunk 447 kB; renderer, fx, CodeMirror, Codex and rooms load on demand. |

## Known issues

- Balance: `src/core/rules.ts` changed after `docs/BALANCE.md` was generated (at least the SHOCKWAVE
  parry and stun and the SHADOWSTEP attack lock; `docs/TUNING.md` quotes the hatchet at 26, the rules
  say 28), so the FFA shares in BALANCE.md may be slightly off. Duels use DASH and are unaffected by
  the skill changes. Across all maps the staff wins 2.2x its FFA share, the warhammer 1.7x, daggers
  0.29x and throwing axes 0.11x; daggers vs bow and greatsword vs axes sit at the band's edge; the
  DPS guideline is 1.41x against 1.5. Next steps are in `docs/TUNING.md`.
- Bleed is built but off and never measured; it has no sensors (`self.bleeding`, `target.bleeding`)
  or `blood_trail` place yet.
- The tuner rarely accepts a change (1 of 21 rounds on The Unpaid Intern): most proposed steps are
  too small to detect. Its first result (agility 36 -> 39, haste 20 -> 17) is not applied to the
  house stack.
- Nobody has listened to the audio. The HOOK and SECOND_WIND cues were added after the offline level
  check (trim 0 dB, unmeasured).
- Performance was measured only on the render dev page with a fake world on this machine (GPU about
  0.2-0.9 ms, CPU render 0.3-1.9 ms per frame; the shared GPU made readings jump to 16-28 ms). An
  integrated GPU and the real sim with 16 fighters are unmeasured; no performance change was made.
- Rooms: the pass 3 room work is tested in node only (in-memory transport), never in a browser, across
  two machines or against a live TURN relay. Revealed strategy codes (`MatchStream.revealed`) are not
  shown on the arena's strategy sheets yet (the Room screen shows them). While a stream is watched,
  the controller reads `MatchStream.view()` every frame and the player rebuilds it every tick (about
  60 Hz) although React reads at 10 Hz.
- Not seen in a browser this pass: room streams in the arena (inspector decisions, the room end
  card's report), Watch on a recorded evolution match, the history panel's compare, the name-collision
  dialog, number dragging, reordering and the side-panel handle (unit tests only).
- Gym: a comparison started from the editor's History panel is not known to the gym's job state, so
  starting a batch meanwhile fails with "already running a job"; it uses fixed settings (16 seeds,
  house stacks, default map). A renamed copy records its parent only while the editor stays mounted.
- Ratings: the "new" marker sits a few px further right on 3-digit ratings than on 4-digit ones.
- Fighter overview: the target-score column needs per-enemy scores no `Decision` carries.
- The fighter hover card follows the pointer and has no Codex link; map objects the map does not list
  (spilled acid) have none either.
- Wall deaths credit nobody; the wall does not break the props it passes over.
- The fx chunk (three.js included) is 0.98 MB.

## Next

Pass 4, in priority order:

1. Balance, picking up from `docs/TUNING.md`: re-run `npm run balance` first (the rules changed after
   the last run), then the shipped roster (`npm run roster`, `docs/ROSTER.md`, not built) and
   `npm run tune` on The Unpaid Intern and the 1-2% house stacks; decide bleed with the harness.
2. Listen to the audio with the user; measure the HOOK and SECOND_WIND cues
   (`/src/audio/dev/audio-dev.html?check`).
3. Rooms: a test across two machines and a live TURN relay, revealed codes on the strategy sheets,
   a cheaper per-frame stream view.
4. Performance on an integrated GPU with the real sim and 16 fighters.
5. Small UI: the rating marker alignment, history comparisons in the gym's job state, a Codex link
   for fighters.

## Later

- A `parry` expression per behaviour (parry is automatic today).
- Server-backed multiplayer, only if the prototype shows it is worth it.
