import { describe, expect, it } from 'vitest';
import { COMBAT, HAZARD_RULES, WEAPONS, angleDiff, damageMultiplier, resolveDamage, shotSpread } from '../core';
import type { BrainFactory, GameEvent } from '../core';
import { MAPS } from './maps';
import { createMatch } from './match';
import { BALANCED, seekerBrain, stage, testConfig } from './testkit';

type Ev<T extends GameEvent['type']> = Extract<GameEvent, { type: T }>;
const of = <T extends GameEvent['type']>(events: GameEvent[], type: T) => events.filter((e): e is Ev<T> => e.type === type);

/** A sharp-eyed archer (tiny aim error) so tests about what an arrow hits are not about aim. */
const SHARP = { vitality: 12, power: 12, agility: 12, perception: 40, armor: 12, haste: 12 };

describe('projectiles', () => {
  // Spec: projectiles stop at the first body in their path, so crowds take stray shots.
  it('an arrow stops at the first body in its path, even if it was aimed past it', () => {
    // Mark stands in light (a shot needs its target in sight); the Blocker stands in the line of fire.
    const s = stage([
      { name: 'Archer', weapon: 'LONGBOW', pos: [400, 196], facing: 0, attributes: SHARP, script: { attack: true } },
      { name: 'Blocker', weapon: 'TWIN_DAGGERS', pos: [550, 196], facing: Math.PI },
      { name: 'Mark', weapon: 'TWIN_DAGGERS', pos: [700, 196], facing: Math.PI },
    ]);
    s.scripts.Archer!.targetId = s.f('Mark').id;
    s.run(6);
    expect(s.match.knowledge(s.f('Archer').id).find((k) => k.id === s.f('Mark').id)?.seen).toBe(true);
    while (of(s.events, 'projectile_end').length === 0 && s.match.state.tick < 200) s.run(1);
    const end = of(s.events, 'projectile_end')[0]!;
    expect(end.hitId).toBe(s.f('Blocker').id);
    expect(s.f('Blocker').damageTaken).toBeGreaterThan(0);
    expect(s.f('Mark').damageTaken).toBe(0);
    expect(of(s.events, 'hit').every((h) => h.victimId === s.f('Blocker').id)).toBe(true);
  });

  // Greatsword and warhammer users trade speed for a shield: guard stance stops arrows from the front only.
  it('a shield in guard stance blocks arrows from the front, not from behind', () => {
    const shoot = (facing: number) => {
      const s = stage([
        { name: 'Archer', weapon: 'LONGBOW', pos: [400, 196], facing: 0, attributes: SHARP, script: { attack: true } },
        { name: 'Guard', weapon: 'GREATSWORD', pos: [700, 196], facing, script: { stance: 'guard' } },
      ]);
      s.scripts.Archer!.targetId = s.f('Guard').id;
      while (of(s.events, 'projectile_end').length === 0 && s.match.state.tick < 200) s.run(1);
      return { s, end: of(s.events, 'projectile_end')[0]! };
    };
    const front = shoot(Math.PI);
    expect(front.end.hitId).toBeNull();
    expect(of(front.s.events, 'parry')).toHaveLength(1);
    expect(front.s.f('Guard').damageTaken).toBe(0);

    const back = shoot(0);
    expect(back.end.hitId).toBe(back.s.f('Guard').id);
    expect(back.s.f('Guard').damageTaken).toBeGreaterThan(0);
  });

  // Players see the orb glow at the staff's tip, the arrow on the bow and an axe in each hand; a
  // shot that appears from the middle of the body reads as a glitch. The spawn point is the
  // projectile's fixed `origin` and the `projectile` event's pos, so trails and muzzle flashes
  // start where the weapon is.
  it('arrows, orbs and axes leave from the weapon, not from the body', () => {
    const shots = (weapon: 'LONGBOW' | 'ARCANE_STAFF' | 'THROWING_AXES', count: number) => {
      const s = stage([
        { name: 'Shooter', weapon, pos: [400, 196], facing: 0, attributes: SHARP, script: { attack: true } },
        { name: 'Mark', weapon: 'GREATSWORD', pos: [700, 196], facing: Math.PI, script: { stance: 'guard' } },
      ]);
      s.scripts.Shooter!.targetId = s.f('Mark').id;
      const out: { ahead: number; right: number }[] = [];
      while (out.length < count && s.match.state.tick < 600) {
        s.run(1);
        const f = s.f('Shooter');
        for (const e of of(s.events, 'projectile').slice(out.length)) {
          const dx = e.pos.x - f.pos.x;
          const dy = e.pos.y - f.pos.y;
          out.push({ ahead: dx * Math.cos(f.facing) + dy * Math.sin(f.facing), right: -dx * Math.sin(f.facing) + dy * Math.cos(f.facing) });
          const p = s.match.state.projectiles.find((q) => q.id === e.projectileId);
          if (p) {
            expect(p.origin).toEqual(e.pos);
            expect(p.pos).not.toEqual(p.origin);
          }
        }
      }
      expect(out.length, `${weapon}: only ${out.length} of ${count} shots within 600 ticks`).toBe(count);
      return out;
    };
    // The orb comes off the tip of a long staff held out front, in the right hand.
    const [orb] = shots('ARCANE_STAFF', 1);
    expect(orb!.ahead).toBeGreaterThan(65);
    expect(orb!.right).toBeGreaterThan(12);
    // The arrow leaves the bow, just in front of the body.
    const [arrow] = shots('LONGBOW', 1);
    expect(arrow!.ahead).toBeGreaterThan(8);
    expect(arrow!.ahead).toBeLessThan(25);
    expect(Math.abs(arrow!.right)).toBeLessThan(8);
    // Axes come from alternating hands: four in hand, so left, right, left.
    const axes = shots('THROWING_AXES', 3);
    expect(axes.map((a) => Math.sign(a.right))).toEqual([-1, 1, -1]);
    for (const a of axes) {
      expect(a.ahead).toBeGreaterThan(8);
      expect(Math.abs(a.right)).toBeGreaterThan(10);
    }
  });

  // A long staff must not shoot through what its tip reaches past: the orb bursts on the wall
  // between the body and the tip, on the tick it is fired, instead of appearing on the far side.
  it('a staff reaching past a wall bursts on the wall, not beyond it', () => {
    // The pit's west gate: the gate wall's lower half spans x 192-214, y 480-620. The mage stands
    // in the hall facing east through the gate at its mark, but the staff's tip (out front, in the
    // right hand, so lower on screen) reaches past the end of the wall into the arena.
    const s = stage([
      { name: 'Mage', weapon: 'ARCANE_STAFF', pos: [150, 465], facing: 0, attributes: SHARP, script: { attack: true } },
      { name: 'Mark', weapon: 'GREATSWORD', pos: [280, 465], facing: Math.PI },
    ]);
    s.scripts.Mage!.targetId = s.f('Mark').id;
    while (of(s.events, 'projectile').length === 0 && s.match.state.tick < 200) s.run(1);
    const shot = of(s.events, 'projectile')[0];
    expect(shot, 'the mage never fired within 200 ticks').toBeDefined();
    expect(shot!.pos.x, 'the staff tip should reach past the gate wall').toBeGreaterThan(214);
    const end = of(s.events, 'projectile_end').find((e) => e.projectileId === shot!.projectileId)!;
    expect(end.tick).toBe(shot!.tick);
    expect(end.hitId).toBeNull();
    // It burst where the staff met the wall, never beyond it.
    expect(end.pos.x).toBeGreaterThanOrEqual(192 - 1e-6);
    expect(end.pos.x).toBeLessThanOrEqual(214 + 1e-6);
    expect(end.pos.y).toBeGreaterThanOrEqual(480 - 1e-6);
    expect(s.f('Mage').pos).toEqual({ x: 150, y: 465 });
  });

  // ...and a target standing closer than the staff is long still takes the orb.
  it('a target inside the staff\'s reach is hit, not shot past', () => {
    const s = stage([
      { name: 'Mage', weapon: 'ARCANE_STAFF', pos: [400, 196], facing: 0, attributes: SHARP, script: { attack: true } },
      { name: 'Hugger', weapon: 'GREATSWORD', pos: [460, 196], facing: Math.PI },
    ]);
    s.scripts.Mage!.targetId = s.f('Hugger').id;
    while (of(s.events, 'projectile').length === 0 && s.match.state.tick < 200) s.run(1);
    const shot = of(s.events, 'projectile')[0];
    expect(shot, 'the mage never fired within 200 ticks').toBeDefined();
    const end = of(s.events, 'projectile_end').find((e) => e.projectileId === shot!.projectileId)!;
    expect(end.tick).toBe(shot!.tick);
    expect(end.hitId).toBe(s.f('Hugger').id);
    expect(s.f('Hugger').damageTaken).toBeGreaterThan(0);
  });

  // Ammo is a resource: spent arrows land on the floor and only come back if you walk over them.
  it('spent arrows land on the floor and must be picked up', () => {
    const s = stage([
      { name: 'Archer', weapon: 'LONGBOW', pos: [400, 196], facing: 0, script: { attack: true } },
      { name: 'Mark', weapon: 'GREATSWORD', pos: [700, 196], facing: 0 },
    ]);
    const archer = s.f('Archer');
    s.scripts.Archer!.targetId = s.f('Mark').id;
    while (of(s.events, 'projectile').length === 0 && s.match.state.tick < 200) s.run(1);
    s.scripts.Archer = { attack: false };
    while (of(s.events, 'projectile_end').length === 0 && s.match.state.tick < 400) s.run(1);
    expect(archer.ammo).toBe(WEAPONS.LONGBOW.ammo - 1);
    const arrows = s.match.state.floor.filter((i) => i.kind === 'arrow');
    expect(arrows).toHaveLength(1);
    // Mark steps out of the lane so the walk to the arrow is about ammo, not about bodies.
    s.f('Mark').pos.x = 680;
    s.f('Mark').pos.y = 760;
    s.run(120);
    expect(archer.ammo).toBe(WEAPONS.LONGBOW.ammo - 1); // standing still: nothing comes back

    s.scripts.Archer = { heading: Math.atan2(arrows[0]!.pos.y - archer.pos.y, arrows[0]!.pos.x - archer.pos.x), speed: 1 };
    s.run(400);
    expect(archer.ammo).toBe(WEAPONS.LONGBOW.ammo);
    expect(s.match.state.floor.filter((i) => i.kind === 'arrow')).toHaveLength(0);
    expect(of(s.events, 'pickup').some((p) => p.kind === 'arrow' && p.fighterId === archer.id)).toBe(true);
  });
});

