import { describe, expect, it } from 'vitest';
import type { GameEvent, Strategy } from '../core';
import { MAPS } from '../sim';
import { encodeStrategyCode, loadStrategy } from '../strategy';
import { INBOUND_BURST, RoomClient } from './client';
import { RoomHost } from './host';
import { PLAYER_TIMING } from './player';
import { hostStorageKey, hostedRooms } from './saved';
import { MAX_MEMBERS, PROTOCOL_VERSION } from './protocol';
import { encodeFrame, mapFingerprint } from './snapshot';
import { createMemoryHub } from './transport';
import type { Transport } from './transport';
import { broughtStrategy, houseMatch } from './testkit';

const CODE = 'KRZBW';

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
    map: m,
  };
}

/** A room with a host on a fake clock; matches are short to set up so tests run whole ones. */
function room() {
  const hub = createMemoryHub();
  let t = 0;
  const now = () => t;
  let seed = 12345;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
  const storage = memoryStorage();
  const clients: RoomClient[] = [];
  const timing = { introMs: 600, outroMs: 1000 };
  const makeHost = () => new RoomHost({ code: CODE, name: 'Host', clientId: 'host-client-000000', transport: hub.join(), now, random, storage, timing });
  let host = makeHost();
  host.setSettings({ fighters: 4 });

  /** Deliver what is in flight, let `ms` pass, pump everyone, deliver again. */
  const pump = (ms = 50) => {
    hub.flush();
    t += ms;
    host.pump();
    for (const c of clients) c.pump();
    hub.flush();
  };
  /** Pump until `cond` holds; fails with `what` after `max` pumps (a test never hangs). */
  const until = (cond: () => boolean, what: string, max = 4000, ms = 250) => {
    for (let i = 0; i < max; i++) {
      if (cond()) return;
      pump(ms);
    }
    throw new Error(`Gave up waiting for ${what} after ${max} pumps.`);
  };
  const join = (name: string, client: string, opts: { spy?: unknown[] } = {}) => {
    const transport = hub.join();
    const c = new RoomClient({ code: CODE, name, clientId: client, transport, now });
    if (opts.spy) {
      const inner = transport.onMessage!;
      transport.onMessage = (m, from) => {
        opts.spy!.push(m);
        inner(m, from);
      };
    }
    clients.push(c);
    hub.flush();
    return c;
  };
  /** A raw browser in the room that sends whatever it likes. */
  const rogue = (): Transport => {
    const tr = hub.join();
    hub.flush();
    return tr;
  };
  return {
    hub, storage, join, rogue, pump, until, now,
    get host() {
      return host;
    },
    reopen() {
      host = makeHost();
      hub.flush();
      return host;
    },
  };
}

const secretStrategy = (): Strategy => ({ ...broughtStrategy('Lurking Gary', 3), author: 'SECRET-AUTHOR-MARK' });

