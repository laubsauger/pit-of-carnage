# Pit of Carnage: Spec

How the game behaves, by topic. Every requirement is written as a current rule. Two markers show
where the code is behind:

- **(not built yet)**: nothing in the code does this yet.
- **(not met yet)**: built, but the current behaviour falls short. [STATUS.md](STATUS.md) lists the gap.

Numbers are the current values. The source of truth for every gameplay number is
`src/core/rules.ts` (the rulebook players and LLMs read is generated from it). Change a number
there, re-run `npm run balance`, and update this file if a rule changes meaning. How the code is
organised is in [ARCHITECTURE.md](ARCHITECTURE.md); why, in [DECISIONS.md](DECISIONS.md).

Design brief: https://claude.ai/code/artifact/540265cf-9782-4fb6-9fd2-1a83e0a63814

## Contents

1. [Product and quality bar](#1-product-and-quality-bar)
2. [Match flow and formats](#2-match-flow-and-formats)
3. [Sudden death and stalemates](#3-sudden-death-and-stalemates)
4. [Maps](#4-maps)
5. [Fighters and builds](#5-fighters-and-builds)
6. [Combat and balance](#6-combat-and-balance)
7. [Perception and fog of war](#7-perception-and-fog-of-war)
8. [Power-ups, hazards and props](#8-power-ups-hazards-and-props)
9. [Strategy language](#9-strategy-language-pit-strategy2)
10. [Strategy validation gate](#10-strategy-validation-gate)
11. [Gym, reports, ratings, evolution, roster](#11-gym-reports-ratings-evolution-roster)
12. [Rendering and effects](#12-rendering-and-effects)
13. [Audio](#13-audio)
14. [UI](#14-ui)
15. [Multiplayer prototype](#15-multiplayer-prototype)
16. [Copy and voice](#16-copy-and-voice)

## 1. Product and quality bar

An autoplaying gladiator arena. Players never steer fighters. They write strategies, by hand or
with an outside LLM, test them in a private gym against built-in house stacks, and send them into
free-for-all brawls. Every match produces a battle report used to improve the next strategy.

- **Tone:** comedic slapstick violence, never grimdark.
- **Readability:** reads like a battle-bot or wrestling broadcast. You always see who hits whom,
  what happened and who died.
- **Readable hits:** every attack telegraphs (windup pose and glow) and lands with an impact flash,
  local hit-stop, knockback, an HP bar drop, sound and blood.
- **A death is an event:** slow motion, kill stamp, gore burst, crowd reaction.
- **Reasonable speed:** the sim runs at a fixed 60 Hz, independent of display refresh. At 1x a
  fighter needs about 8-10 s to cross the default arena. The director slows time around kills.
- **Quiet UI:** dark stone neutrals and one blood-red accent. Saturated colour only on fighters.
- **Glorious effects on a simple world:** light, shadow, blood, impact. Effects never hide who fights
  whom: gore lives on the floor layer, fighters are always on top, with outlines.
- **Performance:** 60 fps with 16 fighters on a laptop. **(not met yet: never measured.)**
- **Determinism:** the same config and seed give the same match in the same browser. Replays, seeks
  and "Watch" from the gym rebuild matches instead of storing them.

The prototypes in `docs/sample/` are concept references only: `(5).html` is the oldest (better
bodies, skills, gore, barks), `(6).html` adds vision cones, fog, maps and props, `(7).html` is the
newest with more character ideas. Many of their systems are broken or fake (evolution and ratings
do not work, several controls are unwired). Never copy their code or structure. Take ideas, build
each system properly to a shippable standard, and innovate where something can look or read better.

## 2. Match flow and formats

| Format | Fighters | Squads | Friendly fire |
| --- | --- | --- | --- |
| Free-for-all (default) | 2-16, default 8 | Every fighter on its own | Always on |
| Squads | 4-16 | Squad size 2 to half the fighters | On by default, can be switched off |
| Duel | 2 | One each | On |

- **Default match:** free-for-all, 8 fighters, the pit, 90 s time limit, sudden death on.
- **Match setup:** map, format, fighter count, squad size, friendly fire (squads), the strategy in
  each slot (random house stack, a chosen house stack or a saved strategy; "All random"), and the
  seed (with a dice button). The same seed and line-up give the same fight; the dialog says so and
  shows the current seed. Sudden death is always on from the setup dialog; `MatchConfig.suddenDeath`
  exists for tools and tests. Duplicate names get roman numerals ("Gary II").
- **Placement:** reverse order of death. The last fighter (or squad) standing is 1st.
- **Endings:**

| Ending | When |
| --- | --- |
| `elimination` | One fighter or squad left. The normal ending. |
| `judges` | Someone is still standing at the hard cap (time limit + 60 s). See section 3. |
| `time` | Only with sudden death off: the bell at the time limit, placed by standing. |
| `capped` | Gym safety stop, 10 s past the hard cap. Never happens in a healthy sim; reports flag it. |

- **Round start:** a "3, 2, 1, FIGHT!" countdown of 2.4 s (three 0.8 s beats), each beat ringing
  every fighter at its spawn in its colour, with a sound per beat and a FIGHT hit. The sim holds at
  tick 0 until FIGHT; a match never just starts mid-air. Every new match, restart and gym match opened
  from its start counts down; Space or a click starts the fight at once. A gym match opened at a kill
  or a death skips the countdown silently (no FIGHT over a replayed death).
- **Round end:** the final kill plays in ultra slow motion (a 0.12 s freeze, then x0.12 for 2.1 s,
  back to full speed just before the card) while the camera eases in close on the kill (about
  3.4 s) and a "WINNER" stamp with the winner's name in its colour slams in above the kill spot
  ("JUDGES' DECISION" for a judged ending, "WINNERS" and the squad in squads). The end card slides in
  from the side 3 s after the final kill and the camera keeps the winner in view beside it. Space or a
  click skips to it. A match replayed or seeked to its end again goes straight to the card.

## 3. Sudden death and stalemates

Every match ends with deaths. Hiding or getting stuck can never stall a match.

| Rule | Value |
| --- | --- |
| Start | At the time limit (90 s), or early on a stalemate. |
| Stalemate | No fighter has damaged another fighter for 15 s. Weapons, skills and kegs count; hazards and the wall do not. |
| Wall speed | Moves inward 0.25 px per tick on every side. |
| Final size | Stops when the arena is 90 px from its centre to an edge (centred on the map). |
| Wall contact | 4 every tick of contact, a push back in, 45 more per tick when pinned (crushed). |
| Damage outside | 4 every 10 ticks (a backstop; the solid wall keeps everyone inside). |
| Escalation | When the wall stops, level 1; +1 every second. Each level adds 2 to the wall damage outside. |
| Everywhere | 5 s after the wall stops, the escalated damage hits fighters inside the zone too. |
| Saws | Move x1.6 faster. |
| Hard cap | Time limit + 60 s: judges' decision. |

- **Judges' decision:** survivors placed by HP fraction left, then damage dealt, then kills; full ties
  keep roster order. Announced in the feed ("The judges give it to Gary, 40% health left."), logged
  in the report and its findings. Never silent.
- **The closing wall is solid and it hurts.**
  - Movement and knockback keep every fighter's whole body inside the playable rectangle.
  - The wall pushes anyone touching it straight back in with a knockback impulse of 10 (before the
    0.55 knockback scale) every tick of contact, whether they move or not, with a hard clamp as
    backstop. It also sweeps spent arrows, axes and dropped gear ahead of it, so ammo stays reachable,
    and Shadowstep cannot land behind it.
  - Touching it deals 4 damage every tick of contact (grinding spikes), with sparks, a blood smear and
    a grinding sound (`wall_contact` event).
  - A fighter pinned between the wall and a wall, pillar or prop is crushed: 45 more damage every
    pinned tick, kill flag `crushed`, stamp "CRUSHED".
  - Nobody can ever end up outside it. Tested: after sudden death starts, no living fighter is ever
    outside the bounds for more than one tick, on all four maps, brawls and wall-walkers included.
  - The numbers are `MATCH_RULES.wallContactDamage`, `wallPushKnockback` and `wallCrushDamage`. The
    "Damage outside" row above is now only a backstop.
- **Strategies can respond:** sensors `sudden_death` (0/1), `zone.distance` (px from me to the
  wall), `zone.time_to_reach` (s until the wall reaches me); place `zone_centre`; zone
  `outside_zone` (outside the arena and the strip the wall reaches within 3 s). Starter behaviour
  `escape_zone`; every house stack imports it. Documented in the registry and rulebook like
  everything else.
- **Visible and announced:**
  - The wall is a riveted iron wall with a row of steel spikes on its inner face. While it moves the
    spikes grind round the arena with a hot scrape line and sparks; they heat red with escalation.
    The arena behind it goes dark.
  - The floor shows a warning band where the wall will be in 3 s, with a dashed line where the spike
    tips will be.
  - A blood tide pulses over the whole floor once damage hits everywhere.
  - The feed announces each step in the broadcast voice: "The walls are closing. Somebody do
    something.", "Fifteen seconds without a scratch. The walls are coming in to help.", "The walls
    have stopped. Outside them it gets worse every second.", "Nowhere is safe now. The whole floor
    bites."
  - The match clock shows "Sudden death in m:ss" for the last 15 s before the time limit, and the
    timeline draws a line at the time limit.

## 4. Maps

All maps are 1360 x 860 px, mirrored on both axes, with one shrine at the centre.

| Id | Name | Floor | Ambient | Plays like | Layout |
| --- | --- | --- | --- | --- | --- |
| `pit` (default) | The Pit | sand | 0.14 | Balanced | Lit centre with the shrine on open sand; a ring of 8 pillars around it; open lanes along the top and bottom edges (ranged); gate halls behind gated walls left and right (melee); dark corner alcoves with a torch at each mouth (stealth). Kegs just inside the pillar ring on the hall side, acid amphoras at the top and bottom gaps of the ring, crates, a spike trap in each gate hall. Spawns spread evenly between the pillar ring and the walls. |
| `pillar_forest` | Pillar Forest | stone | 0.13 | Ambush | Staggered grid of pillars, short sightlines, a lit clearing round the shrine; fire pits (with light) and spike traps; kegs and amphoras. |
| `catacombs` | The Catacombs | stone | 0.06 | Stealth, hearing | 3 x 3 dark rooms joined by corridors, one torch pool per room; spikes on the doors into the shrine hall; amphoras, kegs, crates. |
| `meat_grinder` | The Meat Grinder | flesh | 0.15 | Melee | Walled central arena with corner openings and side gates, narrow corridors and doorways, 5 moving saws (one sweeps over the shrine), fire pits in the corners; kegs and amphoras. |

Every map has two haste and two berserk pedestals. On the pit they sit in contested spots, so
grabbing one is a risk: each berserk draught sits on a gate hall's spike trap (take it on the
off-beat or pay for it), and the haste charms stand in the light in the middle of the open top and
bottom lanes, in the archers' line of fire.

## 5. Fighters and builds

A build is a weapon, a skill and six attributes. Each attribute is 4-40; the total may not exceed
100 points.

| Attribute | Effect |
| --- | --- |
| vitality | Max HP +8.5 per point, slightly bigger body. |
| power | Weapon damage +2.4% per point; Whirlwind damage +0.55 per point. |
| agility | Move speed and turn rate. |
| perception | Vision range (+9.5 px), field of view, hearing (+4.2 px), auto-parry chance. |
| armor | Damage reduction 1.6% per point (cap 48%); slower to move and turn, bigger body. |
| haste | Attack cooldown -1.4% per point; skill cooldown -3.1 ticks per point. |

| Derived stat | Formula |
| --- | --- |
| Max HP | 150 + vitality x 8.5, rounded |
| Body radius | 15.5 + vitality x 0.18 + armor x 0.14 px |
| Move speed | (2.2 + agility x 0.068 - armor x 0.015) x weapon weight x 0.65 px/tick (at least 0.5 before weight) |
| Turn rate | (2.4 + agility x 0.145 - armor x 0.032) x weapon turn weight rad/s, clamped 1.6-7.4 |
| Damage reduction | armor x 1.6%, at most 48% |
| Damage multiplier | 1 + power x 2.4% (+35% while berserk) |
| Attack cooldown | weapon cooldown x (1 - haste x 1.4%), at least 10 ticks |
| Skill cooldown | 205 - haste x 3.1 ticks, at least 60; 40 at spawn |
| Vision range | 255 + perception x 9.5 + weapon bonus px |
| Field of view | weapon base + perception x 0.012 rad, clamped 1.35-2.55 |
| Hearing | 115 + perception x 4.2 px |
| Parry chance | 0.35 x perception / 40 per enemy windup you face |

**Stances** (set per behaviour):

| Stance | Move | Effect |
| --- | --- | --- |
| `normal` | x1 | Heard normally. |
| `creep` | x0.55 | Always counts as quiet for hearing. |
| `guard` | x0.7 | Greatsword and warhammer users raise a shield (blocks projectiles from the front). |

**Limbs.** A hit of at least 24 damage on a fighter below 50% HP has a 30% chance to sever a limb.
Losing the weapon arm drops the weapon; from then on the fighter punches (6 damage, 34 px reach,
every 30 ticks). Losing a leg: speed x0.55 and a hop animation. A crit has a 50% chance to knock the
helmet off (cosmetic).

## 6. Combat and balance

### Attacks

- **Cycle:** windup (the telegraph: pose and glow), strike (damage resolves on the first strike tick),
  recovery. The next windup waits for the attack cooldown and the end of recovery.
- **Melee reach** is measured from the attacker's centre to the near edge of the victim. A melee
  swing hits inside an arc centred on facing; the greatsword cleaves everyone in its arc, others hit
  one victim.
- **Damage:** base x damage multiplier x backstab or crit, reduced by the victim's armor, rounded,
  at least 3.
- **Backstab:** a hit arriving within 1.05 rad of the victim's back deals x1.45 (twin daggers
  x2.35). A backstab cannot also crit.
- **Crit:** 25% chance on hits of at least 28 damage before armor, x1.35.
- **Knockback** impulses are scaled by 0.55. Warhammer hits stun for 34 ticks; longbow hits slow the
  victim to x0.6 speed for 75 ticks.
- **Parry is automatic.** When an enemy within reach starts a windup aimed at a fighter that faces it
  (within 0.9 rad), is not stunned and has its parry off cooldown, the sim rolls the parry chance
  once for that windup. A parry lasts 30 ticks, has a 135-tick cooldown, reflects 65% of the blow and
  stuns the attacker for 40 ticks. Behaviours may set `"parry": "<expr>"` in a later language version.
  **(not built yet)**

### Weapons

| Weapon | Family | Range px | Damage | Cooldown | Windup | Move x | Lunge px | Special |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| GREATSWORD | melee | 82 | 30 | 42 | 14 | 1.06 | 30 | 2.35 rad arc, cleaves; shield in guard |
| WARHAMMER | melee | 70 | 26 | 44 | 15 | 1.02 | 24 | Stun 34, big knockback; shield in guard |
| TWIN_DAGGERS | melee | 56 | 16 | 18 | 6 | 1.15 | 36 | Backstab x2.35, fastest turn |
| THROWING_AXES | ranged | 265 | 21 | 26 | 8 | 1.00 | - | Speed 10.6, 4 axes, must pick up |
| LONGBOW | ranged | 430 | 20 | 33 | 11 | 0.96 | - | Speed 12.2, slow 75, 10 arrows, must pick up |
| ARCANE_STAFF | ranged | 375 | 25 | 43 | 12 | 0.95 | - | Speed 9.6, splash 60% within 72 px, 4 charges, one recharges every 90 ticks |

Cooldown and windup are in ticks; projectile speeds are before the 0.65 speed scale.

### Projectiles

**Stuck arrows and axes (not built yet).** Projectiles that hit a wall, pillar or prop stick into it
at the impact point and angle (a thunk, a little quiver, dust), instead of bouncing and dropping.
They stay retrievable: a fighter recovers one by walking up to that spot (the pickup point sits just
in front of the surface). Arrows and axes that hit a fighter stick in the body (comic pincushion,
capped number shown) and drop to the floor as pickups when that fighter dies; until then that ammo is
out of play. Misses that reach open floor skid and lie there as today. The balance pass checks the
bow's ammo economy with this rule (more arrows or a slow quiver refill if needed).

- A projectile stops at the first wall, pillar, prop, closing wall or fighter in its path. Any
  fighter: crowds take stray shots. It flies up to range x1.15, then drops.
- Spent arrows and axes land on the floor and must be walked over to take back. The staff
  recharges instead.
- A staff orb bursts on impact: 60% damage to others within 72 px.
- Shields: a greatsword or warhammer user in `guard` stance (with its left arm, not stunned) blocks
  projectiles arriving within a 1.6 rad arc of facing. A blocked orb still bursts on the shield; its
  splash spares the bearer.
- Every projectile spawns from its weapon's muzzle point (staff tip about 80 px ahead in the right
  hand, bow string, throwing hand; axes alternate hands) and aims from there. The stretch from body to
  muzzle is checked first, so a staff tip past a thin wall bursts on the wall and an enemy inside the
  staff's reach is still hit. `ProjectileState.origin` is the muzzle point.

### Skills

| Skill | Effect |
| --- | --- |
| WHIRLWIND | 25 + power x 0.55 damage to everyone within 92 px, with knockback. |
| SHADOWSTEP | Teleport 36 px behind the target (within 320 px), facing its back. Cannot land outside the sudden-death wall. |
| DASH | Impulse 14 along the steering heading plus haste for 65 ticks. |
| SHOCKWAVE | Parry window of 48 ticks, plus 19 damage and a 36-tick stun to everyone in a 96 px cone ahead. |
| BLOODRAGE | Berserk (+35% damage) and haste (x1.45 speed) for 145 ticks. |

Skill damage = base + power x scale, then armor (no other multipliers).

### Balance: ranged vs melee

Kiting is easy and closing in is hard, so the numbers must make melee worth it.

- **Kiting costs.** Moving away from where you face is slow: x0.55 straight backwards, blended by
  angle up to full speed forwards (sideways is halfway). Ranged attackers plant to shoot: x0.3 move
  speed during windup and recovery. A shot releases only when the shooter faces its target within
  0.15 rad; the windup holds until then (at most 45 ticks).
- **Shots are not free.** Aim error (half-angle) = 0.025 + 0.06 per px/tick of the shooter's speed
  + 0.00012 per px of distance, at most 0.3 rad. Aim prediction is imperfect: shooters lead 75% of
  the target's seen velocity. Point-blank hits (under 80 px at release) deal half damage. Spent ammo
  must be picked up again.
- **Melee hits harder up close.** Melee damage per second is about 1.5-1.8x ranged (a guideline,
  **not met yet**: 1.07x). A melee hit on a ranged attacker in windup cancels the shot (no ammo
  spent) and staggers it for 18 ticks. Every melee strike lunges 20-40 px. Melee weapons move about
  10% faster than ranged ones, and no ranged weapon outruns a melee one. Shields in guard stance
  block projectiles from the front.
- **Measured, not guessed.** The balance harness (`npm run balance`) runs (a) weapon-vs-weapon duels
  on the pit between comparable stacks (same build, skill and target rule, the family's starter plan)
  over 100 seeds per pairing, each seed played twice with seats swapped, and (b) 8-fighter FFAs with
  the house stacks on all four maps. Targets: every duel pairing wins between 35% and 65%; each
  weapon family wins between 0.67x and 1.5x its fair share of FFAs on the pit. Results and the
  current numbers go to `docs/BALANCE.md`; re-run after any rules change. **(not met yet: 1 of 3
  targets hold.)**

### Core balance and expressiveness pass (not built yet)

User observations to start from (watching live matches after pass 1):

- **Longbow struggles.** Archers must walk to recover arrows and seem to do too little damage, while
  staff users dance around them and regenerate. Candidates: more arrows per quiver or a slow quiver
  refill, higher arrow damage or crit chance, arrows that pierce one body; the bow should reward
  standing still and aiming.
- **Staff too safe.** Slow its orbs so they can be dodged and body-blocked, cap mana so regeneration
  is a real pause, and make it plant to cast like the bow.
- **Twin daggers / Brenda From Accounts overpowered.** The user sees her attack so fast that
  opponents have no chance. Numbers today: 16 damage every 18 ticks before haste (about 3-4 swings a
  second), +43% from her 18 power, backstab x2.35, SHADOWSTEP to get behind, a 36 px lunge, move x1.15
  and turn x1.38. Check how haste shortens the cooldown, whether backstab and lunge stack with
  shadowstep too well, and give daggers a real weakness (low reach, no block, fragile).
- **The Unpaid Intern camps.** It survives by hiding and rarely matters. Treat it as the first
  candidate for automated per-strategy tuning (below).
- **Automated per-strategy tuning.** A gym tool (`npm run tune <strategy>`) that improves one
  strategy only through its JSON (weights, thresholds, ranges, attributes, behaviour choices from the
  library), never by changing the engine: local search over many seeded FFAs against the current
  field, keeping the strategy's identity and niche, reporting before/after placement and win share.
  The roster pipeline uses the same tool for every house strategy.

Treat the current numbers as untested. The user sees the arcane staff dominate: it fires too often
and too fast, and nobody has an answer. A dedicated pass, measured with the harness:

- **Find the crazy imbalances in the core**, starting with ARCANE_STAFF (cooldown, projectile speed,
  splash, homing-like accuracy, charge regeneration), then every other weapon, skill, stat formula
  and hazard. `docs/BALANCE.md` records each weapon's damage per second, effective range,
  time-to-kill and counterplay with the reasoning (projectiles can be dodged, blocked and
  body-blocked; melee cannot be dodged once in reach but must close in).
- **Give strategies more ways to express ideas**, so an LLM can invent non-standard tactics:
  consider more skills (skill shots, traps, decoys, grabs and throws, a shield bash, a smoke bomb, a
  taunt), per-build traits or perks bought from the point budget, and any sensor or place a
  reasonable tactic needs but cannot express today. Every addition goes through the registry,
  rulebook and validator.
- **Bleed, as a candidate.** Adopt only if the harness shows it adds variety without dominating.
  Sketch: a lost limb always bleeds; some sources add bleed stacks (dagger backstabs, a "serrated"
  perk bought from the budget); small damage over time per stack; shrines cure it. Tactics:
  hit-and-run against a bleeding target, retreat to a shrine when bleeding. It ties into fog of war:
  bleeding fighters leave a drip trail hunters can follow out of sight (sensors `self.bleeding`,
  `target.bleeding`; place `blood_trail(target)`).
- **Keep the meta open.** No single build or weapon may win the evolution or the balance harness by
  a wide margin. Diversity is measured, not assumed. The meta may evolve later, but it must not
  start converged.
- **Then crystallize the roster** (section 11, "Shipped roster").

## 7. Perception and fog of war

A fighter acts only on what it perceives. Its records of enemies are its own memory, never a window
onto the live fighter. Head and torso follow the record.

- **Vision:** range and field of view from the build (section 5). The cone follows the head.
  Walls, pillars and the closing wall block line of sight. A target in shadow (light below 0.35) is
  seen only within 45% of normal range.
- **Light:** map ambient plus every light whose line of sight reaches the point. Torch flicker is
  cosmetic only.
- **Hearing:** radius from the build, x1.15 against a target moving faster than 1 px/tick, x0.72
  against one that is slow, still or creeping. It works in every direction; through a wall or pillar
  only within half the radius.
- **Hearing is fuzzy.** A heard-only target gives an estimate, never a position: it is off by between
  half and all of 24 + 0.2 x distance px, in a direction that is deterministic per pair, and it
  moves to a new guess every 30 ticks (about twice a second). Hearing reveals nothing else: no
  velocity, facing, HP or ammo.
- **Losing sight means losing the target.** Once unseen, the record keeps the last seen position and
  velocity; the estimate does not follow the real fighter. An enemy neither seen nor heard for 360
  ticks is forgotten.
- **Attacks follow knowledge.** A ranged attack needs the target seen this tick, at windup and at
  release; otherwise the shot is abandoned and no ammo is spent. Melee may swing blind only at a
  heard target whose estimate is within reach.
- **Search instead of stare.** The head turns smoothly and at a limited rate, never snapping on a
  target change, and stays within 1.4 rad of the torso. After losing sight it looks at the last seen
  spot for 45 ticks, then sweeps 2.4 rad around it every 120 ticks.
- **Vocabulary:** `target.visible`, `target.heard`, `target.last_seen_age` (s), `target.seen`,
  `target.since_seen`; `target.distance` is the distance to the current estimate. Places
  `last_seen(X)` and `search_point` (an expanding sweep around the last seen spot). Starter
  behaviour `search`; four house stacks use it.
- **Show what they know.** Fog view, aim lines and the inspector reflect the fighter's knowledge,
  never the truth: fog from the selected fighter's view (on by default); a ghost marker at the last
  seen spot with "lost sight 2.3 s ago"; hearing drawn as rough ripple rings over the estimate's
  error, never an exact marker; the aim line ends at the live body if seen, the estimate (with an
  uncertainty circle) if heard, the remembered spot otherwise; the inspector's "What it knows" lists
  each enemy as seen, heard or remembered. In fog view, other fighters' tags are hidden unless the
  selected fighter sees them.
- **Tested invariants:** a target behind a wall beyond hearing range can move freely without the
  record changing; a heard-only estimate is never exact and only moves on refresh; across whole
  matches nobody fires a projectile at a target it cannot see; a blind melee swing only happens at a
  heard target in reach; the head eases instead of snapping.

## 8. Power-ups, hazards and props

### Power-ups and the shrine

| Item | Effect | Timing |
| --- | --- | --- |
| Shrine | Heals 42% of max HP on touch | Recharges 320 ticks after use |
| Haste charm | Move speed x1.45 for 200 ticks | First appears after 480 ticks; respawns 600 ticks after it is taken |
| Berserk draught | +35% weapon damage for 200 ticks | First appears after 480 ticks; respawns 600 ticks after it is taken |

Power-ups must matter: strong, short, visible, and worth a detour.

- **Core.** `WorldQuery.nearestPickup(p, kind)` with kind `haste`, `berserk` or `any` returns the
  pedestal's position, whether it is ready and the seconds until it respawns. Pedestals are map
  data, so this is not limited by fog.
- **Vocabulary.** Sensors `pickup.haste.ready`, `pickup.haste.distance`, `pickup.berserk.ready`,
  `pickup.berserk.distance`, `pickup.any.ready`, `pickup.any.distance`, `pickup.respawn_in`,
  `self.hasted`, `self.berserk`; places `pickup(haste)`, `pickup(berserk)`, `pickup(any)`,
  `nearest_pickup`. The rulebook says what each power-up does.
- **Library and house stacks.** Starter behaviours `grab_powerup` and `deny_powerup` (camp near one
  about to respawn). At least three house stacks use power-ups, one whose whole plan is item control
  (Two-For-One Tina).
- **Visible.** A glowing octagonal pedestal with runes that brighten as the respawn nears, a ring
  that fills to show the respawn timer (blinking in the last second), an elastic pop-in, a burst
  ring when taken, and an announcer line when one comes back ("Berserk is up.").
- **Reported.** Battle reports count pedestal power-ups taken and what they bought ("Took berserk 4
  times, 3 kills while berserk"; skill buffs do not count). Findings flag strategies that never take
  one when one was up, and matches where nobody touched them.

### Shrine readability

The shrine is not a capture point: a wounded fighter touching it (34 px) heals 42% of max HP at once,
then it recharges for 320 ticks. Players must be able to see that: a ready shrine pulses and glows, a
ring fills while it recharges, a use shows a green heal burst, a "+N" heal number and a feed line
("Gary patched up at the shrine, 86 health back."). Built as: a heartbeat throb with a heal cross and
green floor light when ready, a drain burst on use, a dark refilling basin with runes lighting up one
by one while it recharges. Every map object (shrine, pedestals, kegs, amphoras, crates, acid, saws,
spikes, fire) has a hover card with what it does, in seconds, and its live state ("Recharging, 3.2 s",
"Back in 7.5 s", "Thrusts in 0.8 s", "18 of 32 HP", "Dries up in 4.1 s"). A centre "crowd favour"
zone is an optional idea for the balance pass, not a default.

### Hazards

| Hazard | Effect |
| --- | --- |
| Spike trap | Thrusts at 88% of its 165-tick cycle for 36 damage. Holes glow red over the last 30% of the cycle. |
| Saw blade | Rolls along its track; 22 damage every 12 ticks to anyone it touches. x1.6 faster in sudden death. |
| Acid pool | 11 damage every 24 ticks and a slow (x0.6 speed for 40 ticks after each damage tick) while you stand in it. Spilled pools dry up after 400 ticks. |
| Fire pit | 9 damage every 20 ticks while you stand in it. Also a light source. |

- **Acid reads as acid and hurts.** **(not met yet: the look and the slow are built; the damage is
  still 11 every 24 ticks, to be raised in the balance pass.)**
  - Look: an opaque, sunken liquid, darker toward the centre, a slowly churning surface, bubbles
    that rise and pop, a few bright glints, thin toxic fumes, a corroded scorched rim, only a faint
    glow. Blood and floor never show through.
  - Fighters inside visibly suffer: green tint, sizzle smoke, hurt flashes.
  - Gameplay (tuned in the balance pass): heavy damage per second plus a slow, so standing in it is an
    obvious, costly mistake and knocking someone into it is a tactic.

### Props

| Prop | HP | On break |
| --- | ---: | --- |
| Powder keg | 32 | Explodes: 38 damage and heavy knockback within 106 px; emits an explosion. Kills credit whoever broke it. |
| Acid amphora | 18 | Shatters into an acid pool that lasts 400 ticks. |
| Crate | 45 | Blocks movement and projectiles until broken. |

## 9. Strategy language (pit-strategy/2)

A strategy is a set of behaviours composed from documented primitives. No black-box verbs.

### Document

| Field | Meaning |
| --- | --- |
| `schema` | Always `"pit-strategy/2"`. |
| `name`, `author`, `version` | Identity; `name@vN` identifies a strategy in reports and ratings. |
| `build` | `weapon`, `skill`, `attributes` (section 5). |
| `target` | Expression evaluated per known enemy with `it.*` bound to that candidate; the highest wins. |
| `behaviours` | Named behaviours: `score`, `move` (terms), `attack` (policy), optional `skill` (expression), `set` (memory writes), `stance`. |
| `imports` | Starter-library behaviours merged in; an own behaviour with the same name wins. |
| `memory` | Named slots and their start values. |
| `commit` | Ticks a newly chosen behaviour keeps the commit bonus. |
| `barks` | Lines per kind: `spawn`, `kill`, `hit`, `low_hp`, `death`, `skill`, `taunt`. |
| `look` | Optional colour (`#RRGGBB`) and glyph (1-2 characters). |

### How a fighter thinks

Every 6 ticks (10 Hz, staggered across fighters):

1. Perception updates what the fighter knows (section 7).
2. The target expression picks a target among known enemies.
3. Every behaviour's `score` is evaluated. The running behaviour gets +0.25 until `commit` ticks
   have passed since it started (hysteresis). The highest score wins.
4. Its move terms each rate 16 directions in [-1, 1]. The weighted sum is smoothed with the last
   think, the danger of walls and hazards along each direction is subtracted, and the best direction
   wins (context steering), refined between neighbours. If danger blocks the wanted direction the
   fighter slides along the best open one.
5. Its `attack` and `skill` policies decide actions; `set` writes memory; `stance` applies.
6. Parry permission is automatic (section 6).

### Expressions

- Numbers, `true`/`false`, sensor paths, memory slots, `+ - * /`, comparisons
  (`< <= > >= == !=`, not chained), `and or not`, `min max` (2-8 arguments), `clamp` (1 or 3
  arguments), `abs`, parentheses. Booleans are 1 and 0.
- `&& || ! = % ^ ?` are rejected with a hint.
- Parsed once into an AST, compiled to closures, evaluated without `eval` or `Function`. No loops or
  recursion, so a strategy cannot loop forever by construction; the rulebook says so.
- Unknown names are errors with "did you mean" suggestions.
- Limits: 600 characters, nesting depth 48.

### Vocabulary

The registry (`src/brain/registry.ts`) is the source of truth. Each word has a doc, unit and range,
and the validator, JSON Schema, rulebook and LLM prompt are generated from it.

- **Sensors about me and the world:** `self.hp` (0-1), `self.hp_abs`, `self.ammo`, `self.ranged`,
  `self.reach`, `self.in_shadow`, `self.light`, `self.speed`, `self.stunned`, `self.seen` (anyone
  sees me), `self.limbs`, `self.kills`, `self.berserk`, `self.hasted`, `skill.ready`, `attack.ready`,
  `parry.ready`, `enemies_seen`, `enemies_known`, `enemies_near` (within 200 px), `fights_nearby`,
  `allies_alive`, `ally.distance`, `shrine.ready`, `shrine.distance`, `ammo.distance`,
  `hazard.distance`, the `pickup.*` sensors (section 8), `time` (s), `sudden_death`,
  `zone.distance`, `zone.time_to_reach`, `since_hit` (ticks since I was hit), `random`.
- **Fighter sensors**, as `target.<key>` in behaviours and `it.<key>` in the target expression only:
  `distance`, `visible`, `heard`, `last_seen_age`, `hp`, `hp_abs`, `facing_away`, `sees_me`,
  `ranged`, `family_ranged`, `winding_up`, `ammo`, `fighting`, `last_attacker`, `kills`, `seen`,
  `since_seen`, `in_reach`, `in_shadow`, `hazard_distance`, `is_target`.
- **Fighter references:** `target`, `nearest_enemy`, `last_attacker`, `weakest`, `nearest_fight`,
  `ally`; the word `enemies` where an argument takes several fighters.
- **Places** (fighter references are places too): `behind(X, d)`, `side(X, deg, d)`,
  `cover_from(X)`, `last_seen(X)`, `search_point`, `hazard_near(P)`, `beyond(P, Q, d)`, `shrine`,
  `ammo`, `pickup(K)`, `nearest_pickup`, `centre`, `zone_centre`, `nearest_keg`, `corner`,
  `dark_spot`.
- **Zones:** `shadow`, `lit`, `seen_by(X)` (including `seen_by(enemies)`), `hazards`, `walls`, `open`,
  `outside_zone`.
- **Move terms:** `seek P`, `flee P`, `keep_range [P, min, max]`, `orbit [P, "cw"|"ccw"]`, `avoid Z`,
  `prefer Z`, each with a `weight` (0-5).
- **Attack policies:** `in_range`, `never`, `if_blocked`, or any expression (truthy = attack).
- **Skill policy:** an expression (truthy = use the skill when ready); omitted = never.

### Limits

| Limit | Value |
| --- | --- |
| Behaviours (after imports) | 8 |
| Move terms per behaviour | 6 |
| Memory slots | 12 (values within ±1e6) |
| Move weight | 0-5 |
| Score | clamped to ±100 (a score that can exceed it is an error) |
| Expression | 600 characters, depth 48 |
| Evaluation cost per think | 4000 units (target expression counted for 15 known enemies) |
| Name, author | 40 characters |
| Behaviour and memory names | 24 characters, `^[a-z][a-z0-9_]*$` |
| Commit | integer 0-600 ticks |
| Barks | 8 lines per kind, 48 characters per line |
| Strategy text | 64 KiB |

### Barks

The sim says lines from the strategy's `barks`: each trigger has a chance (spawn 50%, kill 80%, hit
15%, low HP 60% once below 30%, death 70%, skill 50%, taunt 5%). A fighter barks at most once every
8 s, whatever the kind; `hit` and `taunt` lines also share a global gap of 45 ticks. What is shown
is decided by the view settings (section 12, "Popups").

### Starter library and house stacks

Starter behaviours, written in the language itself: `prowl`, `brawl`, `kite`, `restock`, `heal`,
`retreat`, `lurk`, `backstab`, `bait`, `guard_corner`, `third_party`, `search`, `grab_powerup`,
`deny_powerup`, `escape_zone`. The rulebook includes each with its docs and JSON as worked examples.

House stacks: at least 8 distinct strategies covering every weapon and several play styles, each
with a funny name and barks. Today there are 13 (placeholders until the shipped roster replaces
them):

| Stack | Weapon | Skill |
| --- | --- | --- |
| Apologetic Gary | GREATSWORD | WHIRLWIND |
| Big Lad Steve | GREATSWORD | BLOODRAGE |
| Sir Clanksworth | GREATSWORD | SHOCKWAVE |
| Doug's Corner | WARHAMMER | SHOCKWAVE |
| Shrine Hog Hortense | WARHAMMER | WHIRLWIND |
| Brenda From Accounts | TWIN_DAGGERS | SHADOWSTEP |
| Kevin, Professional Bait | TWIN_DAGGERS | DASH |
| Uncle Hatchet | THROWING_AXES | DASH |
| Two-For-One Tina | THROWING_AXES | DASH |
| Distant Cousin Pam | LONGBOW | DASH |
| Aunt Carol Finishes Things | LONGBOW | BLOODRAGE |
| Mortar Mildred | ARCANE_STAFF | SHOCKWAVE |
| The Unpaid Intern | ARCANE_STAFF | DASH |

## 10. Strategy validation gate

No strategy reaches the brain or the sim without passing one gate.

- **One gate.** Imported files, pasted text, strategy codes, saved versions, house stacks, match
  configs, evolution children, the CLI and (later) network peers all go through
  `loadStrategy(input, source)` and get the same report. The source only shapes message wording and
  logs; each caller passes where the strategy really came from. Anything that crosses a worker or
  the network is gated again on the other side.
- **Branded result.** `loadStrategy` returns `{ strategy?: ValidStrategy, errors, warnings }` and never
  throws. `createBrain` accepts only `ValidStrategy`, so unvalidated JSON cannot compile.
- **Inputs:** JSON text (a byte-order mark is ignored; a ```` ```json ```` block inside an LLM answer
  is read in place), a strategy code (`PIT2.…`), or an already parsed value. Text is capped at
  64 KiB.
- **Errors block loading:** invalid JSON (with line and column), duplicate keys, wrong or missing
  `schema`, unknown properties anywhere (with "did you mean"), wrong types, out-of-range or
  non-integer numbers, non-finite numbers, attribute budget overrun, unknown weapons, skills,
  sensors, places, zones, terms or policies, expression syntax errors, undeclared or reserved memory
  slots, exceeded limits (section 9), duplicate or invalid names, `keep_range` min above max, bad
  `look` colour or glyph, and every static-analysis error below.
- **Warnings lint but allow:** unspent attribute points, no `attack` policy, no `commit`, a behaviour
  that can never win, memory written but never read (or read but never written), all move weights
  zero, a strategy whose winning behaviours never attack, an own behaviour that shadows an import,
  an unused import (one that never scores above 0 for this build), comparisons that are always true
  or false, constant expressions.
- **Precise locations.** Every issue carries a JSON path and, when the input was text, line and
  column, so the editor underlines it and the problem list jumps to it. Messages are one line of
  plain English with a suggested fix that can be pasted back to an LLM.
- **Static analysis before runtime.** Anything a runtime guard could catch is reported at load time.
  Every sensor declares its range in the registry; the validator propagates value intervals through
  each expression (memory slots by a fixed-point loop) and reports: a divisor whose range includes 0
  (error), overflow (error), a score whose range exceeds ±100 (error, with the range it can reach),
  comparisons that are always true or false, constant expressions, behaviours whose best score is
  below another behaviour's worst score (unreachable), and the evaluation cost per think against the
  budget. Cost over budget is an error, so the runtime cap never fires for a valid strategy.
- **Runtime guards, never silent.** As a second line of defence the evaluator turns NaN and
  infinities into 0, division by zero yields 0, scores and weights are clamped, evaluation cost per
  think is bounded, and the sim never accepts a non-finite heading or speed. Every guard trip is
  counted per fighter and per expression path, shown as a badge in the inspector, listed in the
  battle report ("Guard trips: behaviours.lurk.score hit division by zero 212 times") and included
  in the LLM summary. A guard trip in a strategy that passed static analysis is a validator bug and
  gets a test.
- **Strategy codes:** `PIT2.` + base64url of the raw-deflated JSON (fflate, level 9). Codes are
  capped at 16 KiB and their unpacked JSON at 64 KiB (zip-bomb guard).
- **Tooling.**
  - The generated JSON Schema is published at `public/pit-strategy-2.schema.json` so editors can use
    `$schema`; a test keeps it equal to the generated one.
  - `npm run lint:strategy -- <files>` validates files from the command line (handy in an LLM loop):
    one `file:line:column  severity  path  message` line per issue, exit code 1 on any error.
  - Fuzz tests feed thousands of random, mutated and garbled strategies and codes through the gate;
    every accepted one thinks without NaN or guard trips, and a sample plays short real matches.
- **Import UI:** see section 14, "Import".

## 11. Gym, reports, ratings, evolution, roster

### Gym screen

A strategy library rail (new strategy, your strategies, house stacks) and three tabs: Editor, Test
(batches) and Evolve. Jobs run in a Web Worker, one at a time, with progress and Stop. The Gym and
the Room work without WebGPU.

### Batches

A batch request names candidates, a field of opponents, maps, number of matches, fighters per match
and a seed. Every candidate gets a seat in each match; the other seats are drawn from the field;
maps rotate. Seeds derive from the batch seed, so the same request reproduces the same reports.

### Battle reports

- **Match report:** seed, map, format and rules (enough to replay the match exactly), duration, how
  it ended and when and why sudden death started, roster (fighter, strategy name and version,
  weapon, skill, squad, colour), placements, every kill (killer, victim, weapon, tick, position,
  cause, flags, both behaviours), findings.
- **Per fighter:** place, kills, damage dealt and taken (and by source), time of death, ticks per
  behaviour and behaviours that never won, exposure (ticks alive, seen, in shadow), attacks, hits
  landed, skill uses, parries, power-ups taken and kills while buffed, guard trips.
- **Aggregate per strategy:** matches, placement histogram, average place, win rate, wins by map and
  by opponent ("finished ahead of"), killed-most-by, average kills, damage and survival, deaths by
  cause, power-ups, guard trips, findings, openskill rating. Batch findings too ("Lurking Daggers v3
  beats the house stacks 7 of 10 on the Pit.").
- **Findings** are plain sentences computed in code from the numbers, never invented.
- **`reportToText()`:** a compact plain-text summary for pasting into an LLM, followed by the full
  report as JSON. The end card, batch report and editor's "Copy LLM prompt" use it.

### Watch and understand any match

Knowing a strategy lost is useless without seeing why. Every gym match is deterministic, so any of
them can be rebuilt exactly.

- **Watch from anywhere.** Each match row in a batch report has Watch (same seed, same fight in the
  arena), and expands to per-fighter numbers with Watch at any kill or death. One-click "Watch worst
  loss", "Watch best win" and "Watch a typical match" for the selected strategy (the gym's
  `pickMatches`) open just before the moment, with the candidate selected and the timeline
  pre-filtered to it. Evolution generations and archive entries have Watch too. **(not met yet: an
  archive entry plays a fresh deterministic match against the run's field, not the generation's own
  match, because generation reports do not record their matches.)**
- **Back to the gym.** The watch view shows which report it came from ("Test report, match 7 of 20")
  and returns to the same row, flashing it.
- **More numbers per fighter, for humans and LLMs** (beyond the report fields above): distance
  travelled, accuracy, damage dealt and taken per second while engaged, time to first contact, ticks
  idle or stuck (stuck = wanted to move but could not), time near walls and outside the zone, skill
  hit rate, assists and kill participation, and a coarse position heatmap per map (drawn in the UI,
  summarised in words for the LLM: "corners 62%, sides 30%, centre 8%; busiest spot: the north-west
  corner"). Habit findings call out camping, getting stuck, never fighting and a favourite spot. The
  words do not say "dark": shadow time is reported on its own ("in shadow 26%").
- **Compare.** Two strategies or two versions side by side over exactly the same seeds, maps,
  opponents and seat (they never meet; not rated), with the numbers above, their heatmaps, the finish
  on each seed and Watch for either side ("Compare two" in the Test tab; `compareToText` for the LLM).

### Ratings

**Showing a rating (not met yet).** The gym report appends a faint "?" after some ratings: it means
"provisional, few rated matches", but nothing explains it (the native title tooltip is easy to miss)
and it shifts the digits. Rule: ratings sit in a right-aligned column with tabular figures so digits
line up; uncertainty is shown, not hinted: "1240 ±85" with the ± part muted; a provisional rating gets
a small leading "new" marker in its own fixed-width slot before the number, with a proper hover card
("Provisional: rated from 3 matches. Settles after about 10."). Every symbol in the UI has a hover
explanation; no bare glyphs.

- openskill (Plackett-Luce over FFA placements; one team per squad). New strategies start at mu 25,
  sigma 25/3. Ordinal = mu - 3 x sigma, used for sorting. Shown as `round(1000 + ordinal x 40)`, so a
  new strategy shows 1000; the UI marks a rating as provisional ("?") while uncertain.
- Updated from every rated batch match and persisted between sessions. Never assigned by hand.
- The Room shows the leaderboard: rating, matches, wins, win rate, average place, last played.

### Evolution

- MAP-Elites: an archive of elites, one per niche. Niche = weapon family (2) x preferred range (close
  under 120 px, mid, far over 300 px) x aggression (cautious, balanced, aggressive): 18 niches,
  read from where the strategy spends its time.
- Each generation breeds children from the whole archive by mutation (weights, thresholds,
  `keep_range` bounds, attributes, swapped terms, weapon or skill) and crossover (whole behaviours
  with their memory slots from another elite or a field strategy). Every child passes the gate before
  it plays; duplicates are skipped.
- Children, elites and the champion play the same seeds against the same fixed field (paired
  comparison). A child takes an empty niche, or an occupied one when it beats the elite by a margin.
  A title challenger must beat the champion on the shared seeds and again on twice as many fresh
  seeds. Fewer, honest promotions beat a new "champion" every generation.
- Each generation reports what changed in plain words ("kite: keep_range max 300 -> 340") and a
  summary that names it ("New contender: Lurking Daggers v3 beats v2 on 7 of 10 shared seeds.").

### Shipped roster (not built yet)

Develop the 16 strategies that ship as house stacks with the gym rather than guesswork, in an
automated, reproducible pipeline (`npm run roster`) that searches, tests and selects them and writes
`docs/ROSTER.md`. The current house stacks are untested placeholders. Comes after the core balance
and expressiveness pass (section 6).

- **Diverse by construction.** Cover all six weapons and clearly different plans: ambush from
  shadow, corner holder, third-partier, kiter, power-up controller, shrine camper, brawler,
  berserker, hunter-searcher, bait-and-trap, squad-friendly support, and more. Each has a distinct
  name, colour, glyph and voice.
- **Competitive, measured.** Round-robin duel matrices and many 8-16 fighter FFAs across the map pool
  and seeds. Every roster strategy holds an average FFA place inside a band around the middle and
  wins somewhere; none may dominate (cap its overall win share). Rated with openskill.
- **No convergence.** MAP-Elites niches plus hand tuning. Reject candidates that behave like an
  existing member (compare behaviour-usage profiles, positions held, preferred range). The roster
  must not collapse into one archetype with different names.
- **Documented.** `docs/ROSTER.md`: each strategy's idea, niche, strengths, counters, win rates by map
  and the matrix, regenerated by the script.

## 12. Rendering and effects

### Camera

- Orthographic, looking straight down. Depth comes from light and shadow only.
- **Director:** frames the living fighters, follows the selected fighter on demand, eases zoom
  toward big moments (kills, explosions), never zooms past a set limit.
- **Shake only on kills:** one short, decaying shake per kill, capped (never stacking beyond it),
  and only with the shake setting on. Hits and projectile impacts never move the camera.
- **Manual control:** the mouse wheel zooms toward the cursor, dragging pans, double-click follows a
  fighter. Any manual input pauses the director until the viewer presses "Reset camera" (button and
  key C). Zoom is clamped to sensible limits (1x-4x the fitted view). Follow keeps working at the
  viewer's zoom; seeks keep the viewer's view.

### World

- **Floor:** a plane with a subtle procedural sand, stone or flesh texture, with the gore decal target
  composited on top.
- **Walls and pillars:** low bevelled blocks shaded by the light.
- **Light:** dim ambient plus the map's torches (with flicker). A TSL compute light field with 2D
  wall and pillar shadows matches the sim's `lightAt`, so what reads as shadow on screen is shadow
  for stealth. Explosions, kills, skills and parries flash light; orbs and pickups glow.
- **Shadows:** walls and pillars cast torch shadows. Fighters, weapons, projectiles and gibs cast
  soft shadows from nearby lights, so they sit in the world like the environment does.

### Fighters

- Top-down bodies in the oldest sample's spirit: striding boots, a torso in the fighter's colour,
  pauldrons by armor, head with a class helmet, eyes that pop, an oversized weapon with a four-phase
  animation (windup, strike, recovery, idle). Built from instanced vector cut-out shapes with a dark
  ink outline, crisp at any zoom.
- Name tag and a thin HP bar above each fighter; tags keep a constant screen size. White hit flash.
  The HP bar chips: a pale ghost segment holds briefly after a hit, then drains.
- Lost limbs show stumps; a legless fighter hops.

### Overlays

- Vision cones (soft, low alpha) drawn as an exact visibility polygon (rays to every blocker corner
  plus a fan), with the displayed heading eased on the render side. Combined with the sim's damped
  head, cones do not jitter.
- Steering ring and target (aim) line for the selected fighter.
- Fog of war, ghosts and hearing ripples (section 7).

### Post-processing

One TSL `RenderPipeline`: bloom on emissive only (fire, sparks, orbs), vignette, a light film grain,
and a brief kill punch (chromatic split and contrast kick, about 0.3 s). The kill punch must not
tint the screen red at high speed: a real-time envelope allows a full punch only after a quiet
stretch (the final kill always gets one), and the red edge grade multiplies instead of adding red.

### Hits: weight without rumble

Ordinary hits land locally: a few frames of hit-stop on the two fighters involved, a white flash and
squash-and-stretch on the victim, a knockback slide with dust, a small impact ring on the floor,
sparks or spray coloured by the weapon, and the HP bar chip. The camera stays calm.

### Impacts scale with what happened, not with the weapon

Every ordinary hit, melee or ranged, gets a similar, modest impact sized by its damage. The big
moments are reserved for crits, kills, backstabs and explosions, for every weapon: crits get a sharp
flash and extra spray, kills the full death burst. Spells keep their colour identity, not extra size.
Built: `impactSize` sizes every hit by its damage; a staff orb's burst is no bigger than an arrow
or axe hit.

### Projectiles and their impacts

**Spell colour comes from the fighter.** Every caster's spell colour is derived from its fighter
colour (same hue, brighter and more saturated): staff tip glow, orb, trail, light on the floor and
impact all use it, so a spell always says who cast it.

Each projectile has its own colour and impact, and its trail uses the same colour, so a hit reads at
a glance. Never one shared grey smoke puff.

| Projectile | Trail and impact |
| --- | --- |
| Arrow | Fletching in the shooter's colour; amber trail; wood splinters and a small spray. |
| Thrown axe | Spinning, steel trail; metallic sparks and a clang flash. |
| Staff orb | A spell colour per caster (from the fighter's colour) for the orb, trail, halo, floor light, burst and ring. The staff's own tip glow uses the caster's spell colour too. |
| Keg | Orange fireball, hot core, rings, embers, smoke and a scorch mark. |

### Blood and gore

**Blood is stored as data, not colour.** The floor decal target holds, per texel, blood density,
wet density, tone-weighted density (each as exp(-x), so stamps add up exactly) and soot. The floor
shader (`goreFloor`, render-fx) maps them through one blood gradient: arterial red, deep red, dark
maroon, with a darkness floor (#2c0809) and a minimum light on blood, a faint red view-independent
gloss on wet blood, no noise, and the cool gameplay-shadow tint on the bare floor only. Pass 1's grey
haze came from an additive wet sheen with baked noise, the shadow tint on blood and stamps
multiplying toward near black; all three are gone.

Acceptance (met, `docs/screenshots/pass2-render-fx-overlap.png`): a heavily overlapped area, in
torchlight and in shadow, shows only reds and maroons, no grey, no blue cast and no noise pattern.

**Blood ages (user feedback).** Fresh blood starts a little less bright than now (deep arterial red,
not neon) with a slight wet gloss; over about 30 s of game time it darkens and dries toward a deep
dried maroon-brown, never grey. New blood landing on old must stand out clearly, so even late in a
long match you can see where the latest hits landed. Wetness is stored per texel with the density
and dries with a 10 s half-life (in 0.5 s steps), so a fresh splat over old blood makes that spot
fresh again.

Comic excess, not realism. Carnage is the default blood setting.

- **Blood stays on the floor.** Every hit stamps blood into the floor decal target and it stays
  visible for the whole match (cleared only on a new match or seek). Verified by a screenshot after
  30 s of fighting showing red floor.
- **Much more blood.** Hits spray, big hits gush, and a death is an explosion: gib burst, blood
  fountain, radial splatter painted far across the floor, a spreading pool, mist, a flash and a red
  ring, plus the screen's kill punch.
- **Gibs:** a death throws 8-11 gibs by blood setting (always skull, ribcage, heart, intestine and an
  eyeball, then a mix of eyeball, jaw, leg, boot, brain and weapon arm), plus the weapon and helmet.
  Keg deaths throw at least 10, harder. Gibs are drawn as their part, spin and bounce, and leave
  smears as they slide (streaks thin with speed).
- **Splats:** procedural masks per stamp (splat, pool, spray, drop, streak, print, scorch) with random
  rotation, scale and stretch. Droplets fly as GPU particles and splat on landing. Bloody footprints
  follow anyone who walks through fresh blood; dust rises from footsteps elsewhere. A parry throws
  sparks, a flash and a ring.
- **Colour:** from deep maroon to arterial red with a wet highlight. Blood never turns grey or black.
  - **Overlaps stay red.** Where splats stack, the floor must not go to grey or black blotches
    (it reads like dirt or a lighting bug). Store blood as data in the decal target (coverage or
    density and age, accumulated with a clamped or max blend) and let the floor shader map density and
    age through one blood gradient (bright arterial red, deep red, dark maroon, never grey or
    black-grey) with a darkness floor. Verify with a screenshot of a heavily overlapped area.
  - **Drying darkens, never greys.** Drying shifts toward deep maroon and near-black brown, loses the
    wet highlight and some saturation, and keeps the splat's shape. No grey, no blotchy noise.
  - **Reads from straight above.** The wet highlight is subtle and view-independent, splat masks never
    show a repeating pattern (no screen-aligned noise), and dried blood never looks metallic.
  - **Readable on every floor.** Blood replaces the floor albedo by coverage instead of multiplying
    it, so it reads the same red on sand, flagstone (the dark Catacombs included) and flesh.
- **Dismemberment bleeds.** When a limb comes off both pieces spray: the flying limb trails blood and
  the stump spurts. The stump keeps bleeding for several seconds (pulsing spurts that weaken), then
  drips wherever the fighter walks, so a maimed fighter is easy to read and leaves a track.
  Built: the flying limb trails blood; the stump spurts for 4.6 s, then drips. Bleed damage over time is a
  balance-pass decision (section 6).
- **Gibs bleed where they land.** A landed gib, above all intestines, oozes a small pool that grows
  for a second or two under it (today 1.7 s; intestines leave the largest pool).

### Popups

- **Kill stamps** (Bangers, 1-3 words, the sim's title): shown on every kill when the setting is on,
  readable at 1x, but out of the way. Smaller text, spawned offset above the kill spot (not on the
  body), a quick elastic pop, then within about 0.6 s they shrink and float upward while fading, gone
  by about 1.2 s. Several stamps stack upward instead of overlapping. A screen-space size cap keeps
  zooming in from making them huge. Built: 40-60 CSS px tall at any zoom, gone at 1.2 s.
- **Damage numbers** (on by default): small, short-lived (under 1 s), in the attacker's colour, crits
  bigger with "!", backstabs labelled. They stack on the victim's flank and never overlap its name
  tag or HP bar; a quick series from one attacker merges. Numbers of different victims standing close
  together never overlap.
- **Barks:** rare and small. Default "key moments" (spawn, kill, low HP, skill, death); "all" adds hits
  and taunts. At most one bark per fighter every 8 s and at most two bubbles on screen; lines show at
  most about five words; small bubbles that fade in about 1.5 s and dodge each other and the name
  tags. Bubbles stay put once placed (they glide up only when something moves into them).

### Blood amount

Light, normal, carnage (default). It scales how much gore fx paint and spray (drops, flecks, spurts,
splatter, drips, stamp sizes, gib count). Cosmetic only; the sim is unaffected.

## 13. Audio

- Procedural sound: synthesized with WebAudio at runtime, no audio files.
- Starts on the first pointer or key press (browsers refuse audio before a gesture). Pauses with the
  game and when the page is hidden.
- Driven by the same event batches the renderer gets. Catch-up events from a seek play nothing.
- Cues for every swing, release, hit (by weapon, plus crit and backstab), projectile stop, parry,
  dismemberment, death, kill (stepped up for multi-kills and the final kill), crowd roar, explosion,
  skill, footstep (wet in blood), pickup and respawn, heal, hazard, breaking prop, the sudden-death
  wall grind (a continuous grind loop while anyone touches it, a crush cue for CRUSHED, a sizzle when
  the whole floor bites), the match signals (horn, escalation, gong, bell) and the round beats
  (countdown 3, 2, 1, the FIGHT hit, the final-kill sting, played once whether the kill or the
  signal arrives first).
- A mixer with voice limits per group, throttling, ducking, a limiter and a soft clipper, so 16
  fighters never clip.
- Slow motion pitches sound down tape-style and closes a lowpass; announcer signals are not bent.
- Volume from the view settings; M mutes.
- **Crowd that breathes.** The bed is much quieter, swells with action intensity (hits, low-HP fighters, close
  fights) and falls nearly silent in lulls. Its texture, density and pitch vary per round (seeded).
  Occasional sparse reactions (gasps, whistles, boos at campers, chants on a streak) instead of a
  loop. Kills and the final kill get the big roars. Built and measured offline (levels, spectra,
  real matches through the cue mapping); **(not met yet: nobody has listened to it.)**

## 14. UI

### Shell

- Three screens as top tabs (URL hash): **Watch** (arena full-bleed, thin overlays), **Gym**
  (strategy editor, batches, evolution, reports), **Room** (online rooms, section 15, and the
  leaderboard from local results). Leaving Watch pauses the match.
- Palette: stone neutrals `#0e0d0c`, `#161412`, `#1f1c19`, `#2a2622`, `#3a352f` (and `#4d463e`),
  text `#e8e2d9` and dim `#a39a8e`, one accent: blood red `#c4302b`. Fighter colours: the 16
  `FIGHTER_COLORS`, high chroma, colour-blind-aware, no blood red.
- Fonts: Inter (UI), JetBrains Mono (numbers, code), Bangers (kill stamps and barks only).
- No emoji in UI chrome. Labels are plain and short ("Fight", "Next match", "Copy report for LLM").
- Without WebGPU the Watch screen shows "The arena needs WebGPU" with the reason and a link to the
  Gym.

### Splash and loading

Assets are in `public/brand/` (originals from Codex image generation in `docs/brand/`).

- A static splash in `index.html` shows instantly, before any script: `splash.webp` as a cover
  background with a dark vignette, `wordmark.webp` centred (blended so its dark backdrop disappears),
  a progress bar and rotating comedic status lines ("Sharpening blades...", "Mopping yesterday's floor...").
- Progress follows real stages: bundle loaded, WebGPU check, renderer init (three.js and the
  renderer load as their own chunk) and shader warm-up, audio ready, match ready.
- An "Enter the pit" button (Enter and Space too) is the first user gesture, so audio starts with it;
  the splash then fades into the round-start countdown.
- Nothing plays behind the splash: the match is built but does not simulate, animate or make sound
  until the player enters and the countdown reaches FIGHT. The controller holds the sim at tick 0
  and passes a time factor of 0 to the renderer and sound until "Enter the pit".
- Without WebGPU the splash shows a clear message naming supported browsers instead of the button.
- `index.html` head: favicons (`brand/favicon-16/32/48.png`), apple-touch icon, `site.webmanifest`,
  theme colour `#0e0d0c`, Open Graph and Twitter card tags with the absolute image URL
  `https://laubsauger.github.io/pit-of-carnage/brand/og-image.jpg`. All paths work under `BASE_PATH`.
- The emblem appears in the app chrome; the wordmark on menus and the end card where it fits.

### Background jobs

A running evolution or batch shows a small chip with a progress ring in the top bar on every screen
("Evolving: gen 4 of 20"); clicking it returns to the job. Jobs keep running while the user watches
matches or edits strategies. On the Watch screen the match clock owns the top bar's centre, so the
chip shows only its count there ("37/100", the full line in its tooltip).

### Watch HUD

- **Scoreboard** (top left): alive first (by kills), dead greyed with their place; squads grouped.
  Click selects, double-click follows.
- **Match clock** (top centre): play/pause, time, state ("N standing", "Sudden death in m:ss",
  "Sudden death", "Paused", "Final"), speed presets 0.25x-4x. A room's match shows "Room, live"
  instead of play/pause and speeds (the host runs it).
- **Kill feed** (right): short broadcast lines with names in their colours, fading after a few
  seconds. Each line links to its timeline mark (hover pulses it, click replays it).
- **Timeline** (bottom), **hover card**, **inspector**: below.
- **View** button (gear) and **Reset camera** in a quiet corner.

### Dead fighters

Dead fighters get no hover card and cannot be picked in the arena; hovering a corpse shows nothing.
They stay inspectable from the scoreboard, the kill feed and the end card.

### Cinematic view (not built yet)

The scoreboard (top left) and the kill feed (top right) each collapse to a small tab at their edge
and reopen from it; the state persists. A cinematic toggle (key `V`, and a button) hides all HUD
chrome at once except the match clock, leaving the arena full screen; any HUD key or the toggle brings
it back. On narrow screens (phones, below about 760 px wide) scoreboard and feed start collapsed and
the timeline shrinks to a thin bar.

### Keyboard (Watch)

| Key | Action |
| --- | --- |
| Tab / Shift+Tab | Cycle the selected fighter (living, scoreboard order) |
| F | Follow the selected fighter / release |
| Space | Pause / play; during the countdown or the final moment, skip ahead |
| ← / → | Step one think (6 ticks) back or forward; with Shift, one second |
| 1-5 | Speed 0.25x, 0.5x, 1x, 2x, 4x |
| End | Back to live |
| Esc | Deselect, then unfollow; closes the end card |
| C | Reset camera |
| I | Open the full-screen fighter overview |
| ? | Open the Codex (every screen) |
| T, B, N, A, K | Name tags, HP bars, damage numbers, barks (off / key / all), kill stamps |
| V, R, O, H | Vision cones (off / selected / all), steering ring and target line, fog of war, hearing ripples |
| S, M | Screen shake, mute |

Shortcuts match the word the user expects (H hearing, B bars, O fog, T tags). Blood has no key.
Keys are ignored in text fields and with Ctrl, Cmd or Alt. Every view toggle shows a short toast
("Hearing ripples: on").

### View settings

A small "View" button (gear) in a quiet corner opens a popover that never gets in the way of the
arena. Settings persist in localStorage; "Reset to defaults" restores them. Each row shows its
shortcut, and the popover lists every shortcut.

| Setting | Options | Default |
| --- | --- | --- |
| Name tags | on / off | on |
| HP bars | on / off | on |
| Damage numbers | on / off | on |
| Barks | off / key moments / all | key moments |
| Kill stamps | on / off | on |
| Vision cones | off / selected / all | selected |
| Steering ring and target line | on / off | on |
| Fog of war (the selected fighter's view) | on / off | on |
| Hearing ripples | on / off | on |
| Screen shake | off / on kills | on kills |
| Blood | light / normal / carnage | carnage |
| Volume | 0-1 | 0.7 |

### Timeline

The timeline and click-to-replay are liked; they must be explorable.

- **Colour-coded.** Each mark is filled with the colour of the fighter who caused it (killer for
  kills, attacker for big hits and lost limbs, taker for power-ups; neutral for hazards and sudden
  death). The shape is the event type: diamond kill (a size up), downward wedge lost limb, dot big hit
  (45+ damage), filled four-point star power-up, bar sudden death.
- **Always readable.** Every mark is solid, filled with the fighter colour, has a dark outline that
  separates it from the track, sits above the track line and has a minimum size; no hollow rings or
  tiny dots inside circles. Shapes stay distinguishable at a glance.
- **Dense moments cluster** without overlapping: up to three shapes stack, the rest show as "+n".
- **Hover tells the story.** A tooltip shows the time and the event as a sentence with names in their
  fighter colours ("0:42 Gary backstabbed Brenda, twin daggers, from shadow."), plus each side's
  behaviour at that moment.
- **Break it down.** Filter by fighter (select a name in the scoreboard to show only their events)
  and by event type (legend buttons). Expanded per-fighter lanes (liked; keep them) show each
  fighter's rail until death, marks and kills. Kill feed entries link to the same marks.
- **Always a way back.** After seeking, a clear "Back to live" button (and End) returns to the live
  edge; the playhead shows whether you are live or replaying. Clicking a mark replays from a short
  lead-in. Seeking is reliable: every click lands on the right tick, every time (tested).

### Inspector

A pinned panel for the selected fighter: name, build, guard-trip badge, follow and close; HP, status
chips and the target (or what is known of it); behaviours with live score bars, the running one
marked, and action chips (attacking, skill, parry, throttle); the steering ring with each term's own
small ring; "What it knows" (seen, heard, remembered with distance); power-ups and zone; guard
trips; sensors; the fight so far; the build with attribute bars and derived stats.

- The inspector must not cover the arena's action: the panels report what they cover
  (`setViewInsets`) and the camera frames, follows and eases moments inside the uncovered part.

### Full-screen fighter overview

Watching needs the sidebar; reviewing a strategy needs a full view. An "Expand" button on the
inspector (and key I) opens a full-screen overview of the selected fighter, reusing the inspector's
parts in a roomier layout. Esc closes it.

- Every behaviour with its live score bar and a short score history (sparkline over the last ~10 s),
  the winning one marked, the commit timer visible.
- A large steering ring with each move term drawn as its own ring, plus the combined result.
- Target scoring: every known enemy with its target score and whether it is seen, heard or
  remembered.
- All sensors with live value, unit and range; memory slots; guard trips.
- Perception: vision and hearing ranges, last-seen ghosts, current zone and power-up info.
- Attributes chart, build, damage dealt and taken by source, the fighter's own event log.
- A picture-in-picture arena view that follows the fighter, so the match stays visible.

Built, with two gaps: the target-score column appears only when a brain reports per-enemy target
scores (no `Decision` field carries them yet), and damage by source is the report's split, so during
the match it shows totals.

### End card

**"Next match" keeps the lineup (not met yet).** Today "Next match" restarts from the saved match
setup with a new seed, so a fighter the player just brought in (from the editor, gym or import) drops
out. Rule: the current lineup is whatever the last match used, from any source; "Next match" repeats
it with a new seed (and the next map if a map rotation is on). Every way of bringing a fighter into
the pit updates the match setup, so the setup panel always shows the lineup that will play next.
Fighters the player added are marked as theirs and stay pinned until removed; "Shuffle field" refills
only the unpinned slots from the house stacks.

**Victory moment (not built yet:** the WINNER stamp and the camera easing onto the final kill are
built (section 2); the pose, spotlight, dimming and the quiet end card are not). After the final
kill's slow motion, the camera eases in on the winner, who strikes a victory pose (weapon raised, a little hop or flex per weapon class, a taunt
bark) under a warm spotlight while the rest of the arena dims; confetti-of-gore optional. The crowd
gives one big roar and then quiets down; when the end card is up, combat sounds and the crowd bed
stop (only a soft, low ambience or silence remains). Nothing keeps rumbling after a match is over.

- Shows the winner ("Gary takes the Pit."), build or squad, kills, damage, HP left, match time, up to
  three findings, every placing with how they went out, and Next match, Watch again, Copy report for
  LLM.
- Timing and motion: section 2, "Round end".
- **Inspect anyone.** On the end card (and the scoreboard after a match), click any
  fighter, the winner first in line, to open its full strategy sheet: the full-screen overview from
  this match (stats, behaviour usage, heatmap, kills) plus the strategy itself (visual view and JSON)
  with "Copy strategy code" and "Open in gym". Visible to everyone for now, for debugging and
  learning. Later, rooms get a setting for whether rivals' strategies are revealed after a match
  (strategy theft is a real concern); keep the reveal behind one flag (`REVEAL_RIVAL_STRATEGIES`) so
  that decision stays cheap. A room's match never shows the strategies (they never leave the host).

### Strategy editor

**LLM prompt interviews the player.** "Copy LLM prompt" makes the model ask the player first (name and
personality, plan, weapon and skill or "pick for me", whom to beat and how much risk, optional colour
and glyph, each with suggestions) and wait for the answers; examples in the rulebook are syntax only
and must never be copied. With a strategy open and no goal, the model first asks whether to design a
brand-new fighter or improve this one. The prompt never sets `version`. Built in `src/strategy/prompt.ts`
(`mode: 'new' | 'improve'`); the editor should offer two buttons, "New fighter with an LLM" and
"Improve this with an LLM" (not built yet).

- JSON editing with live validation, a problem list ("Checks") with line, column and path that jumps
  to the spot, a status bar with the issue under the caret, a point-budget meter, "What the build
  gives you" (derived stats), version list (load, delete), Save version (Cmd/Ctrl+S), Format, Copy
  LLM prompt (rulebook + strategy + latest report, or a fix-these-errors goal when the draft is
  broken), Copy code, Import, Test in gym, Watch it fight.
- **Diagnostics in place.** Errors and warnings differ in colour and icon (an error is a red circle
  with a wavy underline, a warning an amber triangle with a dotted underline). Hovering a gutter marker or the
  underline shows that issue's message and suggested fix in a tooltip at the spot; several issues on
  one line stack in one tooltip, with a one-click fix from "did you mean" ("Use enemies_seen").
  Clicking an entry in the problem list jumps to the spot and flashes it in the code and the builder.
- **CodeMirror 6** (`@codemirror/lang-json`, `@codemirror/lint` for gutter markers, underlines and
  hover tooltips) instead of the hand-made textarea overlay, with autocompletion and hover docs for
  vocabulary words straight from the registry, so the editor teaches the language. Completion knows
  the slot under the caret (`it.*` only in the target expression, places with their arguments). It
  loads as its own chunk when the code view first opens.

### Strategy builder: visual and code, both ways

The strategy text stays the single source of truth: the visual builder writes minimal edits to it,
so the player's formatting and undo survive. Views: Visual, Split, Code (persisted). **(not met yet:
numbers can be scrubbed in the visual builder only, not in the code view; behaviours and move terms
cannot be reordered.)**

- **Two-way editing.** A visual editor and the code editor edit the same strategy; a change in either
  updates the other immediately. Visual parts: attribute sliders with the budget meter and colour
  coding, weapon and skill pickers with their stats, one card per behaviour (score expression, move
  terms as rows with a weight slider and a place or zone picker, attack and skill policy), target
  preferences, memory slots, barks. Numbers inside expressions can be scrubbed with a slider.
- **Syntax highlighting and recognised words as chips.** JSON and the expression language are
  highlighted; every recognised vocabulary word (sensor, place, zone, move term, policy, attribute,
  weapon, skill) renders as a subtle badge.
- **Hover cards for everything.** Every property, object and vocabulary word shows a neat card on
  hover, IntelliSense-style: what it is, type, unit, range, what values it takes, its effect (for
  attributes: the exact formulas and what +10 changes), an example and related words. Same source
  as the LLM rulebook (the registry and rules docs), so nothing can disagree.
- **Codex.** A browsable, pretty reference of everything the LLM prompt contains: how a fighter
  thinks, every sensor, place, zone, term, policy, attribute, weapon, skill, map, limit and formula,
  searchable, with the starter library as worked examples. Learning the game should be fun.

### Versions and the library (not built yet)

Saves already record their origin (`editor`, `import`, `evolution` with generation); nothing else
below is built. Today the store silently renumbers: saving a strategy whose JSON says `version: 140` stores it as
"latest saved version of that name + 1", and the editor then shows "v2", so it is unclear what was
saved and from where. One clear model:

- **Version numbers belong to the library**, are per name, monotonic and assigned on save. The JSON
  `version` field is overwritten on save and never trusted on import; the editor always shows the
  library number.
- **Origin is separate from version.** Each saved version records its parent (the version it was
  edited from) and its source (editor, import, evolution with generation, room). An evolved build
  reads "Slurpy Hawk v4, evolved from v3, generation 140", never "v140".
- **The editor states its base.** Header: "Editing Slurpy Hawk, based on v3 (saved 17:42)", an
  unsaved-changes dot, and the Save button says what will happen ("Save as v4"). After saving, a toast
  confirms "Saved Slurpy Hawk v4 (from v3)".
- **Name collisions ask.** Importing or saving under a name that exists from a different lineage
  offers "Add as new version of Slurpy Hawk" or "Save as new strategy" (with a suggested new name).
- **History panel.** Every version with time, source, parent and a short diff of what changed
  (attributes, behaviours, weights); "Load this version" and "Compare with current".

### Codex everywhere

The Codex is always one step away: a "Codex" entry in the top bar on every screen, the key `?`, and
deep links. Every hover card (editor words, attributes, sensors, map objects, weapons, skills,
inspector rows) has a "Open in Codex" link that opens the Codex at that entry. Entries have stable
URL anchors (`#codex/sensor/target.visible`), so a link can be shared and opens the right page; Esc
returns to where the player was. Built: the top-bar entry, `?`, the anchors (opening over whatever
screen is showing) and Esc; the editor's hover cards link in. **(not met yet: map-object cards,
inspector rows and attribute charts have no "Open in Codex" link.)**

### Quick matchup (not built yet)

Setting up a fight from files on disk must be low friction:
- "Add fighter" opens a slot where the player drops a `.json` file, pastes JSON or a strategy code,
  or picks a saved or house strategy; it goes through the gate and shows errors in place. "Add next"
  repeats. Dropping several JSON files onto the arena or the setup panel adds them all at once.
- Rules sit next to the lineup: map, format (free-for-all, squads with size, duel), fighter count
  (house stacks fill the rest unless turned off), time limit and sudden death, seed.
- "Fight" starts it. The lineup stays for "Next match" (see End card).

### Import

Drag and drop `.json` files (onto the dialog or the editor), pick files, or paste text or a strategy
code. The dialog shows each entry's report (errors, warnings, line and column) before anything is
saved. Errors block; warnings can be accepted ("Open with 2 warnings"). Save to library or open in
the editor. Export is "Copy code".

### Resizable panes

Side panels (scoreboard, inspector, editor, gym panels) get drag handles on their inner edge, with
min and max widths so nothing wraps badly; double-click a handle to reset (arrow keys nudge it);
widths persist per pane in localStorage (`poc.pane.<id>`). Panels can collapse to a thin rail. On the
Watch screen the panels float over a full-bleed canvas that never resizes (so there is never a frame
of stretched content) and report what they cover, so the camera frames the action in the part that
shows (see DECISIONS). **(not met yet: the editor's side panel has no handle yet.)**

### Attribute display

- **Colour-coded attributes.** Each of the six attributes has one fixed, muted hue used everywhere
  it appears (inspector, hover card, editor budget meter, roster cards, reports): vitality red, power
  orange, agility green, perception cyan, armor steel, haste amber. Labels stay readable without
  colour (name plus number). Muted, so fighter colours still dominate the arena. One table
  (`ATTRIBUTE_COLORS`) and the matching `--attr-<name>` theme tokens; a test keeps them equal.
- **Taller distribution chart.** About 60-80 px for bars, values shown, so two builds' distributions
  differ at a glance; compared against the 40-point maximum, not the build's own maximum.

## 15. Multiplayer prototype

A WebRTC peer-to-peer prototype (Trystero over public Nostr relays, no backend) to find out whether
multiplayer is worth more time, before any server work. Host-authoritative: the host simulates and
streams state; peers watch.

- Create a room, share a 5-letter code (no I or O) or an invite link (`?room=CODE#room`), friends
  join. A host can reopen a room it hosted (pool and board come back); a guest that reloads rejoins
  as the same member.
- Everyone drops strategies into the pool (up to 3 each, 24 in all, 8 people), gated again on the
  host with source `network`. Others see only a strategy's name, weapon and skill, never the strategy.
  House stacks fill empty seats and play while the pool is empty.
- The host runs back-to-back matches and streams them (about 20 frames a second, events in between,
  its slow motion included); everyone, the host too, watches the stream: on the room's radar or in the
  full arena ("Watch in the arena": renderer, sound and HUD, a beat behind the host), with the same
  countdown, final moment and end card as a local match. Playback controls do nothing there.
- Every message is checked (types, ranges, lengths, ids; unknown fields dropped), peers are
  rate-limited and anyone pretending to be the host is ignored.
- A per-room leaderboard (openskill, kept by the host).
- Small and honest about its limits, and the room screen says so: no session browser, strict
  networks need a TURN relay this prototype lacks, the host's tab runs everything.
  **(not met yet: the inspector shows no decisions or knowledge for a streamed match; a guest who
  joins mid-match sees no gore from before it joined; only tested with two tabs on one machine.)**

## 16. Copy and voice

The samples' copy ("GEN N BREAKTHROUGH — WATCH THE META SHIFT!", "obliterated" as the only kill
verb, emoji everywhere) reads generic. Write like a dry, funny sports broadcast.

- **Specific over hype:** "Apologetic Gary takes the Pit — 4 kills, never seen once." beats
  "VICTORY!!".
- **Vary kill lines by cause and weapon:** "Gary opened Brenda like a letter.", "Brenda tripped into
  the saw.", "Doug was hit by his own keg. Classic Doug." Fighters are named by their strategy name.
- **Evolution and meta updates name what changed:** "New contender: Lurking Daggers v3 beats the
  house stacks 7 of 10 on the Pit." Not "META SHIFT".
- **Interface labels are plain and short.** No emoji in UI chrome.
- **Kill stamps** are 1-3 words, chosen by what happened: streaks (DOUBLE KILL, TRIPLE KILL,
  RAMPAGE), specials (OWN GOAL, BACKSTAB, COLLATERAL, NEVER SAW IT, OVERKILL), then by weapon (SPLIT,
  FLATTENED, PERFORATED, AXED, PINNED, VAPORIZED, ...), hazard (SAWED, SKEWERED, DISSOLVED, TOASTED),
  skill, keg (KABOOM), friendly fire, sudden death (CLOSED IN), reflect (RETURN TO SENDER), revenge
  (PAYBACK) and clutch (BY A HAIR). Crushing by the wall stamps CRUSHED.
- **Announcer lines** for sudden death, the wall stopping, damage everywhere, judges' decisions and
  power-ups coming back ("Berserk is up.").