describe('melee', () => {
  /** Daggers at (600, 196) facing east stab a still greatsword user 50 px east, facing `facing`. */
  function stab(facing: number, setup?: (s: ReturnType<typeof stage>) => void) {
    const s = stage([
      { name: 'Stabber', weapon: 'TWIN_DAGGERS', pos: [600, 196], facing: 0, script: { attack: true } },
      { name: 'Victim', weapon: 'GREATSWORD', pos: [650, 196], facing },
    ]);
    s.scripts.Stabber!.targetId = s.f('Victim').id;
    setup?.(s);
    while (of(s.events, 'hit').length === 0 && s.match.state.tick < 60) s.run(1);
    return s;
  }

  // Daggers are built around getting behind people: a backstab is worth x2.35.
  it('a dagger in the back deals the backstab multiple', () => {
    const mult = damageMultiplier(BALANCED, false);
    const front = of(stab(Math.PI).events, 'hit')[0]!;
    const back = of(stab(0).events, 'hit')[0]!;
    expect(front.backstab).toBe(false);
    expect(back.backstab).toBe(true);
    expect(front.amount).toBe(resolveDamage(WEAPONS.TWIN_DAGGERS.damage, mult, BALANCED));
    expect(back.amount).toBe(resolveDamage(WEAPONS.TWIN_DAGGERS.damage, mult * WEAPONS.TWIN_DAGGERS.backstabMult, BALANCED));
  });

  // A parry turns the blow around: the attacker eats 65% and is stunned, the defender takes nothing.
  it('an open parry window facing the attacker reflects the blow and stuns the attacker', () => {
    const s = stab(Math.PI, (st) => (st.f('Victim').parryTicks = 30));
    const hit = of(s.events, 'hit')[0]!;
    expect(of(s.events, 'parry')).toHaveLength(1);
    expect(hit.victimId).toBe(s.f('Stabber').id);
    expect(hit.source).toBe('reflect');
    expect(hit.amount).toBe(resolveDamage(WEAPONS.TWIN_DAGGERS.damage, damageMultiplier(BALANCED, false) * COMBAT.parryReflect, BALANCED));
    expect(s.f('Victim').damageTaken).toBe(0);
    expect(s.f('Stabber').stunTicks).toBeGreaterThan(COMBAT.parryStunTicks - 3);
  });

  it('auto-parry only happens when the brain allows it', () => {
    const count = (parry: boolean) => {
      const s = stage([
        { name: 'Stabber', weapon: 'TWIN_DAGGERS', pos: [600, 196], facing: 0, script: { attack: true } },
        { name: 'Victim', weapon: 'GREATSWORD', pos: [650, 196], facing: Math.PI, attributes: { perception: 40, vitality: 40 }, script: { parry } },
      ]);
      s.scripts.Stabber!.targetId = s.f('Victim').id;
      s.run(300);
      return of(s.events, 'parry').length;
    };
    expect(count(false)).toBe(0);
    expect(count(true)).toBeGreaterThan(0);
  });

  // Losing the weapon arm is not the end: you punch for 6.
  it('a fighter without a weapon arm punches', () => {
    const s = stab(Math.PI, (st) => (st.f('Stabber').limbs.armR = false));
    const hit = of(s.events, 'hit')[0]!;
    expect(hit.source).toBe('punch');
    expect(hit.weapon).toBeNull();
    expect(hit.amount).toBe(resolveDamage(COMBAT.punchDamage, damageMultiplier(BALANCED, false), BALANCED));
  });
});

