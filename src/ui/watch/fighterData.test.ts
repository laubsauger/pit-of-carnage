import { describe, expect, it } from 'vitest';
import { TICK_HZ } from '../../core';
import type { KnownFighter } from '../../core';
import { copyKnowledge, guardTripSummary, knowledgeRows, powerupLines, zoneLines } from './fighterData';
import type { KnownCopy } from './fighterData';

const fighters = [
  { id: 'a', name: 'Gary', color: '#a' },
  { id: 'b', name: 'Brenda', color: '#b' },
  { id: 'c', name: 'Doug', color: '#c' },
  { id: 'd', name: 'Nan', color: '#d' },
];
const k = (id: string, patch: Partial<KnownCopy>): KnownCopy => ({ id, seen: false, heard: false, estimateError: 0, lastSeenTick: 100, pos: { x: 0, y: 0 }, ...patch });

describe('knowledgeRows', () => {
  const self = { x: 0, y: 0 };
  const rows = knowledgeRows(
    [
      k('c', { lastSeenTick: 1000 }),
      k('b', { heard: true, estimateError: 41.6, pos: { x: 300, y: 0 } }),
      k('a', { seen: true, lastSeenTick: 1200, pos: { x: 0, y: 240 } }),
      k('d', { heard: true, estimateError: 80, lastSeenTick: -1, pos: { x: 100, y: 0 } }),
    ],
    self,
    1200 + 2.3 * TICK_HZ,
    fighters,
  );

  it('lists what it sees first, then what it hears, then what it only remembers', () => {
    expect(rows.map((r) => r.state)).toEqual(['seen', 'heard', 'heard', 'remembered']);
    expect(rows.map((r) => r.name)).toEqual(['Gary', 'Nan', 'Brenda', 'Doug']);
  });

  it('never presents a heard enemy as an exact position, only an estimate with its error', () => {
    const heard = rows.filter((r) => r.state === 'heard');
    for (const r of heard) {
      expect(r.text).toMatch(/±\d+ px/);
      expect(r.distance.startsWith('~')).toBe(true);
    }
    expect(rows[0].distance).toBe('240 px');
  });

  it('says how long ago sight was lost, in seconds of match time', () => {
    expect(rows[3].text).toBe(`Lost sight ${((2.3 * TICK_HZ + 200) / TICK_HZ).toFixed(1)} s ago`);
  });

  it('tells a heard-only enemy apart from one seen before', () => {
    expect(rows[1].text).toBe('Heard, never seen (±80 px)');
    expect(rows[2].text).toBe('Heard (±42 px)');
  });

  it('copies records, because the sim rewrites them every tick', () => {
    const live: KnownFighter = {
      id: 'a', squad: 1, pos: { x: 5, y: 6 }, vel: { x: 0, y: 0 }, facing: 0, hp: 10, maxHp: 10, weapon: 'LONGBOW', family: 'ranged',
      seen: true, heard: false, estimateError: 0, lastSeenTick: 3, lastSeenPos: { x: 5, y: 6 }, fighting: false, ammo: 2, kills: 0, windingUp: false,
    };
    const [copy] = copyKnowledge([live]);
    live.pos.x = 999;
    expect(copy.pos.x).toBe(5);
  });
});

describe('guardTripSummary', () => {
  it('puts the busiest trip first and totals them for the badge', () => {
    const s = guardTripSummary([
      { path: 'behaviours.kite.move[0].weight', kind: 'clamped', count: 3 },
      { path: 'behaviours.lurk.score', kind: 'div_zero', count: 212 },
    ]);
    expect(s.total).toBe(215);
    expect(s.lines[0]).toEqual({ path: 'behaviours.lurk.score', what: 'division by zero (read as 0)', count: 212 });
  });

  it('is empty for a clean brain, so no badge shows', () => {
    expect(guardTripSummary([]).total).toBe(0);
  });
});

describe('powerupLines', () => {
  it('shows running buffs with the time left', () => {
    expect(powerupLines({ buffs: { haste: 0, berserk: 90, slow: 0 } }, {})).toEqual([{ label: 'Berserk', value: '1.5 s left', hot: true }]);
  });

  it('describes pedestals from the sensors the brain provides, and skips ones the map lacks', () => {
    const lines = powerupLines(null, { 'pickup.haste.distance': 240.4, 'pickup.haste.ready': 1, 'pickup.berserk.distance': 9999, 'pickup.respawn_in': 4.25 });
    expect(lines.map((l) => l.value)).toEqual(['up, 240 px', '4.3 s']);
  });

  it('shows nothing it does not know rather than inventing numbers', () => {
    expect(powerupLines({ buffs: { haste: 0, berserk: 0, slow: 0 } }, {})).toEqual([]);
  });
});

describe('zoneLines', () => {
  it('stays quiet before sudden death', () => {
    expect(zoneLines(false, { 'zone.distance': 200 })).toEqual([]);
  });

  it('flags a fighter outside the wall', () => {
    expect(zoneLines(true, { 'zone.distance': -12, 'zone.time_to_reach': 0 })[0].hot).toBe(true);
  });

  it('counts down to the wall, and says when it will never arrive', () => {
    expect(zoneLines(true, { 'zone.distance': 80, 'zone.time_to_reach': 2.5 }).map((l) => l.value)).toEqual(['80 px away', 'in 2.5 s']);
    expect(zoneLines(true, { 'zone.distance': 40, 'zone.time_to_reach': 9999 })[1].value).toBe('safe here, the wall stops short');
  });

  it('still says sudden death is on with a brain that has no zone sensors', () => {
    expect(zoneLines(true, {})).toEqual([{ label: 'Sudden death', value: 'walls closing' }]);
  });
});
