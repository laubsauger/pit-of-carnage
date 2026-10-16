import { describe, expect, it } from 'vitest';
import { RIG_NOMINAL_RADIUS } from '../core';
import type { StuckAmmo } from '../core';
import { FALL_SECONDS, GLINT_PERIOD, QUIVER_SECONDS, bodyPoint, fallPose, floorRotation, glint, quiver, stuckPose } from './ammo';
import type { Pose } from './ammo';

const pose = (): Pose => ({ x: 0, y: 0, angle: 0 });

function stuck(over: Partial<StuckAmmo>): StuckAmmo {
  return { id: 's1', kind: 'arrow', ownerId: 'f0', pos: { x: 100, y: 200 }, angle: 0.5, in: { kind: 'wall' }, pickupPos: { x: 90, y: 200 }, tick: 60, ...over };
}

describe('stuck ammo placement', () => {
  // The contract's body frame: u ahead along facing, v toward the right hand. With angles measured
  // from +x toward +y (clockwise on screen), the right hand of a fighter facing east is south.
  it('reads the body frame the way the sim writes it', () => {
    const p = bodyPoint(10, 20, 0, 5, 3, pose());
    expect(p.x).toBeCloseTo(15, 9);
    expect(p.y).toBeCloseTo(23, 9);
    const q = bodyPoint(0, 0, Math.PI / 2, RIG_NOMINAL_RADIUS, 0, pose());
    expect(q.x).toBeCloseTo(0, 9);
    expect(q.y).toBeCloseTo(RIG_NOMINAL_RADIUS, 9);
  });

  // A pincushion must ride along: the arrow moves and turns with the body as drawn this frame, not
  // with the sim's last tick, or it would lag and slide off a running fighter.
  it('pins ammo in a body to the body as drawn, turning with it', () => {
    const s = stuck({ in: { kind: 'fighter', fighterId: 'f1', u: 0, v: 18, turn: Math.PI / 2 }, pickupPos: null });
    const a = stuckPose(s, { x: 300, y: 300, facing: 0 }, pose());
    expect(a.x).toBeCloseTo(300, 9);
    expect(a.y).toBeCloseTo(318, 9);
    expect(a.angle).toBeCloseTo(Math.PI / 2, 9);
    const b = stuckPose(s, { x: 340, y: 300, facing: Math.PI }, pose());
    expect(b.x).toBeCloseTo(340, 9);
    expect(b.y).toBeCloseTo(282, 9);
    expect(b.angle).toBeCloseTo(Math.PI * 1.5, 9);
  });

  it('keeps ammo in walls where the sim put it, and uses the world pose for an off-screen body', () => {
    const w = stuckPose(stuck({}), null, pose());
    expect([w.x, w.y, w.angle]).toEqual([100, 200, 0.5]);
    const body = stuck({ in: { kind: 'fighter', fighterId: 'gone', u: 1, v: 2, turn: 3 } });
    const b = stuckPose(body, null, pose());
    expect([b.x, b.y, b.angle]).toEqual([100, 200, 0.5]);
  });
});

describe('quiver, fall and glint', () => {
  it('quivers right after it sticks, then settles completely', () => {
    let peak = 0;
    for (let t = 0; t < QUIVER_SECONDS; t += 0.005) peak = Math.max(peak, Math.abs(quiver(t)));
    expect(peak).toBeGreaterThan(0.1);
    expect(quiver(QUIVER_SECONDS)).toBe(0);
    expect(quiver(5)).toBe(0);
    // Before the stick (interpolating toward its tick) nothing wobbles.
    expect(quiver(-0.01)).toBe(0);
    expect(Math.abs(quiver(QUIVER_SECONDS * 0.8))).toBeLessThan(peak * 0.1);
  });

  // A dropped piece must end exactly where the floor item lies, at the angle the floor draws it,
  // or it would jump when the fall hands over to the floor item.
  it('lands a falling piece exactly on its floor item', () => {
    const from = { x: 50, y: 60, angle: 2 };
    const to = { x: 80, y: 40, angle: floorRotation('i42') };
    const out = pose();
    expect(fallPose(from, to, 2 * Math.PI, 1, out)).toBeCloseTo(1, 9);
    expect(out).toEqual(to);
    fallPose(from, to, 2 * Math.PI, 0, out);
    expect(out).toEqual(from);
    // Mid-fall it is above the floor: bigger, between the two spots.
    const mid = fallPose(from, to, 2 * Math.PI, 0.5, out);
    expect(mid).toBeGreaterThan(1.1);
    expect(out.x).toBeGreaterThan(50);
    expect(out.x).toBeLessThan(80);
    expect(FALL_SECONDS).toBeLessThan(0.6);
  });

  // Lying ammo should say "pick me up" without twinkling constantly: a short glint once a period,
  // each piece on its own beat so they never flash in unison.
  it('glints briefly once a period, out of step between pieces', () => {
    let on = 0;
    const steps = 1000;
    for (let i = 0; i < steps; i++) if (glint((i / steps) * GLINT_PERIOD, 0.3) > 0) on++;
    expect(on / steps).toBeGreaterThan(0.03);
    expect(on / steps).toBeLessThan(0.2);
    let together = 0;
    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * GLINT_PERIOD;
      if (glint(t, 0.1) > 0 && glint(t, 0.6) > 0) together++;
    }
    expect(together).toBe(0);
  });

  it('rests a floor item at the same angle every frame', () => {
    expect(floorRotation('i7')).toBe(floorRotation('i7'));
    expect(floorRotation('i7')).toBeGreaterThanOrEqual(0);
    expect(floorRotation('i7')).toBeLessThan(6.3);
  });
});
