import { describe, expect, it } from 'vitest';
import { Rng, SKILL_IDS, STEER_DIRS, WEAPONS, WEAPON_IDS, angleDiff, angleTo, steerAngle } from '../core';
import type { Decision, KnownFighter, PerceptionView, PickupInfo, Strategy, Vec2, WorldQuery } from '../core';
import { createBrain as createValidBrain } from '../brain';
import { closingZone, enemy, fakeWorld, fighter, view } from '../brain/test-world';
import { HOUSE_NOTES, HOUSE_STACKS } from './house';
import { mergeBehaviours } from './library';
import { requireValidStrategy } from './load';
import { validateStrategy } from './validate';

/** House stacks reach brains through the gate, as in the game. */
const createBrain = (s: Strategy) => createValidBrain(requireValidStrategy(s, 'house'));

function stack(name: string): Strategy {
  const s = HOUSE_STACKS.find((h) => h.name === name);
  if (!s) throw new Error(`no house stack ${name}`);
  return s;
}

function me(s: Strategy, over: Parameters<typeof fighter>[0] = {}) {
  const w = s.build.weapon;
  return fighter({ weapon: w, skill: s.build.skill, attributes: s.build.attributes, ammo: WEAPONS[w].ammo, maxAmmo: WEAPONS[w].ammo, ...over });
}

function think(s: Strategy, v: PerceptionView): Decision {
  return createBrain(s).think(v, new Rng(7));
}

/** Angle between the decision heading and the direction from `from` to `to`. */
function headingError(d: Decision, from: Vec2, to: Vec2): number {
  return Math.abs(angleDiff(d.heading, angleTo(from, to)));
}

const walled = (extra: Parameters<typeof fakeWorld>[0] = {}): WorldQuery =>
  fakeWorld({
    walls: [{ x: 0, y: 0, w: 1000, h: 20 }, { x: 0, y: 780, w: 1000, h: 20 }, { x: 0, y: 0, w: 20, h: 800 }, { x: 980, y: 0, w: 20, h: 800 }],
    ...extra,
  });

describe('house stacks', () => {
  it('every house stack validates without a single error or warning', () => {
    for (const s of HOUSE_STACKS) expect(validateStrategy(s).issues, s.name).toEqual([]);
  });

  it('cover every weapon and every skill with at least ten distinct fighters', () => {
    expect(HOUSE_STACKS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(HOUSE_STACKS.map((s) => s.build.weapon))).toEqual(new Set(WEAPON_IDS));
    expect(new Set(HOUSE_STACKS.map((s) => s.build.skill))).toEqual(new Set(SKILL_IDS));
    expect(new Set(HOUSE_STACKS.map((s) => s.name)).size).toBe(HOUSE_STACKS.length);
    expect(new Set(HOUSE_STACKS.map((s) => s.look?.color)).size).toBe(HOUSE_STACKS.length);
    for (const s of HOUSE_STACKS) {
      expect(HOUSE_NOTES[s.name], s.name).toBeTruthy();
      expect(Object.keys(s.barks ?? {}).length, s.name).toBeGreaterThanOrEqual(5);
    }
  });

  // Melee fighters that only walk at the nearest enemy make every match look the same and lose
  // to every kiter. One deliberate charger is a joke; two is a missing feature.
  it('melee stacks have real plans, not just charging', () => {
    const planWords = ['dark_spot', 'shadow', 'corner', 'nearest_fight', 'fights_nearby', 'behind(', 'beyond(', 'shrine', 'seen_by', 'facing_away', 'keep_range', '"guard"'];
    const chargers = HOUSE_STACKS.filter((s) => WEAPONS[s.build.weapon].family === 'melee').filter((s) => {
      const text = JSON.stringify(mergeBehaviours(s).filter(([n]) => n !== 'heal' && n !== 'prowl'));
      return !planWords.some((w) => text.includes(w));
    });
    expect(chargers.map((s) => s.name)).toEqual(['Big Lad Steve']);
  });

  it('every stack thinks in common situations and returns sane numbers', () => {
    const situations = (s: Strategy): PerceptionView[] => {
      const world = walled({ light: (p) => (p.x < 300 ? 0.1 : 0.9), hazards: [{ pos: { x: 600, y: 500 }, radius: 40 }], shrine: { pos: { x: 500, y: 400 }, ready: true } });
      const foes: KnownFighter[] = [
        enemy('a', { pos: { x: 420, y: 330 }, fighting: true, weapon: 'LONGBOW' }),
        enemy('b', { pos: { x: 470, y: 360 }, fighting: true, facing: 0, hp: 80 }),
        enemy('c', { pos: { x: 800, y: 600 }, seen: false, heard: true }),
      ];
      return [
        view(me(s), [], world),
        view(me(s), foes, world, { tick: 600 }),
        view(me(s, { hp: 60, lastHitTick: 590, seen: true }), foes, world, { tick: 600, lastAttackerId: 'a' }),
        view(me(s, { ammo: 0 }), foes.slice(0, 1), world, { tick: 6000, suddenDeath: true }),
      ];
    };
    for (const s of HOUSE_STACKS) {
      const brain = createBrain(s);
      const rng = new Rng(3);
      for (const v of situations(s)) {
        const d = brain.think(v, rng);
        expect(Number.isFinite(d.heading), s.name).toBe(true);
        expect(d.speed, s.name).toBeGreaterThanOrEqual(0);
        expect(d.speed, s.name).toBeLessThanOrEqual(1);
        expect(d.ring).toHaveLength(STEER_DIRS);
        expect(Object.values(d.scores).every(Number.isFinite), s.name).toBe(true);
      }
    }
  });
});

