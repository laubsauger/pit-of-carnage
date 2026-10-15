import { describe, expect, it } from 'vitest';
import type { Strategy, ValidationIssue } from '../core';
import { priceBuild, validateStrategy } from './validate';

function base(): Strategy {
  return {
    schema: 'pit-strategy/2',
    name: 'Test Pilot',
    version: 1,
    build: { weapon: 'GREATSWORD', skill: 'WHIRLWIND', attributes: { vitality: 20, power: 20, agility: 15, perception: 15, armor: 15, haste: 15 } },
    target: '300 - it.distance',
    behaviours: { brawl: { score: '1', move: [{ seek: 'target', weight: 1 }], attack: 'in_range' } },
    commit: 30,
  };
}

function errors(input: unknown): ValidationIssue[] {
  return validateStrategy(input).issues.filter((i) => i.severity === 'error');
}

function only(input: unknown): ValidationIssue {
  const errs = errors(input);
  expect(errs).toHaveLength(1);
  return errs[0]!;
}

describe('validateStrategy', () => {
  it('accepts a sound strategy and returns it normalized, without aliasing the input', () => {
    const input = base();
    const r = validateStrategy(input);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.strategy).toEqual(input);
    r.strategy!.behaviours.brawl!.score = '0';
    expect(input.behaviours.brawl!.score).toBe('1');
  });

  // The budget is the whole balance of the game: a build over it must never reach a match.
  it('rejects a build over the attribute budget and says by how much', () => {
    const s = base();
    s.build.attributes.power = 30;
    const e = only(s);
    expect(e.path).toBe('build.attributes');
    expect(e.message).toMatch(/add up to 110; the budget is 100 \(10 over\)/);
    expect(validateStrategy(s).strategy).toBeUndefined();
  });

  it('rejects attributes outside 4..40 and fractions, and warns about unspent points', () => {
    const s = base();
    s.build.attributes.power = 41;
    s.build.attributes.vitality = 2;
    expect(errors(s).map((e) => e.path).sort()).toEqual(['build.attributes.power', 'build.attributes.vitality']);
    const frac = base();
    frac.build.attributes.agility = 14.5;
    expect(only(frac).message).toMatch(/whole number/);
    const cheap = base();
    cheap.build.attributes.haste = 10;
    const r = validateStrategy(cheap);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([{ path: 'build.attributes', message: '5 attribute points unspent.', severity: 'warning' }]);
  });

  it('points at an unknown sensor with its path, column and a suggestion', () => {
    const s = base();
    s.behaviours.brawl!.score = 'self.helth < 0.5';
    const e = only(s);
    expect(e.path).toBe('behaviours.brawl.score');
    expect(e.message).toBe('In "self.helth < 0.5": unknown name "self.helth" at column 1.');
    expect(e.suggestion).toBe('self.hp');
  });

  it('suggests the right spelling for weapons, skills, imports, fields and bark kinds', () => {
    const s = base() as unknown as Record<string, unknown>;
    (s.build as Record<string, unknown>).weapon = 'longbow';
    (s.build as Record<string, unknown>).skill = 'WHIRLWND';
    s.imports = ['lurking'];
    s.barks = { kills: 'Oops.' };
    s.behaviors = {};
    const byPath = Object.fromEntries(errors(s).map((e) => [e.path, e.suggestion]));
    expect(byPath).toEqual({
      'build.weapon': 'LONGBOW',
      'build.skill': 'WHIRLWIND',
      'imports[0]': 'lurk',
      'barks.kills': 'kill',
      behaviors: 'behaviours',
    });
  });

  // An LLM fixes a strategy in one round only if it sees every problem at once.
  it('reports independent problems together instead of stopping at the first', () => {
    const s = base();
    s.target = 'target.distance';
    s.behaviours.brawl!.attack = 'target.in_reach and';
    s.behaviours.brawl!.move = [{ seek: 'behind(target)', weight: 1 }];
    s.build.attributes.power = 35;
    expect(errors(s).map((e) => e.path).sort()).toEqual([
      'behaviours.brawl.attack',
      'behaviours.brawl.move[0].seek',
      'build.attributes',
      'target',
    ]);
  });

  // Same reason: a division that could hit 0 is listed with the typo next to it, not one round later.
  it('lists static analysis errors together with other errors', () => {
    const s = base();
    s.target = 'it.distnce';
    s.behaviours.second = { score: '1 / enemies_seen', move: [], attack: 'never' };
    expect(errors(s).map((e) => e.path).sort()).toEqual(['behaviours.second.score', 'target']);
  });

  it('rejects non-finite numbers and memory outside its limits, and a doubled import', () => {
    const s = base();
    s.commit = Infinity;
    s.memory = { far: 2e6 };
    s.behaviours.brawl!.set = { far: 'far' };
    s.behaviours.brawl!.score = '0.5 + 0 * far';
    s.imports = ['prowl', 'prowl'];
    const byPath = Object.fromEntries(errors(s).map((e) => [e.path, e.message]));
    expect(byPath.commit).toBe('Commit must be a finite number between 0 and 600; got Infinity.');
    expect(byPath['memory.far']).toMatch(/hold -1000000\.\.1000000/);
    expect(byPath['imports[1]']).toBe('"prowl" is imported twice; remove one.');
  });

  it('enforces the behaviour limit including imports', () => {
    const s = base();
    s.imports = ['prowl', 'kite', 'restock', 'heal', 'retreat', 'lurk', 'backstab', 'bait'];
    const e = only(s);
    expect(e.path).toBe('behaviours');
    expect(e.message).toMatch(/9 behaviours including imports; the limit is 8/);
    s.imports.pop();
    expect(validateStrategy(s).ok).toBe(true);
  });

  it('only lets "set" write declared memory slots', () => {
    const s = base();
    s.memory = { last_hit: 0 };
    s.behaviours.brawl!.set = { last_hits: 'time' };
    const e = only(s);
    expect(e.path).toBe('behaviours.brawl.set.last_hits');
    expect(e.suggestion).toBe('last_hit');
    s.behaviours.brawl!.set = { last_hit: 'time' };
    expect(validateStrategy(s).ok).toBe(true);
  });

  it('refuses memory slot names that shadow sensors', () => {
    const s = base();
    s.memory = { time: 0 };
    expect(only(s).path).toBe('memory.time');
  });

  it('checks move terms: one kind each, argument shapes and ranges', () => {
    const two = base();
    two.behaviours.brawl!.move = [{ seek: 'target', flee: 'target', weight: 1 } as never];
    expect(only(two).message).toMatch(/exactly one kind/);
    const band = base();
    band.behaviours.brawl!.move = [{ keep_range: ['target', 300, 200], weight: 1 }];
    expect(only(band).message).toMatch(/min \(300\) is larger than max \(200\)/);
    const orbit = base();
    orbit.behaviours.brawl!.move = [{ orbit: ['target', 'clockwise' as 'cw'], weight: 1 }];
    expect(only(orbit).suggestion).toBe('cw');
    const zone = base();
    zone.behaviours.brawl!.move = [{ avoid: 'target', weight: 1 }];
    expect(only(zone).message).toMatch(/is a place, not a zone/);
  });

  it('fills defaults an author may leave out, with warnings where it matters', () => {
    const s = base() as unknown as Record<string, unknown>;
    delete s.version;
    delete s.commit;
    const behaviours = s.behaviours as Record<string, Record<string, unknown>>;
    delete behaviours.brawl!.attack;
    (behaviours.brawl!.move as Record<string, unknown>[])[0] = { seek: 'target' };
    const r = validateStrategy(s);
    expect(r.ok).toBe(true);
    expect(r.strategy!.version).toBe(1);
    expect(r.strategy!.commit).toBe(30);
    expect(r.strategy!.behaviours.brawl).toEqual({ score: '1', move: [{ seek: 'target', weight: 1 }], attack: 'in_range' });
    expect(r.issues.map((i) => `${i.severity}:${i.path}`).sort()).toEqual(['warning:behaviours.brawl.attack', 'warning:commit']);
  });

  it('checks barks and look', () => {
    const s = base();
    s.barks = { kill: ['x'.repeat(49)] };
    s.look = { color: 'red' };
    expect(errors(s).map((e) => e.path).sort()).toEqual(['barks.kill[0]', 'look.color']);
  });

  it('rejects things that are not strategies at all without throwing', () => {
    expect(only(null).message).toMatch(/JSON object/);
    expect(only([]).message).toMatch(/JSON object/);
    expect(errors({}).length).toBeGreaterThan(3);
  });
});

describe('priceBuild', () => {
  it('prices a build and derives its stats', () => {
    const p = priceBuild(base().build);
    expect(p).toMatchObject({ spent: 100, left: 0, budget: 100, legal: true });
    expect(p.stats.maxHp).toBe(320);
    const over = priceBuild({ weapon: 'LONGBOW', attributes: { ...base().build.attributes, power: 40 } });
    expect(over.legal).toBe(false);
    expect(over.left).toBe(-20);
  });
});
