import { describe, expect, it } from 'vitest';
import { PERCEPTION, angleDiff, hearingRadius, turnRate, visionRange } from '../core';
import type { KnownFighter } from '../core';
import { BALANCED, stage } from './testkit';

/**
 * Observer (greatsword) at `obs` facing `facing`, a still target at `target`. Returns what the
 * observer's brain was told about the target at its first think (tick 6), plus the world query.
 */
function look(obs: [number, number], facing: number, target: [number, number], perception = 16) {
  const s = stage([
    { name: 'Observer', weapon: 'GREATSWORD', pos: obs, facing, attributes: { perception } },
    { name: 'Target', weapon: 'TWIN_DAGGERS', pos: target, facing: 0 },
  ]);
  s.run(6);
  const known = s.lastView('Observer').known.find((k) => k.id === s.f('Target').id) ?? null;
  return { known, world: s.lastView('Observer').world, s };
}

describe('vision', () => {
  // Pillars are cover: standing behind one must hide you from someone who would otherwise see you.
  it('walls and pillars block vision', () => {
    const open = look([400, 196], 0, [700, 196]);
    expect(open.world.losBlocked({ x: 400, y: 196 }, { x: 700, y: 196 })).toBe(false);
    expect(open.known?.seen).toBe(true);
    expect(open.s.f('Target').seen).toBe(true);

    // Same distance (300 px), but the pit pillar at (449, 366) stands in between.
    const hidden = look([299, 366], 0, [599, 366]);
    expect(hidden.world.losBlocked({ x: 299, y: 366 }, { x: 599, y: 366 })).toBe(true);
    expect(hidden.world.lightAt({ x: 599, y: 366 })).toBeGreaterThan(PERCEPTION.shadowLight);
    expect(hidden.known).toBeNull();
    expect(hidden.s.f('Target').seen).toBe(false);
  });

  // Darkness is the lurker's tool: a target in shadow is only seen at 45% of vision range.
  it('a target in shadow is seen only at reduced range', () => {
    const range = visionRange({ vitality: 20, power: 16, agility: 20, perception: 4, armor: 14, haste: 14 }, 'GREATSWORD');
    const shadowRange = range * PERCEPTION.shadowVisionMul;

    // In the dark band between the west gate and the pillar ring, 200 px away: beyond shadow range.
    const far = look([440, 430], Math.PI, [240, 430], 4);
    expect(far.world.lightAt({ x: 240, y: 430 })).toBeLessThan(PERCEPTION.shadowLight);
    expect(200).toBeGreaterThan(shadowRange);
    expect(far.known).toBeNull();

    // The same distance into the lit centre: seen.
    const lit = look([440, 430], 0, [640, 430], 4);
    expect(lit.world.lightAt({ x: 640, y: 430 })).toBeGreaterThan(PERCEPTION.shadowLight);
    expect(200).toBeLessThan(range);
    expect(lit.known?.seen).toBe(true);

    // Closer than the shadow range: seen even in the dark.
    const near = look([440, 430], Math.PI, [320, 430], 4);
    expect(near.world.lightAt({ x: 320, y: 430 })).toBeLessThan(PERCEPTION.shadowLight);
    expect(120).toBeLessThan(shadowRange);
    expect(near.known?.seen).toBe(true);
  });

  it('only sees inside the vision cone', () => {
    const behind = look([400, 196], Math.PI, [700, 196]);
    expect(behind.known).toBeNull();
  });
});