describe('house stack plans', () => {
  it('Brenda stabs a target that is busy and shows her its back', () => {
    const s = stack('Brenda From Accounts');
    // Ten seconds in, so her post-strike vanish window is long over.
    const victim = enemy('v', { pos: { x: 360, y: 300 }, facing: 0, fighting: true });
    const d = think(s, view(me(s), [victim], walled(), { tick: 600 }));
    expect(d.behaviour).toBe('stab');
    expect(d.attack).toBe(true);
  });

  it('Brenda lurks in the dark while the target faces her', () => {
    const s = stack('Brenda From Accounts');
    const watcher = enemy('w', { pos: { x: 600, y: 300 }, facing: Math.PI });
    const d = think(s, view(me(s, { pos: { x: 260, y: 300 } }), [watcher], walled({ light: (p) => (p.x < 300 ? 0.05 : 0.9) }), { tick: 600 }));
    expect(d.behaviour).toBe('lurk');
    expect(d.stance).toBe('creep');
  });

  it("Doug holds the nearest corner in guard stance until someone comes close", () => {
    const s = stack("Doug's Corner");
    const self = me(s);
    const d = think(s, view(self, [enemy('far', { pos: { x: 700, y: 500 } })], walled()));
    expect(d.behaviour).toBe('hold');
    expect(d.stance).toBe('guard');
    // The nearest corner from (300, 300) is the top-left one.
    expect(headingError(d, self.pos, { x: 40, y: 40 })).toBeLessThan(Math.PI / 4);
    const close = think(s, view(self, [enemy('near', { pos: { x: 390, y: 300 } })], walled()));
    expect(close.behaviour).toBe('smash');
  });

  it('Pam backs away from a melee fighter instead of trading blows', () => {
    const s = stack('Distant Cousin Pam');
    const self = me(s);
    const brute = enemy('brute', { pos: { x: 420, y: 300 }, weapon: 'GREATSWORD' });
    const d = think(s, view(self, [brute], walled()));
    expect(d.behaviour).toBe('backpedal');
    expect(headingError(d, self.pos, brute.pos)).toBeGreaterThan(Math.PI / 2);
  });

  it('Gary waits at the edge of a fight and only walks in to finish', () => {
    const s = stack('Apologetic Gary');
    const fightA = enemy('a', { pos: { x: 520, y: 300 }, fighting: true });
    const fightB = enemy('b', { pos: { x: 580, y: 300 }, fighting: true });
    expect(think(s, view(me(s), [fightA, fightB], walled())).behaviour).toBe('loiter');
    const hurt = enemy('a', { pos: { x: 520, y: 300 }, fighting: true, hp: 90 });
    expect(think(s, view(me(s), [hurt, fightB], walled())).behaviour).toBe('finish');
  });

  // Bow and axes run dry: a ranged stack that cannot restock spends the rest of the match punching.
  it('ranged stacks with spent ammo go and pick it up', () => {
    for (const s of HOUSE_STACKS.filter((h) => WEAPONS[h.build.weapon].ammoPickup)) {
      const self = me(s, { ammo: 0 });
      const kind = s.build.weapon === 'LONGBOW' ? 'arrow' : 'axe';
      const item = { x: 300, y: 450 };
      const d = think(s, view(self, [enemy('e', { pos: { x: 650, y: 300 } })], walled({ floorItems: [{ kind, pos: item }] }), { tick: 600 }));
      expect(d.terms.some((t) => t.label.startsWith('seek ammo')), s.name).toBe(true);
      expect(headingError(d, self.pos, item), s.name).toBeLessThan(Math.PI / 4);
    }
  });

  it('every stack has something to do when nobody is known', () => {
    for (const s of HOUSE_STACKS) {
      const d = think(s, view(me(s), [], walled({ shrine: { pos: { x: 500, y: 400 }, ready: false } })));
      const moving = d.speed > 0;
      const holding = d.stance === 'guard' || d.stance === 'creep';
      expect(moving || holding, `${s.name} (${d.behaviour})`).toBe(true);
    }
  });

  // Hiding until sudden death must not be a free win: with the wall two seconds away, every
  // house stack walks inward instead of holding its corner or its shadow.
  it('every stack heads for the last safe square when the wall is about to reach it', () => {
    const world = walled({ light: (p) => (p.x < 300 ? 0.05 : 0.9) });
    // The wall is 30 px in; the fighter stands 30 px inside it: two seconds of wall travel.
    const zone = closingZone(world.map, 30);
    for (const s of HOUSE_STACKS) {
      const self = me(s, { pos: { x: 60, y: 400 } });
      // The enemy is up the wall to the north, so chasing it would mean staying in the wall's path.
      const v = view(self, [enemy('foe', { pos: { x: 90, y: 120 } })], world, { tick: 5400, zone, arena: zone.bounds, suddenDeath: true });
      const d = think(s, v);
      expect(d.speed, `${s.name} (${d.behaviour})`).toBeGreaterThan(0.5);
      expect(headingError(d, self.pos, { x: 500, y: 400 }), `${s.name} (${d.behaviour})`).toBeLessThan(Math.PI / 3);
    }
  });

  // Power-ups only matter if some of the opposition fights over them.
  it('at least three stacks go for power-ups, and one builds its whole plan on them', () => {
    const users = HOUSE_STACKS.filter((s) => /pickup/.test(JSON.stringify(mergeBehaviours(s))));
    expect(users.length).toBeGreaterThanOrEqual(3);
    const tina = stack('Two-For-One Tina');
    expect(Object.values(tina.behaviours).filter((b) => /pickup/.test(JSON.stringify(b))).length).toBeGreaterThanOrEqual(2);
  });

  const pedestal = (ready: boolean, kind: PickupInfo['kind'] = 'berserk', pos = { x: 420, y: 520 }): PickupInfo => ({ id: 'p', kind, pos, ready, respawnIn: ready ? 0 : 2 });

  it('Tina takes a power-up that is up, and waits on the pedestal of one about to come back', () => {
    const s = stack('Two-For-One Tina');
    const self = me(s);
    const foe = [enemy('e', { pos: { x: 800, y: 200 } })];
    const up = think(s, view(self, foe, walled({ pickups: [pedestal(true)] }), { tick: 600 }));
    expect(up.behaviour).toBe('shop');
    expect(headingError(up, self.pos, { x: 420, y: 520 })).toBeLessThan(Math.PI / 6);
    const soon = think(s, view(self, foe, walled({ pickups: [pedestal(false)] }), { tick: 600 }));
    expect(soon.behaviour).toBe('queue');
    expect(headingError(soon, self.pos, { x: 420, y: 520 })).toBeLessThan(Math.PI / 6);
  });

  it('Big Lad Steve stops for a berserk draught on the way, and Kevin grabs what is close', () => {
    const steve = stack('Big Lad Steve');
    const foe = [enemy('e', { pos: { x: 700, y: 300 } })];
    expect(think(steve, view(me(steve), foe, walled({ pickups: [pedestal(true)] }))).behaviour).toBe('pint');
    expect(think(steve, view(me(steve), foe, walled({ pickups: [pedestal(false)] }))).behaviour).toBe('charge');
    const kevin = stack('Kevin, Professional Bait');
    const d = think(kevin, view(me(kevin), [enemy('e', { pos: { x: 800, y: 600 } })], walled({ pickups: [pedestal(true, 'haste', { x: 360, y: 340 })] })));
    expect(d.behaviour).toBe('grab_powerup');
  });

  // Losing sight must mean searching, not walking to a stale spot and standing there.
  it('hunters search where they lost the target instead of charging its old position', () => {
    for (const name of ['Big Lad Steve', 'Sir Clanksworth', 'Uncle Hatchet']) {
      const s = stack(name);
      const self = me(s);
      const lost = enemy('l', { pos: { x: 600, y: 300 }, lastSeenPos: { x: 600, y: 300 }, seen: false, heard: false, lastSeenTick: 540, weapon: 'LONGBOW' });
      const d = think(s, view(self, [lost], walled(), { tick: 600 }));
      expect(d.behaviour, name).toBe('search');
      expect(d.terms[0]!.label, name).toBe('seek search_point x1.1');
    }
  });

  it('steering directions follow the core convention (index 4 points south)', () => {
    // Guards the assumption every expectation above relies on.
    expect(steerAngle(4)).toBeCloseTo(Math.PI / 2);
  });
});
