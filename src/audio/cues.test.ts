import { describe, expect, it } from 'vitest';
import { LIVE_EVENT_TICKS, TICK_HZ, WEAPONS, WEAPON_IDS, initialSuddenDeathState } from '../core';
import type { FighterState, GameEvent, WeaponId, WorldState } from '../core';
import {
  FinalGate,
  PAN_WIDTH,
  SOUND_SPECS,
  createCueMemory,
  cuesForEvent,
  cuesForSignal,
  excitementBump,
  finalKillIndex,
  killDrama,
  panForX,
  rememberContacts,
  wallContact,
} from './cues';
import type { Cue, SoundId } from './cues';
import { RECIPES } from './synth';

const W = 1360;
const H = 860;

function fighter(id: string, x: number, opts: Partial<FighterState> = {}): FighterState {
  return {
    id, entrantId: id, squad: 0, name: id, color: '#ffffff', weapon: 'GREATSWORD', skill: 'DASH',
    attributes: { vitality: 20, power: 16, agility: 20, perception: 16, armor: 14, haste: 14 },
    pos: { x, y: H / 2 }, vel: { x: 0, y: 0 }, facing: 0, headAngle: 0, radius: 18, hp: 300, maxHp: 300,
    alive: true, diedAtTick: null, anim: { phase: 'idle', t: 0, dur: 0 }, walkPhase: 0, attackCd: 0, skillCd: 0,
    parryTicks: 0, parryCd: 0, stunTicks: 0, ammo: 4, maxAmmo: 4, buffs: { haste: 0, berserk: 0, slow: 0 },
    limbs: { armL: true, armR: true, legL: true, legR: true }, helmet: true, inShadow: false, seen: false,
    stance: 'normal', hitFlash: 0, eyePop: 0, behaviour: 'brawl', targetId: null, kills: 0, damageDealt: 0,
    damageTaken: 0, lastHitBy: null, lastHitTick: null, place: null,
    ...opts,
  };
}

function world(fighters: FighterState[], tick = 600): WorldState {
  return {
    tick, mapId: 'pit', fighters, projectiles: [], floor: [], props: [],
    hazards: [{ id: 'saw1', kind: 'saw', pos: { x: 300, y: 300 }, radius: 20, phase: 0, active: true, ttl: null }],
    shrines: [], stuck: [], pickups: [], suddenDeath: initialSuddenDeathState({ width: W, height: H }),
    finished: false, ending: null, placements: [],
  };
}

const EIGHT = Array.from({ length: 8 }, (_, i) => fighter(`f${i}`, 100 + i * 150));

/** A fixed "random" so pitch variation does not blur the assertions. */
const mid = () => 0.5;

function cues(ev: GameEvent, state = world(EIGHT), memory = createCueMemory(), finalKill = false): Cue[] {
  const out: Cue[] = [];
  cuesForEvent(ev, state, memory, finalKill, out, mid);
  return out;
}

function sounds(ev: GameEvent, state?: WorldState): SoundId[] {
  return cues(ev, state).map((c) => c.sound);
}

function hit(weapon: WeaponId | null, amount = 25, extra: Partial<Extract<GameEvent, { type: 'hit' }>> = {}): GameEvent {
  return {
    type: 'hit', tick: 600, attackerId: 'f0', victimId: 'f1', amount, pos: { x: 680, y: 430 }, dir: 0, crit: false,
    backstab: false, weapon, knockback: 5, source: weapon ? 'weapon' : 'punch', ...extra,
  };
}

function kill(flags: Extract<GameEvent, { type: 'kill' }>['flags'] = []): Extract<GameEvent, { type: 'kill' }> {
  return {
    type: 'kill', tick: 600, killerId: 'f0', victimId: 'f1', cause: 'weapon', pos: { x: 680, y: 430 }, dir: 0,
    title: 'SPLIT', killerBehaviour: 'brawl', victimBehaviour: 'lurk', weapon: 'GREATSWORD', flags, hazard: null, final: false,
  };
}