describe('hearing and memory', () => {
  /**
   * Observer (greatsword, perception 16) at `obs` facing `facing`; a longbow target at `target`
   * walking along `heading` (fast, so it counts as noisy). Returns the observer's record of it at
   * its think on tick 18, when the target is up to speed.
   */
  function listen(obs: [number, number], facing: number, target: [number, number], heading: number) {
    const s = stage([
      { name: 'Observer', weapon: 'GREATSWORD', pos: obs, facing },
      { name: 'Target', weapon: 'LONGBOW', pos: target, facing: heading, script: { heading, speed: 1 } },
    ]);
    s.run(18);
    const v = s.lastView('Observer');
    const t = s.f('Target');
    return { s, v, t, k: v.known.find((x) => x.id === t.id) ?? null, d: Math.hypot(t.pos.x - obs[0], t.pos.y - obs[1]) };
  }
  const open = hearingRadius(BALANCED) * PERCEPTION.hearingFastMul;
  const muffled = open * PERCEPTION.hearingWallMul;

  // Hearing is 360 degrees, but a wall or pillar halves it: you can hear someone right behind a
  // pillar, not across the room through it. And hearing never says exactly where they are.
  it('hears through a pillar only within the muffled radius, and only roughly', () => {
    // The pit pillar at (449, 366) stands between them, about 98 px apart: inside the muffled radius.
    const near = listen([449, 316], -Math.PI / 2, [449, 412], 0);
    expect(near.v.world.losBlocked({ x: 449, y: 316 }, near.t.pos)).toBe(true);
    expect(near.d).toBeLessThan(muffled);
    expect(near.k?.seen).toBe(false);
    expect(near.k?.heard).toBe(true);
    expect(near.k!.lastSeenTick).toBe(-1);
    expect(near.k!.estimateError).toBeGreaterThan(0);
    expect(near.k!.pos).not.toEqual(near.t.pos);

    // Same pillar, about 135 px: within open-air hearing but beyond the muffled radius. Unheard.
    const far = listen([449, 316], -Math.PI / 2, [449, 450], 0);
    expect(far.v.world.losBlocked({ x: 449, y: 316 }, far.t.pos)).toBe(true);
    expect(far.d).toBeGreaterThan(muffled);
    expect(far.d).toBeLessThan(open);
    expect(far.k).toBeNull();

    // About 150 px across open floor, behind the listener: heard.
    const clear = listen([400, 196], Math.PI, [530, 196], 0);
    expect(clear.v.world.losBlocked({ x: 400, y: 196 }, clear.t.pos)).toBe(false);
    expect(clear.d).toBeGreaterThan(muffled);
    expect(clear.k?.heard).toBe(true);
  });

  // Losing sight of someone does not erase them: brains can hunt the last known position.
  it('remembers an enemy after losing sight, at its last seen position, then forgets', () => {
    const s = stage([
      { name: 'Observer', weapon: 'GREATSWORD', pos: [400, 196], facing: 0 },
      { name: 'Target', weapon: 'TWIN_DAGGERS', pos: [700, 196], facing: 0 },
    ]);
    s.run(6);
    expect(s.lastView('Observer').known[0]?.seen).toBe(true);
    // Teleport the target out of sight, far beyond hearing.
    s.f('Target').pos.x = 1250;
    s.f('Target').pos.y = 700;
    s.run(60);
    const k = s.lastView('Observer').known[0]!;
    expect(k.seen).toBe(false);
    expect(k.heard).toBe(false);
    expect(k.lastSeenPos).toEqual({ x: 700, y: 196 });
    s.run(PERCEPTION.memoryTicks);
    expect(s.lastView('Observer').known).toHaveLength(0);
  });
});

