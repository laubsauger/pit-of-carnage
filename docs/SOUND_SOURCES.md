# Sound sources: recorded layers under the synth

Research and curation only, 2026-10-16. Nothing here is wired into the game. Sound is procedural
WebAudio today (docs/SPEC.md section 13); this file lists recorded CC0 samples that could sit under
that synthesis the way Brawlock does it, cue by cue, and says where the synth should stay alone.

## How the candidates were picked

- **Brawlock** (`/Users/flo/work/code/brawlock`, `src/audio/assets.ts` AUDIO_CREDITS, processed files
  in `public/audio/`, originals and metadata in `art/archive/audio/`). 16 files fit. The 15 processed
  ones are copied as Opus `.ogg` (mono, 48 kHz, already trimmed and normalized). `body_hit` is an
  original Brawlock archived but never shipped.
- **Openverse** (`api.openverse.org/v1/audio/`). 32 anonymous search requests, 4 s apart, license
  filter `cc0` (3 more with `by` for crowd chants, nothing usable). 26 files downloaded (Freesound
  "hq" preview MP3s, the same source Brawlock used).
- **License check.** Every one of the 42 files is **CC0 1.0**. Each was checked twice: the Openverse
  record, and the live Freesound page, which carries only the CC0 deed link
  (`creativecommons.org/publicdomain/zero/1.0/`) and the same author. No CC-BY, NC, ND or
  Sampling+ file is on the list.
- **Measured** with ffmpeg/ffprobe: duration, sample peak, integrated LUFS, the quietest 50 ms
  (noise floor), onset and "useful to" (where the sound falls 40 dB under its loudest 50 ms), and
  runs of 3+ full-scale samples (baked-in clipping).
- **Not verified:** nobody has listened to any of these. The picks rest on titles, tags, envelopes
  and levels. Listen before you wire anything in (see "Doubts").

Candidates (scratch, not in the repo):
`/private/tmp/claude-501/-Users-flo-work-code-pit-of-carnage/69c5e7ac-8c7e-4212-8b6f-ed10456536d1/scratchpad/sound-candidates/`
with `brawlock/`, `openverse/` and `openverse_metadata.json` (the full Openverse record for each file,
plus what the page check found). 42 files, 4.1 MB as downloaded (3.9 MB of it is the seven long
crowd recordings).

Column key: **dur** = file length / useful length. **Rec**: *layer* = mix under the existing
recipe, *as is* = could replace the recipe, *skip* = keep the synth. The credit number points to the
list at the end.

## Crowd (biggest gain)

The synth crowd (formant choirs and applause noise) is the part SPEC 13 marks "nobody has listened
to it". Real crowds are hard to fake, so these recordings add the most.

| Cue | Candidate | What it adds | dur | Notes | Rec | Credit |
|---|---|---|---|---|---|---|
| `crowd_roar` (kills, victory) | `openverse/crowd_roar_pol.mp3` | a real stadium roar with howls; sustained, so one excerpt covers kill and victory | 29.3 s; excerpt 0.5-4.5 s | -16 LUFS, floor -78 dB, clean | **layer** (excerpt; vary pitch per round) | 17 |
| `crowd_roar` alt / bed swell | `openverse/crowd_cheer_kyles.mp3` | large arena cheer, hockey; 0-6 s is a steady murmur at -28 dB, 7-14 s a swell | 24.0 s | tagged "Habs, chant": may hold an intelligible team chant, avoid those seconds | **layer** for the bed (6 s loop from 0-6 s) | 18 |
| `crowd_gasp` | `openverse/crowd_oooh.mp3` | three separate group "ooohs" (1-4 s, 6-10.5 s, 11.5-15 s) | 16.2 s | ADR walla, digital silence between takes; tags say "chatter", check for words | **as is** (2-3 takes, replaces synth gasp) | 19 |
| `crowd_gasp` (heavy hit, dismember) | `openverse/crowd_ouch.mp3` | four group "ouch / aww" reactions, the comic tone this game wants | 17.9 s | same session as above | **as is** (pick 2 takes) | 20 |
| `crowd_boo` | `openverse/crowd_boo_jm.mp3` | sports crowd booing; builds 0-8 s, peak 5.5-7.5 s | 16.4 s | by a pro sound designer, clean, floor -57 dB | **as is** (4 s excerpt with fade) | 21 |
| `crowd_whistle` | `openverse/crowd_whistle_kyles.mp3` | crowd cheering with whistles | 17.8 s | 2 clipped runs; -10 dB from the first second | **layer** (2-3 s excerpt) | 22 |
| `crowd_chant` | `openverse/crowd_howl_drum_pol.mp3` | crowd howls over drum bangs, near the synth's `stomp` style | 21.0 s | same session as the roar | **skip for now**: the synth chant varies per round (hey/clap/stomp); try this only if it sounds thin | 23 |