describe('sound table', () => {
  // A cue with no recipe would throw inside the mixer mid-match; one with no spec could not be limited.
  it('has a recipe and a spec for every sound', () => {
    expect(Object.keys(RECIPES).sort()).toEqual(Object.keys(SOUND_SPECS).sort());
  });

  // Voice stealing protects what matters: the kill is never lost to footsteps or ordinary hits.
  it('ranks kills above hits above swings above footsteps', () => {
    const p = (s: SoundId) => SOUND_SPECS[s].priority;
    expect(p('kill_sting')).toBeGreaterThan(p('death_splat'));
    expect(p('death_splat')).toBeGreaterThan(p('hit_blade'));
    expect(p('hit_blade')).toBeGreaterThan(p('swing_greatsword'));
    expect(p('swing_greatsword')).toBeGreaterThan(p('footstep'));
    for (const s of Object.keys(SOUND_SPECS) as SoundId[]) if (s !== 'footstep') expect(p(s)).toBeGreaterThanOrEqual(p('footstep'));
  });
});

describe('cuesForEvent', () => {
  // Readable hits: you can hear which weapon landed without looking.
  it('gives every weapon its own impact sound', () => {
    const impacts = WEAPON_IDS.map((w) => sounds(hit(w))[0]);
    expect(new Set(impacts).size).toBe(WEAPON_IDS.length);
    expect(impacts).toEqual(['hit_blade', 'hit_hammer', 'hit_dagger', 'hit_axe', 'hit_arrow', 'hit_arcane']);
    expect(sounds(hit(null))).toEqual(['hit_punch']);
  });

  it('gives every weapon its own swing or windup sound', () => {
    const swings = WEAPON_IDS.map((w) => sounds({ type: 'swing', tick: 600, fighterId: 'f0', weapon: w })[0]);
    expect(new Set(swings).size).toBe(WEAPON_IDS.length);
  });

  // The windup is the telegraph; the whoosh belongs to the blow, so it must peak on the strike tick.
  it('times a melee whoosh to peak when the strike lands', () => {
    for (const w of ['GREATSWORD', 'WARHAMMER', 'TWIN_DAGGERS'] as const) {
      const [c] = cues({ type: 'swing', tick: 600, fighterId: 'f0', weapon: w });
      expect(c!.delay + SOUND_SPECS[c!.sound].lead).toBeCloseTo(WEAPONS[w].windup / TICK_HZ, 6);
    }
    const [bow] = cues({ type: 'swing', tick: 600, fighterId: 'f0', weapon: 'LONGBOW' });
    expect(bow!.delay).toBe(0);
  });

  it('swings a punch when the weapon arm is gone', () => {
    const armless = world([fighter('f0', 400, { limbs: { armL: true, armR: false, legL: true, legR: true } })]);
    expect(sounds({ type: 'swing', tick: 600, fighterId: 'f0', weapon: 'GREATSWORD' }, armless)).toEqual(['swing_punch']);
    // The sim punches with an empty quiver too: no bow creak for a fist.
    const empty = world([fighter('f0', 400, { weapon: 'LONGBOW', ammo: 0 })]);
    expect(sounds({ type: 'swing', tick: 600, fighterId: 'f0', weapon: 'LONGBOW' }, empty)).toEqual(['swing_punch']);
  });

  it('gives each projectile its own release, and its own sound when it hits a wall', () => {
    const memory = createCueMemory();
    const out: SoundId[] = [];
    for (const w of ['LONGBOW', 'THROWING_AXES', 'ARCANE_STAFF'] as const) {
      const released = cues({ type: 'projectile', tick: 600, projectileId: `p${w}`, ownerId: 'f0', weapon: w, pos: { x: 100, y: 100 }, dir: 0 }, world(EIGHT), memory);
      const landed = cues({ type: 'projectile_end', tick: 600, projectileId: `p${w}`, pos: { x: 900, y: 100 }, hitId: null }, world(EIGHT), memory);
      out.push(released[0]!.sound, landed[0]!.sound);
    }
    expect(out).toEqual(['release_bow', 'thunk_arrow', 'release_axe', 'clang_axe', 'release_staff', 'burst_orb']);
    expect(memory.projectiles.size).toBe(0);
  });

  // An arrow in a fighter already sounds through its hit; a second "thunk" would double it.
  it('leaves fighter hits to the hit event, except the orb splash', () => {
    const memory = createCueMemory();
    const s = world(EIGHT);
    cues({ type: 'projectile', tick: 600, projectileId: 'a', ownerId: 'f0', weapon: 'LONGBOW', pos: { x: 0, y: 0 }, dir: 0 }, s, memory);
    cues({ type: 'projectile', tick: 600, projectileId: 'o', ownerId: 'f0', weapon: 'ARCANE_STAFF', pos: { x: 0, y: 0 }, dir: 0 }, s, memory);
    expect(cues({ type: 'projectile_end', tick: 600, projectileId: 'a', pos: { x: 5, y: 5 }, hitId: 'f1' }, s, memory)).toEqual([]);
    expect(cues({ type: 'projectile_end', tick: 600, projectileId: 'o', pos: { x: 5, y: 5 }, hitId: 'f1' }, s, memory).map((c) => c.sound)).toEqual(['burst_orb']);
  });

  // Seeking replays old events to repaint the floor: none of them may make a sound.
  it('plays nothing for catch-up events but still remembers projectiles', () => {
    const state = world(EIGHT, 2000);
    const memory = createCueMemory();
    const old = 2000 - LIVE_EVENT_TICKS - 1;
    expect(cues({ ...kill(), tick: old }, state, memory)).toEqual([]);
    expect(cues({ type: 'projectile', tick: old, projectileId: 'p9', ownerId: 'f0', weapon: 'LONGBOW', pos: { x: 0, y: 0 }, dir: 0 }, state, memory)).toEqual([]);
    expect(memory.projectiles.get('p9')).toBe('LONGBOW');
    expect(cues({ ...kill(), tick: 2000 - LIVE_EVENT_TICKS }, state, memory).length).toBeGreaterThan(0);
  });

  it('makes bigger blows louder, and adds a crunch for crits and a shink for backstabs', () => {
    const small = cues(hit('GREATSWORD', 8))[0]!;
    const big = cues(hit('GREATSWORD', 45))[0]!;
    expect(big.gain).toBeGreaterThan(small.gain);
    expect(big.intensity).toBeGreaterThan(small.intensity);
    expect(sounds(hit('GREATSWORD', 30, { crit: true }))).toEqual(['hit_blade', 'crit_crunch']);
    expect(sounds(hit('TWIN_DAGGERS', 30, { backstab: true }))).toEqual(['hit_dagger', 'backstab_shink']);
  });

  // Wall damage is spikes or the floor biting, never a weapon's splat. Contact arrives as a
  // `wall_contact` plus a `hit` in the same tick, in either order.
  it('grinds instead of splatting when the sudden-death wall does the damage', () => {
    const wallHit = hit(null, 4, { source: 'sudden_death', attackerId: null });
    const contact: GameEvent = { type: 'wall_contact', tick: 600, fighterId: 'f1', damage: 4, pos: { x: 120, y: 430 } };
    const memory = createCueMemory();
    rememberContacts([wallHit, contact], memory);
    expect(cues(wallHit, world(EIGHT), memory).map((c) => c.sound)).toEqual(['wall_grind']);
    // No contact: the escalated damage hitting everyone inside the zone.
    expect(sounds(wallHit)).toEqual(['zone_burn']);
    // The contact event itself is the engine's grind loop, not a retriggered sound.
    expect(sounds(contact)).toEqual([]);
  });

  // A death is an event: splat, broadcast sting and the crowd.
  it('answers a kill with a splat, the kill sting and a crowd roar', () => {
    expect(sounds(kill())).toEqual(['death_splat', 'kill_sting', 'crowd_roar']);
  });

  it('roars louder for multi-kills and loudest for the kill that ends the match', () => {
    const roar = (cs: Cue[]) => cs.find((c) => c.sound === 'crowd_roar')!;
    const plain = roar(cues(kill()));
    const multi = roar(cues(kill(['multi'])));
    const final = roar(cues(kill(), world(EIGHT), createCueMemory(), true));
    expect(multi.intensity).toBeGreaterThan(plain.intensity);
    expect(final.intensity).toBe(1);
    expect(final.gain).toBeGreaterThan(multi.gain);
    const sting = (cs: Cue[]) => cs.find((c) => c.sound === 'kill_sting')!;
    expect(sting(cues(kill(['multi']))).pitch).toBeGreaterThan(sting(cues(kill())).pitch);
  });

  it('keeps footsteps very quiet', () => {
    const step = cues({ type: 'footstep', tick: 600, fighterId: 'f0', pos: { x: 100, y: 100 }, bloody: false })[0]!;
    const blow = cues(hit('WARHAMMER', 20))[0]!;
    expect(step.sound).toBe('footstep');
    expect(step.gain).toBeLessThan(blow.gain * 0.25);
    expect(sounds({ type: 'footstep', tick: 600, fighterId: 'f0', pos: { x: 100, y: 100 }, bloody: true })).toEqual(['footstep_wet']);
  });

  it('announces sudden death, power-ups, the judges and the bell', () => {
    expect(sounds({ type: 'sudden_death', tick: 600, reason: 'stalemate' })[0]).toBe('horn');
    expect(sounds({ type: 'pickup_spawn', tick: 600, pickupId: 'h', kind: 'haste', pos: { x: 680, y: 200 } })).toEqual(['spawn_haste']);
    expect(sounds({ type: 'pickup_spawn', tick: 600, pickupId: 'b', kind: 'berserk', pos: { x: 680, y: 600 } })).toEqual(['spawn_berserk']);
    expect(sounds({ type: 'pickup', tick: 600, fighterId: 'f0', kind: 'berserk', pos: { x: 0, y: 0 } })).toEqual(['pickup_berserk']);
    expect(sounds({ type: 'pickup', tick: 600, fighterId: 'f0', kind: 'arrow', pos: { x: 0, y: 0 } })).toEqual(['pickup_ammo']);
    expect(sounds({ type: 'judges_decision', tick: 600, survivors: [] })[0]).toBe('gong');
    expect(sounds({ type: 'match_end', tick: 600, placements: [], ending: 'elimination' })).toEqual(['bell']);
    expect(sounds({ type: 'match_end', tick: 600, placements: [], ending: 'judges' })).toEqual(['bell', 'crowd_roar']);
  });

  it('sounds the second horn only once, when the escalation first hits everyone', () => {
    const memory = createCueMemory();
    const s = world(EIGHT);
    const esc = (level: number, everywhere: boolean) => cues({ type: 'escalation', tick: 600, level, damage: 4 + 2 * level, everywhere }, s, memory).map((c) => c.sound);
    expect(esc(1, false)).toEqual(['escalation']);
    expect(esc(6, true)).toEqual(['escalation', 'horn']);
    expect(esc(7, true)).toEqual(['escalation']);
  });

  it('booms louder for bigger blasts and picks the hazard sound by its kind', () => {
    const boom = (radius: number) => cues({ type: 'explosion', tick: 600, pos: { x: 680, y: 430 }, radius })[0]!;
    expect(boom(140).gain).toBeGreaterThan(boom(60).gain);
    expect(sounds({ type: 'hazard', tick: 600, hazardId: 'saw1', victimId: 'f2', pos: { x: 300, y: 300 } })).toEqual(['hazard_saw']);
    expect(sounds({ type: 'hazard', tick: 600, hazardId: 'gone', victimId: null, pos: { x: 300, y: 300 } })).toEqual([]);
  });
});

