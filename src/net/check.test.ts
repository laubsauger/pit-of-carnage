import { describe, expect, it } from 'vitest';
import type { GameEvent, GameEventType } from '../core';
import { BAD, checkEvent } from './check';
import { houseMatch, stepFrames } from './testkit';

const ALL_TICKS = { min: 0, max: 1e9 };

// Whole real matches: generous under a loaded machine, still bounded.
describe('event checks', { timeout: 60_000 }, () => {
  // The renderer and audio trust event shapes (they look fighters up by id, read fields without
  // guards). Every event a real match produces must pass unchanged, or peers lose effects.
  it('passes every event of real matches unchanged', () => {
    const seen = new Set<GameEventType>();
    for (const [seed, mapId] of [[2, 'pit'], [9, 'meat_grinder'], [4, 'catacombs']] as const) {
      const match = houseMatch(seed, mapId, 8);
      const refs = { fighters: new Set(match.state.fighters.map((f) => f.id)) };
      stepFrames(match, 1, 20_000, (_, events) => {
        for (const e of events) {
          seen.add(e.type);
          expect(checkEvent(JSON.parse(JSON.stringify(e)), refs, ALL_TICKS), `${e.type} at ${e.tick}`).toEqual(e);
        }
      });
    }
    // The matches must actually exercise the common kinds, or this test proves little.
    for (const t of ['swing', 'hit', 'kill', 'projectile', 'projectile_end', 'footstep', 'match_end'] as const) expect(seen.has(t), t).toBe(true);
  });

  const refs = { fighters: new Set(['f0', 'f1']) };
  const kill: GameEvent = {
    type: 'kill', tick: 10, killerId: 'f0', victimId: 'f1', cause: 'weapon', pos: { x: 1, y: 2 }, dir: 0, title: 'SPLIT', killerBehaviour: 'hunt',
    victimBehaviour: 'flee', weapon: 'GREATSWORD', flags: ['backstab'], hazard: null, final: true,
  };

  it('rebuilds from known fields only', () => {
    const smuggled = { ...kill, extra: '<script>', pos: { x: 1, y: 2, z: 'no' } };
    expect(checkEvent(smuggled, refs, ALL_TICKS)).toEqual(kill);
    // A JSON "__proto__" key becomes an own property; it must not travel or pollute anything.
    const proto = JSON.parse(`{"type":"swing","tick":1,"fighterId":"f0","weapon":"WARHAMMER","__proto__":{"polluted":true}}`);
    const out = checkEvent(proto, refs, ALL_TICKS) as Record<string, unknown>;
    expect(out).toEqual({ type: 'swing', tick: 1, fighterId: 'f0', weapon: 'WARHAMMER' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    ['unknown fighter', { ...kill, victimId: 'f9' }],
    ['killer that is not a fighter', { ...kill, killerId: 'saw1' }],
    ['NaN position', { ...kill, pos: { x: Number.NaN, y: 0 } }],
    ['position far outside any map', { ...kill, pos: { x: 1e9, y: 0 } }],
    ['unknown weapon', { ...kill, weapon: 'BAZOOKA' }],
    ['unknown flag', { ...kill, flags: ['backstab', 'cheated'] }],
    ['flag list flood', { ...kill, flags: Array.from({ length: 100 }, () => 'crit') }],
    ['empty title', { ...kill, title: '' }],
    ['title with a control character', { ...kill, title: 'SPLIT\u0007' }],
    ['very long title', { ...kill, title: 'A'.repeat(1000) }],
    ['missing field', { ...kill, final: undefined }],
    ['wrong field type', { ...kill, final: 'yes' }],
    ['fractional tick', { ...kill, tick: 10.5 }],
    ['inherited type name', { ...kill, type: 'toString' }],
    ['unknown type', { ...kill, type: 'kill_everyone' }],
  ])('refuses %s', (_, e) => {
    expect(checkEvent(e, refs, ALL_TICKS)).toBe(BAD);
  });

  it('holds events to the frame they came with', () => {
    expect(checkEvent(kill, refs, { min: 0, max: 9 })).toBe(BAD);
    expect(checkEvent(kill, refs, { min: 11, max: 20 })).toBe(BAD);
    expect(checkEvent(kill, refs, { min: 10, max: 10 })).toEqual(kill);
  });

  it('checks nested lists of fighters', () => {
    const end = { type: 'match_end', tick: 5, placements: ['f1', 'f0'], ending: 'elimination' };
    expect(checkEvent(end, refs, ALL_TICKS)).toEqual(end);
    expect(checkEvent({ ...end, placements: ['f1', 'ghost'] }, refs, ALL_TICKS)).toBe(BAD);
    const judges = { type: 'judges_decision', tick: 5, survivors: [{ id: 'f0', hpFraction: 0.5, damageDealt: 30, kills: 1 }] };
    expect(checkEvent(judges, refs, ALL_TICKS)).toEqual(judges);
    expect(checkEvent({ ...judges, survivors: [{ id: 'f0', hpFraction: 3, damageDealt: 30, kills: 1 }] }, refs, ALL_TICKS)).toBe(BAD);
  });

  // Stuck arrows pin to a body by fighter id: a ghost id would make the renderer look up a fighter
  // that does not exist, and an unknown surface kind has no drawing rule.
  it('checks what stuck ammo sits in', () => {
    const inBody = { type: 'ammo_stick', tick: 5, stuckId: 's1', projectileId: 'p9', kind: 'arrow', ownerId: 'f0', pos: { x: 10, y: 20 }, angle: 1, in: { kind: 'fighter', fighterId: 'f1', u: 4, v: -3, turn: 0.5 } };
    expect(checkEvent(inBody, refs, ALL_TICKS)).toEqual(inBody);
    expect(checkEvent({ ...inBody, in: { kind: 'fighter', fighterId: 'ghost', u: 4, v: -3, turn: 0.5 } }, refs, ALL_TICKS)).toBe(BAD);
    expect(checkEvent({ ...inBody, in: { kind: 'prop', propId: 'crate_1' } }, refs, ALL_TICKS)).toEqual({ ...inBody, in: { kind: 'prop', propId: 'crate_1' } });
    expect(checkEvent({ ...inBody, in: { kind: 'wall', extra: 1 } }, refs, ALL_TICKS)).toEqual({ ...inBody, in: { kind: 'wall' } });
    expect(checkEvent({ ...inBody, in: { kind: 'ceiling' } }, refs, ALL_TICKS)).toBe(BAD);
    const pulled = { type: 'ammo_unstick', tick: 6, stuckId: 's1', kind: 'arrow', pos: { x: 10, y: 20 }, reason: 'pickup', fighterId: 'f0', floorItemId: null };
    expect(checkEvent(pulled, refs, ALL_TICKS)).toEqual(pulled);
    expect(checkEvent({ ...pulled, reason: 'stolen' }, refs, ALL_TICKS)).toBe(BAD);
  });
});
