import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_LIMIT_TICKS, FIGHTER_COLORS } from '../core';
import type { GameEvent, MatchConfig, Strategy } from '../core';
import { stateHash } from '../sim';
import { HOUSE_STACKS, gatedBrainFactory } from '../strategy';
import { MatchSession, fillHoles, possessive, validatedConfig } from './session';

function config(seed: number, mapId = 'pit', n = 8): MatchConfig {
  return validatedConfig({
    seed, mapId, format: 'ffa', friendlyFire: true, timeLimitTicks: DEFAULT_TIME_LIMIT_TICKS, suddenDeath: true,
    entrants: HOUSE_STACKS.slice(0, n).map((strategy, i) => ({ id: `e${i}`, strategy, squad: i, name: strategy.name, color: FIGHTER_COLORS[i]! })),
  });
}

function playOut(s: MatchSession): GameEvent[] {
  const all: GameEvent[] = [];
  while (!s.over) for (const e of s.step()) all.push(e);
  return all;
}

describe('MatchSession determinism', () => {
  // Same config + seed must give the same match: seeking, replays and gym reports all rely on it.
  it('plays the same match twice from the same config, tick for tick', () => {
    for (const mapId of ['pit', 'catacombs']) {
      const a = new MatchSession(config(7, mapId), gatedBrainFactory);
      const b = new MatchSession(config(7, mapId), gatedBrainFactory);
      playOut(a);
      playOut(b);
      expect(a.tick).toBe(b.tick);
      expect(stateHash(a.state)).toBe(stateHash(b.state));
      expect(a.state.placements).toEqual(b.state.placements);
    }
  });

  it('plays a different match from a different seed (the seed really drives the fight)', () => {
    const a = new MatchSession(config(1), gatedBrainFactory);
    const b = new MatchSession(config(2), gatedBrainFactory);
    for (let i = 0; i < 600; i++) {
      a.step();
      b.step();
    }
    expect(stateHash(a.state)).not.toBe(stateHash(b.state));
  });
});

describe('MatchSession seeking', () => {
  // Scrubbing back on the timeline must show exactly the moment that was played, not a new fight.
  it('lands on the same state when seeking back as when the tick was first played', () => {
    const s = new MatchSession(config(11), gatedBrainFactory);
    while (s.tick < 1500) s.step();
    const at1500 = stateHash(s.state);
    while (s.tick < 3000 && !s.over) s.step();
    const { rebuilt } = s.seek(1500);
    expect(rebuilt).toBe(true);
    expect(s.tick).toBe(1500);
    expect(stateHash(s.state)).toBe(at1500);
  });

  it('keeps the feed and marks of the whole played stretch without duplicating them on replay', () => {
    const s = new MatchSession(config(3), gatedBrainFactory);
    playOut(s);
    const feed = s.feed.map((f) => `${f.tick}:${f.text}`);
    const marks = s.marks.length;
    const maxTick = s.maxTick;
    s.seek(Math.floor(maxTick / 2));
    expect(s.maxTick).toBe(maxTick);
    playOut(s);
    expect(s.feed.map((f) => `${f.tick}:${f.text}`)).toEqual(feed);
    expect(s.marks).toHaveLength(marks);
  });

  // fx paints persistent gore from the replayed events, so a seek must hand over every kill before the target.
  it('returns every event on the way so the floor gore can be repainted', () => {
    const s = new MatchSession(config(5), gatedBrainFactory);
    const played = playOut(s).filter((e) => e.type === 'kill');
    const target = played[Math.floor(played.length / 2)]!.tick;
    const { events } = s.seek(target);
    const replayed = events.filter((e) => e.type === 'kill');
    expect(replayed.length).toBe(played.filter((e) => e.tick <= target).length);
    expect(replayed.length).toBeGreaterThan(0);
  });

  it('steps forward without rebuilding when seeking ahead', () => {
    const s = new MatchSession(config(5), gatedBrainFactory);
    const match = s.match;
    const { rebuilt } = s.seek(300);
    expect(rebuilt).toBe(false);
    expect(s.match).toBe(match);
    expect(s.tick).toBe(300);
  });
});

