import { describe, expect, it } from 'vitest';
import {
  FOUNTAIN, LIMB_TRAIL, POOL, SPURT, createTrail, fountainStep, poolRadius, poolStep, spurtStep, startFountain, startPool, startSpurt, startTrail,
  trailStep,
} from './bleeders';
import type { Fountain, GrowingPool, Spurt } from './bleeders';

function spurt(): Spurt {
  const s: Spurt = { active: true, serial: 0, fighterId: '', limb: 'armL', t: 0, next: 0 };
  startSpurt(s, 'f1', 'armR');
  return s;
}

function run(s: Spurt, dt: number, frames: number): number[] {
  const pulses: number[] = [];
  for (let i = 0; i < frames; i++) spurtStep(s, dt, (k) => pulses.push(k));
  return pulses;
}

/** Frames needed to cover `seconds` at step `dt`. */
const frames = (dt: number, seconds: number) => Math.ceil(seconds / dt);

describe('stump spurts', () => {
  // A maimed fighter must be easy to read: the stump pumps for several seconds (it used to stop
  // after about 1 s), then only drips. Not forever, or every maimed fighter would be a fountain.
  it('pulses for several seconds, slowing down, then stops', () => {
    const s = spurt();
    const times: number[] = [];
    const dt = 1 / 60;
    for (let i = 0; i < frames(dt, 8); i++) {
      spurtStep(s, dt, () => times.push(s.t));
    }
    expect(SPURT.duration).toBeGreaterThanOrEqual(3);
    expect(SPURT.duration).toBeLessThanOrEqual(6);
    expect(times.length).toBeGreaterThanOrEqual(8);
    expect(times.length).toBeLessThanOrEqual(20);
    expect(times[times.length - 1]).toBeGreaterThan(3);
    // The heartbeat slows as pressure drops.
    expect(times[times.length - 1] - times[times.length - 2]).toBeGreaterThan(times[1] - times[0]);
    expect(spurtStep(s, dt, () => undefined)).toBe(false);
  });

  it('loses pressure: every pulse is weaker than the one before', () => {
    const pulses = run(spurt(), 1 / 60, frames(1 / 60, 6));
    expect(pulses[0]).toBe(1);
    for (let i = 1; i < pulses.length; i++) expect(pulses[i]).toBeLessThan(pulses[i - 1]);
    expect(pulses[pulses.length - 1]).toBeGreaterThanOrEqual(SPURT.minStrength);
  });

  // Same heartbeat at any frame rate (and in slow motion, where dt is tiny).
  it('pulses the same at 30, 144 fps and in slow motion', () => {
    const a = run(spurt(), 1 / 30, frames(1 / 30, 6));
    const b = run(spurt(), 1 / 144, frames(1 / 144, 6));
    const c = run(spurt(), 1 / 600, frames(1 / 600, 6));
    expect(b.length).toBe(a.length);
    expect(c.length).toBe(a.length);
  });

  it('freezes while paused', () => {
    const s = spurt();
    run(s, 1 / 60, 6);
    expect(run(s, 0, 600)).toEqual([]);
  });
});

