import { describe, expect, it } from 'vitest';
import { MATCH_RULES, Rng, TICK_HZ, angleDiff, angleTo } from '../core';
import type { KnownFighter, PerceptionView, Strategy, Vec2 } from '../core';
import { requireValidStrategy } from '../strategy';
import { createBrain } from './brain';
import { compilePlace, compileZone } from './compile';
import { prepareContext } from './ctx';
import type { ThinkCtx } from './ctx';
import { SENSORS, SENSOR_INDEX, parseRange, sensorRange } from './registry';
import type { PlaceOut } from './registry';
import { closingZone, enemy, fakeWorld, fighter, randomView, view } from './test-world';
import { STEERING } from './tuning';

const ATTRS = { vitality: 17, power: 17, agility: 17, perception: 17, armor: 16, haste: 16 };

function ctxFor(v: PerceptionView, target: KnownFighter | null = v.known[0] ?? null): ThinkCtx {
  const c = prepareContext(null, v, {}, null);
  c.target = target;
  return c;
}

function sensor(c: ThinkCtx, name: string): number {
  const i = SENSOR_INDEX.get(name);
  if (i === undefined) throw new Error(`no sensor ${name}`);
  return SENSORS[i]!.get(c);
}

function place(c: ThinkCtx, src: string): PlaceOut | null {
  const out: PlaceOut = { x: 0, y: 0, fighter: null };
  return compilePlace(src)(c, out) ? out : null;
}

function strat(behaviour: Strategy['behaviours'][string], weapon: Strategy['build']['weapon'] = 'GREATSWORD'): Strategy {
  return { schema: 'pit-strategy/2', name: 'T', build: { weapon, skill: 'DASH', attributes: ATTRS }, target: '0 - it.distance', behaviours: { b: behaviour }, commit: 0 };
}

function headingTo(d: { heading: number }, from: Vec2, to: Vec2): number {
  return Math.abs(angleDiff(d.heading, angleTo(from, to)));
}