describe('movement', () => {
  it('a missing leg slows a fighter to 55%', () => {
    const walk = (legless: boolean) => {
      const s = stage([
        { name: 'Walker', weapon: 'GREATSWORD', pos: [300, 196], facing: 0, script: { heading: 0, speed: 1 } },
        { name: 'Parked', weapon: 'GREATSWORD', pos: [680, 760], facing: 0 },
      ]);
      if (legless) s.f('Walker').limbs.legL = false;
      s.run(30);
      const x0 = s.f('Walker').pos.x;
      s.run(120);
      return s.f('Walker').pos.x - x0;
    };
    expect(walk(true) / walk(false)).toBeCloseTo(COMBAT.leglessMoveMul, 2);
  });
});

describe('props and hazards', () => {
  // Kegs are weapons: whoever breaks one owns what it does, including to themselves.
  it('a keg blast credits whoever broke it', () => {
    const s = stage([
      { name: 'Doug', weapon: 'GREATSWORD', pos: [445, 430], facing: 0, script: { attack: true } },
      { name: 'Brenda', weapon: 'TWIN_DAGGERS', pos: [575, 430], facing: 0 },
    ]);
    s.f('Brenda').hp = 10;
    while (of(s.events, 'kill').length === 0 && s.match.state.tick < 60) s.run(1);
    expect(of(s.events, 'prop_break')[0]?.kind).toBe('keg');
    expect(of(s.events, 'explosion')).toHaveLength(1);
    const kill = of(s.events, 'kill')[0]!;
    expect(kill.victimId).toBe(s.f('Brenda').id);
    expect(kill.killerId).toBe(s.f('Doug').id);
    expect(kill.cause).toBe('keg');
    expect(s.f('Doug').kills).toBe(1);
  });

  // Placement is earned: when two fall on the same tick, the better record keeps the better place.
  it('fighters killed on the same tick are placed by their record, not their slot', () => {
    const blast = (veteran: 'A' | 'B') => {
      const s = stage([
        { name: 'Doug', weapon: 'GREATSWORD', pos: [445, 430], facing: 0, script: { attack: true } },
        { name: 'A', weapon: 'TWIN_DAGGERS', pos: [575, 430], facing: 0 },
        { name: 'B', weapon: 'TWIN_DAGGERS', pos: [560, 490], facing: 0 },
      ]);
      s.f('A').hp = 5;
      s.f('B').hp = 5;
      s.f(veteran).kills = 2;
      s.run(60);
      const kills = of(s.events, 'kill');
      expect(kills).toHaveLength(2);
      expect(kills[0]!.tick).toBe(kills[1]!.tick);
      return s;
    };
    const a = blast('A');
    expect([a.f('A').place, a.f('B').place]).toEqual([2, 3]);
    const b = blast('B');
    expect([b.f('A').place, b.f('B').place]).toEqual([3, 2]);
  });

  it('blowing yourself up with your own keg is an own goal', () => {
    const s = stage([
      { name: 'Doug', weapon: 'GREATSWORD', pos: [445, 430], facing: 0, script: { attack: true } },
      { name: 'Parked', weapon: 'TWIN_DAGGERS', pos: [680, 760], facing: 0 },
    ]);
    s.f('Doug').hp = 5;
    while (of(s.events, 'kill').length === 0 && s.match.state.tick < 60) s.run(1);
    const kill = of(s.events, 'kill')[0]!;
    expect(kill.victimId).toBe(s.f('Doug').id);
    expect(kill.killerId).toBe(s.f('Doug').id);
    expect(kill.title).toBe('OWN GOAL');
    expect(s.f('Doug').kills).toBe(0);
  });

  // Spike traps have a rhythm players can learn: one thrust per cycle, never a constant drain.
  it('a spike trap hits a fighter standing on it exactly once per cycle', () => {
    const s = stage([
      { name: 'Stander', weapon: 'GREATSWORD', pos: [96, 430], facing: 0 },
      { name: 'Parked', weapon: 'GREATSWORD', pos: [680, 760], facing: 0 },
    ]);
    s.run(HAZARD_RULES.spike.period);
    const hits = of(s.events, 'hit').filter((h) => h.source === 'hazard');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.amount).toBe(resolveDamage(HAZARD_RULES.spike.damage, 1, BALANCED));
  });

  // Standing in acid must be an obvious, costly mistake and knocking someone into it a tactic: it
  // slows you, so you cannot just stroll out. Fire burns but does not hold you.
  it('acid slows whoever stands in it for as long as they stay; fire does not', () => {
    // The Smasher swings at the air beside the pit's north amphora; it shatters into a pool around them.
    const s = stage([
      { name: 'Smasher', weapon: 'GREATSWORD', pos: [640, 236], facing: 0, script: { attack: true } },
      { name: 'Parked', weapon: 'GREATSWORD', pos: [680, 760], facing: 0 },
    ]);
    const smasher = s.f('Smasher');
    while (!of(s.events, 'prop_break').some((p) => p.kind === 'amphora') && s.match.state.tick < 120) s.run(1);
    expect(of(s.events, 'prop_break').some((p) => p.kind === 'amphora'), 'the amphora never broke within 120 ticks').toBe(true);
    s.scripts.Smasher = {};
    const firstAcid = of(s.events, 'hit').find((h) => h.source === 'hazard' && h.victimId === smasher.id);
    expect(firstAcid, 'the Smasher was not burned by the spill').toBeDefined();
    for (let i = 0; i < 150; i++) {
      s.run(1);
      expect(smasher.buffs.slow, `not slowed at tick ${s.match.state.tick} while standing in acid`).toBeGreaterThan(0);
    }
    expect(smasher.buffs.slow).toBeLessThanOrEqual(HAZARD_RULES.acid.slowTicks);

    const fire = MAPS.pillar_forest!.hazards.find((h) => h.kind === 'fire')!;
    const f = stage([
      { name: 'Burnt', weapon: 'GREATSWORD', pos: [fire.pos.x, fire.pos.y], facing: 0 },
      { name: 'Parked', weapon: 'GREATSWORD', pos: [680, 300], facing: 0 },
    ], { mapId: 'pillar_forest' });
    f.run(100);
    expect(of(f.events, 'hit').filter((h) => h.source === 'hazard').length).toBeGreaterThan(0);
    expect(f.f('Burnt').buffs.slow).toBe(0);
  });

  // Before it closes, the wall only hurts whoever it reaches: the fighter tucked in a corner alcove,
  // never the one standing in the middle.
  it('the sudden-death wall hurts only the fighters it reaches before it closes', () => {
    const s = stage(
      [
        { name: 'Corner', weapon: 'GREATSWORD', pos: [60, 60], facing: 0 },
        { name: 'Centre', weapon: 'GREATSWORD', pos: [680, 330], facing: 0 },
      ],
      { timeLimitTicks: 60 },
    );
    s.run(400);
    expect(of(s.events, 'sudden_death')).toHaveLength(1);
    expect(s.match.state.suddenDeath.active).toBe(true);
    expect(s.f('Corner').damageTaken).toBeGreaterThan(0);
    expect(s.f('Centre').damageTaken).toBe(0);
    expect(of(s.events, 'hit').every((h) => h.source === 'sudden_death' && h.victimId === s.f('Corner').id)).toBe(true);
    expect(of(s.events, 'wall_contact').length).toBeGreaterThan(0);
    expect(of(s.events, 'wall_contact').every((c) => c.fighterId === s.f('Corner').id)).toBe(true);
  });
});

