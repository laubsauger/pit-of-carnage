import { afterEach, describe, expect, it } from 'vitest';
import { BLEED_RULES, PICKUP_RULES } from '../core';
import type { GameEvent } from '../core';
import { createMatch } from './match';
import { seekerBrain, stage, testConfig } from './testkit';

type Ev<T extends GameEvent['type']> = Extract<GameEvent, { type: T }>;
const of = <T extends GameEvent['type']>(events: GameEvent[], type: T) => events.filter((e): e is Ev<T> => e.type === type);

/** BLEED_RULES as the harness switches it on for a trial (the shipped table stays as it is). */
const TRIAL = { enabled: true, intervalTicks: 30, limbLossTicks: 240, limbLossDamage: 4, backstabTicks: 150, backstabDamage: 5, maxTicks: 300, shrineCures: true };
const SHIPPED = { ...BLEED_RULES };
const rules = BLEED_RULES as unknown as Record<string, unknown>;

afterEach(() => Object.assign(rules, SHIPPED));

describe('bleeding', () => {
  // A candidate rule must do nothing at all while it is off: no wounds, no bleed damage, no
  // `bleeding` on any record, so turning it off is a true off switch.
  it('nobody bleeds over whole matches while the rule is off', () => {
    expect(BLEED_RULES.enabled).toBe(false);
    for (const seed of [1, 2]) {
      const m = createMatch(testConfig({ seed, fighters: 8, weapons: ['TWIN_DAGGERS', 'GREATSWORD', 'WARHAMMER', 'LONGBOW'] }), seekerBrain);
      while (!m.isOver && m.state.tick < 20000) {
        const events = m.step();
        expect(events.some((e) => e.type === 'hit' && e.source === 'bleed')).toBe(false);
        for (const f of m.state.fighters) expect(f.bleed ?? null).toBeNull();
      }
      for (const f of m.state.fighters) for (const k of m.knowledge(f.id)) expect(k.bleeding ?? false).toBe(false);
    }
  });

  // Switched on: a dagger in the back opens a wound that keeps hurting after the stab, the damage
  // is credited to the stabber (reports and kill credit), and the bleeding shows on what the
  // victim's enemies see.
  it('a dagger backstab opens a wound that bleeds over time and credits the stabber', () => {
    Object.assign(rules, TRIAL);
    const s = stage([
      { name: 'Stabber', weapon: 'TWIN_DAGGERS', pos: [600, 196], facing: 0, script: { attack: true } },
      { name: 'Victim', weapon: 'GREATSWORD', pos: [650, 196], facing: 0 },
    ]);
    s.scripts.Stabber!.targetId = s.f('Victim').id;
    while (!of(s.events, 'hit').some((h) => h.backstab) && s.match.state.tick < 60) s.run(1);
    s.scripts.Stabber = {};
    const v = s.f('Victim');
    expect(v.bleed).toMatchObject({ damagePerTick: TRIAL.backstabDamage, sourceId: s.f('Stabber').id });
    // Walk the stabber away so only the wound hurts from here on.
    s.f('Stabber').pos.x = 300;
    s.f('Stabber').pos.y = 760;
    s.run(TRIAL.backstabTicks + 30);
    const bleeds = of(s.events, 'hit').filter((h) => h.source === 'bleed');
    expect(bleeds.length).toBe(TRIAL.backstabTicks / TRIAL.intervalTicks);
    expect(bleeds.every((h) => h.attackerId === s.f('Stabber').id && h.amount === TRIAL.backstabDamage)).toBe(true);
    expect(v.bleed ?? null).toBeNull();
  });

  it('a shrine heal stops the bleeding', () => {
    Object.assign(rules, TRIAL);
    const s = stage([
      { name: 'Stabber', weapon: 'TWIN_DAGGERS', pos: [600, 196], facing: 0, script: { attack: true } },
      { name: 'Victim', weapon: 'GREATSWORD', pos: [650, 196], facing: 0 },
    ]);
    s.scripts.Stabber!.targetId = s.f('Victim').id;
    while (!s.f('Victim').bleed && s.match.state.tick < 60) s.run(1);
    s.scripts.Stabber = {};
    s.f('Stabber').pos.x = 300;
    s.f('Stabber').pos.y = 760;
    // Onto the pit's shrine (its centre).
    const v = s.f('Victim');
    v.pos.x = 680;
    v.pos.y = 430;
    s.run(2);
    expect(of(s.events, 'heal').some((h) => h.fighterId === v.id && h.shrineId !== null)).toBe(true);
    expect(v.bleed ?? null).toBeNull();
    expect(PICKUP_RULES.shrine.cooldownTicks).toBeGreaterThan(0);
  });
});