## Gore and flesh

Wet gore is the second place synthesis struggles: `splat()` and `flesh()` are filtered noise.
Short real squelches give the comedy its gross-out.

| Cue | Candidate | What it adds | dur | Notes | Rec | Credit |
|---|---|---|---|---|---|---|
| `dismember`, `death_splat` | `openverse/gore_splat.mp3` | crunch plus intestines splat, very wet | 2.86 / 2.6 s | **35 clipped runs** in the source: trim to the first 1.2 s, attenuate, listen for distortion | **layer** if the clipping is not audible | 24 |
| `death_splat`, `hit_flesh` | `openverse/gutsy_spillage.mp3` | blood splat with drips, clean | 1.24 / 0.95 s | floor -89 dB | **layer** | 25 |
| `hit_flesh`, `dismember` | `openverse/squelch3.mp3` | short squelch | 1.37 / 1.25 s | quiet (peak -15 dBFS): normalize | **layer** | 26 |
| `crit_crunch` | `openverse/bone_crack1.mp3` | real bone snap | 0.75 s | 10 clipped runs, inter-sample peak +1.6 dB: renormalize to -1 dBFS | **layer** | 27 |
| `hit_blade`, `hit_dagger`, `backstab_shink` (body) | `openverse/sword_stab3.mp3` | blade into flesh | 1.14 / 1.1 s, onset 0.15 s | trim the lead | **layer** | 28 |
| `death_splat` (body hitting sand), `crush` | `openverse/bodyfall1.mp3` | body collapsing to the ground | 0.83 s | floor -46 dB | **layer** | 29 |
| `hit_punch`, `hit_hammer` | `brawlock/hit_a.ogg`, `brawlock/hit_b.ogg` | meaty punches | 0.66 / 0.48 s | 1 and 5 clipped runs, peaks +1.4 / +1.1: renormalize | **layer** | 1, 2 |
| `hit_hammer`, `crush` | `brawlock/thud_a.ogg`, `brawlock/thud_b.ogg` | heavy low thuds | 0.56 / 0.42 s | clean | **layer** | 3, 4 |
| `hit_punch` alt | `brawlock/body_hit_insanity54_orig.mp3` | body hit (unprocessed original) | 0.84 s, onset 0.2 s | trim the lead | **layer** (spare variant) | 5 |

## Weapons

The synth swings are clean whooshes; real blades add the metal. Keep the synth whooshes (timed to
the strike via `lead`) and put the samples on the hits.

