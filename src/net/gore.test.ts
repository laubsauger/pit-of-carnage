import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../core';
import { MAPS } from '../sim';
import { GORE_LIMITS, GORE_MAX_EVENTS, GoreLog, decodeGore } from './gore';
import { mapFingerprint } from './snapshot';
import type { StreamMatchInfo } from './snapshot';
import { houseMatch, stepFrames } from './testkit';

const hit = (tick: number, amount: number): GameEvent => ({
  type: 'hit', tick, attackerId: 'f0', victimId: 'f1', amount, pos: { x: 10, y: 10 }, dir: 0, crit: false, backstab: false, weapon: 'GREATSWORD', knockback: 1,
  source: 'weapon',
});

describe('gore for late joiners', { timeout: 60_000 }, () => {
  it('keeps the biggest hits and every kill when a long match overflows the summary', () => {
    // Small hits barely stain; the big ones are the pools a late joiner should still see.
    const log = new GoreLog();
    const events: GameEvent[] = [];
    for (let i = 0; i < 3000; i++) events.push(hit(i, i % 100 === 0 ? 500 : 1 + (i % 7)));
    events.push({ type: 'kill', tick: 2999, killerId: 'f0', victimId: 'f1', cause: 'weapon', pos: { x: 1, y: 1 }, dir: 0, title: 'X', killerBehaviour: null, victimBehaviour: 'y', weapon: null, flags: [], hazard: null, final: false });
    events.push({ type: 'footstep', tick: 5, fighterId: 'f0', pos: { x: 1, y: 1 }, bloody: false });
    events.push({ type: 'swing', tick: 5, fighterId: 'f0', weapon: 'GREATSWORD' });
    log.add(events);
    const kept = log.events();
    const hits = kept.filter((e) => e.type === 'hit');
    expect(hits).toHaveLength(GORE_LIMITS.hit);
    expect(hits.filter((e) => e.type === 'hit' && e.amount === 500)).toHaveLength(30);
    expect(kept.filter((e) => e.type === 'kill')).toHaveLength(1);
    expect(kept.some((e) => e.type === 'swing' || e.type === 'footstep'), 'only what leaves a mark').toBe(false);
    expect(kept.map((e) => e.tick)).toEqual([...kept.map((e) => e.tick)].sort((a, b) => a - b));
    expect(kept.length).toBeLessThanOrEqual(GORE_MAX_EVENTS);
  });

  it('checks a summary against its match and drops what is not gore', () => {
    const match = houseMatch(5, 'pit', 6);
    const map = MAPS.pit!;
    const info: StreamMatchInfo = {
      id: 2, mapId: 'pit', mapHash: mapFingerprint(map), seed: 5, format: 'ffa', timeLimitTicks: 5400, suddenDeath: true, friendlyFire: true, fightAt: 0,
      fighters: match.state.fighters.map((f) => ({ id: f.id, entrantId: f.entrantId, squad: f.squad, name: f.name, color: f.color, weapon: f.weapon, skill: f.skill, attributes: f.attributes, radius: f.radius, owner: null })),
    };
    const log = new GoreLog();
    stepFrames(match, 3, 1200, (_, events) => log.add(events));
    const gore = log.events();
    expect(gore.length).toBeGreaterThan(10);
    const tick = match.state.tick;
    const wire = JSON.parse(JSON.stringify({ t: 'gore', m: 2, k: tick, e: gore }));
    expect(decodeGore(wire, info, 1e6)!.events).toEqual(gore);
    // Not gore, from the future, or about a stranger: dropped one by one.
    wire.e.push({ type: 'swing', tick, fighterId: 'f0', weapon: 'GREATSWORD' }, { ...gore[0], tick: tick + 99 }, { ...hit(1, 5), victimId: 'nobody' });
    expect(decodeGore(wire, info, 1e6)!.events).toEqual(gore);
    expect(decodeGore({ ...wire, m: 3 }, info, 1e6), 'another match').toBeNull();
    expect(decodeGore({ ...wire, e: Array.from({ length: GORE_MAX_EVENTS + 1 }, () => gore[0]) }, info, 1e6), 'a flood').toBeNull();
  });
});
