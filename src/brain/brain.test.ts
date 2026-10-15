import { afterEach, describe, expect, it, vi } from 'vitest';
import { Rng, STEER_DIRS, THINK_EVERY_TICKS } from '../core';
import type { Behaviour, Decision, KnownFighter, Strategy, ValidStrategy } from '../core';
import { requireValidStrategy } from '../strategy';
import { createBrain as createValidBrain } from './brain';
import { compileExpression, compilePlace, compileStrategy, compileZone, worstThinkCost } from './compile';
import { ExprError } from './expr';
import { enemy, fakeWorld, fighter, randomView, view } from './test-world';
import { GUARDS } from './tuning';

const ATTRS = { vitality: 17, power: 17, agility: 17, perception: 17, armor: 16, haste: 16 };

/** Test strategies go through the same gate as everything else before they reach a brain. */
const createBrain = (s: Strategy) => createValidBrain(requireValidStrategy(s, 'test'));

function strat(behaviours: Record<string, Behaviour>, over: Partial<Strategy> = {}): Strategy {
  return {
    schema: 'pit-strategy/2', name: 'Test', build: { weapon: 'GREATSWORD', skill: 'DASH', attributes: ATTRS },
    target: '0 - it.distance', behaviours, commit: 0, ...over,
  };
}

function argmax(xs: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i]! > xs[best]!) best = i;
  return best;
}

function nameError(fn: () => unknown): ExprError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExprError) return e;
    throw e;
  }
  throw new Error('expected an ExprError');
}

describe('name resolution', () => {
  const none = new Set<string>();

  // Unknown names are the most common mistake in hand- and LLM-written strategies; a precise
  // suggestion is what turns a failed paste into a one-word fix.
  it('suggests the right sensor for a typo, a missing prefix and a word from other games', () => {
    expect(nameError(() => compileExpression('self.helth < 0.3', 'behaviour', none)).suggestion).toBe('self.hp');
    expect(nameError(() => compileExpression('distance < 100', 'behaviour', none)).suggestion).toBe('target.distance');
    expect(nameError(() => compileExpression('in_range and self.hp > 0.5', 'behaviour', none)).suggestion).toBe('target.in_reach');
  });

  it('keeps it.* inside the target expression and target.* outside it', () => {
    // target.* cannot be read while the target is still being chosen; it.* means nothing elsewhere.
    expect(nameError(() => compileExpression('it.hp', 'behaviour', none)).suggestion).toBe('target.hp');
    expect(nameError(() => compileExpression('target.hp', 'target', none)).suggestion).toBe('it.hp');
    expect(() => compileExpression('it.hp + self.hp', 'target', none)).not.toThrow();
  });

  it('resolves declared memory slots and nothing else', () => {
    expect(() => compileExpression('struck_at + 1', 'behaviour', new Set(['struck_at']))).not.toThrow();
    expect(nameError(() => compileExpression('struck + 1', 'behaviour', new Set(['struck_at']))).suggestion).toBe('struck_at');
  });

  it('checks place and zone arguments', () => {
    expect(() => compilePlace('beyond(hazard_near(target), target, 85)')).not.toThrow();
    expect(() => compilePlace('behind(target)')).toThrow(/behind takes 2 arguments/);
    expect(() => compilePlace('behind(enemies, 30)')).toThrow(/must be a fighter/);
    expect(() => compilePlace('side(target, 270, 40)')).toThrow(/between -180 and 180/);
    expect(nameError(() => compilePlace('nearest_enmy')).suggestion).toBe('nearest_enemy');
    expect(() => compileZone('seen_by(enemies)')).not.toThrow();
    expect(() => compileZone('target')).toThrow(/is a place, not a zone/);
    expect(nameError(() => compilePlace('shadow')).suggestion).toBe('dark_spot');
  });
});