describe('panForX', () => {
  // A top-down arena: left of centre comes from the left speaker.
  it('pans by the side of the arena, never fully hard', () => {
    const s = world(EIGHT);
    expect(panForX(W / 2, s)).toBe(0);
    expect(panForX(100, s)).toBeLessThan(0);
    expect(panForX(W - 100, s)).toBeGreaterThan(0);
    expect(panForX(-500, s)).toBe(-PAN_WIDTH);
    expect(panForX(5000, s)).toBe(PAN_WIDTH);
    expect(panForX(Number.NaN, s)).toBe(0);
  });
});

describe('killDrama', () => {
  it('rises as the field thins', () => {
    const full = world(EIGHT);
    const thin = world(EIGHT.map((f, i) => (i < 6 ? { ...f, alive: false } : f)));
    expect(killDrama(kill(), thin, false)).toBeGreaterThan(killDrama(kill(), full, false));
    expect(killDrama(kill(['multi', 'backstab', 'overkill', 'revenge', 'unseen']), thin, false)).toBeLessThanOrEqual(1);
  });
});

describe('finalKillIndex', () => {
  it('finds the last kill before an elimination, and nothing for other endings', () => {
    const end = (ending: 'elimination' | 'judges'): GameEvent => ({ type: 'match_end', tick: 600, placements: [], ending });
    expect(finalKillIndex([hit('GREATSWORD'), kill(), kill(), end('elimination')])).toBe(2);
    expect(finalKillIndex([kill(), end('judges')])).toBe(-1);
    expect(finalKillIndex([kill()])).toBe(-1);
  });
});