| Cue | Candidate | What it adds | dur | Notes | Rec | Credit |
|---|---|---|---|---|---|---|
| `parry`, `hit_blade` on armour | `brawlock/clang_a.ogg` | sword-on-sword clash | 0.56 s | inter-sample peak +0.8: renormalize | **layer** | 6 |
| `parry` alt | `openverse/sword_clang_badass.mp3` | brighter katana clang | 0.88 / 0.6 s, onset 0.2 s | trim the lead | **layer** (variant) | 30 |
| `clang_axe` (axe stopped by stone, shield) | `brawlock/clang_ring.ogg` | ringing metal hit | 1.41 / 1.15 s | clean | **layer** | 7 |
| `ammo_clatter`, `pickup_ammo` | `brawlock/clank.ogg` | short metallic clank | 0.23 s | clean | **layer** | 8 |
| `backstab_shink` | `openverse/shling.mp3` | metal scrape, the "shing" | 0.86 / 0.8 s | clean | **as is or layer** | 31 |
| `swing_greatsword`, `swing_axe`, `skill_whirlwind` | `brawlock/blade_swish.ogg` | blade whoosh with metal edge | 0.86 s | loud (-14 LUFS) | **layer** at low gain; synth timing stays | 9 |
| `swing_daggers`, `skill_dash` | `brawlock/swish.ogg` | short swish | 0.45 s | | **layer** | 10 |
| `release_axe` (thrown, spinning) | `openverse/spinning.mp3` | spinning whoosh | 3.38 s | quiet (peak -11 dBFS), tagged as a melee spin: may not read as a thrown axe | **listen first**, else skip | 32 |
| `release_bow` | `openverse/longbow_release1.mp3` | real bowstring twang | 0.53 / 0.5 s | quiet (-26 LUFS): normalize | **layer** | 33 |
| `thunk_arrow` (into wood, prop) | `openverse/arrow_impact4.mp3` | arrow into a target | 1.0 s, onset 0.47 s | long lead silence: cut to 0.45-0.75 s | **layer** | 34 |
| `thunk_arrow` (axe into wood), `ammo_yank`, `break_crate` | `openverse/wood_chop9.mp3` | axe biting wood | 1.01 s, onset 0.35 s | trim the lead | **layer** | 35 |
| `draw_bow`, `charge_staff`, `release_staff`, `burst_orb`, `hit_arcane`, `hit_arrow` | none | | | the magic and bow-draw sounds are synth territory; nothing found beat them | **synth is fine, skip** | |

## Props, hazards, sudden death

| Cue | Candidate | What it adds | dur | Notes | Rec | Credit |
|---|---|---|---|---|---|---|
| `wall_grind` (looped while touched) | `brawlock/stone_drag.ogg` | stone block dragged on wood/stone | 0.76 / 0.5 s | the original is only 1.1 s; it fits the cue as it is today (a 0.32 s grain every 0.28 s), not as a long loop | **layer** as a grain, random offsets and pitch | 11 |
| `wall_grind` (long loop), `crush` | `brawlock/stone_door.ogg` | heavy stone door grinding shut | 2.01 / 1.6 s | clean, floor -86 dB | **layer** (crossfade loop for the grind, the tail for crush) | 12 |
| `sudden_death`, `crush`, `escalation` | `brawlock/rumble.ogg` | cave rumble | 3.0 s | | **layer** under the wall start | 13 |
| `break_amphora`, `crush` debris | `brawlock/debris_a.ogg` | stone rubble | 0.81 s | | **layer** | 14 |
| `break_amphora` | `openverse/tile_breaking.mp3` | ceramic/tile shatter | 0.74 / 0.5 s | clean, digital silence after | **as is** | 36 |
| `break_keg`, `break_crate` | `openverse/barrel_break1.mp3` | wooden barrel breaking | 1.5 / 1.4 s | clean | **as is** | 37 |
| `explosion` (keg blast) | `openverse/explosion1.mp3` | short punchy blast | 1.24 s | 1 clipped run | **layer** (the synth keeps the low boom and the 2 s tail) | 38 |
| `explosion`, `hazard_fire` | `brawlock/fire_burst.ogg` | fire flash | 0.76 s | 1 clipped run | **layer** | 15 |
| `hazard_acid`, `zone_burn` (floor bites) | `openverse/acid_bubbling.mp3` | acid bubbling and sizzle | 2.19 s | quiet (-26 LUFS), stereo: fold to mono | **layer** | 39 |
| `skill_hook` | `brawlock/chain_clicks.ogg` | steel chain rattle | 1.86 s | | **layer** (first 0.6 s) | 16 |
| `heal` (shrine pulse) | `openverse/heartbeat_single.mp3` | one real heartbeat | 0.66 s | 3 clipped runs; the synth already has `heartbeat()` | **skip** unless the synth pulse sounds weak | 40 |
| `hazard_spike`, `hazard_saw`, `pickup_*`, `spawn_*`, `footstep`, `footstep_wet` | none | | | small, frequent or tonal; samples add little | **synth is fine, skip** | |

