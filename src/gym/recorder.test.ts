import { describe, expect, it } from 'vitest';
import { PICKUP_RULES, initialSuddenDeathState } from '../core';
import type { FighterState, GameEvent, MatchConfig, MatchResult, WeaponId, WorldState } from '../core';
import { gymConfig } from './batch';
import { MatchRecorder, placementsByStanding } from './recorder';
import { makeStrategy } from './testkit';

function fighter(i: number, name: string, weapon: WeaponId, behaviour: string): FighterState {
  return {
    id: `f${i}`, entrantId: `e${i}`, squad: i, name, color: '#fff', weapon, skill: 'DASH',
    attributes: { vitality: 18, power: 18, agility: 18, perception: 16, armor: 14, haste: 16 },
    pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, facing: 0, headAngle: 0, radius: 18, hp: 300, maxHp: 300,
    alive: true, diedAtTick: null, anim: { phase: 'idle', t: 0, dur: 0 }, walkPhase: 0, attackCd: 0,
    skillCd: 0, parryTicks: 0, parryCd: 0, stunTicks: 0, ammo: 0, maxAmmo: 0, buffs: { haste: 0, berserk: 0, slow: 0 },
    limbs: { armL: true, armR: true, legL: true, legR: true }, helmet: true, inShadow: false, seen: false,
    stance: 'normal', hitFlash: 0, eyePop: 0, behaviour, targetId: null, kills: 0, damageDealt: 0,
    damageTaken: 0, lastHitBy: null, lastHitTick: null, place: null,
  };
}

const at = { x: 10, y: 20 };
const hit = (tick: number, attackerId: string | null, victimId: string, amount: number, source: 'weapon' | 'skill' | 'hazard'): GameEvent => ({
  tick, type: 'hit', attackerId, victimId, amount, pos: at, dir: 0, crit: false, backstab: false, weapon: null, knockback: 0, source,
});

function setup(): { config: MatchConfig; state: WorldState; recorder: MatchRecorder } {
  const config = gymConfig(42, 'pit', [
    makeStrategy('Gary', { weapon: 'GREATSWORD' }),
    makeStrategy('Brenda', { weapon: 'LONGBOW' }),
    makeStrategy('Doug', { weapon: 'TWIN_DAGGERS' }),
  ]);
  const state: WorldState = {
    tick: 0, mapId: 'pit',
    fighters: [fighter(0, 'Gary', 'GREATSWORD', 'brawl'), fighter(1, 'Brenda', 'LONGBOW', 'kite'), fighter(2, 'Doug', 'TWIN_DAGGERS', 'brawl')],
    projectiles: [], floor: [], props: [], hazards: [], shrines: [], pickups: [],
    suddenDeath: initialSuddenDeathState({ width: 1360, height: 860 }), finished: false, ending: null, placements: [],
  };
  return { config, state, recorder: new MatchRecorder(config, state) };
}