describe('MatchSession broadcast', () => {
  it('writes one feed line and one timeline mark per kill, and names the winner at the end', () => {
    const s = new MatchSession(config(9), gatedBrainFactory);
    const kills = playOut(s).filter((e) => e.type === 'kill');
    expect(s.feed.filter((f) => f.kind === 'kill')).toHaveLength(kills.length);
    expect(s.marks.filter((m) => m.kind === 'kill')).toHaveLength(kills.length);
    const winner = s.state.fighters.find((f) => f.id === s.state.placements[0])!;
    const last = s.feed[s.feed.length - 1]!;
    expect(last.text).toContain(`${winner.name} takes the Pit`);
    expect(last.ids).toEqual([winner.id]);
  });

  // The kill feed links each line to its timeline mark by tick, kind and fighter ids (ui markForFeed).
  // A mark without such a line is unreachable from the feed; ammo off the floor is not news.
  it('marks power-ups taken and sudden death, each with a feed line the feed can link to', () => {
    let found: { s: MatchSession; events: GameEvent[] } | null = null;
    for (let seed = 1; seed <= 12 && !found; seed++) {
      const s = new MatchSession(config(seed), gatedBrainFactory);
      const events = playOut(s);
      const tookPowerUp = events.some((e) => e.type === 'pickup' && (e.kind === 'haste' || e.kind === 'berserk'));
      if (tookPowerUp && events.some((e) => e.type === 'sudden_death')) found = { s, events };
    }
    if (!found) throw new Error('No pit match in seeds 1-12 had both a power-up taken and sudden death; widen the search.');
    const { s, events } = found;

    const powerUps = events.filter((e) => e.type === 'pickup' && (e.kind === 'haste' || e.kind === 'berserk'));
    expect(s.marks.filter((m) => m.kind === 'pickup')).toHaveLength(powerUps.length);
    expect(s.marks.filter((m) => m.kind === 'sudden_death')).toHaveLength(1);

    for (const m of s.marks) {
      if (m.kind === 'big_hit') continue; // big hits are timeline-only by design
      const ids = [m.actorId, m.targetId].filter((id): id is string => id !== null);
      const line = s.feed.find((f) => f.tick === m.tick && f.kind === m.kind && (ids.length === 0 || ids.some((id) => f.ids.includes(id))));
      expect(line, `${m.kind} mark at tick ${m.tick} has no feed line`).toBeDefined();
    }
    const wall = s.marks.find((m) => m.kind === 'sudden_death')!;
    expect(s.feed.some((f) => f.tick === wall.tick && f.text === wall.text)).toBe(true);
    // Power-ups coming back are announced ("Berserk is up."), as the spec asks.
    expect(s.feed.some((f) => f.kind === 'pickup' && f.ids.length === 0 && / is (up|back)/.test(f.text))).toBe(true);
  });

  it('keeps the battle report of a finished match across a seek back', () => {
    const s = new MatchSession(config(9), gatedBrainFactory);
    playOut(s);
    const report = s.report;
    expect(report?.placements).toEqual(s.state.placements);
    s.seek(100);
    expect(s.report).toBe(report);
  });
});

describe('possessive', () => {
  // Fighters are named by their strategy: "Aunt Carol Finishes Things's leg" reads like a typo on air.
  it('adds only an apostrophe to names ending in s', () => {
    expect(possessive('Apologetic Gary')).toBe("Apologetic Gary's");
    expect(possessive('Aunt Carol Finishes Things')).toBe("Aunt Carol Finishes Things'");
  });
});

describe('validatedConfig', () => {
  // the brain gate throws on an invalid strategy; the player should hear which fighter is broken instead.
  it('refuses a match with an invalid strategy and names the fighter', () => {
    const bad = { ...HOUSE_STACKS[0]!, target: 'it.distnce' } as Strategy;
    const raw = config(1);
    const broken = { ...raw, entrants: raw.entrants.map((e, i) => (i === 2 ? { ...e, name: 'Broken Bob', strategy: bad } : e)) };
    expect(() => validatedConfig(broken)).toThrow(/Broken Bob/);
  });

  // The Watch screen must refuse exactly what the gym and the import dialog refuse: one gate. A
  // division that can hit zero passes the schema but fails the gate's static analysis.
  it('refuses what only the static analysis catches, like the import dialog does', () => {
    const base = HOUSE_STACKS[0]!;
    const [first] = Object.keys(base.behaviours);
    const risky = { ...base, behaviours: { ...base.behaviours, [first!]: { ...base.behaviours[first!]!, score: '1 / self.hp' } } } as Strategy;
    const raw = config(1);
    const entrants = raw.entrants.map((e, i) => (i === 0 ? { ...e, name: 'Risky Rita', strategy: risky } : e));
    expect(() => validatedConfig({ ...raw, entrants })).toThrow(/Risky Rita/);
  });
});

describe('fillHoles', () => {
  // Names come from strategies; "$&" in a replacement string would print the hole instead of the name.
  it('prints names with replacement patterns exactly as written', () => {
    const line = "{k} took {v's} leg. {v} is hopping now.";
    expect(fillHoles(line, { '{k}': 'Cash$&Carry', "{v's}": "Dollar$'s", '{v}': 'Dollar$1' })).toBe("Cash$&Carry took Dollar$'s leg. Dollar$1 is hopping now.");
  });

  it('fills the possessive hole before the plain one it starts with', () => {
    expect(fillHoles("{v's} arm, {v}", { "{v's}": "Gary's", '{v}': 'Gary' })).toBe("Gary's arm, Gary");
  });
});