describe('fog of war vocabulary', () => {
  // The heard record's estimate sits 90 px off where it was last seen; the truth is unknown to the brain.
  const heard = (over: Partial<KnownFighter> = {}) => enemy('h', { pos: { x: 600, y: 390 }, lastSeenPos: { x: 600, y: 300 }, seen: false, heard: true, estimateError: 80, lastSeenTick: 120, ...over });

  it('target.distance is the distance to where you think it is, and the visibility sensors say how good that is', () => {
    const c = ctxFor(view(fighter(), [heard()], fakeWorld(), { tick: 300 }));
    expect(sensor(c, 'target.distance')).toBeCloseTo(Math.hypot(300, 90), 6);
    expect(sensor(c, 'target.visible')).toBe(0);
    expect(sensor(c, 'target.heard')).toBe(1);
    expect(sensor(c, 'target.last_seen_age')).toBeCloseTo(180 / TICK_HZ, 6);
    expect(sensor(c, 'target.since_seen')).toBe(180);
    // Only ever heard: no sighting to date, so the age reads its "never" value.
    const never = ctxFor(view(fighter(), [heard({ lastSeenTick: -1 })], fakeWorld(), { tick: 300 }));
    expect(sensor(never, 'target.last_seen_age')).toBe(STEERING.farSeconds);
    const seen = ctxFor(view(fighter(), [enemy('s', { lastSeenTick: 300 })], fakeWorld(), { tick: 300 }));
    expect([sensor(seen, 'target.visible'), sensor(seen, 'target.heard'), sensor(seen, 'target.last_seen_age')]).toEqual([1, 0, 0]);
  });

  // The sim refuses a shot at a target out of sight; a brain that thought it could shoot would
  // stand there winding up at a wall forever.
  it('a shot needs the target in sight; a melee swing may go at one it only hears', () => {
    const bow = (t: KnownFighter) => createBrain(requireValidStrategy(strat({ score: '1', move: [], attack: 'in_range' }, 'LONGBOW')))
      .think(view(fighter({ weapon: 'LONGBOW', ammo: 10 }), [t], fakeWorld(), { tick: 300 }), new Rng(1));
    expect(bow(heard()).attack).toBe(false);
    expect(bow(heard()).sensors['target.in_reach']).toBe(0);
    expect(bow(enemy('s', { pos: { x: 600, y: 390 } })).attack).toBe(true);
    const sword = createBrain(requireValidStrategy(strat({ score: '1', move: [], attack: 'in_range' })))
      .think(view(fighter(), [heard({ pos: { x: 380, y: 300 } })], fakeWorld(), { tick: 300 }), new Rng(1));
    expect(sword.attack).toBe(true);
  });

  it('seek leads a target in sight but not one it only hears (its velocity is stale)', () => {
    const s = requireValidStrategy(strat({ score: '1', move: [{ seek: 'target', weight: 1 }], attack: 'never' }));
    const vel = { x: 0, y: 3 };
    const me = fighter();
    const led = createBrain(s).think(view(me, [enemy('s', { pos: { x: 600, y: 300 }, vel })], fakeWorld()), new Rng(1));
    const flat = createBrain(s).think(view(me, [heard({ pos: { x: 600, y: 300 }, vel })], fakeWorld(), { tick: 300 }), new Rng(1));
    expect(headingTo(flat, me.pos, { x: 600, y: 300 })).toBeLessThan(0.05);
    expect(led.heading).toBeGreaterThan(0.15);
  });

  it('last_seen(target) is where it was last seen, or the estimate when it was never seen', () => {
    const c = ctxFor(view(fighter(), [heard()], fakeWorld(), { tick: 300 }));
    expect(place(c, 'last_seen(target)')).toMatchObject({ x: 600, y: 300 });
    const never = ctxFor(view(fighter(), [heard({ lastSeenTick: -1 })], fakeWorld(), { tick: 300 }));
    expect(place(never, 'last_seen(target)')).toMatchObject({ x: 600, y: 390 });
  });

  // A lost target must be hunted, not stared at: the search point starts where it was last
  // known and sweeps outward over time instead of parking the fighter on one spot.
  it('search_point starts on the last known spot, widens and turns with time, and stays in the arena', () => {
    const lost = (tick: number, over: Partial<KnownFighter> = {}) =>
      enemy('l', { pos: { x: 600, y: 300 }, lastSeenPos: { x: 600, y: 300 }, vel: { x: 1, y: 0 }, seen: false, heard: false, lastSeenTick: 300, ...over });
    const at = (tick: number, over: Partial<KnownFighter> = {}) => place(ctxFor(view(fighter(), [lost(tick, over)], fakeWorld(), { tick })), 'search_point')!;
    expect(at(300)).toMatchObject({ x: 600, y: 300 });
    const r = (p: PlaceOut) => Math.hypot(p.x - 600, p.y - 300);
    expect(r(at(360))).toBeCloseTo(STEERING.searchGrowth, 6);
    expect(r(at(600))).toBeCloseTo(Math.min(STEERING.searchMax, STEERING.searchGrowth * 5), 6);
    // It starts on the side the target was heading (east) and then turns.
    expect(at(360).x).toBeGreaterThan(600);
    expect(Math.atan2(at(480).y - 300, at(480).x - 600)).toBeCloseTo(STEERING.searchSpin * 3, 6);
    // Near the map edge the sweep is kept inside the playable area.
    const edge = at(900, { pos: { x: 990, y: 300 }, lastSeenPos: { x: 990, y: 300 } });
    expect(edge.x).toBeLessThanOrEqual(1000 - STEERING.searchMargin);
    // A target in sight is simply the target (a fighter place: seek leads it and stops at touching).
    const c = ctxFor(view(fighter(), [enemy('s', { pos: { x: 640, y: 320 } })], fakeWorld()));
    expect(place(c, 'search_point')).toMatchObject({ x: 640, y: 320 });
    expect(place(c, 'search_point')!.fighter).not.toBeNull();
    // Heard but not seen: go where it is heard (the estimate moves with the real fighter, roughly).
    const h = ctxFor(view(fighter(), [lost(400, { heard: true, pos: { x: 700, y: 350 } })], fakeWorld(), { tick: 400 }));
    expect(place(h, 'search_point')).toMatchObject({ x: 700, y: 350, fighter: null });
    expect(place(ctxFor(view(fighter(), [], fakeWorld()), null), 'search_point')).toBeNull();
  });
});