describe('excitementBump', () => {
  it('excites the crowd more for kills than hits, and not at all for footsteps', () => {
    const k = excitementBump(kill());
    const h = excitementBump(hit('GREATSWORD', 30));
    expect(k).toBeGreaterThan(h);
    expect(h).toBeGreaterThan(0);
    expect(excitementBump({ type: 'footstep', tick: 600, fighterId: 'f0', pos: { x: 0, y: 0 }, bloody: false })).toBe(0);
  });
});

describe('round end and match signals', () => {
  // The kill that decides the match gets its own fanfare, not a louder copy of every other kill.
  it('gives the final kill the final sting and the loudest roar, from the event alone', () => {
    const final = cues({ ...kill(), final: true });
    expect(final.map((c) => c.sound)).toEqual(['death_splat', 'final_sting', 'crowd_roar']);
    expect(final.find((c) => c.sound === 'crowd_roar')!.intensity).toBe(1);
    expect(sounds(kill())).not.toContain('final_sting');
  });

  // CRUSHED is the wall's own kill: iron and bones on top of the usual death.
  it('adds a crush for a fighter pinned by the closing wall', () => {
    expect(sounds({ ...kill(['crushed']), cause: 'sudden_death', killerId: null, weapon: null })).toEqual(['crush', 'death_splat', 'kill_sting', 'crowd_roar']);
  });

  it('counts down with a climbing beat, then hits FIGHT with the crowd', () => {
    const beat = (value: number) => {
      const out: Cue[] = [];
      cuesForSignal({ type: 'countdown', value }, out);
      return out[0]!;
    };
    expect(beat(3).sound).toBe('countdown');
    expect(beat(2).pitch).toBeGreaterThan(beat(3).pitch);
    expect(beat(1).pitch).toBeGreaterThan(beat(2).pitch);
    const fight: Cue[] = [];
    cuesForSignal({ type: 'fight' }, fight);
    expect(fight.map((c) => c.sound)).toEqual(['fight', 'crowd_roar']);
    const fin: Cue[] = [];
    cuesForSignal({ type: 'final_kill', killerId: 'f0', victimId: 'f1', pos: { x: 0, y: 0 } }, fin);
    expect(fin.map((c) => c.sound)).toEqual(['final_sting']);
  });

  // Announcer beats are real time: slow motion must never bend the countdown or the final sting.
  it('keeps the countdown, FIGHT and the final sting on the unbent signal bus', () => {
    for (const s of ['countdown', 'fight', 'final_sting'] as const) expect(SOUND_SPECS[s].group).toBe('signal');
  });

  // The kill event and the final_kill signal arrive in the same frame in either order: one sting.
  it('plays the final sting once per final kill, whichever source comes first', () => {
    const gate = new FinalGate(5);
    expect(gate.take('f1', 10)).toBe(true);
    expect(gate.take('f1', 10.01)).toBe(false);
    expect(gate.take('f2', 10.02)).toBe(true);
    // A replay of the same match later rings it again.
    expect(gate.take('f2', 20)).toBe(true);
    gate.reset();
    expect(gate.take('f2', 20.5)).toBe(true);
  });
});

