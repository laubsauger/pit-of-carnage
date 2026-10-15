/**
 * Test helpers for the gym (used only by *.test.ts). The real sim, brain and validator are built in
 * parallel, so gym tests run against these stand-ins:
 *
 * - `strictValidate`: checks the strategy shape and limits the way the real validator must
 *   (schema, build, attribute budget, behaviour/term/memory limits, finite numbers, keep_range
 *   bands) plus a closed sensor vocabulary, so a mutation that invents a name or drops a memory slot
 *   still fails.
 * - `fakeRunner`: a "match" where each entrant draws strength(strategy) + noise and the order of
 *   those draws is the finishing order. Each fighter is killed by the one placed just above it,
 *   while in its first behaviour; its time alive is split evenly over its behaviours.
 */

import {
  ATTRIBUTE_KEYS,
  DEFAULT_TIME_LIMIT_TICKS,
  MAX_BEHAVIOURS,
  MAX_MEMORY_SLOTS,
  MAX_MOVE_TERMS,
  Rng,
  SKILL_IDS,
  STRATEGY_SCHEMA,
  WEAPONS,
  WEAPON_IDS,
  addToHeatmap,
  attributesLegal,
  createHeatmap,
  emptyFighterStats,
  hashString,
  strategyKey,
} from '../core';
import type {
  Attributes,
  Behaviour,
  FighterReport,
  KillRecord,
  MatchReport,
  ReportRosterEntry,
  Strategy,
  ValidationIssue,
  ValidationResult,
  WeaponId,
} from '../core';
import type { MatchRunner } from './batch';
import { MAX_WEIGHT } from './mutate';

/** The closed sensor vocabulary of the test strategies. */
const SENSORS = new Set([
  'self.hp',
  'self.ammo',
  'self.in_shadow',
  'enemies_near',
  'enemies_seen',
  'shrine.ready',
  'target.distance',
  'target.facing_away',
  'attack.ready',
  'skill.ready',
  'it.distance',
  'it.hp',
  'since_hit',
]);
const WORDS = new Set(['and', 'or', 'not', 'min', 'max', 'clamp', 'abs']);
const PLACE_KEYS = ['seek', 'flee', 'keep_range', 'orbit', 'avoid', 'prefer'] as const;

export function strictValidate(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const err = (path: string, message: string) => issues.push({ path, message, severity: 'error' });
  const s = input as Strategy;
  if (typeof s !== 'object' || s === null || s.schema !== STRATEGY_SCHEMA) {
    err('schema', 'wrong schema');
    return { ok: false, issues };
  }
  if (typeof s.name !== 'string' || s.name.length === 0) err('name', 'missing');
  if (!WEAPON_IDS.includes(s.build?.weapon)) err('build.weapon', 'unknown weapon');
  if (!SKILL_IDS.includes(s.build?.skill)) err('build.skill', 'unknown skill');
  const attrs = s.build?.attributes;
  if (!attrs || !ATTRIBUTE_KEYS.every((k) => Number.isInteger(attrs[k])) || !attributesLegal(attrs)) err('build.attributes', 'illegal');
  if (!Number.isFinite(s.commit) || s.commit < 0) err('commit', 'bad commit');
  const memory = s.memory ?? {};
  if (Object.keys(memory).length > MAX_MEMORY_SLOTS) err('memory', 'too many slots');
  for (const [k, v] of Object.entries(memory)) if (!Number.isFinite(v)) err(`memory.${k}`, 'not finite');

  const known = new Set([...SENSORS, ...Object.keys(memory)]);
  const expr = (path: string, e: unknown) => {
    if (typeof e !== 'string' || e.trim() === '') return err(path, 'empty expression');
    if (/NaN|Infinity/.test(e)) err(path, 'non-finite number');
    let depth = 0;
    for (const ch of e) {
      depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
      if (depth < 0) err(path, 'unbalanced');
    }
    if (depth !== 0) err(path, 'unbalanced');
    for (const name of e.match(/[A-Za-z_][\w.]*/g) ?? []) {
      if (!WORDS.has(name) && !known.has(name)) err(path, `unknown name ${name}`);
    }
  };
  expr('target', s.target);

  const names = new Set([...Object.keys(s.behaviours ?? {}), ...(s.imports ?? [])]);
  if (names.size === 0 || names.size > MAX_BEHAVIOURS) err('behaviours', `${names.size} behaviours`);
  for (const [name, b] of Object.entries(s.behaviours ?? {})) {
    const at = `behaviours.${name}`;
    expr(`${at}.score`, b.score);
    if (!['in_range', 'never', 'if_blocked'].includes(b.attack)) expr(`${at}.attack`, b.attack);
    if (b.skill !== undefined) expr(`${at}.skill`, b.skill);
    for (const [slot, e] of Object.entries(b.set ?? {})) {
      if (!(slot in memory)) err(`${at}.set.${slot}`, 'undeclared memory slot');
      expr(`${at}.set.${slot}`, e);
    }
    if (!Array.isArray(b.move) || b.move.length > MAX_MOVE_TERMS) err(`${at}.move`, 'too many terms');
    b.move.forEach((t, i) => {
      const tp = `${at}.move[${i}]`;
      const kinds = PLACE_KEYS.filter((k) => k in t);
      if (kinds.length !== 1) err(tp, 'needs exactly one kind');
      if (!Number.isFinite(t.weight) || Math.abs(t.weight) > MAX_WEIGHT) err(`${tp}.weight`, 'bad weight');
      if ('keep_range' in t) {
        const [p, min, max] = t.keep_range;
        if (typeof p !== 'string' || !Number.isFinite(min) || !Number.isFinite(max) || min < 0 || min >= max) err(tp, 'bad band');
      }
      if ('orbit' in t && !['cw', 'ccw'].includes(t.orbit[1])) err(tp, 'bad orbit');
    });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, issues, strategy: s };
}