describe('behaviour choice', () => {
  // Two behaviours whose scores trade a 0.1 lead every think (a memory slot toggles each think).
  const flipper = (commit: number) =>
    strat(
      {
        a: { score: '0.5 + 0.1 * flip', move: [], attack: 'never', set: { flip: '1 - flip' } },
        b: { score: '0.5 + 0.1 * (1 - flip)', move: [], attack: 'never', set: { flip: '1 - flip' } },
      },
      { memory: { flip: 0 }, commit },
    );

  function behaviours(s: Strategy, thinks: number): string[] {
    const brain = createBrain(s);
    const rng = new Rng(1);
    const world = fakeWorld();
    const out: string[] = [];
    for (let i = 0; i < thinks; i++) out.push(brain.think(view(fighter(), [], world, { tick: i * THINK_EVERY_TICKS }), rng).behaviour);
    return out;
  }

  it('commit hysteresis stops two close behaviours from flip-flopping every think', () => {
    const committed = behaviours(flipper(600), 10);
    expect(new Set(committed).size).toBe(1);
    // Without commit the same strategy switches on every think, which is what the bonus prevents.
    const uncommitted = behaviours(flipper(0), 10);
    const switches = uncommitted.filter((b, i) => i > 0 && b !== uncommitted[i - 1]).length;
    expect(switches).toBe(9);
  });

  it('the commit bonus wears off after commit ticks', () => {
    // Started at tick 0 with commit 30: thinks at ticks 6..24 keep it, the think at tick 30 may switch.
    const seq = behaviours(flipper(30), 7);
    expect(seq.slice(0, 5).every((b) => b === seq[0])).toBe(true);
    expect(seq[5]).not.toBe(seq[0]);
  });

  it('reports every behaviour score so the inspector can show why one won', () => {
    const brain = createBrain(strat({ low: { score: '0.2', move: [], attack: 'never' }, high: { score: '0.7', move: [], attack: 'never' } }));
    const d = brain.think(view(fighter(), [], fakeWorld()), new Rng(1));
    expect(d.behaviour).toBe('high');
    expect(d.scores).toEqual({ low: 0.2, high: 0.7 });
  });
});

