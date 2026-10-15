import { describe, expect, it } from 'vitest';
import type { Rect } from '../../core';
import { PIECE_PHYS, createPiece, launchPiece, stepPiece } from './pieces';
import type { Piece, PieceSink } from './pieces';
import type { StreakStamp } from './streaks';

type Log = { impacts: number[]; streaks: StreakStamp[]; walls: number[] };

function sink(log: Log): PieceSink {
  return {
    impact: (_p, s) => log.impacts.push(s),
    streak: (_p, st) => log.streaks.push({ ...st }),
    wall: (_p, s) => log.walls.push(s),
  };
}

function simulate(p: Piece, walls: Rect[], seconds: number, dt = 1 / 60): Log {
  const log: Log = { impacts: [], streaks: [], walls: [] };
  const s = sink(log);
  for (let t = 0; t < seconds; t += dt) {
    stepPiece(p, dt, walls, () => 0.5, s);
    expect(p.z).toBeGreaterThanOrEqual(0);
  }
  return log;
}

function thrown(part: Parameters<typeof launchPiece>[1], vx: number, vz: number): Piece {
  const p = createPiece();
  p.active = true;
  return launchPiece(p, part, 100, 100, 12, vx, 0, vz, 0, 8);
}

describe('flying pieces', () => {
  // Gibs must come to rest on the floor (they stay there for the rest of the match).
  it('arcs, bounces, slides and settles on the floor', () => {
    const p = thrown('skull', 260, 300);
    const log = simulate(p, [], 6);
    expect(p.settled).toBe(true);
    expect(p.z).toBe(0);
    expect(p.spin).toBe(0);
    expect(log.impacts.length).toBeGreaterThan(1);
    expect(log.impacts[1]).toBeLessThan(log.impacts[0]);
    expect(p.x).toBeGreaterThan(150);
  });

  it('bounces bone more than meat', () => {
    const bone = thrown('skull', 0, 400);
    const meat = thrown('heart', 0, 400);
    const b = simulate(bone, [], 4).impacts.length;
    const m = simulate(meat, [], 4).impacts.length;
    expect(b).toBeGreaterThan(m);
    expect(b).toBeLessThanOrEqual(PIECE_PHYS.maxBounces + 1);
  });

  // A limb skidding over the floor paints its path; the streak thins as it slows.
  it('streaks blood along the slide path, thinning as it slows', () => {
    const p = thrown('limbArm', 420, 0);
    p.z = 0;
    const log = simulate(p, [], 4);
    const smears = log.streaks.filter((s) => !s.fleck);
    expect(smears.length).toBeGreaterThan(4);
    expect(smears[smears.length - 1].width).toBeLessThan(smears[0].width);
    for (const s of log.streaks) expect(s.y).toBeCloseTo(100, 6);
    const lastX = log.streaks[log.streaks.length - 1].x;
    expect(lastX).toBeLessThanOrEqual(p.x + 1e-6);
  });

  it('never streaks clean metal (helmets and weapons)', () => {
    const p = thrown('weapon_GREATSWORD', 400, 0);
    p.z = 0;
    expect(simulate(p, [], 3).streaks.length).toBe(0);
  });

  // Gore must not end up inside or behind walls and pillars.
  it('stops at a wall instead of passing through it', () => {
    const wall: Rect = { x: 160, y: 0, w: 40, h: 300 };
    const p = thrown('ribcage', 900, 120);
    const log = simulate(p, [wall], 5);
    expect(p.x + p.radius).toBeLessThanOrEqual(wall.x + 0.5);
    expect(log.walls.length).toBeGreaterThan(0);
  });

  it('does not tunnel through a thin pillar even in a long frame', () => {
    const pillar: Rect = { x: 150, y: 60, w: 10, h: 80 };
    const p = thrown('eyeball', 1500, 0);
    p.z = 0;
    simulate(p, [pillar], 1, 1 / 10);
    expect(p.x).toBeLessThan(pillar.x);
  });

  it('rolling helmets curve away instead of sliding straight', () => {
    const p = thrown('helmet_WARHAMMER', 300, 0);
    p.z = 0;
    simulate(p, [], 3);
    expect(Math.abs(p.y - 100)).toBeGreaterThan(5);
    expect(p.tumble).toBeGreaterThan(0);
  });

  it('leaves settled and inactive pieces alone', () => {
    const p = thrown('jaw', 100, 0);
    p.settled = true;
    const x = p.x;
    simulate(p, [], 1);
    expect(p.x).toBe(x);
    const q = thrown('jaw', 100, 0);
    q.active = false;
    simulate(q, [], 1);
    expect(q.x).toBe(100);
  });
});
