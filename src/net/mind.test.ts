import { describe, expect, it } from 'vitest';
import { FIGHTER_COLORS, DEFAULT_TIME_LIMIT_TICKS } from '../core';
import type { Decision } from '../core';
import { MAPS, createMatch } from '../sim';
import { HOUSE_STACKS, gatedBrainFactory } from '../strategy';
import { MIND_LIMITS, decodeMind, encodeMind } from './mind';
import type { WireMind } from './mind';
import { mapFingerprint } from './snapshot';
import type { StreamMatchInfo } from './snapshot';
import { differences } from './testkit';

/** A real match with inspecting brains (as the host runs them), stepped until everyone has thought. */
function thinkingMatch() {
  const match = createMatch(
    {
      seed: 9, mapId: 'pit', format: 'ffa', friendlyFire: true, timeLimitTicks: DEFAULT_TIME_LIMIT_TICKS, suddenDeath: true,
      entrants: Array.from({ length: 4 }, (_, i) => ({ id: `e${i}`, strategy: HOUSE_STACKS[i]!, squad: i, name: HOUSE_STACKS[i]!.name, color: FIGHTER_COLORS[i]! })),
    },
    gatedBrainFactory,
  );
  for (let i = 0; i < 240; i++) match.step();
  const map = MAPS.pit!;
  const info: StreamMatchInfo = {
    id: 3, mapId: 'pit', mapHash: mapFingerprint(map), seed: 9, format: 'ffa', timeLimitTicks: DEFAULT_TIME_LIMIT_TICKS, suddenDeath: true, friendlyFire: true,
    fightAt: 0,
    fighters: match.state.fighters.map((f) => ({
      id: f.id, entrantId: f.entrantId, squad: f.squad, name: f.name, color: f.color, weapon: f.weapon, skill: f.skill, attributes: f.attributes, radius: f.radius, owner: null,
    })),
  };
  const index = new Map(match.state.fighters.map((f, i) => [f.id, i]));
  return { match, info, index };
}

const CAP = 1e6;
const wire = (m: WireMind) => JSON.parse(JSON.stringify(m)) as WireMind;

describe('minds (the selected fighter in a streamed match)', { timeout: 60_000 }, () => {
  // The inspector reads these exactly as it reads a local match's: the scores, the steering ring,
  // the sensor table and the fog-of-war records must survive the trip within rounding.
  it('carries a real decision and knowledge within rounding', () => {
    const { match, info, index } = thinkingMatch();
    const d = match.lastDecision('f0')!;
    expect(Object.keys(d.sensors).length, 'inspecting brains fill the sensor table').toBeGreaterThan(10);
    expect(d.terms.length).toBeGreaterThan(0);
    const known = match.knowledge('f0');
    const got = decodeMind(wire(encodeMind(3, 1234, match.state.tick, 'f0', d, known, index)), info, CAP);
    expect(got).not.toBeNull();
    expect(got!.fighterId).toBe('f0');
    expect(differences(got!.decision, d, 0.0051)).toEqual([]);
    expect(differences(got!.knowledge, known, 0.0051)).toEqual([]);
  });

  it('refuses a mind that does not fit its match, whole', () => {
    const { match, info, index } = thinkingMatch();
    const good = wire(encodeMind(3, 1234, match.state.tick, 'f1', match.lastDecision('f1'), match.knowledge('f1'), index));
    expect(decodeMind(good, info, CAP)).not.toBeNull();
    const broken = (patch: (m: WireMind & Record<string, unknown>) => void) => {
      const m = structuredClone(good) as WireMind & Record<string, unknown>;
      patch(m);
      return decodeMind(m, info, CAP);
    };
    expect(broken((m) => (m.m = 4)), 'another match').toBeNull();
    expect(broken((m) => (m.f = 9)), 'a fighter outside the roster').toBeNull();
    expect(broken((m) => (m.d!.g = 9)), 'a target outside the roster').toBeNull();
    expect(broken((m) => (m.d!.r = [1, 2, 3])), 'a ring of the wrong size').toBeNull();
    expect(broken((m) => (m.d!.s = [['a', 1], ['a', 2]])), 'a behaviour scored twice').toBeNull();
    expect(broken((m) => (m.d!.se = Array.from({ length: MIND_LIMITS.sensors + 1 }, (_, i) => [`s${i}`, 1]))), 'a sensor flood').toBeNull();
    expect(broken((m) => (m.d!.b = 'x‮y')), 'a direction override in a name').toBeNull();
    expect(broken((m) => (m.n = Array.from({ length: 40 }, () => m.n[0]!))), 'more records than fighters').toBeNull();
    expect(broken((m) => (m.n[0]![2] = null as unknown as number)), 'a NaN that became null').toBeNull();
    expect(decodeMind('mind', info, CAP)).toBeNull();
  });

  it('keeps odd names plain keys, never the prototype', () => {
    const { info, index } = thinkingMatch();
    const d: Decision = {
      behaviour: 'hunt', scores: { hunt: 1 }, targetId: null, heading: 0, speed: 1, ring: Array(16).fill(0), terms: [], attack: false, parry: false, useSkill: false,
      stance: 'normal', sensors: {}, guardTrips: [],
    };
    const m = wire(encodeMind(3, 1, 1, 'f0', d, [], index));
    m.d!.se = [['__proto__', 5], ['constructor', 2]];
    const got = decodeMind(m, info, CAP)!;
    expect(Object.getPrototypeOf(got.decision!.sensors)).toBe(Object.prototype);
    expect(Object.keys(got.decision!.sensors)).toEqual(['__proto__', 'constructor']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
