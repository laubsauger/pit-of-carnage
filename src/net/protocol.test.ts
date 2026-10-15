import { describe, expect, it } from 'vitest';
import { MAX_STRATEGY_TEXT } from '../strategy';
import { codeFromSearch, newClientId, newRoomCode, parseRoomCode, roomLink } from './code';
import { checkHistory, cleanName, parseHostMessage, parsePeerMessage } from './protocol';
import type { RoomState } from './protocol';

const CLIENT = 'abcdefghijklmnopqrstuv';

describe('peer messages', () => {
  it('accepts the three things a peer may say', () => {
    expect(parsePeerMessage({ t: 'hello', v: 1, name: '  Flo  ', client: CLIENT })).toEqual({ t: 'hello', v: 1, name: 'Flo', client: CLIENT });
    expect(parsePeerMessage({ t: 'add', strategy: 'PIT2.abc' })).toEqual({ t: 'add', strategy: 'PIT2.abc' });
    expect(parsePeerMessage({ t: 'remove', entry: 'e3' })).toEqual({ t: 'remove', entry: 'e3' });
  });

  it.each([
    ['not an object', 'hello'],
    ['an array', [{ t: 'hello' }]],
    ['unknown type', { t: 'state', state: {} }],
    ['a nameless hello', { t: 'hello', v: 1, name: '   ', client: CLIENT }],
    ['a name of control characters', { t: 'hello', v: 1, name: '\u0000\u0001', client: CLIENT }],
    ['a short client id', { t: 'hello', v: 1, name: 'Flo', client: 'abc' }],
    ['a client id with odd characters', { t: 'hello', v: 1, name: 'Flo', client: 'abcdefghijklmnopqrstuv<>' }],
    ['a version that is not a number', { t: 'hello', v: '1', name: 'Flo', client: CLIENT }],
    ['an empty strategy', { t: 'add', strategy: '' }],
    ['a strategy over the gate limit', { t: 'add', strategy: 'x'.repeat(MAX_STRATEGY_TEXT + 1) }],
    ['a strategy object instead of text', { t: 'add', strategy: { name: 'x' } }],
    ['an entry id with spaces', { t: 'remove', entry: 'e 3' }],
  ])('refuses %s', (_, msg) => {
    expect(parsePeerMessage(msg)).toBeNull();
  });

  it('cuts long names and squeezes whitespace', () => {
    expect(cleanName('The   Very\tLong Name Of A Person Indeed')).toBe('The Very Long Name Of A');
    // A right-to-left override would flip the text after the name in every list it appears in.
    expect(cleanName('Flo\u202e is great')).toBe('Flo is great');
    expect(cleanName('')).toBeNull();
  });
});

describe('host messages', () => {
  const state: RoomState = {
    code: 'KRZBW',
    members: [{ id: 'm0', name: 'Host', online: true, host: true }],
    entries: [{ id: 'e1', member: 'm1', owner: 'Flo', name: 'Gary', version: 2, weapon: 'LONGBOW', skill: 'DASH', matches: 3 }],
    board: [{ key: 'Gary@v2#abc', name: 'Gary', version: 2, owner: 'Flo', mu: 27, sigma: 7, matches: 3, wins: 1, avgPlace: 2.3, kills: 4 }],
    settings: { fighters: 8, mapId: 'rotate', fillWithHouse: true, running: true },
    history: [{ id: 1, mapId: 'pit', ending: 'elimination', ticks: 3000, fighters: 8, winner: 'Gary', winnerOwner: 'Flo', winnerKills: 3 }],
    match: { id: 2, mapId: 'pit', fighters: 8 },
  };

  it('accepts a full room state and drops unknown fields', () => {
    const extra = { ...state, members: [{ ...state.members[0]!, ip: '10.0.0.1' }], secret: 1 };
    expect(parseHostMessage({ t: 'state', state: extra })).toEqual({ t: 'state', state });
  });

  it.each([
    ['a lower-case code', { ...state, code: 'krzbw' }],
    ['a member list flood', { ...state, members: Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, name: 'x', online: true, host: false })) }],
    ['a NaN rating', { ...state, board: [{ ...state.board[0]!, mu: Number.NaN }] }],
    ['an unknown weapon', { ...state, entries: [{ ...state.entries[0]!, weapon: 'SPOON' }] }],
    ['too many fighters per match', { ...state, settings: { ...state.settings, fighters: 40 } }],
    ['a missing field', { ...state, history: undefined }],
  ])('refuses a state with %s', (_, s) => {
    expect(parseHostMessage({ t: 'state', state: s })).toBeNull();
  });

  it('checks replies and refusals', () => {
    expect(parseHostMessage({ t: 'you', v: 1, member: 'm4' })).toEqual({ t: 'you', v: 1, member: 'm4' });
    expect(parseHostMessage({ t: 'added', ok: false, line: 'Nope.' })).toEqual({ t: 'added', ok: false, line: 'Nope.' });
    expect(parseHostMessage({ t: 'bye', reason: 'Closed.' })).toEqual({ t: 'bye', reason: 'Closed.' });
    expect(parseHostMessage({ t: 'added', ok: 'yes', line: 'x' })).toBeNull();
    expect(parseHostMessage({ t: 'refused', reason: 'x'.repeat(5000) })).toBeNull();
    expect(parseHostMessage({ t: 'match', info: 'nope' })).toBeNull();
    expect(parseHostMessage({ t: 'hello', v: 1, name: 'x', client: CLIENT })).toBeNull();
  });

  it('keeps only well-formed history from storage', () => {
    expect(checkHistory(state.history)).toEqual(state.history);
    expect(checkHistory([{ id: 1 }])).toEqual([]);
    expect(checkHistory('junk')).toEqual([]);
  });
});

describe('room codes', () => {
  it('makes codes from the readable alphabet only', () => {
    let k = 0;
    const code = newRoomCode((n) => (k++ * 7) % n);
    expect(code).toMatch(/^[A-HJ-NP-Z]{5}$/);
    for (let i = 0; i < 200; i++) expect(newRoomCode()).toMatch(/^[A-HJ-NP-Z]{5}$/);
  });

  it('reads codes the way people type them', () => {
    expect(parseRoomCode(' krz-bw ')).toEqual({ code: 'KRZBW' });
    expect(parseRoomCode('K R Z B W')).toEqual({ code: 'KRZBW' });
    expect(parseRoomCode('ABCD')).toEqual({ code: 'ABCD' });
    expect('problem' in parseRoomCode('KR0BW')).toBe(true);
    expect('problem' in parseRoomCode('KRIBW')).toBe(true);
    expect('problem' in parseRoomCode('KRZ')).toBe(true);
    expect('problem' in parseRoomCode('KRZBWAA')).toBe(true);
    expect('problem' in parseRoomCode('')).toBe(true);
  });

  it('puts the code in a share link that opens the Room screen', () => {
    const link = roomLink('https://laubsauger.github.io/pit-of-carnage/#watch', 'KRZBW');
    expect(link).toBe('https://laubsauger.github.io/pit-of-carnage/?room=KRZBW#room');
    expect(codeFromSearch(new URL(link).search)).toBe('KRZBW');
    expect(codeFromSearch('?room=nope0')).toBeNull();
    expect(codeFromSearch('')).toBeNull();
  });

  it('makes client ids the host accepts', () => {
    const id = newClientId();
    expect(parsePeerMessage({ t: 'hello', v: 1, name: 'x', client: id })).not.toBeNull();
    expect(newClientId()).not.toBe(id);
  });
});
