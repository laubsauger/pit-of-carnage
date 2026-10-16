# Tuning

Where the balance work stands and how to pick it up again. Current state, not a log: rewrite it
when the numbers change. The official measurement is `docs/BALANCE.md` (`npm run balance`); this
file explains how the numbers got there and what is still open. The targets are in
`docs/SPEC.md` section 6: every duel pairing 35-65% on the pit, each weapon family 0.67-1.5x its
fair share of pit FFAs, melee nominal DPS 1.5-1.8x ranged as a guideline.

## Where it stands (pass 3)

`npm run balance` (seed 1, 100 duel seeds, 100 FFAs per map): **2 of 3 targets hold.**

- Duels: 13 of 15 pairings inside 35-65%. Outside, just: greatsword 67% vs throwing axes, twin
  daggers 67% vs longbow.
- Pit FFAs: melee 1.07x, ranged 0.92x of fair share (both inside).
- DPS guideline: melee 1.41x ranged (66.7 vs 47.2 per second), below 1.5. Pushing it to 1.5 would
  mean nerfing ranged damage, which the duel matrix punishes (the bow and staff already sit at
  39-48% average).

Before pass 3 (same harness): 5 of 15 duels inside (daggers 98% vs axes, 95% vs staff; axes 15%
average), pit FFAs melee 1.44x / ranged 0.49x, DPS ratio 1.07.

