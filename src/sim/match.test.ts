import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BarkKind, BrainFactory, GameEvent, Match, MatchConfig, WeaponId } from '../core';
import { BARK_RULES, STEER_DIRS } from '../core';
import { MAPS, createMatch, stateHash } from './index';
import { scriptedBrains, seekerBrain, testConfig, testStrategy } from './testkit';

function runToEnd(m: Match, cap = 20000): GameEvent[] {
  const events: GameEvent[] = [];
  while (!m.isOver && m.state.tick < cap) events.push(...m.step());
  return events;
}

/** Brains that never move or attack: only the sudden-death wall can end their match. */
const pacifists: BrainFactory = () => ({
  memory: {},
  think: (view) => ({
    behaviour: 'wait',
    scores: {},
    targetId: null,
    heading: view.self.facing,
    speed: 0,
    ring: new Array<number>(STEER_DIRS).fill(0),
    terms: [],
    attack: false,
    parry: false,
    useSkill: false,
    stance: 'normal',
    sensors: {},
    guardTrips: [],
  }),
});

describe('determinism', () => {
  afterEach(() => vi.restoreAllMocks());

  // Replays, seeking and gym reports all assume a config + seed replays exactly. 16 fighters on
  // the catacombs (long, dark: hearing estimates, memory, search) with seed 3 runs past 3000 ticks
  // and into sudden death (the closing wall pushing and crushing), so every system is involved.
  it('replays the same seed to an identical state, checked every 100 ticks for 3000+ ticks', () => {
    const config = testConfig({ seed: 3, mapId: 'catacombs', fighters: 16 });
    const a = createMatch(config, seekerBrain);
    const b = createMatch(config, seekerBrain);
    let checked = 0;
    let suddenDeath = false;
    while (!a.isOver) {
      const ea = a.step();
      const eb = b.step();
      expect(JSON.stringify(eb)).toBe(JSON.stringify(ea));
      if (ea.some((e) => e.type === 'sudden_death')) suddenDeath = true;
      if (a.state.tick % 100 === 0) {
        expect(stateHash(b.state)).toBe(stateHash(a.state));
        checked++;
      }
    }
    expect(b.isOver).toBe(true);
    expect(stateHash(b.state)).toBe(stateHash(a.state));
    expect(a.state.tick).toBeGreaterThanOrEqual(3000);
    expect(suddenDeath).toBe(true);
    expect(checked).toBeGreaterThanOrEqual(30);
  });

  it('different seeds play different matches', () => {
    const a = createMatch(testConfig({ seed: 1 }), seekerBrain);
    const b = createMatch(testConfig({ seed: 2 }), seekerBrain);
    for (let i = 0; i < 300; i++) {
      a.step();
      b.step();
    }
    expect(stateHash(a.state)).not.toBe(stateHash(b.state));
  });

  // The sim must take every random number from the seeded Rng; ambient randomness or clocks would
  // make replays drift in ways no test of equal seeds would notice on one machine.
  it('never touches Math.random, Date.now or performance.now', () => {
    const boom = () => {
      throw new Error('ambient randomness or time used in the sim');
    };
    vi.spyOn(Math, 'random').mockImplementation(boom);
    vi.spyOn(Date, 'now').mockImplementation(boom);
    vi.spyOn(performance, 'now').mockImplementation(boom);
    for (const mapId of Object.keys(MAPS)) {
      const m = createMatch(testConfig({ seed: 3, mapId, fighters: 8 }), seekerBrain);
      runToEnd(m);
      expect(m.isOver).toBe(true);
    }
  });
});

