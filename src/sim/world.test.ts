import { describe, expect, it } from 'vitest';
import { JUDGES_ORDER, MATCH_RULES, PICKUP_RULES, TICK_HZ, matchHardCapTicks, zoneBoundsAfter } from '../core';
import type { GameEvent, Match, Rect } from '../core';
import { MAPS } from './maps';
import { createMatch } from './match';
import { scriptedBrains, stage, testConfig } from './testkit';

type Ev<T extends GameEvent['type']> = Extract<GameEvent, { type: T }>;
const of = <T extends GameEvent['type']>(events: GameEvent[], type: T) => events.filter((e): e is Ev<T> => e.type === type);

function runToEnd(m: Match, events: GameEvent[] = [], cap = 20000): GameEvent[] {
  while (!m.isOver && m.state.tick < cap) events.push(...m.step());
  return events;
}

/** Four still fighters inside the zone's final square, clear of the shrine (which would heal them). */
const ZONE_SQUAD = [
  { name: 'A', weapon: 'GREATSWORD' as const, pos: [610, 360] as [number, number], facing: 0 },
  { name: 'B', weapon: 'GREATSWORD' as const, pos: [750, 360] as [number, number], facing: 0 },
  { name: 'C', weapon: 'GREATSWORD' as const, pos: [610, 500] as [number, number], facing: 0 },
  { name: 'D', weapon: 'GREATSWORD' as const, pos: [750, 500] as [number, number], facing: 0 },
];

