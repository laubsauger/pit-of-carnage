import { describe, expect, it } from 'vitest';
import { Rng, SKILL_IDS, WEAPON_IDS } from '../core';
import type { GameEvent, HazardKind, KillCause, KillFlag, WorldState } from '../core';
import { announcements, killLine, killStamp } from './copy';
import type { StampInput } from './copy';

const CAUSES: KillCause[] = ['weapon', 'skill', 'hazard', 'keg', 'friendly', 'sudden_death'];
const HAZARDS: HazardKind[] = ['spike', 'saw', 'acid', 'fire'];
const FLAGS: KillFlag[] = ['backstab', 'crit', 'unseen', 'ranged', 'splash', 'reflect', 'multi', 'revenge', 'overkill', 'crushed'];

function stamp(over: Partial<StampInput>, seed = 1): string {
  return killStamp({ cause: 'weapon', weapon: 'GREATSWORD', skill: null, hazard: null, flags: [], self: false, streak: 1, avenged: false, clutch: false, ...over }, new Rng(seed));
}

describe('kill stamps', () => {
  // Stamps are drawn in Bangers at screen centre: 1-3 words, capitals, nothing else.
  it('are always 1-3 uppercase words', () => {
    const rng = new Rng(9);
    for (const cause of CAUSES)
      for (const weapon of [...WEAPON_IDS, null])
        for (const skill of [...SKILL_IDS, null])
          for (const hazard of [...HAZARDS, null])
            for (let streak = 0; streak <= 5; streak++) {
              const flags = FLAGS.filter(() => rng.chance(0.3));
              const s = stamp({ cause, weapon, skill, hazard, flags, streak, self: rng.chance(0.1), avenged: rng.chance(0.1), clutch: rng.chance(0.1) }, rng.nextU32());
              expect(s).toMatch(/^[A-Z]+( [A-Z]+){0,2}$/);
            }
  });

  it('name the most specific fact first', () => {
    expect(stamp({ streak: 2, flags: ['backstab', 'multi'] })).toBe('DOUBLE KILL');
    expect(stamp({ streak: 4 })).toBe('RAMPAGE');
    expect(stamp({ cause: 'keg', self: true })).toBe('OWN GOAL');
    expect(stamp({ flags: ['backstab'] })).toBe('BACKSTAB');
    expect(['SAWED', 'SLICED THIN']).toContain(stamp({ cause: 'hazard', hazard: 'saw', weapon: null }));
    expect(['SPLIT', 'HALVED', 'CLEAVED']).toContain(stamp({}));
    expect(['KNOCKOUT', 'BARE HANDS']).toContain(stamp({ weapon: null }));
  });

  // Pinned by the closing wall against a pillar is its own spectacle: always CRUSHED, while a plain
  // wall death keeps the generic sudden-death stamps.
  it('stamps a wall pin CRUSHED', () => {
    for (let seed = 1; seed <= 20; seed++) {
      expect(stamp({ cause: 'sudden_death', weapon: null, flags: ['crushed'] }, seed)).toBe('CRUSHED');
      expect(stamp({ cause: 'sudden_death', weapon: null, flags: [] }, seed)).not.toBe('CRUSHED');
    }
  });
});

describe('kill lines', () => {
  const state = {
    fighters: [
      { id: 'f0', name: 'Gary', skill: 'WHIRLWIND' },
      { id: 'f1', name: 'Brenda', skill: 'DASH' },
      { id: 'f2', name: 'Doug', skill: 'DASH' },
    ],
    hazards: [{ id: 'saw', kind: 'saw', pos: { x: 500, y: 500 }, radius: 26 }],
  } as unknown as WorldState;

  const kill = (over: Partial<Extract<GameEvent, { type: 'kill' }>>): Extract<GameEvent, { type: 'kill' }> => ({
    type: 'kill',
    tick: 100,
    killerId: 'f0',
    victimId: 'f1',
    cause: 'weapon',
    pos: { x: 100, y: 100 },
    dir: 0,
    title: 'SPLIT',
    killerBehaviour: 'brawl',
    victimBehaviour: 'kite',
    weapon: 'GREATSWORD',
    flags: [],
    hazard: null,
    final: false,
    ...over,
  });

  // The feed reads like a dry broadcast: who did what to whom, no shouting, no "obliterated".
  it('names both fighters, in plain sentences', () => {
    for (const weapon of WEAPON_IDS) {
      for (let tick = 0; tick < 6; tick++) {
        const line = killLine(kill({ weapon, tick }), state);
        expect(line).toContain('Gary');
        expect(line).toContain('Brenda');
        expect(line).toMatch(/\.$/);
        expect(line).not.toMatch(/!|obliterat/i);
      }
    }
  });

  it('is the same line every time for the same kill (replays print the same feed)', () => {
    const ev = kill({ tick: 1234 });
    expect(killLine(ev, state)).toBe(killLine({ ...ev }, state));
  });

  it('tells hazard kills apart from pushes into hazards', () => {
    const solo = killLine(kill({ cause: 'hazard', killerId: null, weapon: null, hazard: 'saw' }), state);
    expect(solo).toContain('saw');
    expect(solo).not.toContain('Gary');
    const pushed = killLine(kill({ cause: 'hazard', weapon: null, hazard: 'saw' }), state);
    expect(pushed).toContain('Gary');
    expect(pushed).toContain('saw');
  });

  it('calls out an own keg', () => {
    const line = killLine(kill({ cause: 'keg', killerId: 'f2', victimId: 'f2', weapon: null }), state);
    expect(line.startsWith('Doug')).toBe(true);
    expect(line).toMatch(/own keg|lit the keg/);
  });

  it('says the wall crushed someone, not just that it closed', () => {
    const crushed = killLine(kill({ cause: 'sudden_death', killerId: null, weapon: null, flags: ['crushed'] }), state);
    const closed = killLine(kill({ cause: 'sudden_death', killerId: null, weapon: null }), state);
    expect(crushed).toContain('Brenda');
    expect(crushed).toMatch(/wall/i);
    expect(crushed).toMatch(/\.$/);
    expect(crushed).not.toBe(closed);
  });

  it('describes skill kills by the killer\'s skill', () => {
    const line = killLine(kill({ cause: 'skill', weapon: null }), state);
    expect(line).toMatch(/spin|blender/);
  });
});