describe('fog of war in combat', () => {
  // Spec invariant: a fighter never fires a projectile at a target it cannot see. Hearing someone
  // behind a pillar is not enough to shoot at them.
  it('never shoots at a target it only hears', () => {
    const s = stage([
      { name: 'Archer', weapon: 'LONGBOW', pos: [449, 316], facing: Math.PI / 2, script: { attack: true } },
      { name: 'Hidden', weapon: 'TWIN_DAGGERS', pos: [449, 412], facing: 0 },
    ]);
    s.scripts.Archer!.targetId = s.f('Hidden').id;
    let heard = 0;
    for (let k = 0; k < 20; k++) {
      // Pacing back and forth behind the pillar: noisy, never in sight.
      s.scripts.Hidden = { heading: k % 2 ? Math.PI : 0, speed: 1 };
      for (let i = 0; i < 12; i++) {
        s.run(1);
        const rec = s.match.knowledge(s.f('Archer').id).find((r) => r.id === s.f('Hidden').id);
        expect(rec?.seen ?? false).toBe(false);
        if (rec?.heard) heard++;
      }
    }
    expect(heard).toBeGreaterThan(20);
    expect(of(s.events, 'projectile')).toHaveLength(0);
  });

  // A shot already winding up when the target slips out of sight is abandoned, not fired at a memory.
  it('abandons a windup when the target drops out of sight, spending no ammo', () => {
    const s = stage([
      { name: 'Archer', weapon: 'LONGBOW', pos: [400, 196], facing: 0, script: { attack: true } },
      { name: 'Mark', weapon: 'TWIN_DAGGERS', pos: [600, 196], facing: 0 },
    ]);
    s.scripts.Archer!.targetId = s.f('Mark').id;
    while (of(s.events, 'swing').length === 0 && s.match.state.tick < 60) s.run(1);
    expect(s.f('Archer').anim.phase).toBe('windup');
    s.f('Mark').pos.x = 1250;
    s.f('Mark').pos.y = 790;
    s.run(90);
    expect(of(s.events, 'projectile')).toHaveLength(0);
    expect(s.f('Archer').ammo).toBe(WEAPONS.LONGBOW.ammo);
    expect(s.f('Archer').anim.phase).toBe('idle');
  });

  // The same invariant over whole matches, with brains that try to shoot anything they remember.
  it('across whole matches, nobody fires while seeing no enemy', () => {
    const triggerHappy: BrainFactory = (strategy) => {
      const inner = seekerBrain(strategy);
      return { memory: inner.memory, think: (view, rng) => ({ ...inner.think(view, rng), attack: view.known.length > 0 }) };
    };
    let shots = 0;
    for (const mapId of Object.keys(MAPS)) {
      const m = createMatch(testConfig({ seed: 21, mapId, fighters: 8 }), triggerHappy);
      while (!m.isOver && m.state.tick < 4000) {
        for (const e of m.step()) {
          if (e.type !== 'projectile') continue;
          shots++;
          expect(m.knowledge(e.ownerId).some((k) => k.seen)).toBe(true);
        }
      }
    }
    expect(shots).toBeGreaterThan(20);
  });

  // A shadowstep lands behind the target's true position, so it must not work on someone only heard.
  it('shadowsteps only behind a target in sight', () => {
    const step = (hidden: boolean) => {
      // Hidden: the pit pillar at (449, 366) stands between them. Open: across the top lane.
      const s = stage([
        { name: 'Stepper', weapon: 'TWIN_DAGGERS', skill: 'SHADOWSTEP', pos: hidden ? [449, 316] : [400, 196], facing: hidden ? -Math.PI / 2 : 0, script: { useSkill: true } },
        { name: 'Mark', weapon: 'GREATSWORD', pos: hidden ? [449, 412] : [600, 196], facing: 0, script: { heading: 0, speed: 1 } },
      ]);
      s.scripts.Stepper!.targetId = s.f('Mark').id;
      let heard = 0;
      let seen = false;
      for (let k = 0; k < 8; k++) {
        s.scripts.Mark = { heading: k % 2 ? Math.PI : 0, speed: 1 };
        for (let i = 0; i < 12; i++) {
          s.run(1);
          const rec = s.match.knowledge(s.f('Stepper').id).find((r) => r.id === s.f('Mark').id);
          if (rec?.heard) heard++;
          if (rec?.seen) seen = true;
        }
      }
      return { skills: of(s.events, 'skill').length, heard, seen };
    };
    // Behind the pillar: heard, never seen, never stepped to.
    const blind = step(true);
    expect(blind.heard).toBeGreaterThan(10);
    expect(blind.seen).toBe(false);
    expect(blind.skills).toBe(0);
    // In plain sight across the open floor: steps.
    expect(step(false).skills).toBeGreaterThan(0);
  });

  // Melee may swing blind, but only at a heard target whose rough position is within reach.
  it('swings blind only at a heard target whose estimate is within reach', () => {
    const blind = (target: [number, number], script: { heading?: number; speed?: number }) => {
      const s = stage([
        { name: 'Brute', weapon: 'GREATSWORD', pos: [900, 196], facing: Math.PI, script: { attack: true } },
        { name: 'Sneak', weapon: 'TWIN_DAGGERS', pos: target, facing: 0, script },
      ]);
      s.scripts.Brute!.targetId = s.f('Sneak').id;
      let heardOnly = 0;
      let blindSwings = 0;
      for (let i = 0; i < 150; i++) {
        s.run(1);
        const rec = s.match.knowledge(s.f('Brute').id).find((r) => r.id === s.f('Sneak').id);
        if (rec?.seen) break;
        if (rec?.heard) heardOnly++;
        blindSwings += s.events.filter((e) => e.type === 'swing' && e.tick === s.match.state.tick && e.fighterId === s.f('Brute').id).length;
      }
      return { heardOnly, blindSwings };
    };
    // 50 px behind: heard, and any estimate is within a greatsword's reach.
    const close = blind([950, 196], {});
    expect(close.heardOnly).toBeGreaterThan(0);
    expect(close.blindSwings).toBeGreaterThan(0);
    // 200 px behind and walking away noisily: heard, but no estimate can be within reach.
    const far = blind([1100, 196], { heading: Math.PI / 2, speed: 1 });
    expect(far.heardOnly).toBeGreaterThan(0);
    expect(far.blindSwings).toBe(0);
  });
});

