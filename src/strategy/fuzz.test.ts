/**
 * Fuzzing the gate. Strategy text and codes come from strangers and from LLMs, so thousands of
 * random, mutated and garbled strategies go through `loadStrategy` here. The gate must answer every
 * one with a clean report (never a crash, never an internal error), and everything it accepts must
 * compile, think and fight without a non-finite number and without tripping a single runtime guard,
 * because the static analysis promised exactly that.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_LIMIT_TICKS, FIGHTER_COLORS, Rng, SKILL_IDS, STEER_DIRS, WEAPONS, WEAPON_IDS, maxHp } from '../core';
import type { Behaviour, LoadReport, MatchConfig, MoveTerm, PerceptionView, Strategy, ValidStrategy } from '../core';
import { GUARDS, SENSORS, createBrain } from '../brain';
import { randomAttributes, randomView } from '../brain/test-world';
import { createMatch } from '../sim';
import { encodeStrategyCode } from './code';
import { HOUSE_STACKS } from './house';
import { STARTER_NAMES } from './library';
import { gatedBrainFactory, loadStrategy } from './load';
import { formatJson } from './rulebook';

/** Fuzzing is deliberately bulky; give it room on a slow machine. */
const FUZZ_TIMEOUT = 30_000;

const SELF_NAMES = SENSORS.filter((s) => s.scope === 'self').map((s) => s.name);
const TARGET_NAMES = SENSORS.filter((s) => s.scope === 'target').map((s) => s.name);
const IT_NAMES = SENSORS.filter((s) => s.scope === 'it').map((s) => s.name);
const NUMBERS = ['0', '1', '0.5', '0.25', '2', '100', '0.001', '9999', '-1'];
const BIN = ['+', '-', '*', '/', '<', '<=', '>', '>=', '==', '!=', 'and', 'or'];
const PLACES = ['target', 'nearest_enemy', 'last_attacker', 'weakest', 'nearest_fight', 'ally', 'behind(target, 36)', 'side(target, 90, 80)', 'cover_from(enemies)',
  'last_seen(target)', 'search_point', 'hazard_near(target)', 'beyond(hazard_near(target), target, 85)', 'shrine', 'ammo', 'centre', 'zone_centre',
  'nearest_keg', 'corner', 'dark_spot', 'pickup(haste)', 'pickup(berserk)', 'pickup(any)', 'nearest_pickup'];
const ZONES = ['shadow', 'lit', 'seen_by(enemies)', 'seen_by(target)', 'hazards', 'walls', 'open', 'outside_zone'];
const JUNK = ['', ' ', 'target', 'self.hp <', '((', 'it.distance', 'seen_by(', 'shadow', '1e9', 'NaN', 'x'.repeat(700), 'flee', 'in_range', 'never', 'behind(enemies, 3)'];

function expr(rng: Rng, names: readonly string[], depth: number): string {
  if (depth <= 0 || rng.chance(0.3)) return rng.chance(0.6) ? rng.pick(names) : rng.pick(NUMBERS);
  switch (rng.int(0, 6)) {
    case 0:
      return `not ${expr(rng, names, depth - 1)}`;
    case 1:
      return `${rng.pick(['min', 'max'])}(${expr(rng, names, depth - 1)}, ${expr(rng, names, depth - 1)})`;
    case 2:
      return rng.chance(0.5) ? `clamp(${expr(rng, names, depth - 1)})` : `abs(${expr(rng, names, depth - 1)})`;
    default:
      return `(${expr(rng, names, depth - 1)} ${rng.pick(BIN)} ${expr(rng, names, depth - 1)})`;
  }
}

function term(rng: Rng): MoveTerm {
  const weight = rng.chance(0.1) ? 0 : Math.round(rng.range(0, 2) * 10) / 10;
  switch (rng.int(0, 5)) {
    case 0: return { seek: rng.pick(PLACES), weight };
    case 1: return { flee: rng.pick(PLACES), weight };
    case 2: { const a = rng.int(0, 300); return { keep_range: [rng.pick(PLACES), a, a + rng.int(0, 300)], weight }; }
    case 3: return { orbit: [rng.pick(PLACES), rng.chance(0.5) ? 'cw' : 'ccw'], weight };
    case 4: return { avoid: rng.pick(ZONES), weight };
    default: return { prefer: rng.pick(ZONES), weight };
  }
}