describe('steering terms', () => {
  const seekTarget = strat({ go: { score: '1', move: [{ seek: 'target', weight: 1 }], attack: 'never' } });

  it('seek rates the direction toward its place highest and walks there at full speed', () => {
    const world = fakeWorld();
    // East of me: direction 0.
    let d = createBrain(seekTarget).think(view(fighter(), [enemy('e', { pos: { x: 600, y: 300 } })], world), new Rng(1));
    expect(argmax(d.terms[0]!.ratings)).toBe(0);
    expect(argmax(d.ring)).toBe(0);
    expect(d.heading).toBeCloseTo(0, 5);
    expect(d.speed).toBe(1);
    // South-west of me (135°): direction 6 of 16.
    d = createBrain(seekTarget).think(view(fighter(), [enemy('e', { pos: { x: 100, y: 500 } })], world), new Rng(1));
    expect(argmax(d.terms[0]!.ratings)).toBe(6);
    expect(d.heading).toBeCloseTo((3 * Math.PI) / 4, 5);
  });

  it('seek stops when it arrives instead of pushing into the target', () => {
    const me = fighter();
    const d = createBrain(seekTarget).think(view(me, [enemy('e', { pos: { x: 300 + me.radius + 10, y: 300 } })], fakeWorld()), new Rng(1));
    expect(d.speed).toBe(0);
  });

  // Light to the east of x = 400 is gone: that half of the map is shadow.
  const darkEast = fakeWorld({ light: (p) => (p.x > 400 ? 0 : 1) });
  const east = 0;
  const west = STEER_DIRS / 2;

  it('avoid lowers directions entering a zone and leaves the others alone', () => {
    const s = strat({ hide: { score: '1', move: [{ avoid: 'shadow', weight: 1 }], attack: 'never' } });
    const d = createBrain(s).think(view(fighter({ pos: { x: 360, y: 300 } }), [], darkEast), new Rng(1));
    const r = d.terms[0]!.ratings;
    expect(r[east]!).toBeLessThan(-0.2);
    expect(r[west]!).toBe(0);
    // Nothing to gain by moving: avoid alone never makes a fighter walk out of a lit spot.
    expect(d.speed).toBe(0);
  });

  it('avoid pushes out of a zone you stand in, prefer pulls into it', () => {
    const avoid = strat({ out: { score: '1', move: [{ avoid: 'shadow', weight: 1 }], attack: 'never' } });
    const inside = createBrain(avoid).think(view(fighter({ pos: { x: 430, y: 300 } }), [], darkEast), new Rng(1));
    const r = inside.terms[0]!.ratings;
    expect(r[west]!).toBe(Math.max(...r));
    expect(r[west]!).toBeGreaterThan(0.5);
    expect(r[east]!).toBeLessThanOrEqual(0);

    const prefer = strat({ in: { score: '1', move: [{ prefer: 'shadow', weight: 1 }], attack: 'never' } });
    const outside = createBrain(prefer).think(view(fighter({ pos: { x: 360, y: 300 } }), [], darkEast), new Rng(1));
    expect(argmax(outside.ring)).toBe(east);
    expect(outside.speed).toBeGreaterThan(0);
  });

  it('behind() circles round the target instead of walking through its front', () => {
    const s = strat({ flank: { score: '1', move: [{ seek: 'behind(target, 36)', weight: 1 }], attack: 'never' } });
    // The target stands east of me and faces me (west): its back is the far side.
    const t = enemy('t', { pos: { x: 500, y: 300 }, facing: Math.PI });
    const front = createBrain(s).think(view(fighter(), [t], fakeWorld()), new Rng(1));
    // The waypoint swings 60° round the target, so I head off-line (direction 1), not straight at it (0).
    expect(argmax(front.terms[0]!.ratings)).toBe(1);
    // Once behind it, the point is straight behind its back: from the east I head west.
    const behind = createBrain(s).think(view(fighter({ pos: { x: 580, y: 300 } }), [t], fakeWorld()), new Rng(1));
    expect(argmax(behind.terms[0]!.ratings)).toBe(west);
  });

  it('goes round a pillar between it and its target instead of stopping at it', () => {
    const me = fighter();
    // A pillar touching my east side, the target straight behind it.
    const pillar = fakeWorld({ pillars: [{ x: 300 + me.radius + 1, y: 250, w: 40, h: 100 }] });
    const s = strat({ go: { score: '1', move: [{ seek: 'target', weight: 1 }], attack: 'never' } });
    const d = createBrain(s).think(view(me, [enemy('e', { pos: { x: 600, y: 300 } })], pillar), new Rng(1));
    // Danger shows as a negative term on the blocked side...
    expect(d.terms.at(-1)!.ratings[east]!).toBeLessThan(-0.9);
    // ...and the fighter slides along the pillar at full speed rather than standing still.
    expect(d.speed).toBe(1);
    expect(Math.abs(Math.cos(d.heading))).toBeLessThan(0.5);
  });

  it('does not pick a direction its body would clip a wall corner on', () => {
    // Found in a real catacombs match: standing on a wall 2 px from its end, target behind it.
    // A single ray from the front of the body clears the corner at 67.5°, but the body does not,
    // and the fighter stood pinned against the corner for seconds.
    const wall = fakeWorld({ walls: [{ x: 825, y: 540, w: 160, h: 50 }] });
    const s = strat({ go: { score: '1', move: [{ seek: 'target', weight: 1 }], attack: 'never' } });
    const self = fighter({ pos: { x: 983, y: 517 }, radius: 23.4 });
    const d = createBrain(s).think(view(self, [enemy('e', { pos: { x: 965, y: 609 } })], wall), new Rng(1));
    expect(d.terms.at(-1)!.ratings[3]!).toBeLessThan(-0.5);
    expect(argmax(d.ring)).not.toBe(3);
    expect(d.speed).toBeGreaterThan(0);
  });

  it('still walks straight at a target when a wall is near but not in the way', () => {
    const wall = fakeWorld({ walls: [{ x: 0, y: 240, w: 1000, h: 20 }] });
    const s = strat({ go: { score: '1', move: [{ seek: 'target', weight: 1 }], attack: 'never' } });
    const d = createBrain(s).think(view(fighter(), [enemy('e', { pos: { x: 600, y: 300 } })], wall), new Rng(1));
    expect(argmax(d.ring)).toBe(east);
    expect(d.speed).toBe(1);
  });
});