describe('ranged vs melee mechanics', () => {
  // Kiting costs: walking away from where you face is slow (x0.55 straight back).
  it('backpedalling away from a target you face is slower', () => {
    const walk = (watch: boolean) => {
      const s = stage([
        { name: 'Walker', weapon: 'GREATSWORD', pos: [560, 196], facing: watch ? 0 : Math.PI, script: { heading: Math.PI, speed: 1 } },
        { name: 'Watched', weapon: 'GREATSWORD', pos: [660, 196], facing: Math.PI },
      ]);
      if (watch) s.scripts.Walker!.targetId = s.f('Watched').id;
      s.run(30);
      const x0 = s.f('Walker').pos.x;
      s.run(60);
      return { dx: x0 - s.f('Walker').pos.x, facing: s.f('Walker').facing };
    };
    const back = walk(true);
    const free = walk(false);
    // Still facing the watched target (within 0.2 rad, so facingMoveMul is within 0.01 of straight back).
    expect(Math.abs(back.facing)).toBeLessThan(0.2);
    expect(back.dx / free.dx).toBeCloseTo(COMBAT.backpedalMoveMul, 1);
  });

  // Ranged attackers plant to shoot: windup, release and recovery are at x0.3 speed.
  it('an archer who keeps shooting covers far less ground', () => {
    const run = (attack: boolean) => {
      const s = stage([
        { name: 'Archer', weapon: 'LONGBOW', pos: [450, 196], facing: 0, script: { heading: Math.PI, speed: 1, attack } },
        { name: 'Mark', weapon: 'GREATSWORD', pos: [650, 196], facing: Math.PI, script: { stance: 'guard' } },
      ]);
      s.scripts.Archer!.targetId = s.f('Mark').id;
      s.run(120);
      return { moved: 450 - s.f('Archer').pos.x, shots: of(s.events, 'projectile').length };
    };
    const shooting = run(true);
    const walking = run(false);
    expect(shooting.shots).toBeGreaterThanOrEqual(2);
    expect(walking.shots).toBe(0);
    expect(shooting.moved / walking.moved).toBeLessThan(0.65);
  });

  // A shot releases only when the shooter faces its target; until then the windup holds.
  it('holds the release until the shooter faces its target', () => {
    const shoot = (facing: number) => {
      const s = stage([
        { name: 'Archer', weapon: 'LONGBOW', pos: [400, 196], facing, script: { attack: true } },
        { name: 'Mark', weapon: 'GREATSWORD', pos: [600, 196], facing: Math.PI, script: { stance: 'guard' } },
      ]);
      s.scripts.Archer!.targetId = s.f('Mark').id;
      while (of(s.events, 'projectile').length === 0 && s.match.state.tick < 120) s.run(1);
      const swing = of(s.events, 'swing')[0]!;
      const shot = of(s.events, 'projectile')[0]!;
      return { delay: shot.tick - swing.tick, facing: s.f('Archer').facing };
    };
    const ready = shoot(0);
    expect(ready.delay).toBe(WEAPONS.LONGBOW.windup);
    const turning = shoot(-0.95);
    expect(turning.delay).toBeGreaterThan(WEAPONS.LONGBOW.windup);
    expect(Math.abs(turning.facing)).toBeLessThanOrEqual(COMBAT.releaseFacingTolerance);
  });

  // Shots are not free: each flies off the aim line by a random angle, never beyond shotSpread. The
  // aim line runs from the muzzle (the bow), where the arrow leaves, to the target.
  it('spreads shots within shotSpread of the aim line', () => {
    const s = stage([
      { name: 'Archer', weapon: 'LONGBOW', pos: [400, 196], facing: 0, script: { attack: true } },
      { name: 'Wall', weapon: 'GREATSWORD', pos: [700, 196], facing: Math.PI, script: { stance: 'guard' } },
    ]);
    s.scripts.Archer!.targetId = s.f('Wall').id;
    s.run(500);
    const shots = of(s.events, 'projectile');
    expect(shots.length).toBeGreaterThanOrEqual(5);
    const limit = shotSpread(0, 300);
    const offs = shots.map((p) => angleDiff(Math.atan2(196 - p.pos.y, 700 - p.pos.x), p.dir));
    for (const o of offs) expect(Math.abs(o)).toBeLessThanOrEqual(limit + 1e-9);
    expect(new Set(offs).size).toBeGreaterThan(1);
    // The shield took every one: a parry per shot, no damage.
    expect(s.f('Wall').damageTaken).toBe(0);
  });

  // Point-blank shots (under 80 px) do half damage: an archer cornered by a brawler is in trouble.
  it('point-blank shots deal half damage', () => {
    const firstHit = (x: number) => {
      const s = stage([
        { name: 'Archer', weapon: 'LONGBOW', pos: [400, 196], facing: 0, script: { attack: true } },
        { name: 'Mark', weapon: 'GREATSWORD', pos: [x, 196], facing: Math.PI },
      ]);
      s.scripts.Archer!.targetId = s.f('Mark').id;
      while (of(s.events, 'hit').length === 0 && s.match.state.tick < 120) s.run(1);
      return of(s.events, 'hit')[0]!.amount;
    };
    const mult = damageMultiplier(BALANCED, false);
    expect(firstHit(460)).toBe(resolveDamage(WEAPONS.LONGBOW.damage, mult * COMBAT.pointBlankMul, BALANCED));
    expect(firstHit(600)).toBe(resolveDamage(WEAPONS.LONGBOW.damage, mult, BALANCED));
  });

  // Melee swings lunge: a target just out of reach when the windup starts still gets hit.
  it('a greatsword lunges into a target that started just out of reach', () => {
    const s = stage([
      { name: 'Swinger', weapon: 'GREATSWORD', pos: [400, 196], facing: 0, script: { attack: true } },
      { name: 'Mark', weapon: 'GREATSWORD', pos: [523, 196], facing: Math.PI },
    ]);
    const mark = s.f('Mark');
    s.scripts.Swinger!.targetId = mark.id;
    expect(Math.hypot(mark.pos.x - 400, 0) - mark.radius).toBeGreaterThan(WEAPONS.GREATSWORD.range + 15);
    while (of(s.events, 'hit').length === 0 && s.match.state.tick < 60) s.run(1);
    const hit = of(s.events, 'hit')[0]!;
    expect(hit.victimId).toBe(mark.id);
    expect(s.f('Swinger').pos.x - 400).toBeCloseTo(WEAPONS.GREATSWORD.lunge, 0);
  });

  // A melee hit on an archer mid-windup cancels the shot and staggers them.
  it('a melee hit interrupts a ranged windup', () => {
    const s = stage([
      { name: 'Archer', weapon: 'LONGBOW', pos: [400, 196], facing: 0, script: { attack: true } },
      { name: 'Mark', weapon: 'GREATSWORD', pos: [600, 196], facing: Math.PI },
      { name: 'Stabber', weapon: 'TWIN_DAGGERS', pos: [350, 196], facing: 0, script: { attack: true } },
    ]);
    s.scripts.Archer!.targetId = s.f('Mark').id;
    s.scripts.Stabber!.targetId = s.f('Archer').id;
    const archer = s.f('Archer');
    let interrupted = -1;
    for (let i = 0; i < 40 && interrupted < 0; i++) {
      const wasWindingUp = archer.anim.phase === 'windup';
      s.run(1);
      const stabbed = of(s.events, 'hit').some((h) => h.victimId === archer.id && h.tick === s.match.state.tick);
      if (wasWindingUp && stabbed) interrupted = s.match.state.tick;
    }
    expect(interrupted).toBeGreaterThan(0);
    expect(archer.anim.phase).toBe('idle');
    expect(archer.stunTicks).toBeGreaterThanOrEqual(COMBAT.interruptStaggerTicks - 1);
    expect(archer.ammo).toBe(WEAPONS.LONGBOW.ammo);
    expect(of(s.events, 'projectile')).toHaveLength(0);
  });

  // Shields in guard stance stop every projectile from the front: a staff orb bursts on the shield
  // and its splash spares the bearer (but not whoever stands next to them).
  it('a raised shield stops a staff orb; the burst spares the bearer', () => {
    const s = stage([
      { name: 'Mage', weapon: 'ARCANE_STAFF', pos: [400, 196], facing: 0, attributes: SHARP, script: { attack: true } },
      { name: 'Guard', weapon: 'WARHAMMER', pos: [600, 196], facing: Math.PI, script: { stance: 'guard' } },
      { name: 'Bystander', weapon: 'TWIN_DAGGERS', pos: [592, 242], facing: 0 },
    ]);
    s.scripts.Mage!.targetId = s.f('Guard').id;
    while (of(s.events, 'projectile_end').length === 0 && s.match.state.tick < 200) s.run(1);
    const end = of(s.events, 'projectile_end')[0]!;
    expect(end.hitId).toBeNull();
    expect(of(s.events, 'parry').some((p) => p.fighterId === s.f('Guard').id)).toBe(true);
    expect(s.f('Guard').damageTaken).toBe(0);
    expect(s.f('Bystander').damageTaken).toBeGreaterThan(0);
  });
});