// Hosts play whole real matches: generous under a loaded machine, still bounded.
describe('rooms', { timeout: 60_000 }, () => {
  it('lets peers join by code and shows everyone who is there', () => {
    const r = room();
    const ana = r.join('Ana', 'ana-client-0000000');
    const ben = r.join('Ana', 'ben-client-0000000'); // same name: the host tells them apart
    r.pump();
    expect(ana.getView()).toMatchObject({ status: 'connected', me: 'm1' });
    expect(ben.getView()).toMatchObject({ status: 'connected', me: 'm2' });
    const members = r.host.getView().room!.members;
    expect(members.map((m) => [m.name, m.online, m.host])).toEqual([
      ['Host', true, true],
      ['Ana', true, false],
      ['Ana 2', true, false],
    ]);
    // Peers see the same list.
    expect(ana.getView().room!.members).toEqual(members);
  });

  it("gates a peer's strategy on the host and never shows its text to others", () => {
    const r = room();
    const ana = r.join('Ana', 'ana-client-0000000');
    const seenByBen: unknown[] = [];
    const ben = r.join('Ben', 'ben-client-0000000', { spy: seenByBen });
    r.pump();
    expect(ana.add(secretStrategy(), 'saved')).toMatchObject({ ok: true });
    r.pump(300); // room-state broadcasts are spaced out (HOST_TIMING.stateMs)
    const entries = r.host.getView().room!.entries;
    expect(entries).toEqual([expect.objectContaining({ member: 'm1', owner: 'Ana', name: 'Lurking Gary', version: 1 })]);
    expect(ana.getView().notices.at(-1)).toMatchObject({ tone: 'good', text: expect.stringContaining('joined the pool') });
    expect(ben.getView().room!.entries).toEqual(entries);
    // Strategy theft is a real concern: other peers get the name, never the strategy.
    r.until(() => (r.host.getView().room!.board.length ?? 0) > 0, 'a rated match');
    expect(JSON.stringify(seenByBen)).not.toContain('SECRET-AUTHOR-MARK');
  });

  it('refuses broken strategies with the reason, also when a peer skips its own check', () => {
    const r = room();
    const ana = r.join('Ana', 'ana-client-0000000');
    r.pump();
    expect(ana.add({ schema: 'pit-strategy/2', name: 'Half a thought' }, 'paste')).toMatchObject({ ok: false });
    // A modified client sends junk straight to the host: the host's gate answers.
    const mallory = r.rogue();
    const replies: unknown[] = [];
    mallory.onMessage = (m) => replies.push(m);
    mallory.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'Mallory', client: 'mallory-client-0000' });
    r.pump();
    mallory.send({ t: 'add', strategy: '{"schema":"pit-strategy/2","name":"x","behaviours":{"a":{"score":"eval(1)"}}}' });
    mallory.send({ t: 'add', strategy: 'PIT2.bm90IGEgcmVhbCBjb2Rl' });
    r.pump();
    const answers = replies.filter((m) => (m as { t: string }).t === 'added') as { ok: boolean; line: string }[];
    expect(answers).toHaveLength(2);
    expect(answers.every((a) => !a.ok && a.line.startsWith("The host's gate refused it"))).toBe(true);
    expect(r.host.getView().room!.entries).toEqual([]);
  });

  it('lets members remove only their own strategies', () => {
    const r = room();
    const ana = r.join('Ana', 'ana-client-0000000');
    const ben = r.join('Ben', 'ben-client-0000000');
    r.pump();
    ana.add(broughtStrategy('Anas Pick'), 'saved');
    r.pump();
    const id = r.host.getView().room!.entries[0]!.id;
    ben.remove(id);
    r.pump();
    expect(r.host.getView().room!.entries).toHaveLength(1);
    ana.remove(id);
    r.pump();
    expect(r.host.getView().room!.entries).toHaveLength(0);
  });

  it('runs back-to-back matches, rates them, and every peer watches the same fight', () => {
    const r = room();
    r.host.setSettings({ running: false }); // no house warm-up: both strategies play from match 1
    const ana = r.join('Ana', 'ana-client-0000000');
    const ben = r.join('Ben', 'ben-client-0000000');
    r.pump();
    ana.add(broughtStrategy('Anas Pick', 2), 'saved');
    ben.add(broughtStrategy('Bens Pick', 5), 'saved');
    r.pump();
    r.host.setSettings({ running: true });
    let checked = 0;
    r.until(() => {
      // Whenever a frame lands, both peers hold exactly the state the host shows itself.
      const h = r.host.player.latest;
      if (h && h.tick > 0) {
        expect(ana.player.latest).toEqual(h);
        expect(ben.player.latest).toEqual(h);
        checked++;
      }
      return r.host.getView().room!.history.length >= 2;
    }, 'two finished matches');
    expect(checked).toBeGreaterThan(50);
    const view = r.host.getView().room!;
    // Ana and Ben's strategies played (4 seats: both in every match) and are rated, with owners.
    for (const [name, owner] of [['Anas Pick', 'Ana'], ['Bens Pick', 'Ben']]) {
      expect(view.board.find((b) => b.name === name)).toMatchObject({ owner, matches: 2 });
      expect(view.entries.find((e) => e.name === name)?.matches).toBe(2);
    }
    // House stacks filled the other seats and are rated too.
    expect(view.board.filter((b) => b.owner === null).length).toBeGreaterThanOrEqual(2);
    expect(view.history.map((h) => h.id)).toEqual([2, 1]);
    expect(ana.getView().room!.history).toEqual(view.history);
    // The peers' players followed the second match to its end.
    expect(ana.player.info?.id).toBeGreaterThanOrEqual(2);
  });

  it('stops after the current match when the host pauses the room', () => {
    const r = room();
    r.until(() => r.host.getView().room!.match !== null, 'a warm-up match');
    r.host.setSettings({ running: false });
    r.until(() => r.host.getView().room!.match === null, 'the match to finish');
    const played = r.host.getView().room!.history.length;
    for (let i = 0; i < 40; i++) r.pump(250);
    expect(r.host.getView().room!.history.length).toBe(played);
    expect(r.host.getView().room!.match).toBeNull();
  });

  it('keeps your member id and strategies when you leave and come back', () => {
    const r = room();
    const ana = r.join('Ana', 'ana-client-0000000');
    r.pump();
    ana.add(broughtStrategy('Anas Pick'), 'saved');
    r.pump();
    ana.leave();
    r.pump();
    expect(r.host.getView().room!.members.find((m) => m.id === 'm1')).toMatchObject({ online: false });
    expect(r.host.getView().room!.entries).toHaveLength(1);
    const again = r.join('Ana B.', 'ana-client-0000000');
    r.pump();
    expect(again.getView()).toMatchObject({ status: 'connected', me: 'm1' });
    expect(r.host.getView().room!.entries[0]).toMatchObject({ member: 'm1', owner: 'Ana B.' });
    // Back under the same id, the strategy is hers to remove.
    again.remove(r.host.getView().room!.entries[0]!.id);
    r.pump();
    expect(r.host.getView().room!.entries).toHaveLength(0);
  });

  it('tells everyone when the host leaves, and the host can reopen the same room', () => {
    const r = room();
    const ana = r.join('Ana', 'ana-client-0000000');
    r.pump();
    ana.add(broughtStrategy('Anas Pick'), 'saved');
    r.until(() => r.host.getView().room!.history.length >= 1, 'a rated match');
    const board = r.host.getView().room!.board;
    r.host.leave();
    r.pump();
    expect(ana.getView().status).toBe('host-gone');
    expect(ana.getView().notices.at(-1)!.text).toMatch(/closed the room/);
    // Nothing frozen on screen pretends the fight goes on.
    expect(ana.player.info).toBeNull();
    expect(ana.player.sample(1e9)).toBeNull();
    expect(r.storage.map.has(hostStorageKey(CODE))).toBe(true);
    // Same browser, same code: the room comes back with its pool and its board.
    const back = r.reopen();
    r.pump();
    expect(ana.getView().status).toBe('connected');
    expect(ana.getView().notices.at(-1)!.text).toBe('The host is back.');
    expect(back.getView().room!.entries.map((e) => e.name)).toEqual(['Anas Pick']);
    expect(back.getView().room!.board).toEqual(board);
    expect(back.getView().room!.members.find((m) => m.id === 'm1')).toMatchObject({ name: 'Ana', online: true });
    // The lobby offers it again, whatever this browser joined since.
    r.storage.setItem('poc.room.host.ZZZZ', '{broken');
    expect(hostedRooms(r.storage)).toEqual([expect.objectContaining({ code: CODE, strategies: 1, matches: expect.any(Number) })]);
  });

  it('ignores anyone who pretends to be the host', () => {
    const r = room();
    const ana = r.join('Ana', 'ana-client-0000000');
    r.pump();
    const before = ana.getView().room;
    const fake = r.rogue();
    fake.send({ t: 'you', v: PROTOCOL_VERSION, member: 'm9' });
    fake.send({ t: 'state', state: { ...before, code: 'KRZBW', members: [] } });
    fake.send({ t: 'match', info: { id: 99 } });
    fake.send({ t: 'frame', m: 1, k: 0 });
    fake.send({ t: 'bye', reason: 'Go home.' });
    r.hub.flush();
    expect(ana.getView().status).toBe('connected');
    expect(ana.getView().me).toBe('m1');
    expect(ana.getView().room!.members).toEqual(before!.members);
    expect(ana.getView().rejected).toBe(5);
    // The host refuses all of it too (none of it is something a peer may say), and says that
    // someone else is acting as host of this room.
    expect(r.host.getView().rejected).toBe(4);
    expect(r.host.getView().notices.at(-1)!.text).toMatch(/also hosting/);
  });

  it('warns the host when another browser hosts the same code', () => {
    const r = room();
    const rival = r.rogue();
    rival.send({ t: 'state', state: r.host.getView().room });
    rival.send({ t: 'state', state: r.host.getView().room });
    r.hub.flush();
    const warnings = r.host.getView().notices.filter((n) => /also hosting/.test(n.text));
    expect(warnings).toHaveLength(1);
  });

  it('drops floods instead of processing them', () => {
    const r = room();
    const flood = r.rogue();
    for (let i = 0; i < 500; i++) flood.send({ t: 'nonsense', i });
    r.hub.flush();
    // A burst of 20 is checked (and refused); the rest never reaches the parser.
    expect(r.host.getView().rejected).toBe(20);
  });

  it('turns away other game versions and a full room, with the reason', () => {
    const r = room();
    const old = r.rogue();
    const replies: unknown[] = [];
    old.onMessage = (m) => replies.push(m);
    old.send({ t: 'hello', v: PROTOCOL_VERSION + 1, name: 'Future', client: 'future-client-00000' });
    r.hub.flush();
    expect(replies).toEqual([{ t: 'refused', reason: expect.stringMatching(/another version/) }]);

    const peers = Array.from({ length: MAX_MEMBERS - 1 }, (_, i) => r.join(`P${i}`, `peer-client-${i}-000000`));
    r.pump();
    expect(peers.every((p) => p.getView().status === 'connected')).toBe(true);
    const late = r.join('Late', 'late-client-0000000');
    r.pump();
    expect(late.getView().status).toBe('refused');
    expect(late.getView().notices.at(-1)!.text).toMatch(/full/);
  });

  it('shares strategies only when the host turns the reveal on, and then as codes that pass the gate', () => {
    const r = room();
    r.host.setSettings({ running: false });
    const ana = r.join('Ana', 'ana-client-0000000');
    const seenByBen: unknown[] = [];
    const ben = r.join('Ben', 'ben-client-0000000', { spy: seenByBen });
    r.pump();
    expect(r.host.getView().room!.settings.revealStrategies, 'off by default').toBe(false);
    ana.add(secretStrategy(), 'saved');
    r.pump();
    r.host.setSettings({ running: true });
    r.until(() => r.host.getView().room!.history.length >= 1, 'a finished match');
    const first = r.host.getView().room!.history[0]!.id;
    expect(seenByBen.some((m) => (m as { t: string }).t === 'reveal')).toBe(false);
    expect(JSON.stringify(seenByBen)).not.toContain('PIT2.');
    expect(ben.extras(first)?.revealed ?? null).toBeNull();

    r.host.setSettings({ revealStrategies: true });
    r.until(() => r.host.getView().room!.history.length >= 2, 'a finished match with the reveal on');
    const second = r.host.getView().room!.history[0]!.id;
    const revealed = ben.extras(second)?.revealed;
    expect(revealed, "Ben got the second match's strategies").toBeTruthy();
    expect(revealed!.length).toBe(4);
    // Every code is a real strategy (Ana's own among them), and gated like any other import.
    const loaded = revealed!.map((x) => loadStrategy(x.code, 'network'));
    expect(loaded.every((l) => l.strategy)).toBe(true);
    expect(loaded.find((l) => l.strategy!.name === 'Lurking Gary')?.strategy?.author).toBe('SECRET-AUTHOR-MARK');
    expect(revealed!.find((x) => x.name === 'Lurking Gary')).toMatchObject({ owner: 'Ana' });
    expect(r.host.extras(second)!.revealed!.map((x) => x.code)).toEqual(revealed!.map((x) => x.code));
  });

  it('gives every guest the battle report of a finished match', () => {
    const r = room();
    const ana = r.join('Ana', 'ana-client-0000000');
    r.pump();
    r.until(() => r.host.getView().room!.history.length >= 1, 'a finished match');
    const h = r.host.getView().room!.history[0]!;
    const report = r.host.extras(h.id)?.report;
    expect(report, 'the host recorded the match').toBeTruthy();
    expect(report).toContain(h.winner!);
    expect(ana.extras(h.id)?.report).toBe(report);
  });

  it("shows a guest the thinking of the fighter it selected, and only to that guest", () => {
    const r = room();
    const seenByAna: unknown[] = [];
    const ana = r.join('Ana', 'ana-client-0000000', { spy: seenByAna });
    const seenByBen: unknown[] = [];
    r.join('Ben', 'ben-client-0000000', { spy: seenByBen });
    r.until(() => (r.host.player.latest?.tick ?? 0) > 120 && ana.player.info?.id === r.host.player.info?.id, 'a match under way');
    const alive = r.host.player.latest!.fighters.find((f) => f.alive)!.id;
    ana.player.select(alive);
    r.host.player.select(alive);
    for (let i = 0; i < 6; i++) r.pump(100);
    const minds = (seen: unknown[]) => seen.filter((m) => (m as { t: string }).t === 'mind').length;
    expect(minds(seenByAna)).toBeGreaterThan(0);
    expect(minds(seenByBen), 'nobody asked for it').toBe(0);
    ana.player.advance(r.now());
    r.host.player.advance(r.now());
    // Same fighter, same picture: the guest sees what the host sees.
    expect(ana.player.decision(alive)?.behaviour).toBeTruthy();
    expect(ana.player.decision(alive)).toEqual(r.host.player.decision(alive));
    expect(ana.player.knowledge(alive)).toEqual(r.host.player.knowledge(alive));
    // Deselecting stops the stream.
    ana.player.select(null);
    for (let i = 0; i < 4; i++) r.pump(100);
    const before = minds(seenByAna);
    for (let i = 0; i < 6; i++) r.pump(100);
    expect(minds(seenByAna)).toBe(before);
  });

  it('paints the gore so far for someone who joins mid-match', () => {
    const r = room();
    r.until(() => r.host.player.latest !== null && r.host.player.latest.tick > 900, 'a match well under way');
    const joinedAt = r.host.player.latest!.tick;
    const seen: unknown[] = [];
    const cleo = r.join('Cleo', 'cleo-client-000000', { spy: seen });
    r.pump();
    const gore = seen.find((m) => (m as { t: string }).t === 'gore') as { e: GameEvent[] } | undefined;
    expect(gore, 'the host sent the gore so far').toBeDefined();
    expect(gore!.e.length).toBeGreaterThan(0);
    for (let i = 0; i < 4; i++) r.pump(100);
    const out = cleo.player.advance(r.now());
    expect(out?.reset).toBe(true);
    // The arena repaints from before Cleo arrived.
    expect(out!.events.filter((e) => e.tick < joinedAt - 600).length).toBeGreaterThan(0);
  });

  it('stays responsive when a hostile host floods it', () => {
    // One page, one hostile host: messages beyond the budget are dropped unread, the screen is told
    // once per pump, and what the player keeps stays within its limits.
    const hub = createMemoryHub();
    let t = 0;
    const evil = hub.join();
    const ana = new RoomClient({ code: CODE, name: 'Ana', clientId: 'ana-client-0000000', transport: hub.join(), now: () => t });
    let told = 0;
    ana.subscribe(() => told++);
    const match = houseMatch(1, 'pit', 4);
    const map = MAPS.pit!;
    const info = {
      id: 1, mapId: 'pit', mapHash: mapFingerprint(map), seed: 1, format: 'ffa', timeLimitTicks: 5400, suddenDeath: true, friendlyFire: true, fightAt: 0,
      fighters: match.state.fighters.map((f) => ({ id: f.id, entrantId: f.entrantId, squad: f.squad, name: f.name, color: f.color, weapon: f.weapon, skill: f.skill, attributes: f.attributes, radius: f.radius, owner: null })),
    };
    hub.flush();
    evil.send({ t: 'you', v: PROTOCOL_VERSION, member: 'm1' });
    evil.send({ t: 'match', info });
    hub.flush();
    expect(ana.getView().status).toBe('connected');
    const index = new Map(match.state.fighters.map((f, i) => [f.id, i]));
    const kill: GameEvent = { type: 'kill', tick: 0, killerId: 'f0', victimId: 'f1', cause: 'weapon', pos: { x: 1, y: 1 }, dir: 0, title: 'AGAIN', killerBehaviour: null, victimBehaviour: 'x', weapon: null, flags: [], hazard: null, final: false };
    const flood = 600;
    for (let i = 0; i < flood; i++) evil.send(encodeFrame(1, i + 1, 1, match.state, Array.from({ length: 40 }, () => kill), index));
    for (let i = 0; i < 200; i++) evil.send({ t: 'added', ok: true, line: `spam ${i}` });
    hub.flush();
    expect(ana.getView().rejected, 'everything past the burst is dropped unread').toBeGreaterThanOrEqual(flood + 200 - INBOUND_BURST);
    expect(ana.player.feed.length).toBeLessThanOrEqual(PLAYER_TIMING.maxFeed);
    expect(ana.player.marks.length).toBeLessThanOrEqual(PLAYER_TIMING.maxMarks);
    t += 16;
    ana.pump();
    expect(told, 'one screen update for the whole flood').toBe(1);
  });

  it('reopens with every stored strategy gated again', () => {
    const r = room();
    const ana = r.join('Ana', 'ana-client-0000000');
    r.pump();
    ana.add(broughtStrategy('Anas Pick'), 'saved');
    r.pump();
    r.host.leave();
    // Someone edits the stored room by hand: a broken strategy must not come back.
    const key = hostStorageKey(CODE);
    const saved = JSON.parse(r.storage.getItem(key)!);
    saved.entries.push({ id: 'e9', member: 'm1', owner: 'Ana', code: encodeStrategyCode({ name: 'Broken' } as Strategy), matches: 0 });
    r.storage.setItem(key, JSON.stringify(saved));
    const back = r.reopen();
    expect(back.getView().room!.entries.map((e) => e.name)).toEqual(['Anas Pick']);
  });
});