describe('fog of war', () => {
  type Staged = ReturnType<typeof stage>;
  /** What `observer` knows of `target` right now (the live record, as render and the inspector read it). */
  const recordOf = (s: Staged, observer: string, target: string): KnownFighter | null =>
    s.match.knowledge(s.f(observer).id).find((k) => k.id === s.f(target).id) ?? null;

  // Spec invariant: losing sight means losing the target. A record must not follow a fighter the
  // observer can neither see nor hear, however far or often it moves; otherwise heads and aim
  // track enemies through walls and fighters look omniscient.
  it('a target behind a wall beyond hearing range moves freely without the record changing', () => {
    const s = stage([
      { name: 'Observer', weapon: 'GREATSWORD', pos: [400, 196], facing: 0 },
      { name: 'Target', weapon: 'TWIN_DAGGERS', pos: [550, 196], facing: Math.PI },
    ]);
    s.run(6);
    expect(recordOf(s, 'Observer', 'Target')?.seen).toBe(true);
    // Into the far corner alcove, behind its walls and far beyond hearing.
    const t = s.f('Target');
    t.pos.x = 1250;
    t.pos.y = 790;
    s.run(1);
    const rec = recordOf(s, 'Observer', 'Target')!;
    expect(rec.seen || rec.heard).toBe(false);
    const frozen = JSON.stringify(rec);
    let travelled = 0;
    for (const heading of [Math.PI, 0, -Math.PI / 2, Math.PI, 0]) {
      s.scripts.Target = { heading, speed: 1 };
      for (let i = 0; i < 40; i++) {
        const x = t.pos.x;
        const y = t.pos.y;
        s.run(1);
        travelled += Math.hypot(t.pos.x - x, t.pos.y - y);
        expect(JSON.stringify(recordOf(s, 'Observer', 'Target'))).toBe(frozen);
      }
    }
    expect(travelled).toBeGreaterThan(150);
  });

  // Spec invariant: hearing gives an estimate, never a position. Off by half to all of the error
  // for that distance, moving only when it refreshes, and revealing nothing but rough position.
  it('a heard-only estimate is never exact, stays within its error and only moves on refresh', () => {
    const s = stage([
      { name: 'Listener', weapon: 'GREATSWORD', pos: [400, 196], facing: Math.PI },
      { name: 'Target', weapon: 'TWIN_DAGGERS', pos: [500, 196], facing: 0 },
    ]);
    const t = s.f('Target');
    // Live facts the listener has no way to learn without seeing it.
    t.hp = 7;
    t.kills = 3;
    s.run(6);
    const err = PERCEPTION.hearingErrorBase + PERCEPTION.hearingErrorPerPx * 100;
    const moves: number[] = [];
    const first = recordOf(s, 'Listener', 'Target')!;
    let last = `${first.pos.x},${first.pos.y}`;
    for (let i = 0; i < 300; i++) {
      s.run(1);
      const rec = recordOf(s, 'Listener', 'Target')!;
      expect(rec.heard).toBe(true);
      expect(rec.seen).toBe(false);
      const off = Math.hypot(rec.pos.x - t.pos.x, rec.pos.y - t.pos.y);
      expect(off).toBeGreaterThanOrEqual(err / 2 - 1e-9);
      expect(off).toBeLessThanOrEqual(err + 1e-9);
      expect(rec.estimateError).toBeCloseTo(err, 6);
      expect([rec.hp, rec.kills, rec.lastSeenTick, rec.vel.x, rec.vel.y]).toEqual([t.maxHp, 0, -1, 0, 0]);
      const key = `${rec.pos.x},${rec.pos.y}`;
      if (key !== last) moves.push(s.match.state.tick);
      last = key;
    }
    // A new guess every hearingRefreshTicks, and never in between.
    expect(moves.length).toBeGreaterThanOrEqual(9);
    for (let i = 1; i < moves.length; i++) expect(moves[i]! - moves[i - 1]!).toBe(PERCEPTION.hearingRefreshTicks);
  });

  // `seen_by(target)` and `target.sees_me` must answer from what the asker knows, never from the
  // other fighter's live position and head.
  it('inVisionOf judges another fighter from the asker\'s record, not its live state', () => {
    const s = stage([
      { name: 'A', weapon: 'GREATSWORD', pos: [400, 196], facing: 0 },
      { name: 'B', weapon: 'GREATSWORD', pos: [550, 196], facing: Math.PI },
    ]);
    s.run(6);
    // B slips away into the far alcove and turns its back; A only remembers B facing it.
    const b = s.f('B');
    b.pos.x = 1250;
    b.pos.y = 790;
    b.facing = 0;
    b.headAngle = 0;
    s.run(6);
    const v = s.lastView('A');
    const rec = v.known.find((k) => k.id === b.id)!;
    expect(rec.seen).toBe(false);
    expect(rec.pos).toEqual({ x: 550, y: 196 });
    const a = s.f('A').pos;
    expect(v.world.inVisionOf(rec, a)).toBe(true);
    expect(v.world.inVisionOf({ ...rec, facing: 0 }, a)).toBe(false);
    // Never seen: its facing is unknown, so only range, walls and light count.
    expect(v.world.inVisionOf({ ...rec, facing: 0, lastSeenTick: -1 }, a)).toBe(true);
    // The asker itself is judged by its true head.
    expect(v.world.inVisionOf(v.self, { x: 550, y: 196 })).toBe(true);
    expect(v.world.inVisionOf(v.self, { x: 250, y: 196 })).toBe(false);
  });

  // Search instead of stare: after losing sight the head holds on the last seen spot, then sweeps
  // around it, so the vision cone shows a fighter looking for someone, not tracking them.
  it('the head stares at the last seen spot, then sweeps around it', () => {
    const s = stage([
      { name: 'Hunter', weapon: 'GREATSWORD', pos: [400, 196], facing: 0 },
      { name: 'Prey', weapon: 'TWIN_DAGGERS', pos: [550, 196], facing: 0 },
    ]);
    s.scripts.Hunter!.targetId = s.f('Prey').id;
    s.run(6);
    const prey = s.f('Prey');
    prey.pos.x = 1250;
    prey.pos.y = 790;
    const hunter = s.f('Hunter');
    const atSpot = () => Math.abs(angleDiff(Math.atan2(196 - hunter.pos.y, 550 - hunter.pos.x), hunter.headAngle));
    s.run(PERCEPTION.searchStareTicks);
    expect(atSpot()).toBeLessThan(0.05);
    let widest = 0;
    for (let i = 0; i < PERCEPTION.searchScanTicks; i++) {
      s.run(1);
      widest = Math.max(widest, atSpot());
    }
    expect(widest).toBeGreaterThan(PERCEPTION.searchScanArc / 2 - 0.35);
    expect(widest).toBeLessThan(PERCEPTION.searchScanArc / 2 + 0.05);
  });

  // The cone must not jitter or snap: on a target switch the head turns no faster than its cap and
  // slows down over several ticks as it arrives, instead of running at full rate and stopping dead.
  it('the head eases onto a new target instead of snapping', () => {
    const s = stage([
      { name: 'Hunter', weapon: 'GREATSWORD', pos: [400, 196], facing: 0 },
      { name: 'Ahead', weapon: 'TWIN_DAGGERS', pos: [550, 196], facing: 0 },
      { name: 'Aside', weapon: 'TWIN_DAGGERS', pos: [500, 290], facing: 0 },
    ]);
    s.scripts.Hunter!.targetId = s.f('Ahead').id;
    s.run(36);
    const hunter = s.f('Hunter');
    expect(Math.abs(hunter.headAngle)).toBeLessThan(0.01);
    s.scripts.Hunter!.targetId = s.f('Aside').id;
    const cap = (turnRate(BALANCED, 'GREATSWORD') / 60) * 2.2;
    const steps: number[] = [];
    let prev = hunter.headAngle;
    for (let i = 0; i < 60; i++) {
      s.run(1);
      steps.push(Math.abs(angleDiff(prev, hunter.headAngle)));
      prev = hunter.headAngle;
    }
    expect(Math.max(...steps)).toBeLessThanOrEqual(cap + 1e-9);
    const slowing = steps.filter((x) => x > 1e-3 && x < 0.9 * cap);
    expect(slowing.length).toBeGreaterThanOrEqual(4);
    expect(Math.abs(angleDiff(hunter.headAngle, Math.atan2(94, 100)))).toBeLessThan(0.01);
  });
});