function randomStrategy(rng: Rng, n: number): Strategy {
  const memory: Record<string, number> = {};
  for (let i = rng.int(0, 3); i > 0; i--) memory[`m${i}`] = rng.chance(0.2) ? rng.range(-2e6, 2e6) : rng.int(-5, 5);
  const slots = Object.keys(memory);
  const names = [...SELF_NAMES, ...TARGET_NAMES, ...slots];
  const behaviours: Record<string, Behaviour> = {};
  for (let i = rng.int(1, 6); i > 0; i--) {
    const b: Behaviour = {
      score: expr(rng, names, rng.int(0, 3)),
      move: Array.from({ length: rng.int(0, 4) }, () => term(rng)),
      attack: rng.chance(0.6) ? rng.pick(['in_range', 'never', 'if_blocked']) : expr(rng, names, 2),
    };
    if (rng.chance(0.5)) b.skill = expr(rng, names, 2);
    if (slots.length && rng.chance(0.4)) b.set = { [rng.pick(slots)]: expr(rng, names, 2) };
    if (rng.chance(0.3)) b.stance = rng.pick(['normal', 'creep', 'guard'] as const);
    behaviours[`b${i}`] = b;
  }
  const s: Strategy = {
    schema: 'pit-strategy/2', name: `Fuzz ${n}`, version: 1,
    build: { weapon: rng.pick(WEAPON_IDS), skill: rng.pick(SKILL_IDS), attributes: randomAttributes(rng) },
    target: expr(rng, [...SELF_NAMES, ...IT_NAMES, ...slots], rng.int(0, 3)), behaviours, commit: rng.int(0, 90),
  };
  if (rng.chance(0.5)) s.imports = STARTER_NAMES.filter(() => rng.chance(0.15));
  if (slots.length) s.memory = memory;
  return s;
}

/** Every value inside a JSON tree, with a way to replace or delete it. */
function slots(v: unknown, out: { get: () => unknown; set: (x: unknown) => void; del: () => void }[] = []): typeof out {
  if (Array.isArray(v)) v.forEach((x, i) => { out.push({ get: () => v[i], set: (y) => { v[i] = y; }, del: () => v.splice(i, 1) }); slots(x, out); });
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) { out.push({ get: () => o[k], set: (y) => { o[k] = y; }, del: () => delete o[k] }); slots(o[k], out); }
  }
  return out;
}

function mutate(rng: Rng, s: unknown): unknown {
  const doc = structuredClone(s) as Record<string, unknown>;
  for (let k = rng.int(1, 4); k > 0; k--) {
    const all = slots(doc);
    if (all.length === 0) break;
    const at = rng.pick(all);
    switch (rng.int(0, 7)) {
      case 0: at.del(); break;
      case 1: at.set(rng.pick([null, true, 0, -1, 1e308, -0.5, 41, 3.7, '', 'x', [], {}, [1, 2], { a: 1 }])); break;
      case 2: at.set(rng.pick(JUNK)); break;
      case 3: if (typeof at.get() === 'number') at.set((at.get() as number) * rng.pick([-1, 0, 2, 10, 1e6, 0.5])); break;
      case 4: if (typeof at.get() === 'string') at.set(expr(rng, [...SELF_NAMES, ...TARGET_NAMES, ...IT_NAMES], 3)); break;
      case 5: { const o = at.get(); if (o && typeof o === 'object' && !Array.isArray(o)) (o as Record<string, unknown>)[rng.pick(['behavior', 'wieght', 'extra', '__proto__', 'constructor'])] = 1; break; }
      case 6: if (typeof at.get() === 'string') at.set(rng.pick(PLACES)); break;
      default: if (typeof at.get() === 'string') at.set(rng.pick(ZONES)); break;
    }
  }
  return doc;
}

function garble(rng: Rng, text: string): string {
  let t = text;
  for (let k = rng.int(1, 6); k > 0; k--) {
    const i = rng.int(0, t.length);
    const ch = rng.pick(['{', '}', '[', ']', ',', ':', '"', '\\', "'", '/', '\n', ' ', 'x', '9', '-', '.', '\u0000', 'é', '😀']);
    t = rng.chance(0.4) ? t.slice(0, i) + t.slice(i + 1) : t.slice(0, i) + ch + t.slice(i);
  }
  return t;
}

/** The report contract every answer must keep, whatever the input. */
function expectWellFormed(r: LoadReport, text?: string): void {
  for (const i of [...r.errors, ...r.warnings]) {
    expect(typeof i.path).toBe('string');
    expect(i.message).not.toMatch(/\n/);
    expect(i.message).not.toMatch(/Internal error/);
    if (text !== undefined && i.line !== undefined) {
      const lines = text.split('\n');
      expect(i.line).toBeGreaterThanOrEqual(1);
      expect(i.line).toBeLessThanOrEqual(lines.length);
      expect(i.column).toBeGreaterThanOrEqual(1);
      expect(i.column!).toBeLessThanOrEqual(lines[i.line - 1]!.length + 1);
    }
  }
  expect(r.errors.every((i) => i.severity === 'error')).toBe(true);
  expect(r.warnings.every((i) => i.severity === 'warning')).toBe(true);
  expect(r.strategy === undefined).toBe(r.errors.length > 0);
}

/** A random moment, with the fighter carrying the strategy's own build. */
function viewFor(rng: Rng, s: Strategy): PerceptionView {
  const v = randomView(rng);
  const w = s.build.weapon;
  Object.assign(v.self, { weapon: w, skill: s.build.skill, attributes: s.build.attributes, maxHp: maxHp(s.build.attributes), ammo: Math.min(v.self.ammo, WEAPONS[w].ammo), maxAmmo: WEAPONS[w].ammo });
  v.self.hp = Math.min(v.self.hp, v.self.maxHp);
  return v;
}

