import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FIGHTERS, strategyKey } from '../core';
import type { GameController, LineupFighter, MatchRules } from '../core';
import { MAPS } from '../sim';
import { HOUSE_STACKS } from '../strategy';
import { createController } from './controller';
import { DEFAULT_MATCH_RULES } from './lineup';

// The controller's loop needs a browser frame; these tests only start matches, so no frame ever runs.
beforeAll(() => vi.stubGlobal('requestAnimationFrame', () => 1));
afterAll(() => vi.unstubAllGlobals());

const rules = (patch: Partial<MatchRules> = {}): MatchRules => ({ ...DEFAULT_MATCH_RULES, ...patch });
const pick = (i: number): LineupFighter => ({ key: `mine-${i}`, strategy: { ...HOUSE_STACKS[i]!, name: `My Pick ${i}` }, source: 'file', savedId: null, pinned: true });
const names = (c: GameController) => c.getSnapshot().fighters.map((f) => f.name);

describe('the controller keeps the lineup', () => {
  it('plays the house stacks on a fresh "Next match", eight by default', () => {
    const c = createController();
    c.nextMatch();
    expect(c.getSnapshot().fighters).toHaveLength(DEFAULT_FIGHTERS);
    expect(c.getLineup().fighters.every((f) => !f.pinned && f.source === 'house')).toBe(true);
  });

  // The bug this pass fixes: a fighter brought in from the gym or a file dropped out on "Next match".
  it('keeps the player\'s pinned picks and the drawn field through "Next match", with a new seed', () => {
    const c = createController();
    c.startMatchup({ lineup: { fighters: [pick(0), pick(1)], size: 6 }, rules: rules(), seed: 1234 });
    const first = names(c);
    expect(first.slice(0, 2)).toEqual(['My Pick 0', 'My Pick 1']);
    expect(first).toHaveLength(6);
    expect(c.getSnapshot().seed).toBe(1234);
    c.nextMatch();
    expect(names(c)).toEqual(first);
    expect(c.getSnapshot().seed).not.toBe(1234);
  });

  it('"Shuffle field" redraws only the unpinned slots', () => {
    const c = createController();
    c.startMatchup({ lineup: { fighters: [pick(0)], size: 8 }, rules: rules(), seed: 5 });
    const before = c.getLineup().fighters.map((f) => strategyKey(f.strategy));
    let changed = false;
    for (let i = 0; i < 6 && !changed; i++) {
      c.shuffleField();
      const after = c.getLineup();
      expect(after.fighters[0]!.key).toBe('mine-0');
      expect(after.fighters).toHaveLength(8);
      changed = after.fighters.some((f, j) => strategyKey(f.strategy) !== before[j]);
    }
    expect(changed).toBe(true);
    c.nextMatch();
    expect(names(c)[0]).toBe('My Pick 0');
  });

  it('keeps every fighter of a match started from a bare config (the lineup is whatever the last match used)', () => {
    const c = createController();
    c.startMatchup({ lineup: { fighters: [], size: 4 }, rules: rules(), seed: 9 });
    const config = { seed: 77, mapId: 'pit', format: 'ffa' as const, friendlyFire: true, timeLimitTicks: 5400, suddenDeath: true,
      entrants: [0, 1, 2].map((i) => ({ id: `e${i}`, strategy: HOUSE_STACKS[i + 3]!, squad: i, name: HOUSE_STACKS[i + 3]!.name, color: '#fff' })) };
    c.startMatch(config);
    expect(c.getLineup().fighters.every((f) => f.pinned)).toBe(true);
    c.nextMatch();
    expect(names(c)).toEqual(config.entrants.map((e) => e.name));
  });

  it('moves on to the next map when rotation is on, and stays put when it is off', () => {
    const ids = Object.keys(MAPS);
    const c = createController();
    c.startMatchup({ lineup: { fighters: [], size: 4 }, rules: rules({ mapId: ids[0]!, rotateMaps: true }), seed: 3 });
    c.nextMatch();
    expect(c.getSnapshot().mapId).toBe(ids[1]);
    c.startMatchup({ lineup: { fighters: [], size: 4 }, rules: rules({ mapId: ids[0]! }), seed: 3 });
    c.nextMatch();
    expect(c.getSnapshot().mapId).toBe(ids[0]);
  });

  it('refuses a lineup the gate refuses, naming the fighter, and keeps the match it had', () => {
    const c = createController();
    c.startMatchup({ lineup: { fighters: [], size: 4 }, rules: rules(), seed: 3 });
    const broken: LineupFighter = { ...pick(0), strategy: { ...pick(0).strategy, target: 'no_such_sensor +' } };
    expect(() => c.startMatchup({ lineup: { fighters: [broken], size: 4 }, rules: rules(), seed: 4 })).toThrow(/My Pick 0 cannot fight/);
    expect(c.getSnapshot().seed).toBe(3);
  });
});