describe('sudden death', () => {
  // Hiding forever or getting stuck must not stall a match: 15 s without anyone hurting anyone
  // starts sudden death early.
  it('starts early on a stalemate', () => {
    const s = stage(ZONE_SQUAD.slice(0, 2), { timeLimitTicks: 5400 });
    s.run(MATCH_RULES.stalemateTicks + 5);
    const sd = of(s.events, 'sudden_death');
    expect(sd).toHaveLength(1);
    expect(sd[0]).toMatchObject({ tick: MATCH_RULES.stalemateTicks, reason: 'stalemate' });
    expect(s.match.state.suddenDeath).toMatchObject({ active: true, reason: 'stalemate', startedAtTick: MATCH_RULES.stalemateTicks });
  });

  it('has no stalemate start in matches without sudden death', () => {
    const s = stage(ZONE_SQUAD.slice(0, 2), { timeLimitTicks: 5400, suddenDeath: false });
    s.run(MATCH_RULES.stalemateTicks * 2);
    expect(of(s.events, 'sudden_death')).toHaveLength(0);
    expect(s.match.state.suddenDeath.active).toBe(false);
  });

  // Only fighters hurting fighters holds the stalemate off: a spike trap chewing on someone does not.
  it('counts fighter damage, not hazards, toward the stalemate', () => {
    const s = stage(
      [
        { name: 'Stabber', weapon: 'TWIN_DAGGERS', pos: [600, 196], facing: 0, script: { attack: true } },
        { name: 'Victim', weapon: 'GREATSWORD', pos: [650, 196], facing: 0, attributes: { vitality: 40 } },
        // Standing on the west spike trap: hurt every cycle, by nobody.
        { name: 'Spiked', weapon: 'GREATSWORD', pos: [96, 430], facing: 0, attributes: { vitality: 40 } },
      ],
      { timeLimitTicks: 5400 },
    );
    s.scripts.Stabber!.targetId = s.f('Victim').id;
    s.run(120);
    s.scripts.Stabber = { attack: false };
    while (of(s.events, 'sudden_death').length === 0 && s.match.state.tick < 3000) s.run(1);
    const fighterHits = of(s.events, 'hit').filter((h) => h.attackerId !== null && h.attackerId !== h.victimId);
    const hazardHits = of(s.events, 'hit').filter((h) => h.source === 'hazard');
    const lastFight = fighterHits[fighterHits.length - 1]!.tick;
    const sd = of(s.events, 'sudden_death')[0]!;
    expect(hazardHits.some((h) => h.tick > lastFight)).toBe(true);
    expect(sd.reason).toBe('stalemate');
    expect(sd.tick).toBe(lastFight + MATCH_RULES.stalemateTicks);
  });

  // Every match ends in deaths: once the wall stops, the damage climbs every second, first outside
  // the zone and soon everywhere, announced level by level.
  it('escalates after the wall stops, outside first and then everywhere', () => {
    const s = stage(ZONE_SQUAD.slice(0, 3), { timeLimitTicks: 60 });
    const events = runToEnd(s.match, s.events);
    const z = s.match.state.suddenDeath;
    expect(z.closedAtTick).toBeGreaterThan(0);
    expect(z.bounds).toEqual(z.final);
    const esc = of(events, 'escalation');
    expect(esc.length).toBeGreaterThan(5);
    esc.forEach((e, i) => {
      expect(e.level).toBe(i + 1);
      expect(e.tick).toBe(z.closedAtTick + i * MATCH_RULES.escalationStepTicks);
      expect(e.damage).toBe(MATCH_RULES.suddenDeathDamage + MATCH_RULES.escalationDamage * e.level);
      expect(e.everywhere).toBe(i * MATCH_RULES.escalationStepTicks >= MATCH_RULES.escalationEverywhereTicks);
    });
    // Inside the zone nobody is hurt until the ramp reaches everywhere; then by escalationDamage x level.
    const everywhereAt = esc.find((e) => e.everywhere)!.tick;
    const wallHits = of(events, 'hit').filter((h) => h.source === 'sudden_death');
    expect(wallHits.length).toBeGreaterThan(0);
    for (const h of wallHits) {
      expect(h.tick).toBeGreaterThanOrEqual(everywhereAt);
      const level = esc.filter((e) => e.tick <= h.tick).length;
      expect(h.amount).toBeLessThanOrEqual(MATCH_RULES.escalationDamage * level);
    }
    expect(s.match.state.ending).toBe('elimination');
    expect(s.match.state.tick).toBeLessThan(matchHardCapTicks(60));
  });

  // The floor's warning band shows where the wall will be in 3 s: it must be where the wall gets to.
  it('warns where the wall will be warningTicks ahead', () => {
    const s = stage(ZONE_SQUAD.slice(0, 2), { timeLimitTicks: 60 });
    const z = s.match.state.suddenDeath;
    expect(z.warning).toEqual(z.bounds);
    expect(z.bounds).toEqual({ x: 0, y: 0, w: s.match.map.width, h: s.match.map.height });
    s.run(200);
    const promised: Rect = { ...z.warning };
    expect(promised.w).toBeLessThan(z.bounds.w);
    expect(zoneBoundsAfter(z, MATCH_RULES.warningTicks, { x: 0, y: 0, w: 0, h: 0 })).toEqual(promised);
    s.run(MATCH_RULES.warningTicks);
    expect(z.bounds).toEqual(promised);
  });

  // The absolute cap: anyone still standing at time limit + 60 s is placed by the judges (HP share,
  // then damage dealt, then kills; full ties keep roster order), and it is announced, never silent.
  it('ends with a judges\' decision at the hard cap', () => {
    const s = stage(ZONE_SQUAD, { timeLimitTicks: 60 });
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((n) => s.f(n));
    for (const f of [a!, b!, c!, d!]) f.maxHp = f.hp = 1e7;
    a!.hp = d!.hp = 0.5e7;
    b!.hp = c!.hp = 0.9e7;
    c!.damageDealt = 50;
    const events = runToEnd(s.match, s.events);
    const cap = matchHardCapTicks(60);
    expect(s.match.state.tick).toBe(cap);
    const judged = of(events, 'judges_decision');
    expect(judged).toHaveLength(1);
    expect(judged[0]!.tick).toBe(cap);
    expect(judged[0]!.survivors.map((x) => x.id)).toEqual([c!.id, b!.id, a!.id, d!.id]);
    expect(judged[0]!.survivors[0]).toMatchObject({ damageDealt: 50, kills: 0 });
    expect(JUDGES_ORDER[0]).toBe('hp_fraction');
    const end = of(events, 'match_end')[0]!;
    expect(end).toMatchObject({ tick: cap, ending: 'judges', placements: [c!.id, b!.id, a!.id, d!.id] });
    expect(events.indexOf(judged[0]!)).toBeLessThan(events.indexOf(end));
    expect(s.match.result().ending).toBe('judges');
  });

  // The gym's safety stop reads results mid-match; such a result must say so, never pass as a real ending.
  it('reports a match read before its end as capped', () => {
    const m = createMatch(testConfig({ seed: 1, fighters: 2 }), scriptedBrains({}));
    m.step();
    expect(m.state.ending).toBeNull();
    expect(m.result().ending).toBe('capped');
  });
});