describe('match flow', () => {
  it('places fighters in reverse order of death, last standing first', () => {
    const m = createMatch(testConfig({ seed: 11, fighters: 8 }), seekerBrain);
    const events = runToEnd(m);
    expect(m.isOver).toBe(true);
    const fighters = m.state.fighters;
    expect(fighters.map((f) => f.place).sort((x, y) => x! - y!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(fighters.filter((f) => f.alive).map((f) => f.place)).toEqual([1]);
    // Anyone who died later placed better than anyone who died earlier.
    for (const a of fighters) {
      for (const b of fighters) {
        if (a.diedAtTick !== null && b.diedAtTick !== null && a.diedAtTick < b.diedAtTick) expect(a.place!).toBeGreaterThan(b.place!);
      }
    }
    expect(m.state.placements).toEqual([...fighters].sort((a, b) => a.place! - b.place!).map((f) => f.id));
    const end = events.filter((e) => e.type === 'match_end');
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({ placements: m.state.placements });
    // Every death has exactly one kill event.
    expect(events.filter((e) => e.type === 'kill')).toHaveLength(7);
    expect(m.result().fighters.every((f) => f.place >= 1)).toBe(true);
  });

  // No strategy may stall a match forever: hiding or standing still must lose to the wall.
  it('sudden death ends a match even when nobody fights', () => {
    const timeLimitTicks = 600;
    const m = createMatch(testConfig({ seed: 5, fighters: 8, timeLimitTicks }), pacifists);
    const events = runToEnd(m);
    expect(m.isOver).toBe(true);
    expect(events.filter((e) => e.type === 'sudden_death')).toHaveLength(1);
    // Identical pacifists take identical wall damage, so the last ones may fall on the same tick;
    // the tie-break still gives everyone a distinct place.
    const kills = events.filter((e) => e.type === 'kill');
    expect(kills.length).toBeGreaterThanOrEqual(7);
    expect(kills.every((k) => k.type === 'kill' && k.cause === 'sudden_death')).toBe(true);
    expect(new Set(m.state.placements).size).toBe(8);
    // The wall closes in under 40 s and the escalation finishes the job in seconds: the judges'
    // hard cap (time limit + 60 s) is never needed.
    expect(m.state.tick).toBeLessThan(timeLimitTicks + 60 * 60);
    expect(m.state.ending).toBe('elimination');
    expect(events.filter((e) => e.type === 'match_end')[0]).toMatchObject({ ending: 'elimination' });
  });

  // The final-kill slow motion, the WINNER stamp and the biggest roar hang off this flag: exactly
  // the kill that decided the match, on the match_end tick, and never a kill in a match the clock ended.
  it('marks exactly one kill as final: the last kill of an elimination, on the match_end tick', () => {
    for (const seed of [11, 12]) {
      const m = createMatch(testConfig({ seed, fighters: 6 }), seekerBrain);
      const events = runToEnd(m);
      expect(m.isOver, `seed ${seed} did not finish within the tick cap`).toBe(true);
      expect(m.state.ending).toBe('elimination');
      const kills = events.filter((e): e is Extract<GameEvent, { type: 'kill' }> => e.type === 'kill');
      const finals = kills.filter((k) => k.final);
      expect(finals).toHaveLength(1);
      const end = events.find((e) => e.type === 'match_end')!;
      expect(finals[0]!.tick).toBe(end.tick);
      expect(finals[0]).toBe(kills.filter((k) => k.tick === end.tick).at(-1));
    }
    const timed = createMatch(testConfig({ seed: 5, fighters: 4, timeLimitTicks: 300, suddenDeath: false }), seekerBrain);
    const timedEvents = runToEnd(timed);
    expect(timed.state.ending).toBe('time');
    expect(timedEvents.some((e) => e.type === 'kill' && e.final)).toBe(false);
  });

  it('without sudden death the match ends at the time limit, ranked by remaining health', () => {
    const m = createMatch(testConfig({ seed: 5, fighters: 4, timeLimitTicks: 300, suddenDeath: false }), pacifists);
    m.state.fighters[2]!.hp -= 50;
    runToEnd(m);
    expect(m.isOver).toBe(true);
    expect(m.state.tick).toBe(300);
    expect(m.state.fighters.every((f) => f.alive)).toBe(true);
    expect(m.state.placements[3]).toBe(m.state.fighters[2]!.id);
    expect(m.state.ending).toBe('time');
    expect(m.result().ending).toBe('time');
  });

  it.each(Object.keys(MAPS))('an 8-fighter free-for-all on %s finishes with one winner', (mapId) => {
    for (const seed of [1, 2, 3]) {
      const m = createMatch(testConfig({ seed, mapId, fighters: 8 }), seekerBrain);
      runToEnd(m);
      expect(m.isOver).toBe(true);
      expect(m.state.fighters.filter((f) => f.alive)).toHaveLength(1);
      expect(new Set(m.state.placements).size).toBe(8);
    }
  });

  it('runs 16 fighters, the most a match supports', () => {
    const m = createMatch(testConfig({ seed: 4, fighters: 16 }), seekerBrain);
    runToEnd(m);
    expect(m.isOver).toBe(true);
    expect(m.state.placements).toHaveLength(16);
  });

  it('rejects configs it cannot play instead of guessing', () => {
    expect(() => createMatch({ ...testConfig({ seed: 1 }), mapId: 'nowhere' }, seekerBrain)).toThrow(/unknown map/);
    expect(() => createMatch(testConfig({ seed: 1, fighters: 1 }), seekerBrain)).toThrow(/entrants/);
    expect(() => createMatch(testConfig({ seed: 1, fighters: 17 }), seekerBrain)).toThrow(/entrants/);
  });
});

describe('pace', () => {
  // Spec: "At 1x a fighter needs roughly 8-10 seconds to cross the default arena." This guards
  // SPEED_SCALE, weapon weights and the movement model against drifting out of readable speed.
  it('a balanced build (agility 20) crosses the pit in 8-10 s on average', () => {
    const weapons: WeaponId[] = ['GREATSWORD', 'WARHAMMER', 'TWIN_DAGGERS', 'THROWING_AXES', 'LONGBOW', 'ARCANE_STAFF'];
    const seconds = weapons.map((weapon) => {
      const config: MatchConfig = testConfig({ seed: 1, fighters: 2 });
      config.entrants[0]!.strategy = testStrategy('runner', weapon);
      config.entrants[1]!.strategy = testStrategy('parked', 'GREATSWORD');
      const m = createMatch(config, scriptedBrains({ runner: { heading: 0, speed: 1 } }));
      const [a, b] = m.state.fighters as [typeof m.state.fighters[0], typeof m.state.fighters[0]];
      expect(a.attributes.agility).toBe(20);
      // The open lane along the top of the pit, wall to wall.
      a.pos.x = 24 + a.radius;
      a.pos.y = 196;
      a.facing = 0;
      b.pos.x = 680;
      b.pos.y = 760;
      while (a.pos.x < 1336 - a.radius - 0.5 && m.state.tick < 1200) m.step();
      return m.state.tick / 60;
    });
    const avg = seconds.reduce((s, x) => s + x, 0) / seconds.length;
    expect(avg).toBeGreaterThanOrEqual(8);
    expect(avg).toBeLessThanOrEqual(10);
  });
});

describe('barks and credit', () => {
  const ALL_BARKS: Partial<Record<BarkKind, string[]>> = {
    spawn: ['Hello.'], kill: ['Got one.'], hit: ['Ha.'], low_hp: ['Ouch.'], death: ['Bye.'], skill: ['Watch this.'], taunt: ['Come on.'],
  };

  // Barks are rare: at most one per fighter every BARK_RULES.cooldownTicks (8 s), kill and death
  // lines included, so the screen never fills with speech bubbles.
  it('no fighter barks twice within the cooldown, whatever the kind', () => {
    let barks = 0;
    const kinds = new Set<string>();
    for (const seed of [1, 2, 3]) {
      const config = testConfig({ seed, fighters: 8 });
      config.entrants.forEach((e) => (e.strategy = testStrategy(e.name, e.strategy.build.weapon, { barks: ALL_BARKS })));
      const m = createMatch(config, seekerBrain);
      const last = new Map<string, number>();
      for (const e of runToEnd(m)) {
        if (e.type !== 'bark') continue;
        barks++;
        kinds.add(e.kind);
        const prev = last.get(e.fighterId);
        if (prev !== undefined) expect(e.tick - prev).toBeGreaterThanOrEqual(BARK_RULES.cooldownTicks);
        last.set(e.fighterId, e.tick);
      }
    }
    expect(barks).toBeGreaterThan(20);
    expect(kinds.has('spawn')).toBe(true);
    expect(kinds.has('kill') || kinds.has('death')).toBe(true);
  });

  // The timeline colours a lost limb by who took it: the dismember event must name the attacker of
  // the blow that took it (null for hazards and the wall).
  it('credits every lost limb to the fighter who landed the blow', () => {
    let credited = 0;
    for (const seed of [1, 2, 3, 4]) {
      const events = runToEnd(createMatch(testConfig({ seed, fighters: 8 }), seekerBrain));
      for (const d of events) {
        if (d.type !== 'dismember') continue;
        const blow = events.find((h) => h.type === 'hit' && h.tick === d.tick && h.victimId === d.victimId && h.attackerId === d.attackerId);
        expect(blow).toBeDefined();
        if (d.attackerId) credited++;
      }
    }
    expect(credited).toBeGreaterThan(0);
  });
});