Pooled over duel seed sets 1, 2 and 3 (60 seeds each, seats swapped, 5400 duels), the final
numbers give every pairing between 39% and 64% (search score 0.099): GS-WH 43, GS-TD 49, GS-TA
61, GS-LB 49, GS-AS 62, WH-TD 62, WH-TA 58, WH-LB 42, WH-AS 43, TD-TA 60, TD-LB 64, TD-AS 61,
TA-LB 44, TA-AS 60, LB-AS 39 (row weapon's win rate). The official seed-1 run differs by a few
points per pairing: that is the noise of 200 duels per pairing (about +-3.5 points).

## What changed and why

Mechanics (src/sim, src/core):

- **Stuck ammo** (`STUCK_AMMO`, `src/sim/stuck.ts`). Arrows and axes stick in walls, pillars,
  props and bodies; ammo in a body is out of play until it dies, then drops by the corpse; a broken
  prop and the closing wall drop what they hold. Brains find stuck ammo through the same `ammo`
  place and `ammo.distance` sensor as floor ammo (its pickup point). With every hit arrow stuck in
  the victim, the bow ran dry in duels (29% of its time alive with no arrows, every bow death with
  an empty quiver), which is what forced the quiver changes below.
- **Hand weapons** (`WeaponRule.handDamage`). Throwing axes keep a hatchet (28), the staff whacks
  with the staff (16): used instead of throwing at an enemy within punch reach and when out of
  ammo, on the weapon's own cooldown. This was the one change that fixed throwing axes: without it
  they lost 95-100% to every melee weapon whatever their ammo, damage or stun (they threw their
  axes into the body of whoever closed in, then punched for 6).
- **Skills HOOK and SECOND_WIND** (rules, sim, house stacks Uncle Hatchet and Kevin). Not dominant:
  against DASH on every weapon pairing, HOOK wins 54% overall (strong on melee, 36-39% on bow and
  axes), SECOND_WIND 47%. For reference the old skills against DASH: WHIRLWIND 62%, BLOODRAGE 62%,
  SHOCKWAVE 68%, SHADOWSTEP 70% (91% on the warhammer).
- **Bleed** is implemented behind `BLEED_RULES.enabled` (wounds from lost limbs and dagger
  backstabs, bleed ticks credited to the opener, shrine cures, `KnownFighter.bleeding` on sight)
  and stays **off**: the harness never measured it. No `self.bleeding` / `target.bleeding`
  sensors or `blood_trail` place yet; the trial values are in `src/sim/bleed.test.ts`.

Numbers (src/core/rules.ts), old -> new:

| Rule | Old | New | Why |
| --- | ---: | ---: | --- |
| Shrine cooldown | 320 | 900 | The biggest FFA lever: with a heal every 5 s the shrine squatters and slow melee won the pit (ranged 0.49-0.62x). 900 brought pit FFAs to about 1.0x / 0.95x. A smaller heal (0.25-0.3) hurt duels instead. |
| Twin daggers damage / cooldown | 16 / 18 | 22 / 27 | Fewer, heavier stabs: same identity, much less haste scaling (18 ticks hit the haste floor). |
| Twin daggers move / lunge / backstab / range | 1.15 / 36 / 2.35 / 56 | 1.08 / 22 / 2.2 / 58 | Less free closing distance. Floors kept: move >= 1.08 (still the fastest melee), backstab >= 2.0. |
| Greatsword damage / cooldown | 30 / 42 | 35 / 36 | Lifted when the daggers came down; also carries the melee DPS ratio. |
| Warhammer damage / cooldown / stun / range / move | 26 / 44 / 34 / 70 / 1.02 | 30 / 38 / 16 / 76 / 1.0 | Long stuns locked the bow and staff out; the reach and damage keep it the slow, heavy hitter. |
| Throwing axes ammo / cooldown / hand | 4 / 26 / - | 5 / 42 / 28 | The hatchet (above) made them viable; a slower throw keeps them from out-trading melee at mid range. |
| Longbow ammo / refill / cooldown / slow | 10 / none / 33 / 75 | 12 / one per 240 ticks / 37 / 105 | Stuck arrows drain the quiver; a slow refill keeps the bow shooting without making restocking free. Damage stayed 20: 22 swings the bow to 67-88% against melee. |
| Arcane staff damage / cooldown / recharge / knockback / hand | 25 / 43 / 90 / 8 / - | 26 / 38 / 65 / 4 / 16 | Faster casts and recharge for duels (it was 41% average), the whack for when it is caught. |

Other rules (spread, plant, backpedal, point blank, stagger, shield, armor, acid) are unchanged.

## What the searches showed

- **Daggers vs warhammer** was decided by knockback, not stun: every hammer blow knocks the
  daggers about 100 px away, so each exchange is one stab for one smash. Hammer stun 16-28 barely
  moved it (77-90%). Longer dagger reach (62-66) and heavier stabs fixed it.
- **Doug's Corner** wins about 30-45% of pit FFAs whatever the weapon numbers: it holds a corner
  in guard stance for 60% of its life and lets the field thin out. Not shields (shield arc 0 changed
  nothing), not parry, not a kill heal (tested, 30% heal on kill: 43% -> 38%, removed). Armor
  per point 0.012 cut it to 31% but hurt the warhammer everywhere. This is a strategy problem for
  `npm run tune` / the roster pass, not a rules one.
- **Staff recharge vs the bow**: staff recharge is the lever for bow vs staff (60 -> 70 moves the
  bow from 34% to 46%), but it costs the staff against melee; recharge 65 with a 16 whack is the
  compromise. Smaller splash (60 px, 0.5) made bow vs staff worse (the staff loses its melee
  answer and the bow gains nothing).
- **Bow levers**: damage is very steep (20 -> 22 takes the bow from 48% to 76% against the
  greatsword); ammo 14 overshoots the same way. Slow (COMBAT.slowMoveMul 0.45-0.5, slowTicks 105)
  and arrow speed barely change the bow's worst matchup, daggers, which close in from the side.
- **Acid** (11 per 24 ticks, radius 62) is not a balance factor in house FFAs: amphoras are broken
  in few matches and acid deals a fraction of a percent of all damage. Raising it is a look and
  feel call (SPEC wants it heavy), safe for the matrix.
- **Global levers** that did not help: rangedPlantMoveMul 0.5, backpedalMoveMul 0.7, point blank
  1.0 (axes went to 4%), shadow vision 0.6-0.75, interrupt stagger 0-8.
- **Ammo economy** (BALANCE.md, "Ammo economy in the duels"): the bow is dry 11% of its time
  alive, 14% of bow deaths come with an empty quiver and 15% while out restocking; axes are dry 20%
  and 62% of axe deaths are empty-handed (they fight with the hatchet then).

## Still open

- Daggers vs bow (64-67%) and greatsword vs axes (61-67%) sit at the edge of the band.
- Across all maps the staff wins 2.2x its FFA share, the warhammer 1.7x, daggers 0.29x and
  throwing axes 0.11x (house stacks, so partly plans: Uncle Hatchet, Two-For-One Tina and Kevin are
  1-2% winners). The meat grinder favours ranged 1.56x. Per-strategy tuning (`npm run tune`, built in pass 3 but not run
  on the house stacks yet) is the next lever.
- DPS guideline 1.41x vs 1.5.
- `docs/BALANCE.md` was generated before the last rules edits (SHOCKWAVE parry 36 / stun 24, the
  SHADOWSTEP attack lock, hatchet 28): re-run `npm run balance` first thing next session.
- Bleed: built, off, never measured. Decide with the harness (switch `BLEED_RULES` on with the
  trial values from `src/sim/bleed.test.ts`, add the sensors, re-run).
- New skills were measured against DASH only, not in FFAs or against each other.

## How to resume

Use at most 6 threads on this machine (the scripts default to 6).

```
npm run balance -- --threads 6                                  # official numbers -> docs/BALANCE.md
npx tsx scripts/balance-search.ts probe --seeds 60 --ffas 40 --seed 2 --pit
npx tsx scripts/balance-search.ts probe --ovr '{"WEAPONS.LONGBOW.damage":21}'
npx tsx scripts/balance-search.ts tune scripts/tuning/params-last.json --seeds 60 --seed-sets 1,2,3 --passes 2
npx tsx scripts/balance-search.ts skills HOOK --seeds 20
npx tsx scripts/balance-search.ts trace LONGBOW TWIN_DAGGERS --seed 6 --every 10
npx tsx scripts/balance-search.ts acid --ffas 40
```

- `scripts/tuning/params-last.json` holds the parameters of the last search (staff, greatsword,
  dagger and bow cooldowns) at today's values; `params-wide.json` the wide set (every weapon
  number the search may move, with the identity floors as min/max). `tune` writes
  `<file>.best.json` after each pass; copy the result into `src/core/rules.ts` by hand, then run
  `npm run balance`.
- Budgets: one `tune` evaluation over seed sets 1,2,3 at 60 seeds is 5400 duels (about 1-2
  minutes on 6 threads); a pass over 8 parameters is 30-40 evaluations. Always confirm a result on
  a seed set the search did not use (`probe --seed 4`) before committing to it.
- Keep identities: daggers stay the fastest melee with the biggest backstab, the hammer the slow
  heavy hitter, axes the close skirmisher, the bow the long-range one, the staff the splash caster.