describe('announcer', () => {
  const state = { fighters: [{ id: 'f0', name: 'Gary' }, { id: 'f1', name: 'Brenda' }] } as unknown as WorldState;

  // The broadcast voice: plain sentences, no shouting, and the wall's start says why it started.
  it('announces sudden death by its reason, in plain sentences', () => {
    const time = announcements([{ type: 'sudden_death', tick: 5400, reason: 'time' }], state);
    const stale = announcements([{ type: 'sudden_death', tick: 900, reason: 'stalemate' }], state);
    expect(time).toHaveLength(1);
    expect(stale).toHaveLength(1);
    expect(time[0]).toMatchObject({ tick: 5400, kind: 'sudden_death', ids: [] });
    expect(stale[0]!.text).not.toBe(time[0]!.text);
    for (const line of [time[0]!.text, stale[0]!.text]) {
      expect(line).toMatch(/wall/i);
      expect(line).toMatch(/\.$/);
      expect(line).not.toMatch(/!/);
    }
  });

  // Escalation is announced twice, not every second: when the wall stops and when it reaches everywhere.
  it('announces the wall stopping and the damage reaching everywhere, nothing in between', () => {
    const levels = Array.from({ length: 10 }, (_, i) => ({ type: 'escalation' as const, tick: 1000 + i * 60, level: i + 1, damage: 4 + 2 * (i + 1), everywhere: i >= 5 }));
    const lines = levels.flatMap((e) => announcements([e], state));
    expect(lines.map((l) => l.tick)).toEqual([1000, 1300]);
  });

  it('names the judges\' winner and their health', () => {
    const [line] = announcements([{ type: 'judges_decision', tick: 9000, survivors: [{ id: 'f1', hpFraction: 0.43, damageDealt: 212, kills: 2 }, { id: 'f0', hpFraction: 0.2, damageDealt: 90, kills: 1 }] }], state);
    expect(line!.text).toContain('Brenda');
    expect(line!.text).toContain('43%');
    expect(line!.ids).toEqual(['f1', 'f0']);
  });

  // "Berserk is up." once per kind per tick, however many pedestals of it filled at once.
  it('announces power-ups coming back once per kind', () => {
    const spawn = (pickupId: string, kind: 'haste' | 'berserk') => ({ type: 'pickup_spawn' as const, tick: 480, pickupId, kind, pos: { x: 0, y: 0 } });
    const lines = announcements([spawn('berserk_0', 'berserk'), spawn('berserk_1', 'berserk'), spawn('haste_0', 'haste'), spawn('haste_1', 'haste')], state);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.text).toMatch(/^Berserk is/);
    expect(lines[1]!.text).toMatch(/^Haste is/);
    expect(lines.every((l) => l.kind === 'pickup')).toBe(true);
    expect(announcements([{ type: 'match_end', tick: 1, placements: [], ending: 'elimination' }], state)).toEqual([]);
  });

  // The shrine is not a capture point: players must see it heal. "Gary patched up at the shrine"
  // names who and how much, once per heal.
  it('announces a shrine heal with who and how much', () => {
    const [line, ...rest] = announcements([{ type: 'heal', tick: 700, fighterId: 'f0', amount: 86, pos: { x: 680, y: 430 }, shrineId: 'shrine' }], state);
    expect(rest).toEqual([]);
    expect(line).toMatchObject({ tick: 700, kind: 'heal', ids: ['f0'] });
    expect(line!.text).toContain('Gary');
    expect(line!.text).toContain('86');
    expect(line!.text).toMatch(/shrine/);
    expect(line!.text).toMatch(/\.$/);
    expect(announcements([{ type: 'heal', tick: 700, fighterId: 'f0', amount: 20, pos: { x: 0, y: 0 }, shrineId: null }], state)).toEqual([]);
  });

  // Strategy names come from strangers: a name is printed as written, never read as a pattern.
  it('prints names with $ patterns or holes literally in the shrine and judges lines', () => {
    const odd = { ...state, fighters: state.fighters.map((f, i) => (i === 0 ? { ...f, name: 'Cash$&Carry {a}' } : f)) };
    const [heal] = announcements([{ type: 'heal', tick: 700, fighterId: 'f0', amount: 86, pos: { x: 680, y: 430 }, shrineId: 'shrine' }], odd);
    expect(heal!.text).toContain('Cash$&Carry {a}');
    const [judged] = announcements([{ type: 'judges_decision', tick: 9000, survivors: [{ id: 'f0', hpFraction: 0.43, damageDealt: 212, kills: 2 }] }], odd);
    expect(judged!.text).toContain('Cash$&Carry {a}');
  });
});