describe('power-up vocabulary', () => {
  const pedestals = (list: { kind: 'haste' | 'berserk'; x: number; ready: boolean; respawnIn?: number }[]) =>
    fakeWorld({ pickups: list.map((p, i) => ({ id: `p${i}`, kind: p.kind, pos: { x: p.x, y: 300 }, ready: p.ready, respawnIn: p.ready ? 0 : p.respawnIn ?? 5 })) });

  // Going for a pedestal that is empty while another power-up waits is a wasted trip.
  it('nearest_pickup goes for a power-up that is there before a nearer empty pedestal', () => {
    const c = ctxFor(view(fighter(), [], pedestals([{ kind: 'haste', x: 400, ready: false }, { kind: 'berserk', x: 800, ready: true }])));
    expect(place(c, 'nearest_pickup')).toMatchObject({ x: 800 });
    expect([sensor(c, 'pickup.any.ready'), sensor(c, 'pickup.any.distance'), sensor(c, 'pickup.respawn_in')]).toEqual([1, 500, 0]);
    // pickup(kind) is the nearest pedestal of that kind, ready or not.
    expect(place(c, 'pickup(haste)')).toMatchObject({ x: 400 });
    expect([sensor(c, 'pickup.haste.ready'), sensor(c, 'pickup.haste.distance')]).toEqual([0, 100]);
    expect([sensor(c, 'pickup.berserk.ready'), sensor(c, 'pickup.berserk.distance')]).toEqual([1, 500]);
  });

  it('with nothing on a pedestal, nearest_pickup is the one back soonest (for camping it)', () => {
    const c = ctxFor(view(fighter(), [], pedestals([{ kind: 'haste', x: 400, ready: false, respawnIn: 7 }, { kind: 'berserk', x: 800, ready: false, respawnIn: 2 }])));
    expect(place(c, 'nearest_pickup')).toMatchObject({ x: 800 });
    expect(sensor(c, 'pickup.any.ready')).toBe(0);
    expect(sensor(c, 'pickup.respawn_in')).toBe(2);
  });

  it('reads "none" on a map without pedestals', () => {
    const c = ctxFor(view(fighter(), [], fakeWorld()));
    expect(sensor(c, 'pickup.any.distance')).toBe(STEERING.far);
    expect(sensor(c, 'pickup.respawn_in')).toBe(STEERING.farSeconds);
    expect(sensor(c, 'pickup.haste.ready')).toBe(0);
    expect(place(c, 'nearest_pickup')).toBeNull();
  });
});