const BRAWL: Behaviour = {
  score: '0.5 + enemies_near * 0.1',
  move: [
    { seek: 'target', weight: 1 },
    { avoid: 'hazards', weight: 0.6 },
  ],
  attack: 'in_range',
  skill: 'enemies_near >= 2',
};
const HEAL: Behaviour = {
  score: 'self.hp < 0.3 and shrine.ready',
  move: [
    { seek: 'shrine', weight: 1.2 },
    { avoid: 'seen_by(enemies)', weight: 0.5 },
  ],
  attack: 'if_blocked',
};
const KITE: Behaviour = {
  score: '0.6 + (target.distance < 220) * 0.3',
  move: [
    { keep_range: ['target', 220, 360], weight: 1 },
    { orbit: ['target', 'cw'], weight: 0.4 },
  ],
  attack: 'in_range',
};
const LURK: Behaviour = {
  score: '0.4 + self.in_shadow * 0.2',
  move: [
    { prefer: 'shadow', weight: 1 },
    { avoid: 'seen_by(enemies)', weight: 0.8 },
  ],
  attack: 'target.facing_away == 1',
  stance: 'creep',
};

/** Starter-library stand-in for import tests. */
export const TEST_LIBRARY: Readonly<Record<string, Behaviour>> = { brawl: BRAWL, heal: HEAL, kite: KITE, lurk: LURK };

const ATTRS: Attributes = { vitality: 18, power: 18, agility: 18, perception: 16, armor: 14, haste: 16 };

export function makeStrategy(
  name: string,
  opts: { weapon?: WeaponId; version?: number; behaviours?: Record<string, Behaviour>; attributes?: Partial<Attributes>; memory?: Record<string, number>; imports?: string[] } = {},
): Strategy {
  const weapon = opts.weapon ?? 'GREATSWORD';
  const ranged = WEAPONS[weapon].family === 'ranged';
  const s: Strategy = {
    schema: STRATEGY_SCHEMA,
    name,
    version: opts.version ?? 1,
    build: { weapon, skill: 'DASH', attributes: { ...ATTRS, ...opts.attributes } },
    target: '1000 - it.distance + (1 - it.hp) * 200',
    behaviours: structuredClone(opts.behaviours ?? (ranged ? { kite: KITE, heal: HEAL } : { brawl: BRAWL, heal: HEAL })),
    commit: 30,
  };
  if (opts.memory) s.memory = { ...opts.memory };
  if (opts.imports) s.imports = [...opts.imports];
  return s;
}

/**
 * Fake finishing order: higher strength + noise places higher. Each loser is killed by the fighter
 * one place above. The noise depends on the seed, the seat and the strategy in it: like a real sim,
 * a different strategy in the same seat plays a different match, so paired seeds do not cancel luck.
 */