describe('wall contact and heals', () => {
  it('counts each fighter on the spikes once per batch and pans the grind toward them', () => {
    const s = world(EIGHT, 600);
    const touch = (id: string, x: number, tick = 600): GameEvent => ({ type: 'wall_contact', tick, fighterId: id, damage: 2, pos: { x, y: 430 } });
    expect(wallContact([], s)).toEqual({ fighters: 0, pan: 0 });
    const left = wallContact([touch('f0', 40), touch('f0', 40), touch('f1', 60)], s);
    expect(left.fighters).toBe(2);
    expect(left.pan).toBeLessThan(-0.5);
    // Catch-up from a seek grinds nothing.
    expect(wallContact([touch('f0', 40, 600 - LIVE_EVENT_TICKS - 1)], s).fighters).toBe(0);
  });

  // A shrine's blessing is a moment; it should sound fuller than any other heal.
  it('makes a shrine heal fuller than another heal', () => {
    const shrine = cues({ type: 'heal', tick: 600, fighterId: 'f0', amount: 40, pos: { x: 680, y: 430 }, shrineId: 's1' })[0]!;
    const other = cues({ type: 'heal', tick: 600, fighterId: 'f0', amount: 40, pos: { x: 680, y: 430 }, shrineId: null })[0]!;
    expect(shrine.sound).toBe('heal');
    expect(shrine.intensity).toBeGreaterThan(other.intensity);
  });
});