describe('power-ups', () => {
  // Pedestals start empty and fill after firstSpawnTicks, each appearance announced, so the ring
  // and the announcer can tell players when to go for one.
  it('appear after firstSpawnTicks, announced with pickup_spawn', () => {
    const s = stage(ZONE_SQUAD.slice(0, 2));
    const pk = s.match.state.pickups;
    expect(pk.length).toBeGreaterThan(0);
    for (const p of pk) expect(p.cooldown).toBe(PICKUP_RULES[p.kind].firstSpawnTicks);
    s.run(6);
    const world = s.lastView('A').world;
    const haste = world.nearestPickup({ x: 0, y: 0 }, 'haste')!;
    expect(haste).toMatchObject({ kind: 'haste', ready: false });
    expect(haste.respawnIn).toBeCloseTo((PICKUP_RULES.haste.firstSpawnTicks - 6) / TICK_HZ, 6);
    s.run(PICKUP_RULES.haste.firstSpawnTicks);
    const spawns = of(s.events, 'pickup_spawn');
    expect(spawns.map((e) => e.pickupId).sort()).toEqual(pk.map((p) => p.id).sort());
    for (const e of spawns) expect(e.tick).toBe(PICKUP_RULES[e.kind].firstSpawnTicks);
    expect(world.nearestPickup({ x: 0, y: 0 }, 'any')).toMatchObject({ ready: true, respawnIn: 0 });
  });

  // Taking one starts the respawn timer; it comes back after cooldownTicks, announced again.
  it('is taken by touch, buffs the taker and respawns after cooldownTicks', () => {
    const spot = MAPS.pit!.pickups.find((p) => p.kind === 'haste')!.pos;
    const s = stage([
      { name: 'Grabber', weapon: 'TWIN_DAGGERS', pos: [spot.x, spot.y], facing: 0 },
      { name: 'Parked', weapon: 'GREATSWORD', pos: [680, 600], facing: 0 },
    ]);
    const first = PICKUP_RULES.haste.firstSpawnTicks;
    s.run(first + 1);
    const took = of(s.events, 'pickup').filter((p) => p.kind === 'haste');
    expect(took).toHaveLength(1);
    expect(took[0]!.tick).toBe(first + 1);
    expect(s.f('Grabber').buffs.haste).toBe(PICKUP_RULES.haste.durationTicks);
    const pedestal = s.match.state.pickups.find((p) => p.pos.x === spot.x && p.pos.y === spot.y)!;
    expect(pedestal.cooldown).toBe(PICKUP_RULES.haste.cooldownTicks);
    s.run(PICKUP_RULES.haste.cooldownTicks);
    const again = of(s.events, 'pickup_spawn').filter((e) => e.pickupId === pedestal.id);
    expect(again.map((e) => e.tick)).toEqual([first, first + 1 + PICKUP_RULES.haste.cooldownTicks]);
  });
});
