import { describe, expect, it } from 'vitest';
import type { SavedStrategy } from '../../core';
import type { MatchSummary } from '../../net';
import { defaultName, historyLine, latestPerName, statusLine } from './model';

const saved = (name: string, version: number): SavedStrategy =>
  ({ id: `${name}-${version}`, name, version, savedAt: 0, strategy: {} as SavedStrategy['strategy'], code: '', parentId: null, origin: null });

describe('room screen model', () => {
  it('offers only the newest version of each strategy for the pool', () => {
    // Older versions in the pool would rate a strategy the owner already moved past.
    const list = latestPerName([saved('Gary', 1), saved('Brenda', 2), saved('Gary', 3), saved('Brenda', 1)]);
    expect(list.map((s) => `${s.name} v${s.version}`)).toEqual(['Brenda v2', 'Gary v3']);
  });

  it('says what the connection is doing in plain words', () => {
    const room = { members: [{ id: 'm0', name: 'H', online: true, host: true }, { id: 'm1', name: 'A', online: true, host: false }] };
    const base = { role: 'peer' as const, code: 'KRZBW', peers: 0, room: null };
    expect(statusLine({ ...base, status: 'looking' }).text).toBe('Looking for the host of KRZBW…');
    expect(statusLine({ ...base, status: 'looking', peers: 2 }).tone).toBe('wait');
    expect(statusLine({ ...base, status: 'host-gone' }).tone).toBe('bad');
    expect(statusLine({ ...base, role: 'host', status: 'hosting', room: room as never }).text).toBe('Hosting. 1 guest in the room.');
    expect(statusLine({ ...base, role: 'host', status: 'hosting', room: { members: [room.members[0]] } as never }).text).toMatch(/nobody is here yet/);
  });

  it('writes match history like the broadcast does', () => {
    const h: MatchSummary = { id: 1, mapId: 'pit', ending: 'elimination', ticks: 3000, fighters: 8, winner: 'Gary', winnerOwner: 'Ana', winnerKills: 3 };
    expect(historyLine(h)).toBe("Gary (Ana's) took the Pit with 3 kills.");
    expect(historyLine({ ...h, winnerOwner: null, winnerKills: 0 })).toBe('Gary took the Pit without a kill.');
    expect(historyLine({ ...h, ending: 'judges' })).toBe("The judges gave the Pit to Gary (Ana's).");
    expect(historyLine({ ...h, winner: null })).toBe('Nobody walked out of the Pit.');
  });

  it('picks a ringside name for people who have not chosen one', () => {
    expect(defaultName(() => 0)).toBe('Ringside Regular');
    expect(defaultName(() => 0.9999)).toBeTruthy();
  });
});
