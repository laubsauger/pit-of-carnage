import { describe, expect, it } from 'vitest';
import { APP_ID, TURN_KEY, checkTurnConfig, readTurn, roomJoinConfig, turnHost, turnUrlProblem, writeTurn } from './turn';

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), map: m };
}

const relay = { url: 'turn:relay.example.com:3478', username: 'ana', credential: 's3cret' };

describe('TURN relay', () => {
  // Strict networks connect only through a relay: the config must reach WebRTC exactly, next to
  // trystero's own STUN servers (turnConfig appends; rtcConfig.iceServers would replace them).
  it('hands the relay to the room join, and nothing without one', () => {
    expect(roomJoinConfig('KRZBW', null)).toEqual({ appId: APP_ID, password: 'pit:KRZBW' });
    expect(roomJoinConfig('KRZBW', relay)).toEqual({
      appId: APP_ID, password: 'pit:KRZBW', turnConfig: [{ urls: 'turn:relay.example.com:3478', username: 'ana', credential: 's3cret' }],
    });
    // An open relay without credentials sends none (an empty username would be refused by WebRTC).
    expect(roomJoinConfig('KRZBW', { url: 'turns:relay.example.com', username: '', credential: '' }).turnConfig).toEqual([{ urls: 'turns:relay.example.com' }]);
  });

  it('accepts TURN addresses only, and says why not', () => {
    expect(turnUrlProblem('turn:relay.example.com:3478')).toBeNull();
    expect(turnUrlProblem('turns:relay.example.com:5349?transport=tcp')).toBeNull();
    expect(turnUrlProblem('')).toMatch(/Enter/);
    expect(turnUrlProblem('stun:stun.l.google.com:19302')).toMatch(/starts with "turn:"/);
    expect(turnUrlProblem('https://relay.example.com')).toMatch(/starts with "turn:"/);
    expect(turnUrlProblem('turn:relay example.com')).toMatch(/does not look like/);
    expect(checkTurnConfig({ ...relay, url: '  turn:relay.example.com:3478 ' })).toEqual(relay);
    expect(checkTurnConfig({ ...relay, url: 'stun:x' })).toBeNull();
    expect(checkTurnConfig({ ...relay, credential: 'a\u0000b' })).toBeNull();
    expect(checkTurnConfig({ url: relay.url })).toEqual({ url: relay.url, username: '', credential: '' });
    expect(checkTurnConfig('turn:relay.example.com')).toBeNull();
  });

  it('keeps the relay in this browser and survives junk in storage', () => {
    const store = memoryStorage();
    expect(readTurn(store)).toBeNull();
    expect(writeTurn(store, relay)).toBe(true);
    expect(readTurn(store)).toEqual(relay);
    store.setItem(TURN_KEY, '{broken');
    expect(readTurn(store)).toBeNull();
    store.setItem(TURN_KEY, JSON.stringify({ url: 'javascript:alert(1)' }));
    expect(readTurn(store)).toBeNull();
    expect(writeTurn(store, null)).toBe(true);
    expect(store.map.has(TURN_KEY)).toBe(false);
    expect(writeTurn(null, relay)).toBe(false);
    // Shown in the room as a host name only: credentials never appear on screen.
    expect(turnHost({ ...relay, url: 'turns:relay.example.com:5349?transport=tcp' })).toBe('relay.example.com:5349');
  });
});