## Match signals

| Cue | Candidate | What it adds | dur | Notes | Rec | Credit |
|---|---|---|---|---|---|---|
| `gong`, under `fight` and `final_sting` | `openverse/gong_qubodup.mp3` | a real gong with shimmer | 4.93 s | clean | **layer** (optional) | 41 |
| `horn` | `openverse/war_horn_booga4.mp3` | war horn | 4.88 s | **303 clipped runs**; tagged "roblox", "Booga Booga" is a Roblox game, so it may copy a game asset despite the CC0 mark | **skip** | 42 |
| `countdown`, `fight`, `kill_sting`, `final_sting`, `bell`, `escalation` | none | | | musical, tightly timed announcer beats; the synth owns them | **synth is fine, skip** | |

## Integration plan

1. **Order by gain.** (a) Crowd: roar, gasp/ouch, boo, whistle, bed loop. (b) Gore: squelch,
   spillage, splat, bone crack, stab, bodyfall. (c) Metal: clang, shing, clang_ring. (d) Props:
   barrel, tile, explosion, acid, wall grind and crush. Ship (a) and (b) first; they fix what the
   synth does worst. Leave the announcer beats, magic and footsteps synthetic.
2. **Layer, don't replace.** The synth keeps timing (`lead`), pitch and slow-motion bending; a sample
   adds body at a trimmed gain into the same voice group, so the mixer's voice limits, ducking and
   limiter still hold. Vary pitch ±5-8 % and pick among 2-3 takes so 16 fighters don't machine-gun
   one file. The crowd samples take their pitch and density from the round's `crowdProfile` seed.
3. **Processing.** Brawlock's `art/tools/process_audio.py` (ffmpeg only) does this already: trim the
   lead silence noted above, fade the tail, fold to mono, renormalize to -1 dBFS (every clipped or
   +dB file above), loop crossfades for the bed and the grind. Encode Opus `.ogg` plus AAC `.m4a`
   for Safari, like Brawlock.
4. **Size budget.** The recommended set trims to about 55-60 s of mono audio (25 s crowd, 7.5 s
   gore and impacts, 6 s weapons, 19 s props, wall and gong). At Opus 64 kbps that is about
   450-500 KB per format (one format loads per browser); dropping the gong and the second takes
   gets it near 350 KB. Stay under 1 MB.
5. **Loading.** Lazily after the splash, never blocking `init()`. Decode into AudioBuffers in the
   background; until a buffer is ready (or if fetch fails) the cue plays synth only, so nothing
   breaks offline or in tests.
6. **Credits are required.** CC0 asks for none, but Brawlock credits every file and so should this
   game: an `AUDIO_CREDITS` list (title, author, license, source URL) in the code, shown in the UI
   credits, and an assets table in the docs naming file, source, processing and license. Keep the
   original downloads and their metadata JSON in an archive folder (Brawlock: `art/archive/audio/`,
   gitignored and backed up).
7. **SPEC.** SPEC 13 says "no audio files". Adopting samples changes that line; update it when the
   build lands.

## Doubts

- **Nothing was listened to.** Content is inferred from titles, tags and envelopes. Spinning (32)
  may not sound like a thrown axe; the crowd walla (19, 20) and the hockey crowd (18) may contain
  intelligible words or a team chant, so pick excerpts by ear.
- **Clipping baked in:** gore_splat (24, 35 runs) and the war horn (42, 303 runs) are clipped in
  the source. Renormalizing does not undo it.