describe('targeting and actions', () => {
  // A and B are both 200 px away. A faces me; B shows me its back.
  const a = (): KnownFighter => enemy('A', { pos: { x: 500, y: 300 }, facing: Math.PI });
  const b = (dx = 0): KnownFighter => enemy('B', { pos: { x: 100 - dx, y: 300 }, facing: Math.PI });
  const idle = { score: '1', move: [], attack: 'never' } satisfies Behaviour;

  function target(expr: string, known: KnownFighter[]): string | null {
    return createBrain(strat({ idle }, { target: expr })).think(view(fighter(), known, fakeWorld()), new Rng(1)).targetId;
  }

  it('the target expression prefers a facing-away enemy when weighted to', () => {
    expect(target('100 * it.facing_away - it.distance', [a(), b()])).toBe('B');
    expect(target('100 * it.facing_away - it.distance', [a(), b(60)])).toBe('B');
    // Without the weight, the nearer enemy wins, and on a tie the first listed.
    expect(target('0 - it.distance', [a(), b(60)])).toBe('A');
    expect(target('0 - it.distance', [a(), b()])).toBe('A');
  });

  it('it.is_target lets a strategy stay on its previous target', () => {
    const brain = createBrain(strat({ idle }, { target: '0 - it.distance + 100 * it.is_target' }));
    const world = fakeWorld();
    expect(brain.think(view(fighter(), [a(), b(60)], world), new Rng(1)).targetId).toBe('A');
    // B is now slightly nearer, but not by enough to beat the stickiness.
    const nearB = enemy('B', { pos: { x: 120, y: 300 } });
    const farA = enemy('A', { pos: { x: 530, y: 300 } });
    expect(brain.think(view(fighter(), [farA, nearB], world, { tick: 6 }), new Rng(1)).targetId).toBe('A');
  });

  it('in_range does not shoot into a pillar', () => {
    const bow = (world = fakeWorld()) =>
      createBrain(strat({ shoot: { score: '1', move: [], attack: 'in_range' } }, { build: { weapon: 'LONGBOW', skill: 'DASH', attributes: ATTRS } }))
        .think(view(fighter({ weapon: 'LONGBOW', ammo: 10 }), [enemy('e', { pos: { x: 600, y: 300 } })], world), new Rng(1));
    expect(bow().attack).toBe(true);
    expect(bow(fakeWorld({ pillars: [{ x: 440, y: 280, w: 30, h: 40 }] })).attack).toBe(false);
  });

  it('in_range for melee counts reach plus a body, and an empty bow means punching range', () => {
    const swing = (dist: number) =>
      createBrain(strat({ hit: { score: '1', move: [], attack: 'in_range' } })).think(view(fighter(), [enemy('e', { pos: { x: 300 + dist, y: 300 } })], fakeWorld()), new Rng(1)).attack;
    expect(swing(95)).toBe(true); // greatsword 82 + 18
    expect(swing(110)).toBe(false);
    const emptyBow = createBrain(strat({ shoot: { score: '1', move: [], attack: 'in_range' } }, { build: { weapon: 'LONGBOW', skill: 'DASH', attributes: ATTRS } }))
      .think(view(fighter({ weapon: 'LONGBOW', ammo: 0 }), [enemy('e', { pos: { x: 500, y: 300 } })], fakeWorld()), new Rng(1));
    expect(emptyBow.attack).toBe(false);
  });

  it('if_blocked hits whoever stands in the way and aims at them, not at the target', () => {
    const s = strat({ run: { score: '1', move: [{ seek: 'target', weight: 1 }], attack: 'if_blocked' } }, { target: 'it.distance' });
    const far = enemy('far', { pos: { x: 900, y: 300 } });
    const inWay = enemy('wall', { pos: { x: 360, y: 300 } });
    const d = createBrain(s).think(view(fighter(), [far, inWay], fakeWorld()), new Rng(1));
    expect(d.attack).toBe(true);
    expect(d.targetId).toBe('wall');
    const behindMe = enemy('tail', { pos: { x: 240, y: 300 } });
    expect(createBrain(s).think(view(fighter(), [far, behindMe], fakeWorld()), new Rng(1)).attack).toBe(false);
  });

  it('turns to face a melee enemy winding up at it while the parry is ready', () => {
    const s = strat({ idle }, { target: 'it.distance' });
    const far = enemy('far', { pos: { x: 900, y: 300 } });
    const swinger = enemy('swinger', { pos: { x: 360, y: 300 }, facing: Math.PI, weapon: 'WARHAMMER', windingUp: true });
    const ready = createBrain(s).think(view(fighter(), [far, swinger], fakeWorld()), new Rng(1));
    expect(ready.targetId).toBe('swinger');
    expect(ready.parry).toBe(true);
    const cooling = createBrain(s).think(view(fighter({ parryCd: 50 }), [far, swinger], fakeWorld()), new Rng(1));
    expect(cooling.targetId).toBe('far');
    expect(cooling.parry).toBe(false);
  });

  it('skills fire only when the policy says so and the skill is ready', () => {
    const s = strat({ go: { score: '1', move: [], attack: 'never', skill: 'target.distance < 150' } });
    const near = [enemy('e', { pos: { x: 400, y: 300 } })];
    expect(createBrain(s).think(view(fighter(), near, fakeWorld()), new Rng(1)).useSkill).toBe(true);
    expect(createBrain(s).think(view(fighter({ skillCd: 10 }), near, fakeWorld()), new Rng(1)).useSkill).toBe(false);
    expect(createBrain(s).think(view(fighter(), [enemy('e', { pos: { x: 600, y: 300 } })], fakeWorld()), new Rng(1)).useSkill).toBe(false);
  });
});