describe('spreading death pools', () => {
  function pool(): GrowingPool {
    const p: GrowingPool = { active: true, serial: 0, x: 0, y: 0, radius: 0, angle: 0, seed: 0, duration: 0, t: 0, next: 0 };
    startPool(p, 10, 20, 40, 0, 3);
    return p;
  }

  it('grows monotonically up to its full radius', () => {
    const p = pool();
    let last = 0;
    for (let t = 0; t <= POOL.duration; t += 0.05) {
      const r = poolRadius(p, t);
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
    expect(poolRadius(p, POOL.duration)).toBeCloseTo(40, 6);
    expect(poolRadius(p, POOL.duration * 3)).toBeCloseTo(40, 6);
  });

  it('stamps while spreading and then finishes', () => {
    const p = pool();
    const radii: number[] = [];
    let alive = true;
    for (let i = 0; i < 400 && alive; i++) alive = poolStep(p, 1 / 60, (r) => radii.push(r));
    expect(alive).toBe(false);
    expect(radii.length).toBeGreaterThan(10);
    expect(radii[radii.length - 1]).toBeGreaterThan(radii[0]);
  });
});

describe('death fountain', () => {
  function fountain(): Fountain {
    const f: Fountain = { active: true, serial: 0, x: 0, y: 0, power: 0, t: 0, next: 0 };
    startFountain(f, 5, 6, 1);
    return f;
  }

  function erupt(f: Fountain, dt: number, steps: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < steps; i++) fountainStep(f, dt, (k) => out.push(k));
    return out;
  }

  // A death is an eruption: many pulses in under a second, the first the strongest, then it dies down.
  it('erupts many times within about a second, weakening, then stops', () => {
    const f = fountain();
    const pulses = erupt(f, 1 / 60, frames(1 / 60, 2));
    expect(pulses.length).toBeGreaterThanOrEqual(8);
    expect(pulses[0]).toBe(1);
    for (let i = 1; i < pulses.length; i++) expect(pulses[i]).toBeLessThan(pulses[i - 1]);
    expect(pulses[pulses.length - 1]).toBeGreaterThanOrEqual(FOUNTAIN.minStrength);
    expect(fountainStep(f, 1 / 60, () => undefined)).toBe(false);
    expect(FOUNTAIN.duration).toBeLessThan(1.5);
  });

  it('erupts the same at any frame rate and freezes while paused', () => {
    const a = erupt(fountain(), 1 / 30, frames(1 / 30, 2)).length;
    expect(erupt(fountain(), 1 / 144, frames(1 / 144, 2)).length).toBe(a);
    const f = fountain();
    erupt(f, 1 / 60, 6);
    expect(erupt(f, 0, 600)).toEqual([]);
  });
});

describe('gib ooze', () => {
  // A landed gib bleeds for a second or two, not as long as a whole body.
  it('spreads for its own, shorter duration and then stops', () => {
    const p: GrowingPool = { active: true, serial: 0, x: 0, y: 0, radius: 0, angle: 0, seed: 0, duration: 0, t: 0, next: 0 };
    startPool(p, 0, 0, 20, 0, 1, 1.7);
    expect(poolRadius(p, 1.7)).toBeCloseTo(20, 6);
    let steps = 0;
    let alive = true;
    while (alive && steps < 600) {
      alive = poolStep(p, 1 / 60, () => undefined);
      steps++;
    }
    expect(steps / 60).toBeGreaterThan(1.5);
    expect(steps / 60).toBeLessThan(1.8);
  });
});

describe('severed limb blood trail', () => {
  function shed(dt: number, seconds: number): number[] {
    const tr = createTrail();
    startTrail(tr);
    const drops: number[] = [];
    for (let i = 0; i < frames(dt, seconds); i++) trailStep(tr, dt, (k) => drops.push(k));
    return drops;
  }

  // Both pieces bleed: a limb flying off trails blood in the air, not only where it lands.
  it('sheds a stream of drops in flight that weakens and stops', () => {
    const drops = shed(1 / 60, 3);
    expect(drops.length).toBeGreaterThan(20);
    expect(drops.length).toBeLessThan(80);
    expect(drops[0]).toBeGreaterThan(drops[drops.length - 1]);
    const early = shed(1 / 60, LIMB_TRAIL.duration / 3).length;
    const late = drops.length - shed(1 / 60, (LIMB_TRAIL.duration * 2) / 3).length;
    expect(early).toBeGreaterThan(late * 1.5);
  });

  it('sheds the same number of drops at any frame rate, and none while paused', () => {
    const a = shed(1 / 30, 3).length;
    expect(Math.abs(shed(1 / 144, 3).length - a)).toBeLessThanOrEqual(1);
    const tr = createTrail();
    startTrail(tr);
    let n = 0;
    for (let i = 0; i < 600; i++) trailStep(tr, 0, () => n++);
    expect(n).toBe(0);
  });

  it('does nothing for pieces that never started bleeding', () => {
    let n = 0;
    expect(trailStep(createTrail(), 1 / 60, () => n++)).toBe(false);
    expect(n).toBe(0);
  });
});