- **War horn (42):** CC0 on Freesound, but its title and tags point at a Roblox game. Skipped for
  that reason.
- **Deleted account (19, 20):** the uploader is shown as `deleted_user_2104797`. The CC0 mark stays
  on the page and CC0 cannot be withdrawn, but the author cannot be named beyond that handle.
- **Previews, not originals:** all files are Freesound's ~128 kbps preview MP3s (as in Brawlock).
  Good enough for short layers; the original WAVs need a Freesound login.
- The license check read the license link on each Freesound page on 2026-10-16. It did not look at
  descriptions for "this is a recording of X's product"-style claims beyond the war horn.

## Credits

All CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/), from Freesound (1-16 via
Brawlock, 17-42 via Openverse). Attribution text, one line each:
`"<title>" by <author> (freesound.org), CC0 1.0`.

| # | File | Title | Author | Source |
|---|---|---|---|---|
| 1 | brawlock/hit_a.ogg | Hit 3 | ihitokage | https://freesound.org/people/ihitokage/sounds/395359 |
| 2 | brawlock/hit_b.ogg | Hit 4 | ihitokage | https://freesound.org/people/ihitokage/sounds/395358 |
| 3 | brawlock/thud_a.ogg | Thud2.wav | BMacZero | https://freesound.org/people/BMacZero/sounds/96137 |
| 4 | brawlock/thud_b.ogg | Thud3.wav | BMacZero | https://freesound.org/people/BMacZero/sounds/96138 |
| 5 | brawlock/body_hit_insanity54_orig.mp3 | body_hit.wav | insanity54 | https://freesound.org/people/insanity54/sounds/276600 |
| 6 | brawlock/clang_a.ogg | Sword Clash.wav | Bird_man | https://freesound.org/people/Bird_man/sounds/275159 |
| 7 | brawlock/clang_ring.ogg | Metal Hit 2 | dslrguide | https://freesound.org/people/dslrguide/sounds/321482 |
| 8 | brawlock/clank.ogg | Metallic hit | _jack | https://freesound.org/people/_jack/sounds/240213 |
| 9 | brawlock/blade_swish.ogg | ninja | Igor1998 | https://freesound.org/people/Igor1998/sounds/391286 |
| 10 | brawlock/swish.ogg | Swish wipe HZA 16-05-2022.wav | hz37 | https://freesound.org/people/hz37/sounds/667419 |
| 11 | brawlock/stone_drag.ogg | Stone,Block,Drag,Wood,Grind.wav | Mediaman57 | https://freesound.org/people/Mediaman57/sounds/347149 |
| 12 | brawlock/stone_door.ogg | stone door close.wav | patchytherat | https://freesound.org/people/patchytherat/sounds/530987 |
| 13 | brawlock/rumble.ogg | Earthquake in cave | Bertsz | https://freesound.org/people/Bertsz/sounds/524307 |
| 14 | brawlock/debris_a.ogg | Stone Impact Rubble Debris 12 | Sheyvan | https://freesound.org/people/Sheyvan/sounds/569508 |
| 15 | brawlock/fire_burst.ogg | Fire Burst Flash | Za-Games | https://freesound.org/people/Za-Games/sounds/539972 |
| 16 | brawlock/chain_clicks.ogg | Steel chain hard clicking | ani_music | https://freesound.org/people/ani_music/sounds/167916 |
| 17 | openverse/crowd_roar_pol.mp3 | S004_Crowd_Roar_Clapping_Mono.wav | Pól | https://freesound.org/people/P%C3%B3l/sounds/385920 |
| 18 | openverse/crowd_cheer_kyles.mp3 | crowd large cheer arena stadium hockey game Montreal Canadiens Habs chant applause whistle.flac | kyles | https://freesound.org/people/kyles/sounds/629884 |
| 19 | openverse/crowd_oooh.mp3 | Crowd Oooh.wav | deleted_user_2104797 | https://freesound.org/people/deleted_user_2104797/sounds/324890 |
| 20 | openverse/crowd_ouch.mp3 | Crowd Ouch.wav | deleted_user_2104797 | https://freesound.org/people/deleted_user_2104797/sounds/324897 |
| 21 | openverse/crowd_boo_jm.mp3 | JM_AMB_INT_Crowd Sport 01 - Booing.wav | Julien Matthey | https://freesound.org/people/Julien%20Matthey/sounds/557189 |
| 22 | openverse/crowd_whistle_kyles.mp3 | crowd ext cheering whistling crazy.flac | kyles | https://freesound.org/people/kyles/sounds/453863 |
| 23 | openverse/crowd_howl_drum_pol.mp3 | S006_Crowd_Howl_Drum_Bang_Mono.wav | Pól | https://freesound.org/people/P%C3%B3l/sounds/385918 |
| 24 | openverse/gore_splat.mp3 | goreSplat.wav | ThefitzyG | https://freesound.org/people/ThefitzyG/sounds/414296 |
| 25 | openverse/gutsy_spillage.mp3 | Gutsy Spillage 1 | magnuswaker | https://freesound.org/people/magnuswaker/sounds/522159 |
| 26 | openverse/squelch3.mp3 | Squelch 3.wav | JarredGibb | https://freesound.org/people/JarredGibb/sounds/217333 |
| 27 | openverse/bone_crack1.mp3 | Bone Crack (1) | johnfolker | https://freesound.org/people/johnfolker/sounds/269025 |
| 28 | openverse/sword_stab3.mp3 | Sword stab 3 | ihitokage | https://freesound.org/people/ihitokage/sounds/395372 |
| 29 | openverse/bodyfall1.mp3 | Body falling on the ground 1 | ihitokage | https://freesound.org/people/ihitokage/sounds/395331 |
| 30 | openverse/sword_clang_badass.mp3 | Badass Sword Clang!.wav | ethanchase7744 | https://freesound.org/people/ethanchase7744/sounds/439508 |
| 31 | openverse/shling.mp3 | shling.mp3 | pugger | https://freesound.org/people/pugger/sounds/63506 |
| 32 | openverse/spinning.mp3 | Spinning | ihitokage | https://freesound.org/people/ihitokage/sounds/395337 |
| 33 | openverse/longbow_release1.mp3 | Longbow Release 1.wav | saturdaysoundguy | https://freesound.org/people/saturdaysoundguy/sounds/394178 |
| 34 | openverse/arrow_impact4.mp3 | Arrow Impact 4 | Ali_6868 | https://freesound.org/people/Ali_6868/sounds/384911 |
| 35 | openverse/wood_chop9.mp3 | Wood Chop 9.wav | wavecal22 | https://freesound.org/people/wavecal22/sounds/537434 |
| 36 | openverse/tile_breaking.mp3 | Tile Breaking | Fission9 | https://freesound.org/people/Fission9/sounds/583310 |
| 37 | openverse/barrel_break1.mp3 | Barrel Break 1.wav | kevinkace | https://freesound.org/people/kevinkace/sounds/66769 |
| 38 | openverse/explosion1.mp3 | Explosion 1 | magnuswaker | https://freesound.org/people/magnuswaker/sounds/523089 |
| 39 | openverse/acid_bubbling.mp3 | Acid Bubbling.wav | spookymodem | https://freesound.org/people/spookymodem/sounds/202094 |
| 40 | openverse/heartbeat_single.mp3 | Single Heartbeat Clean HQ_BeatSmith.wav | Lunardrive | https://freesound.org/people/Lunardrive/sounds/22440 |
| 41 | openverse/gong_qubodup.mp3 | Gong | qubodup | https://freesound.org/people/qubodup/sounds/157432 |
| 42 | openverse/war_horn_booga4.mp3 | Booga Booga War Horn Variant 4 | Palaniru | https://freesound.org/people/Palaniru/sounds/720204 (skip) |