export function fakeRunner(strength: (s: Strategy) => number, noise = 1): MatchRunner {
  return (config) => {
    const n = config.entrants.length;
    const luck = (i: number) => new Rng((config.seed ^ hashString(`${strategyKey(config.entrants[i]!.strategy)}#${i}`)) >>> 0).normal(0, noise);
    const order = config.entrants
      .map((e, i) => ({ i, score: strength(e.strategy) + luck(i) }))
      .sort((a, b) => b.score - a.score || a.i - b.i);
    const roster: ReportRosterEntry[] = config.entrants.map((e, i) => ({
      fighterId: `f${i}`,
      entrantId: e.id,
      name: e.name,
      strategyName: e.strategy.name,
      strategyVersion: e.strategy.version ?? 1,
      strategyKey: strategyKey(e.strategy),
      weapon: e.strategy.build.weapon,
      skill: e.strategy.build.skill,
      squad: e.squad,
      color: e.color,
    }));
    const placements = order.map((o) => `f${o.i}`);
    const firstBehaviour = (i: number) => Object.keys(config.entrants[i]!.strategy.behaviours)[0] ?? 'idle';
    const kills: KillRecord[] = [];
    for (let p = n; p >= 2; p--) {
      const victim = order[p - 1]!.i;
      const killer = order[p - 2]!.i;
      kills.push({
        tick: (n - p + 1) * 100,
        killerId: `f${killer}`,
        victimId: `f${victim}`,
        weapon: config.entrants[killer]!.strategy.build.weapon,
        cause: 'weapon',
        pos: { x: 0, y: 0 },
        flags: [],
        killerBehaviour: firstBehaviour(killer),
        victimBehaviour: firstBehaviour(victim),
      });
    }
    const ticks = n * 100;
    const fighters: FighterReport[] = config.entrants.map((e, i) => {
      const place = placements.indexOf(`f${i}`) + 1;
      const died = kills.find((k) => k.victimId === `f${i}`)?.tick ?? null;
      const killCount = kills.filter((k) => k.killerId === `f${i}`).length;
      const alive = died ?? ticks;
      const own = Object.keys(e.strategy.behaviours);
      return {
        fighterId: `f${i}`,
        place,
        kills: killCount,
        damageDealt: killCount * 50,
        damageTaken: died === null ? 30 : 150,
        diedAtTick: died,
        behaviourTicks: Object.fromEntries(own.map((b) => [b, Math.round(alive / own.length)])),
        neverWon: [],
        exposure: { ticksAlive: alive, ticksSeen: Math.round(alive / 2), ticksInShadow: 0 },
        damageDealtBySource: { weapon: killCount * 50 },
        damageTakenBySource: { weapon: died === null ? 30 : 150 },
        attacks: 10,
        hitsLanded: 5,
        skillUses: 1,
        parries: 0,
        pickupsTaken: {},
        killsWhileBuffed: {},
        guardTrips: [],
        stats: { ...emptyFighterStats(), accuracy: 0.5 },
        death: (() => {
          const k = kills.find((x) => x.victimId === `f${i}`);
          return k ? { tick: k.tick, cause: k.cause, killerId: k.killerId, weapon: k.weapon, hazard: null, flags: [], title: 'SPLIT' } : null;
        })(),
        // Every seat keeps to its own spot along the north wall, so heatmaps have something to say.
        heatmap: (() => {
          const h = createHeatmap(1360, 860);
          addToHeatmap(h, 100 + 150 * i, 100, alive);
          return h;
        })(),
      };
    });
    return {
      seed: config.seed, mapId: config.mapId, format: config.format, timeLimitTicks: config.timeLimitTicks, suddenDeath: config.suddenDeath,
      friendlyFire: config.friendlyFire, ticks, ending: 'elimination', suddenDeathStart: null, judges: null, roster, placements, kills, fighters, findings: [],
    };
  };
}

/** A minimal MatchReport for rating tests: fighters f0..fn-1 running the given keys, placed in `order` (best first). */
export function placedReport(keys: readonly string[], order: readonly number[], format: MatchReport['format'] = 'ffa', squads?: readonly number[]): MatchReport {
  const roster: ReportRosterEntry[] = keys.map((key, i) => {
    const [name, v] = key.split('@v');
    return {
      fighterId: `f${i}`,
      entrantId: `e${i}`,
      name: name!,
      strategyName: name!,
      strategyVersion: Number(v ?? 1),
      strategyKey: key,
      weapon: 'GREATSWORD',
      skill: 'DASH',
      squad: squads?.[i] ?? i,
      color: '#fff',
    };
  });
  const placements = order.map((i) => `f${i}`);
  const fighters: FighterReport[] = keys.map((_, i) => ({
    fighterId: `f${i}`,
    place: placements.indexOf(`f${i}`) + 1,
    kills: 0,
    damageDealt: 0,
    damageTaken: 0,
    diedAtTick: null,
    behaviourTicks: {},
    neverWon: [],
    exposure: { ticksAlive: 0, ticksSeen: 0, ticksInShadow: 0 },
    damageDealtBySource: {},
    damageTakenBySource: {},
    attacks: 0,
    hitsLanded: 0,
    skillUses: 0,
    parries: 0,
    pickupsTaken: {},
    killsWhileBuffed: {},
    guardTrips: [],
    stats: emptyFighterStats(),
    death: null,
    heatmap: createHeatmap(1360, 860),
  }));
  return {
    seed: 1, mapId: 'pit', format, timeLimitTicks: DEFAULT_TIME_LIMIT_TICKS, suddenDeath: true, friendlyFire: true,
    ticks: 1000, ending: 'elimination', suddenDeathStart: null, judges: null, roster, placements, kills: [], fighters, findings: [],
  };
}
