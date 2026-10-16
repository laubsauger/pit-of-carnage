import { describe, expect, it } from 'vitest';
import { initialSuddenDeathState, matchHardCapTicks } from '../core';
import type { FighterState, Match, MatchConfig, MatchEnding, WorldState } from '../core';
import { createMatch } from '../sim';
import { HOUSE_STACKS, gatedBrainFactory, headlessBrainFactory } from '../strategy';
import { gymConfig } from './batch';
import { SAFETY_MARGIN_TICKS, createSimRunner } from './runner';
import { makeStrategy } from './testkit';

const config = gymConfig(5, 'pit', [makeStrategy('Gary'), makeStrategy('Brenda', { weapon: 'LONGBOW' })]);

function fighter(i: number, hp: number): FighterState {
  return {
    id: `f${i}`, entrantId: `e${i}`, squad: i, name: `F${i}`, color: '#fff', weapon: 'GREATSWORD', skill: 'DASH',
    attributes: { vitality: 18, power: 18, agility: 18, perception: 16, armor: 14, haste: 16 },
    pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, facing: 0, headAngle: 0, radius: 18, hp, maxHp: 300,
    alive: true, diedAtTick: null, anim: { phase: 'idle', t: 0, dur: 0 }, walkPhase: 0, attackCd: 0,
    skillCd: 0, parryTicks: 0, parryCd: 0, stunTicks: 0, ammo: 0, maxAmmo: 0, buffs: { haste: 0, berserk: 0, slow: 0 },
    limbs: { armL: true, armR: true, legL: true, legR: true }, helmet: true, inShadow: false, seen: false,
    stance: 'normal', hitFlash: 0, eyePop: 0, behaviour: 'brawl', targetId: null, kills: 0, damageDealt: 0,
    damageTaken: 0, lastHitBy: null, lastHitTick: null, place: null,
  };
}

/** A sim stand-in that ends with `ending` at `endTick`, or never when `endTick` is null. */
function fakeMatch(endTick: number | null, ending: MatchEnding = 'judges') {
  return (c: MatchConfig): Match => {
    const state: WorldState = {
      tick: 0, mapId: c.mapId, fighters: [fighter(0, 100), fighter(1, 250)], projectiles: [], floor: [], props: [], hazards: [],
      shrines: [], stuck: [], pickups: [], suddenDeath: initialSuddenDeathState({ width: 1360, height: 860 }), finished: false, ending: null, placements: [],
    };
    const over = () => endTick !== null && state.tick >= endTick;
    return {
      config: c, map: null as never, state, get isOver() { return over(); },
      step() {
        state.tick++;
        return [];
      },
      lastDecision: () => null,
      knowledge: () => [],
      result: () => ({
        seed: c.seed, mapId: c.mapId, ticks: state.tick, placements: over() ? ['f0', 'f1'] : [], ending: over() ? ending : 'capped',
        fighters: state.fighters.map((f, i) => ({ id: f.id, entrantId: f.entrantId, name: f.name, place: over() ? i + 1 : 0, kills: 0, damageDealt: 0, damageTaken: 0, diedAtTick: null, guardTrips: [] })),
      }),
    };
  };
}

describe('createSimRunner', () => {
  // A stalled sim must not hang a batch of hundreds of matches: the gym stops it, places it by
  // standing and says so, never silently.
  it('stops a match that never ends shortly after the hard cap and reports it as capped', () => {
    const run = createSimRunner({ createMatch: fakeMatch(null), brainFactory: () => null as never });
    const report = run(config);
    expect(report.ticks).toBe(matchHardCapTicks(config.timeLimitTicks) + SAFETY_MARGIN_TICKS);
    expect(report.ending).toBe('capped');
    expect(report.placements).toEqual(['f1', 'f0']);
    expect(report.findings.some((f) => f.startsWith('Stopped at the safety cap'))).toBe(true);
  });

  // The sim's own judges' decision at the hard cap is the real ending; the gym's cap must never cut it off.
  it("lets the sim reach its own judges' decision at the hard cap", () => {
    const cap = matchHardCapTicks(config.timeLimitTicks);
    const run = createSimRunner({ createMatch: fakeMatch(cap), brainFactory: () => null as never });
    const report = run(config);
    expect(report).toMatchObject({ ticks: cap, ending: 'judges', placements: ['f0', 'f1'] });
  });

  // The Watch screen replays a gym report with inspecting brains; switching the inspector off for
  // speed must not change a single decision, or the replay would show a different match.
  it('plays the same match headless as with the inspector on', () => {
    const duel = { ...gymConfig(11, 'pit', [HOUSE_STACKS[0]!, HOUSE_STACKS[3]!]), format: 'duel' as const };
    const headless = createSimRunner({ createMatch, brainFactory: headlessBrainFactory })(duel);
    const inspected = createSimRunner({ createMatch, brainFactory: gatedBrainFactory })(duel);
    expect(headless).toEqual(inspected);
    expect(headless.ticks).toBeGreaterThan(0);
  });

  // The per-fighter stats are only worth quoting if they agree with the match they came from: no
  // time counted after death, shares that fit inside the time alive, credit that fits the deaths.
  it('records stats on a real match that stay consistent with the match', () => {
    const ffa = gymConfig(21, 'catacombs', HOUSE_STACKS.slice(0, 8));
    const report = createSimRunner({ createMatch, brainFactory: headlessBrainFactory })(ffa);
    let moved = 0;
    for (const f of report.fighters) {
      const s = f.stats;
      const alive = f.exposure.ticksAlive;
      const squad = report.roster.find((e) => e.fighterId === f.fighterId)!.squad;
      const enemyDeaths = report.kills.filter((k) => report.roster.find((e) => e.fighterId === k.victimId)!.squad !== squad).length;
      expect(f.heatmap.total, f.fighterId).toBe(alive);
      for (const ticks of [s.ticksEngaged, s.ticksIdle + s.ticksStuck, s.ticksNearWalls, s.ticksOutsideZone]) expect(ticks, f.fighterId).toBeLessThanOrEqual(alive);
      expect(s.ticksToFirstContact === null, f.fighterId).toBe(s.ticksEngaged === 0);
      expect(s.accuracy).toBeGreaterThanOrEqual(0);
      expect(s.accuracy).toBeLessThanOrEqual(1);
      expect(s.skillHits).toBeLessThanOrEqual(f.skillUses);
      expect(s.assists + f.kills, f.fighterId).toBeLessThanOrEqual(enemyDeaths);
      expect(s.killParticipation).toBeLessThanOrEqual(1);
      if (!report.suddenDeathStart) expect(s.ticksOutsideZone).toBe(0);
      if (f.death) expect(f.death.tick).toBe(f.diedAtTick);
      else expect(f.diedAtTick).toBeNull();
      moved += s.distanceTravelled;
    }
    expect(moved).toBeGreaterThan(0);
  });
});