describe('victory and stuck ammo', () => {
  // The winner's moment is one big roar; the end card itself makes no sound (the driver hushes).
  it('roars once for the victory and stays quiet for the end card', () => {
    const v: Cue[] = [];
    cuesForSignal({ type: 'victory', winnerIds: ['f0'], ending: 'elimination' }, v);
    expect(v.map((c) => c.sound)).toEqual(['crowd_roar']);
    expect(v[0]!.intensity).toBe(1);
    // The roar sits on the crowd bus with a minimum gap, so the final kill's own roar in the same
    // frame and this one come out as one roar, not two stacked.
    expect(SOUND_SPECS.crowd_roar.minGap).toBeGreaterThanOrEqual(0.2);
    const card: Cue[] = [];
    cuesForSignal({ type: 'end_card', shown: true, winnerIds: ['f0'] }, card);
    expect(card).toEqual([]);
  });

  const unstick = (reason: 'pickup' | 'drop', kind: 'arrow' | 'axe' = 'arrow'): GameEvent => ({
    type: 'ammo_unstick', tick: 600, stuckId: 's1', kind, pos: { x: 680, y: 430 }, reason, fighterId: reason === 'pickup' ? 'f0' : null, floorItemId: reason === 'drop' ? 'i1' : null,
  });

  it('yanks ammo out of a wall and clatters it to the floor when its holder is gone', () => {
    expect(sounds(unstick('pickup'))).toEqual(['ammo_yank']);
    expect(sounds(unstick('drop'))).toEqual(['ammo_clatter']);
    // Axes are heavier: lower, with the metal clank.
    const axe = cues(unstick('drop', 'axe'))[0]!;
    const arrow = cues(unstick('drop'))[0]!;
    expect(axe.pitch).toBeLessThan(arrow.pitch);
    expect(axe.intensity).toBeGreaterThan(arrow.intensity);
  });

  // A stick already sounds through its projectile_end (the thunk with its quiver) or its hit: a
  // second sound for the same impact would double it.
  it('adds no sound of its own for a stick', () => {
    const stick: GameEvent = { type: 'ammo_stick', tick: 600, stuckId: 's1', projectileId: 'p1', kind: 'arrow', ownerId: 'f0', pos: { x: 680, y: 430 }, angle: 0, in: { kind: 'wall' } };
    expect(sounds(stick)).toEqual([]);
  });

  // When a pincushion dies all its arrows drop on one tick: the clatter must not machine-gun.
  it('throttles a burst of clatters and keeps them quiet', () => {
    expect(SOUND_SPECS.ammo_clatter.minGap).toBeGreaterThan(0.04);
    expect(SOUND_SPECS.ammo_clatter.priority).toBeLessThan(SOUND_SPECS.hit_arrow.priority);
    expect(cues(unstick('drop'))[0]!.gain).toBeLessThan(cues(hit('LONGBOW'))[0]!.gain);
  });
});