describe('MatchRecorder', () => {
  // Reports feed findings and the LLM; every count has to match what actually happened in the match.
  it('counts attacks, landed hits, damage by source, exposure and behaviour time from events and state', () => {
    const { state, recorder } = setup();
    const [gary, brenda, doug] = state.fighters as [FighterState, FighterState, FighterState];
    gary.seen = true;
    brenda.inShadow = true;
    doug.seen = true;
    doug.inShadow = true;
    doug.behaviour = ''; // has not thought yet

    state.tick = 1;
    recorder.observe([
      { tick: 1, type: 'swing', fighterId: 'f0', weapon: 'GREATSWORD' },
      { tick: 1, type: 'swing', fighterId: 'f1', weapon: 'LONGBOW' },
      { tick: 1, type: 'projectile', projectileId: 'p1', ownerId: 'f1', weapon: 'LONGBOW', pos: at, dir: 0 },
    ], state);
    // One greatsword swing cleaves two people: still one landed attack. The arrow lands on Gary.
    state.tick = 2;
    doug.behaviour = 'brawl';
    recorder.observe([
      hit(2, 'f0', 'f1', 30, 'weapon'),
      hit(2, 'f0', 'f2', 25, 'weapon'),
      { tick: 2, type: 'projectile_end', projectileId: 'p1', pos: at, hitId: 'f0' },
      hit(2, 'f1', 'f0', 20, 'weapon'),
    ], state);
    // A second swing that only lands skill damage is an attack that missed.
    state.tick = 3;
    recorder.observe([
      { tick: 3, type: 'swing', fighterId: 'f0', weapon: 'GREATSWORD' },
      hit(3, 'f0', 'f1', 10, 'skill'),
      { tick: 3, type: 'parry', fighterId: 'f2', attackerId: 'f0', pos: at },
      { tick: 3, type: 'skill', fighterId: 'f1', skill: 'DASH', pos: at },
      hit(3, null, 'f2', 15, 'hazard'),
    ], state);
    state.tick = 4;
    brenda.alive = false;
    brenda.diedAtTick = 4;
    recorder.observe([
      { tick: 4, type: 'kill', killerId: 'f0', victimId: 'f1', cause: 'weapon', pos: { x: 10.4, y: 20.6 }, dir: 0, title: 'SPLIT',
        killerBehaviour: 'brawl', victimBehaviour: 'kite', weapon: 'GREATSWORD', flags: ['crit'], hazard: null },
    ], state);

    const result: MatchResult = {
      seed: 42, mapId: 'pit', ticks: 4, placements: ['f0', 'f2', 'f1'], ending: 'elimination',
      fighters: [
        { id: 'f0', entrantId: 'e0', name: 'Gary', place: 1, kills: 1, damageDealt: 65, damageTaken: 20, diedAtTick: null, guardTrips: [] },
        { id: 'f1', entrantId: 'e1', name: 'Brenda', place: 3, kills: 0, damageDealt: 20, damageTaken: 40, diedAtTick: 4, guardTrips: [] },
        { id: 'f2', entrantId: 'e2', name: 'Doug', place: 2, kills: 0, damageDealt: 0, damageTaken: 40, diedAtTick: null, guardTrips: [] },
      ],
    };
    const report = recorder.finish(result);
    const by = (id: string) => report.fighters.find((f) => f.fighterId === id)!;

    expect(by('f0')).toMatchObject({ attacks: 2, hitsLanded: 1, place: 1, kills: 1 });
    expect(by('f0').damageDealtBySource).toEqual({ weapon: 55, skill: 10 });
    expect(by('f1')).toMatchObject({ attacks: 1, hitsLanded: 1, skillUses: 1 });
    expect(by('f1').damageTakenBySource).toEqual({ weapon: 30, skill: 10 });
    expect(by('f2').damageTakenBySource).toEqual({ weapon: 25, hazard: 15 });
    expect(by('f2').parries).toBe(1);

    // Exposure stops when a fighter dies: Brenda was alive for ticks 1-3 only.
    expect(by('f0').exposure).toEqual({ ticksAlive: 4, ticksSeen: 4, ticksInShadow: 0 });
    expect(by('f1').exposure).toEqual({ ticksAlive: 3, ticksSeen: 0, ticksInShadow: 3 });
    expect(by('f2').exposure).toEqual({ ticksAlive: 4, ticksSeen: 4, ticksInShadow: 4 });

    // A defined behaviour that never ran is reported: usually a score that can never win.
    expect(by('f0').behaviourTicks).toEqual({ brawl: 4 });
    // Time before the first think is not a behaviour choice.
    expect(by('f2').behaviourTicks).toEqual({ brawl: 3 });
    expect(by('f0').neverWon).toEqual(['heal']);
    expect(by('f1').neverWon).toEqual(['heal']);

    expect(report.kills).toEqual([
      { tick: 4, killerId: 'f0', victimId: 'f1', weapon: 'GREATSWORD', cause: 'weapon', pos: { x: 10, y: 21 }, flags: ['crit'], killerBehaviour: 'brawl', victimBehaviour: 'kite' },
    ]);
    expect(report.roster.map((r) => r.strategyKey)).toEqual(['Gary@v1', 'Brenda@v1', 'Doug@v1']);
    expect(report.placements).toEqual(['f0', 'f2', 'f1']);
    expect(report.findings[0]).toBe('Gary takes pit: 1 kill, seen 100% of the time.');
  });

  // "Took berserk 4 times, 3 kills while berserk": power-ups must show what they bought, and only
  // the pedestal buff counts (a kill after it ran out, or by someone who never took one, does not).
  it('counts power-ups taken and the kills landed while one was running', () => {
    const { state, recorder } = setup();
    const kill = (tick: number, killerId: string, victimId: string): GameEvent => ({
      tick, type: 'kill', killerId, victimId, cause: 'weapon', pos: at, dir: 0, title: 'SPLIT',
      killerBehaviour: 'brawl', victimBehaviour: 'kite', weapon: 'GREATSWORD', flags: [], hazard: null,
    });
    const berserk = PICKUP_RULES.berserk.durationTicks;
    recorder.observe([
      { tick: 10, type: 'pickup', fighterId: 'f0', kind: 'berserk', pos: at },
      { tick: 10, type: 'pickup', fighterId: 'f1', kind: 'arrow', pos: at },
    ], state);
    // Taken at tick 10, the buff is counted down from tick 11: tick 9 + duration is its last tick.
    recorder.observe([kill(9 + berserk, 'f0', 'f1')], state);
    recorder.observe([kill(10 + berserk, 'f0', 'f2'), kill(10 + berserk, 'f2', 'f0')], state);
    const report = recorder.finish({
      seed: 42, mapId: 'pit', ticks: 20 + berserk, placements: ['f0', 'f2', 'f1'], ending: 'elimination',
      fighters: ['f0', 'f1', 'f2'].map((id, i) => ({ id, entrantId: `e${i}`, name: id, place: i + 1, kills: 0, damageDealt: 0, damageTaken: 0, diedAtTick: null, guardTrips: [] })),
    });
    const by = (id: string) => report.fighters.find((f) => f.fighterId === id)!;
    expect(by('f0').pickupsTaken).toEqual({ berserk: 1 });
    // Spent arrows picked off the floor are ammo, not power-ups.
    expect(by('f1').pickupsTaken).toEqual({});
    expect(by('f0').killsWhileBuffed).toEqual({ berserk: 1 });
    expect(by('f2').killsWhileBuffed).toEqual({});
  });

  // Stalemates and guard trips must never be silent: the report says when sudden death started,
  // why, how the match ended, and which expressions tripped a runtime guard (worst first).
  it('reports the sudden-death start, the ending and the guard trips from the result', () => {
    const { recorder, state } = setup();
    recorder.observe([{ tick: 900, type: 'sudden_death', reason: 'stalemate' }], state);
    const trips = [
      { path: 'behaviours.brawl.score', kind: 'div_zero' as const, count: 3 },
      { path: 'target', kind: 'nan' as const, count: 212 },
    ];
    const result: MatchResult = {
      seed: 42, mapId: 'pit', ticks: 9000, placements: ['f0', 'f2', 'f1'], ending: 'judges',
      fighters: ['f0', 'f1', 'f2'].map((id, i) => ({ id, entrantId: `e${i}`, name: id, place: i + 1, kills: 0, damageDealt: 0, damageTaken: 0, diedAtTick: null, guardTrips: i === 0 ? trips : [] })),
    };
    const report = recorder.finish(result);
    expect(report.suddenDeathStart).toEqual({ tick: 900, reason: 'stalemate' });
    expect(report.ending).toBe('judges');
    expect(report.fighters[0]!.guardTrips.map((g) => g.count)).toEqual([212, 3]);
    // The gym's safety stop overrides whatever the sim said.
    expect(new MatchRecorder(setup().config, setup().state).finish(result, { capped: true }).ending).toBe('capped');
  });

  // The judges' scorecards only exist in the sim's event; the report must carry them into its
  // findings. The map's pedestals come from the state, so callers need not pass map data.
  it("puts the judges' scorecards and untouched pedestals into the findings", () => {
    const { config, state } = setup();
    state.pickups = [{ id: 'p0', kind: 'berserk', pos: at, cooldown: PICKUP_RULES.berserk.firstSpawnTicks }];
    const recorder = new MatchRecorder(config, state);
    recorder.observe([
      {
        tick: 9000, type: 'judges_decision', survivors: [
          { id: 'f2', hpFraction: 0.5, damageDealt: 10, kills: 0 },
          { id: 'f0', hpFraction: 0.25, damageDealt: 90, kills: 1 },
        ],
      },
    ], state);
    const report = recorder.finish({
      seed: 42, mapId: 'pit', ticks: 9000, placements: ['f2', 'f0', 'f1'], ending: 'judges',
      fighters: ['f0', 'f1', 'f2'].map((id, i) => ({ id, entrantId: `e${i}`, name: id, place: [2, 3, 1][i]!, kills: 0, damageDealt: 0, damageTaken: 0, diedAtTick: i === 1 ? 600 : null, guardTrips: [] })),
    });
    expect(report.findings).toContain("Judges' decision at 2:30: still standing at the hard cap, ranked by HP left, then damage dealt, then kills: Doug 50% HP, Gary 25% HP.");
    expect(report.findings).toContain('Nobody touched the power-ups (berserk) all match.');
  });

  // A capped match still needs a fair order: the living outrank the dead, healthier first.
  it('places a stopped match by standing: survivors by HP, then the latest death first', () => {
    const { state } = setup();
    const [a, b, c] = state.fighters as [FighterState, FighterState, FighterState];
    a.hp = 100;
    b.hp = 250;
    c.alive = false;
    c.diedAtTick = 50;
    expect(placementsByStanding(state.fighters)).toEqual(['f1', 'f0', 'f2']);
  });

  it('refuses a state whose fighters do not match the config', () => {
    const { config, state } = setup();
    state.fighters[0]!.entrantId = 'nobody';
    expect(() => new MatchRecorder(config, state)).toThrow(/no entrant/);
  });
});
