import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import type { FighterState, WeaponId, WorldState } from '../core';
import { FighterLayer } from './fighters';
import { HIT_STOP_MAX, IMPACT_PROGRESS, hitSeverity } from './rig';
import type { ShadowLayer } from './shadows';

function fighter(id: string, x: number, weapon: WeaponId): FighterState {
  return {
    id, entrantId: id, squad: 0, name: id, color: '#cc4444', weapon, skill: 'DASH',
    attributes: { vitality: 10, power: 10, agility: 10, perception: 10, armor: 10, haste: 10 },
    pos: { x, y: 100 }, vel: { x: 0, y: 0 }, facing: 0, headAngle: 0, radius: 18, hp: 100, maxHp: 100, alive: true, diedAtTick: null,
    anim: { phase: 'idle', t: 0, dur: 0 }, walkPhase: 0, attackCd: 0, skillCd: 0, parryTicks: 0, parryCd: 0, stunTicks: 0,
    ammo: 0, maxAmmo: 0, buffs: { haste: 0, berserk: 0, slow: 0 }, limbs: { armL: true, armR: true, legL: true, legR: true },
    helmet: true, inShadow: false, seen: false, stance: 'normal', hitFlash: 0, eyePop: 0, behaviour: 'x', targetId: null,
    kills: 0, damageDealt: 0, damageTaken: 0, lastHitBy: null, lastHitTick: null, place: null,
  };
}

function world(...fighters: FighterState[]): WorldState {
  return { fighters } as unknown as WorldState;
}

function layer(): FighterLayer {
  const m = new THREE.MeshBasicNodeMaterial();
  const shadows = { body() {} } as unknown as ShadowLayer;
  return new FighterLayer(m, m, () => {}, shadows);
}

const DT = 1 / 60;

// User feedback: hits shook the whole screen. The weight of an ordinary hit now lands on the two
// fighters: they hold still for a few frames, then catch up with the sim in a quick slide.
describe('local hit-stop', () => {
  it('holds victim and melee attacker where they were on screen, then slides them to the live state', () => {
    const fl = layer();
    const victim = fighter('v', 100, 'GREATSWORD');
    const attacker = fighter('a', 60, 'GREATSWORD');
    const s = world(victim, attacker);
    fl.update(s, s, 1, 0, DT, null, null);
    fl.hit('v', 'a', 0, hitSeverity(40, false), IMPACT_PROGRESS.GREATSWORD);
    // The sim knocks the victim back and the attacker steps in; the screen must not follow yet.
    victim.pos.x = 130;
    attacker.pos.x = 70;
    let t = 0;
    while (t < HIT_STOP_MAX - DT) {
      fl.update(s, s, 1, t, DT, null, null);
      t += DT;
      expect(fl.xs[0]).toBe(100);
      expect(fl.xs[1]).toBe(60);
    }
    for (let i = 0; i < 12; i++) fl.update(s, s, 1, (t += DT), DT, null, null);
    expect(fl.xs[0]).toBeCloseTo(130, 6);
    expect(fl.xs[1]).toBeCloseTo(70, 6);
  });

  it('never freezes the shooter of a ranged hit (it stands far from where the shot lands)', () => {
    const fl = layer();
    const victim = fighter('v', 100, 'GREATSWORD');
    const archer = fighter('a', 400, 'LONGBOW');
    const s = world(victim, archer);
    fl.update(s, s, 1, 0, DT, null, null);
    fl.hit('v', null, 0, hitSeverity(20, false), -1);
    archer.pos.x = 410;
    fl.update(s, s, 1, DT, DT, null, null);
    expect(fl.xs[1]).toBe(410);
    expect(fl.xs[0]).toBe(100);
  });

  it('lets hazard ticks squash without stopping, so a body in a saw track does not stutter', () => {
    const fl = layer();
    const victim = fighter('v', 100, 'WARHAMMER');
    const s = world(victim);
    fl.update(s, s, 1, 0, DT, null, null);
    fl.nudge('v', 0, hitSeverity(22, false));
    victim.pos.x = 104;
    fl.update(s, s, 1, DT, DT, null, null);
    expect(fl.xs[0]).toBe(104);
  });

  it('pauses with the game: a hit-stop does not run out while game time stands still', () => {
    const fl = layer();
    const victim = fighter('v', 100, 'WARHAMMER');
    const s = world(victim);
    fl.update(s, s, 1, 0, DT, null, null);
    fl.hit('v', null, 0, 1, -1);
    victim.pos.x = 140;
    for (let i = 0; i < 60; i++) fl.update(s, s, 1, 0, 0, null, null);
    expect(fl.xs[0]).toBe(100);
    fl.resetHits();
    fl.update(s, s, 1, 0, 0, null, null);
    expect(fl.xs[0]).toBe(140);
  });
});