describe('memory and determinism', () => {
  it('applies all memory writes from the memory as it was at the start of the think', () => {
    // A swap only works if writes do not see each other; otherwise both slots end up equal.
    const brain = createBrain(strat({ swap: { score: '1', move: [], attack: 'never', set: { a: 'b', b: 'a' } } }, { memory: { a: 1, b: 2 } }));
    brain.think(view(fighter(), [], fakeWorld()), new Rng(1));
    expect(brain.memory).toEqual({ a: 2, b: 1 });
  });

  afterEach(() => vi.restoreAllMocks());

  it('never touches Math.random, and the same seed gives the same decisions', () => {
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random used in the brain');
    });
    const s = strat(
      {
        a: { score: 'random', move: [{ seek: 'target', weight: 1 }, { orbit: ['target', 'cw'], weight: 0.5 }], attack: 'in_range' },
        b: { score: '0.5', move: [{ flee: 'target', weight: 1 }], attack: 'never' },
      },
      { barks: { taunt: ['Oi', 'Hey', 'You'] } },
    );
    const runOnce = (): Decision[] => {
      const brain = createBrain(s);
      const rng = new Rng(42);
      const world = fakeWorld();
      const out: Decision[] = [];
      for (let i = 0; i < 40; i++) out.push(brain.think(view(fighter(), [enemy('e', { pos: { x: 400 + i, y: 300 } })], world, { tick: i * 6 }), rng));
      return out;
    };
    const first = runOnce();
    expect(runOnce()).toEqual(first);
    // The random sensor actually varies, so the comparison above is not trivially equal.
    expect(new Set(first.map((d) => d.behaviour)).size).toBe(2);
  });
});