describe('sudden-death vocabulary', () => {
  const world = fakeWorld();
  const map = world.map;

  it('reads "no wall coming" before sudden death, and outside_zone is empty', () => {
    const c = ctxFor(view(fighter({ pos: { x: 30, y: 30 } }), [], world));
    expect(sensor(c, 'zone.distance')).toBe(STEERING.far);
    expect(sensor(c, 'zone.time_to_reach')).toBe(STEERING.farSeconds);
    expect(compileZone('outside_zone')(c, 5, 5)).toBe(0);
  });

  it('measures the closing wall: signed distance, seconds until it arrives, the last safe square', () => {
    const zone = closingZone(map, 100);
    const at = (p: Vec2) => ctxFor(view(fighter({ pos: p }), [], world, { zone, arena: zone.bounds, suddenDeath: true }));
    expect(sensor(at({ x: 160, y: 400 }), 'zone.distance')).toBeCloseTo(60, 6);
    expect(sensor(at({ x: 60, y: 400 }), 'zone.distance')).toBeCloseTo(-40, 6);
    // 60 px of wall travel at the inset speed.
    expect(sensor(at({ x: 160, y: 400 }), 'zone.time_to_reach')).toBeCloseTo(60 / MATCH_RULES.suddenDeathInsetPerTick / TICK_HZ, 6);
    expect(sensor(at({ x: 60, y: 400 }), 'zone.time_to_reach')).toBe(0);
    // Inside the square where the wall stops, it never arrives.
    expect(sensor(at({ x: 500, y: 400 }), 'zone.time_to_reach')).toBe(STEERING.farSeconds);
    expect(place(at({ x: 160, y: 400 }), 'zone_centre')).toMatchObject({ x: 500, y: 400 });
  });

  it('outside_zone covers outside the wall and the strip it reaches in 3 s, fading inside', () => {
    const zone = closingZone(map, 100);
    const c = ctxFor(view(fighter(), [], world, { zone, arena: zone.bounds, suddenDeath: true }));
    const z = compileZone('outside_zone');
    const strip = MATCH_RULES.warningTicks * MATCH_RULES.suddenDeathInsetPerTick;
    expect(z(c, 50, 400)).toBe(1);
    expect(z(c, 100 + strip / 2, 400)).toBe(1);
    expect(z(c, 100 + strip + STEERING.zoneFade / 2, 400)).toBeCloseTo(0.5, 6);
    expect(z(c, 500, 400)).toBe(0);
  });

  // In sudden death a corner by the wall is a death trap: the place must not send anyone there.
  it('corner skips spots the wall reaches within 3 s', () => {
    const walled = fakeWorld({ walls: [{ x: 0, y: 0, w: 1000, h: 20 }, { x: 0, y: 780, w: 1000, h: 20 }, { x: 0, y: 0, w: 20, h: 800 }, { x: 980, y: 0, w: 20, h: 800 }] });
    const quiet = ctxFor(view(fighter(), [], walled));
    const before = place(quiet, 'corner')!;
    expect(before.x).toBeLessThan(100);
    const zone = closingZone(walled.map, 20);
    const late = ctxFor(view(fighter(), [], walled, { zone, arena: zone.bounds, suddenDeath: true }));
    // Every corner of a bare box is within 3 s of a wall 20 px in, so there is none to go to.
    expect(place(late, 'corner')).toBeNull();
    // Once the wall has stopped, the warning strip is gone and corners count again.
    const closed = closingZone(walled.map, 20, { closedAtTick: 0 });
    expect(place(ctxFor(view(fighter(), [], walled, { zone: closed, arena: closed.bounds, suddenDeath: true })), 'corner')).not.toBeNull();
  });
});

describe('sensor ranges', () => {
  it('every sensor declares a range the validator can read', () => {
    for (const s of SENSORS) expect(parseRange(s.range), s.name).not.toBeNull();
  });

  // The validator proves things from these ranges (no division by zero, scores in bounds); a
  // sensor reading outside its declared range would make those proofs wrong. The brain clamps as a
  // backstop, but the declared ranges must be honest about real values.
  it('raw sensor values stay inside the declared ranges across thousands of random moments', () => {
    const rng = new Rng(2024);
    const outside: string[] = [];
    for (let n = 0; n < 800; n++) {
      const v = randomView(rng);
      const c = ctxFor(v, v.known.length ? rng.pick(v.known) : null);
      c.it = v.known.length ? rng.pick(v.known) : null;
      c.random = rng.next();
      for (let i = 0; i < SENSORS.length; i++) {
        const r = sensorRange(i, null);
        const x = SENSORS[i]!.get(c);
        if (!(x >= r.lo && x <= r.hi)) outside.push(`${SENSORS[i]!.name}=${x}`);
      }
    }
    expect(outside.slice(0, 10)).toEqual([]);
  });

  it('a build narrows the sensors it decides, and the brain reads them inside that', () => {
    const melee = { weapon: 'GREATSWORD' as const, attributes: ATTRS };
    const bow = { weapon: 'LONGBOW' as const, attributes: ATTRS };
    const range = (name: string, b: typeof melee | typeof bow) => sensorRange(SENSOR_INDEX.get(name)!, b);
    expect(range('self.ranged', melee)).toEqual({ lo: 0, hi: 0 });
    expect(range('self.ranged', bow)).toEqual({ lo: 1, hi: 1 });
    expect(range('self.ammo', bow)).toEqual({ lo: 0, hi: 10 });
    expect(range('self.ammo', melee)).toEqual({ lo: 99, hi: 99 });
    // A view that breaks the build (more arrows than a quiver holds) still reads inside the range.
    const d = createBrain(requireValidStrategy(strat({ score: '1', move: [], attack: 'never' }, 'LONGBOW')))
      .think(view(fighter({ weapon: 'LONGBOW', ammo: 40 }), [], fakeWorld()), new Rng(1));
    expect(d.sensors['self.ammo']).toBe(10);
  });

});