/** Think a few times and hold the brain to the gate's promise. */
function expectSafeThinking(rng: Rng, s: ValidStrategy, thinks: number): void {
  const brain = createBrain(s, { inspect: rng.chance(0.5) });
  const brainRng = new Rng(rng.int(0, 1e9));
  let tick = 0;
  for (let i = 0; i < thinks; i++) {
    const v = viewFor(rng, s);
    tick += 6;
    v.tick = Math.max(v.tick, tick);
    const d = brain.think(v, brainRng);
    expect(Number.isFinite(d.heading)).toBe(true);
    expect(d.speed).toBeGreaterThanOrEqual(0);
    expect(d.speed).toBeLessThanOrEqual(1);
    expect(d.ring).toHaveLength(STEER_DIRS);
    for (const x of Object.values(d.scores)) expect(Math.abs(x)).toBeLessThanOrEqual(GUARDS.scoreLimit + 1);
    for (const x of Object.values(brain.memory)) expect(Number.isFinite(x)).toBe(true);
    // The static analysis promised this strategy never needs a guard.
    expect(d.guardTrips, JSON.stringify(s)).toEqual([]);
    if (d.targetId !== null) expect(v.known.some((f) => f.id === d.targetId)).toBe(true);
  }
}

describe('fuzzing the gate', () => {
  it('answers thousands of random strategies cleanly, and every accepted one thinks safely', () => {
    const rng = new Rng(1234);
    let accepted = 0;
    for (let n = 0; n < 1000; n++) {
      const s = randomStrategy(rng, n);
      const r = loadStrategy(s, 'test');
      expectWellFormed(r);
      if (!r.strategy) continue;
      accepted++;
      expectSafeThinking(rng, r.strategy, 5);
    }
    // Enough get through for the second half of the promise to mean something.
    expect(accepted).toBeGreaterThan(100);
  }, FUZZ_TIMEOUT);

  it('answers thousands of mutated house stacks cleanly, and every accepted one thinks safely', () => {
    const rng = new Rng(99);
    let accepted = 0;
    let rejected = 0;
    for (let n = 0; n < 1200; n++) {
      const doc = mutate(rng, rng.pick(HOUSE_STACKS));
      const r = loadStrategy(doc, 'evolution');
      expectWellFormed(r);
      if (!r.strategy) {
        rejected++;
        continue;
      }
      accepted++;
      expectSafeThinking(rng, r.strategy, 3);
    }
    expect(accepted).toBeGreaterThan(150);
    expect(rejected).toBeGreaterThan(150);
  }, FUZZ_TIMEOUT);

  it('answers garbled text and codes cleanly, with positions inside the text', () => {
    const rng = new Rng(7);
    for (let n = 0; n < 1500; n++) {
      const base = formatJson(rng.pick(HOUSE_STACKS));
      const text = garble(rng, base);
      expectWellFormed(loadStrategy(text, 'paste'), text);
      const code = encodeStrategyCode(rng.pick(HOUSE_STACKS));
      const cut = code.slice(0, rng.int(5, code.length));
      expectWellFormed(loadStrategy(rng.chance(0.5) ? cut : garble(rng, code), 'code'));
    }
  }, FUZZ_TIMEOUT);
});

describe('fuzzed strategies in real matches', () => {
  // The fake world in the tests above is simple; a real match feeds brains the sim's own
  // perception, maps, hazards and sudden death. Accepted mutants must survive that too.
  it('accepted mutants play short matches without a crash, a NaN or a guard trip', () => {
    const rng = new Rng(4242);
    const pool: Strategy[] = [];
    while (pool.length < 24) {
      const r = loadStrategy(mutate(rng, rng.pick(HOUSE_STACKS)), 'evolution');
      if (r.strategy) pool.push(r.strategy);
    }
    for (let m = 0; m < 3; m++) {
      const entrants = pool.slice(m * 8, m * 8 + 8).map((strategy, i) => ({ id: `f${i}`, strategy, squad: i, name: `${strategy.name} ${i}`, color: FIGHTER_COLORS[i]! }));
      const config: MatchConfig = { seed: 100 + m, mapId: ['pit', 'catacombs', 'meat_grinder'][m]!, format: 'ffa', friendlyFire: true, timeLimitTicks: DEFAULT_TIME_LIMIT_TICKS, suddenDeath: true, entrants };
      const match = createMatch(config, gatedBrainFactory);
      for (let t = 0; t < 900 && !match.isOver; t++) {
        match.step();
        if (t % 60 !== 0) continue;
        for (const f of match.state.fighters) {
          expect(Number.isFinite(f.pos.x) && Number.isFinite(f.pos.y), `${f.name} position`).toBe(true);
          const d = match.lastDecision(f.id);
          if (d) expect(d.guardTrips, f.name).toEqual([]);
        }
      }
    }
  }, FUZZ_TIMEOUT);
});