describe('runtime guards', () => {
  // These strategies skip the gate on purpose (the cast stands in for a validator bug): the guards
  // are the second line of defence, and a trip must be counted and shown, never swallowed.
  const unchecked = (s: Strategy) => createValidBrain(s as ValidStrategy);
  const idle = (score: string): Behaviour => ({ score, move: [], attack: 'never' });

  it('counts each division by zero at its path, as running totals in a fresh array every think', () => {
    // A full-HP fighter reads self.hp = 1, so the divisor is exactly 0.
    const brain = unchecked(strat({ a: idle('1 / (self.hp - 1)') }));
    const first = brain.think(view(fighter(), [], fakeWorld()), new Rng(1));
    const second = brain.think(view(fighter(), [], fakeWorld(), { tick: 6 }), new Rng(1));
    expect(first.scores.a).toBe(0);
    expect(first.guardTrips).toEqual([{ path: 'behaviours.a.score', kind: 'div_zero', count: 1 }]);
    expect(second.guardTrips).toEqual([{ path: 'behaviours.a.score', kind: 'div_zero', count: 2 }]);
    // Old decisions keep the numbers they had (the inspector may still be showing one).
    expect(first.guardTrips[0]!.count).toBe(1);
  });

  it('turns a non-finite result into 0 and cuts an out-of-bounds score, counting both', () => {
    // 1e6 to the 60th power is far past what a double holds.
    const run = Array(30).fill('m').join(' * ');
    const brain = unchecked(strat({ inf: idle(`(${run}) * (${run}) * self.hp`), big: idle('500 * self.hp') }, { memory: { m: 1e6 } }));
    const d = brain.think(view(fighter(), [], fakeWorld()), new Rng(1));
    expect(d.scores).toEqual({ inf: 0, big: GUARDS.scoreLimit });
    expect(d.guardTrips).toEqual([
      { path: 'behaviours.inf.score', kind: 'nan', count: 1 },
      { path: 'behaviours.big.score', kind: 'clamped', count: 1 },
    ]);
  });

  // An over-budget strategy would make every think slow for every fighter on screen.
  it('stops spending at the evaluation budget and counts the cut think', () => {
    const heavy: Behaviour = { score: '1', move: Array.from({ length: 6 }, () => ({ avoid: 'seen_by(enemies)', weight: 1 })), attack: 'in_range' };
    const s = strat({ heavy }, { target: Array.from({ length: 12 }, () => 'it.hp * 2').join(' + ') });
    expect(worstThinkCost(compileStrategy(s)).total).toBeGreaterThan(GUARDS.costBudget);
    const known = Array.from({ length: 15 }, (_, i) => enemy(`e${i}`, { pos: { x: 400 + i * 30, y: 500 } }));
    const d = unchecked(s).think(view(fighter(), known, fakeWorld()), new Rng(1));
    expect(d.guardTrips).toEqual([{ path: 'think', kind: 'cost', count: 1 }]);
    // Cut short means it does nothing this think, safely.
    expect(d.attack).toBe(false);
    expect(Number.isFinite(d.heading)).toBe(true);
  });

  it('a clean strategy reports no trips', () => {
    const d = createBrain(strat({ a: idle('1 / max(1, enemies_known)') })).think(view(fighter(), [], fakeWorld()), new Rng(1));
    expect(d.guardTrips).toEqual([]);
  });
});

describe('headless brains', () => {
  // The gym runs thousands of matches headless: skipping the inspector's data must not change a
  // single choice, or gym results would not match what players watch.
  it('make exactly the same choices without the inspector data', () => {
    const s = requireValidStrategy(strat(
      {
        a: { score: 'random', move: [{ seek: 'target', weight: 1 }, { avoid: 'seen_by(enemies)', weight: 0.5 }], attack: 'in_range', skill: 'target.distance < 120' },
        b: { score: '0.5', move: [{ flee: 'nearest_enemy', weight: 1 }, { prefer: 'shadow', weight: 0.4 }], attack: 'if_blocked' },
      },
      { memory: { last: 0 } },
    ), 'test');
    s.behaviours.a!.set = { last: 'time' };
    const full = createValidBrain(s);
    const lean = createValidBrain(s, { inspect: false });
    const views = new Rng(5);
    const r1 = new Rng(9);
    const r2 = new Rng(9);
    for (let i = 0; i < 60; i++) {
      const v = randomView(views);
      const a = full.think(v, r1);
      const b = lean.think(v, r2);
      expect({ ...b, sensors: a.sensors, terms: a.terms }).toEqual(a);
      expect(b.sensors).toEqual({});
      expect(b.terms).toEqual([]);
    }
    expect(lean.memory).toEqual(full.memory);
  });
});
