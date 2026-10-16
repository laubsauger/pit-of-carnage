import { describe, expect, it } from 'vitest';
import { JUDGES_ORDER, MATCH_RULES, PICKUP_RULES, SKILL_IDS, STEER_DIRS, TICK_HZ, matchHardCapTicks, zoneBoundsAfter } from '../core';
import type { BrainFactory, FighterState, GameEvent, Match, Rect } from '../core';
import { MAPS } from './maps';
import { createMatch } from './match';
import { scriptedBrains, seekerBrain, stage, testConfig } from './testkit';

type Ev<T extends GameEvent['type']> = Extract<GameEvent, { type: T }>;
const of = <T extends GameEvent['type']>(events: GameEvent[], type: T) => events.filter((e): e is Ev<T> => e.type === type);

function runToEnd(m: Match, events: GameEvent[] = [], cap = 20000): GameEvent[] {
  while (!m.isOver && m.state.tick < cap) events.push(...m.step());
  return events;
}

/**
 * Four still fighters whose bodies sit wholly inside the zone's final square (590-770 x 340-520 on
 * the pit), so the solid wall never touches them, clear of the shrine (which would heal them).
 */
const ZONE_SQUAD = [
  { name: 'A', weapon: 'GREATSWORD' as const, pos: [620, 370] as [number, number], facing: 0 },
  { name: 'B', weapon: 'GREATSWORD' as const, pos: [740, 370] as [number, number], facing: 0 },
  { name: 'C', weapon: 'GREATSWORD' as const, pos: [620, 490] as [number, number], facing: 0 },
  { name: 'D', weapon: 'GREATSWORD' as const, pos: [740, 490] as [number, number], facing: 0 },
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

/** Brains that walk straight away from the centre forever: they lean on the wall as hard as anyone can. */
const wallHuggers: BrainFactory = () => ({
  memory: {},
  think: (view) => ({
    behaviour: 'hug',
    scores: {},
    targetId: null,
    heading: Math.atan2(view.self.pos.y - view.world.map.height / 2, view.self.pos.x - view.world.map.width / 2),
    speed: 1,
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

/** Does any part of the body stick out past the face of rectangle b? */
function bodyOutside(f: FighterState, b: Rect): boolean {
  const eps = 1e-6;
  return f.pos.x - f.radius < b.x - eps || f.pos.x + f.radius > b.x + b.w + eps || f.pos.y - f.radius < b.y - eps || f.pos.y + f.radius > b.y + b.h + eps;
}

describe('the closing wall is solid', () => {
  // SPEC: nobody can ever end up outside the wall. Whole matches on every map, with fighters who
  // brawl (knockback, kegs, skills incl. dashes and shadowsteps) and fighters who lean on the wall.
  // Spent ammo the wall reaches is swept along, never buried behind it.
  it('after sudden death starts, no living fighter is outside the bounds for more than one tick', () => {
    let contacts = 0;
    let checkedTicks = 0;
    let stuckChecked = 0;
    for (const mapId of Object.keys(MAPS)) {
      const runs: [string, Match][] = [];
      for (const seed of [1, 2]) {
        const config = testConfig({ seed, mapId, fighters: 8, timeLimitTicks: 400 });
        config.entrants.forEach((e, i) => (e.strategy.build.skill = SKILL_IDS[i % SKILL_IDS.length]!));
        runs.push([`brawl ${mapId} seed ${seed}`, createMatch(config, seekerBrain)]);
      }
      runs.push([`huggers ${mapId}`, createMatch(testConfig({ seed: 7, mapId, fighters: 8, timeLimitTicks: 300 }), wallHuggers)]);
      for (const [label, m] of runs) {
        const outsideFor = new Map<string, number>();
        while (!m.isOver && m.state.tick < 20000) {
          for (const e of m.step()) if (e.type === 'wall_contact') contacts++;
          const z = m.state.suddenDeath;
          if (!z.active) continue;
          checkedTicks++;
          for (const f of m.state.fighters) {
            if (!f.alive) continue;
            const n = bodyOutside(f, z.bounds) ? (outsideFor.get(f.id) ?? 0) + 1 : 0;
            outsideFor.set(f.id, n);
            expect(n, `${label}: ${f.name} outside the wall for ${n} ticks at tick ${m.state.tick}`).toBeLessThanOrEqual(1);
          }
          for (const it of m.state.floor) {
            const inside = it.pos.x >= z.bounds.x && it.pos.x <= z.bounds.x + z.bounds.w && it.pos.y >= z.bounds.y && it.pos.y <= z.bounds.y + z.bounds.h;
            expect(inside, `${label}: floor item ${it.id} left behind the wall at tick ${m.state.tick}`).toBe(true);
          }
          // Arrows and axes stuck in walls and props are knocked out as the wall passes their pickup point.
          for (const st of m.state.stuck) {
            const q = st.pickupPos;
            if (!q) continue;
            stuckChecked++;
            const inside = q.x >= z.bounds.x && q.x <= z.bounds.x + z.bounds.w && q.y >= z.bounds.y && q.y <= z.bounds.y + z.bounds.h;
            expect(inside, `${label}: stuck ${st.kind} ${st.id} left behind the wall at tick ${m.state.tick}`).toBe(true);
          }
        }
        expect(m.isOver, `${label} did not finish within the tick cap`).toBe(true);
      }
    }
    // Enough sudden death to mean something (matches got shorter with the pass-3 balance: the
    // shrine recharges far slower, so fewer fighters stall into the wall).
    expect(checkedTicks).toBeGreaterThan(6000);
    expect(contacts).toBeGreaterThan(1000);
    expect(stuckChecked, 'no stuck ammo was ever reachable in sudden death: the invariant above checked nothing').toBeGreaterThan(0);
  });

  // Impenetrable: push, push, push. A fighter who just stands there is shoved back in every time
  // the advancing wall reaches it, and the spikes bite on every tick of contact. The contact is
  // reported at the wall's face (where the sparks fly), and the same damage arrives as a hit from
  // nobody, so HP, reports and the feed see it.
  it('shoves a fighter standing still back in on every tick of contact, and the spikes bite', () => {
    const s = stage([
      { name: 'Still', weapon: 'GREATSWORD', pos: [500, 60], facing: 0 },
      { name: 'Parked', weapon: 'GREATSWORD', pos: [620, 370], facing: 0 },
    ], { timeLimitTicks: 30 });
    const still = s.f('Still');
    s.run(400);
    const z = s.match.state.suddenDeath;
    const contacts = of(s.events, 'wall_contact');
    expect(contacts.length).toBeGreaterThanOrEqual(3);
    for (const c of contacts) {
      expect(c.fighterId).toBe(still.id);
      // On the top wall's face as it stood that tick, straight above the fighter.
      expect(c.pos.y).toBeCloseTo(24 + (c.tick - z.startedAtTick) * MATCH_RULES.suddenDeathInsetPerTick, 6);
      expect(c.pos.x).toBeCloseTo(500, 0);
      expect(c.damage).toBe(MATCH_RULES.wallContactDamage);
      const hit = of(s.events, 'hit').find((h) => h.tick === c.tick && h.victimId === still.id)!;
      expect(hit).toMatchObject({ attackerId: null, source: 'sudden_death', amount: c.damage, knockback: MATCH_RULES.wallPushKnockback });
      expect(hit.dir).toBeCloseTo(Math.PI / 2, 6); // straight back in (down, away from the top wall)
    }
    // Pushed, then caught again: separate contacts, not one long grind.
    const gaps = contacts.slice(1).map((c, i) => c.tick - contacts[i]!.tick);
    expect(gaps.filter((g) => g > 5).length).toBeGreaterThanOrEqual(2);
    // Driven ahead of the wall without ever being inside it, and never crushed in the open.
    expect(still.pos.y).toBeGreaterThan(60 + 50);
    expect(bodyOutside(still, z.bounds)).toBe(false);
    expect(still.damageTaken).toBe(contacts.length * MATCH_RULES.wallContactDamage);
    expect(s.f('Parked').damageTaken).toBe(0);
  });

  // A fighter who walks into the wall gets bounced back in, again and again, and pays for each touch.
  it('bounces a fighter who keeps walking into it', () => {
    const s = stage([
      { name: 'Walker', weapon: 'TWIN_DAGGERS', pos: [500, 120], facing: -Math.PI / 2, script: { heading: -Math.PI / 2, speed: 1 } },
      { name: 'Parked', weapon: 'GREATSWORD', pos: [620, 370], facing: 0 },
    ], { timeLimitTicks: 30 });
    const walker = s.f('Walker');
    let deepest = 0;
    for (let i = 0; i < 300; i++) {
      s.run(1);
      deepest = Math.min(deepest, walker.pos.y - walker.radius - s.match.state.suddenDeath.bounds.y);
    }
    expect(deepest).toBeGreaterThanOrEqual(-1e-6);
    const contacts = of(s.events, 'wall_contact').filter((c) => c.fighterId === walker.id);
    expect(contacts.length).toBeGreaterThanOrEqual(10);
    expect(walker.damageTaken).toBe(contacts.length * MATCH_RULES.wallContactDamage);
  });

  // Caught between the wall and a pillar there is nowhere to go: CRUSHED. Big damage every tick it
  // holds, a kill by nobody with cause sudden_death, the `crushed` flag and the CRUSHED stamp.
  it('crushes a fighter it pins against a pillar', () => {
    // The pit's east pillar spans x 888-934, y 471-517; the right wall comes in from x 1336.
    const s = stage([
      { name: 'Pinned', weapon: 'GREATSWORD', pos: [956, 494], facing: 0 },
      { name: 'Parked', weapon: 'GREATSWORD', pos: [620, 370], facing: 0 },
    ], { timeLimitTicks: 30 });
    const pinned = s.f('Pinned');
    while (pinned.alive && s.match.state.tick < 3000) {
      s.run(1);
      // Pinned into the pillar, but never through the wall.
      if (pinned.alive) expect(bodyOutside(pinned, s.match.state.suddenDeath.bounds), `outside at tick ${s.match.state.tick}`).toBe(false);
    }
    expect(pinned.alive, 'the wall never crushed the pinned fighter within 3000 ticks').toBe(false);
    const kill = of(s.events, 'kill').find((k) => k.victimId === pinned.id)!;
    expect(kill).toMatchObject({ killerId: null, cause: 'sudden_death', title: 'CRUSHED' });
    expect(kill.flags).toContain('crushed');
    const crushes = of(s.events, 'wall_contact').filter((c) => c.damage > MATCH_RULES.wallContactDamage);
    expect(crushes.length).toBeGreaterThan(0);
    expect(crushes[0]!.damage).toBe(MATCH_RULES.wallContactDamage + MATCH_RULES.wallCrushDamage);
    // Pinned means pinned: it died against the pillar's face, not somewhere it slid off to.
    expect(pinned.pos.x).toBeGreaterThan(934);
    expect(pinned.pos.x).toBeLessThan(934 + pinned.radius);
    expect(s.f('Parked').damageTaken).toBe(0);
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
