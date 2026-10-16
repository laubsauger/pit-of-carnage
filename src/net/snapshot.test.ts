import { describe, expect, it } from 'vitest';
import type { GameEvent, WorldState } from '../core';
import { MAPS } from '../sim';
import { decodeFrame, encodeFrame, mapFingerprint, parseMatchInfo } from './snapshot';
import type { StreamMatchInfo, WireFrame } from './snapshot';
import { differences, houseMatch, stepFrames } from './testkit';

function infoFor(state: WorldState, timeLimitTicks = 5400): StreamMatchInfo {
  const map = MAPS[state.mapId]!;
  return {
    id: 7, mapId: map.id, mapHash: mapFingerprint(map), seed: 1, format: 'ffa', timeLimitTicks, suddenDeath: true, friendlyFire: true, fightAt: 0,
    fighters: state.fighters.map((f) => ({
      id: f.id, entrantId: f.entrantId, squad: f.squad, name: f.name, color: f.color, weapon: f.weapon, skill: f.skill, attributes: f.attributes,
      radius: f.radius, owner: null,
    })),
  };
}

/** Through JSON, like the wire. */
function wire(frame: WireFrame): unknown {
  return JSON.parse(JSON.stringify(frame));
}

/** A whole real match, frames every 3 ticks (what the host sends at 1x). */
function recordMatch(seed: number, mapId: string, maxTicks = 20_000) {
  const match = houseMatch(seed, mapId, 8);
  const index = new Map(match.state.fighters.map((f, i) => [f.id, i]));
  const frames: { state: WorldState; events: GameEvent[]; frame: WireFrame }[] = [];
  stepFrames(match, 3, maxTicks, (state, events) => {
    frames.push({ state, events, frame: encodeFrame(7, state.tick * 16.7, 1, state, events, index) });
  });
  return { match, frames, info: infoFor(match.state) };
}

// Whole real matches: generous under a loaded machine, still bounded.
describe('frame codec', { timeout: 60_000 }, () => {
  // Peers draw only what the frames carry: if a field is lost or bent, every peer sees a different
  // fight from the host's. Whole matches on two maps (saws and spills on the grinder) cover every
  // field the sim fills, including spilled acid, floor items, sudden death and the end.
  it.each([
    ['pit', 11],
    ['meat_grinder', 5],
  ])('rebuilds every state of a real match on %s within rounding', (mapId, seed) => {
    const { frames, info, match } = recordMatch(seed, mapId);
    expect(match.isOver, 'the recorded match must finish within the tick bound').toBe(true);
    const map = MAPS[mapId]!;
    let events = 0;
    for (const { state, frame, events: sent } of frames) {
      const decoded = decodeFrame(wire(frame), info, map);
      expect(decoded, `frame at tick ${state.tick} was refused`).not.toBeNull();
      // Positions are rounded to 0.01 px, angles to 0.001 rad, HP to 0.1.
      const diff = differences(decoded!.state, state, 0.051);
      expect(diff.slice(0, 5), `tick ${state.tick}`).toEqual([]);
      expect(decoded!.events).toEqual(sent);
      expect(decoded!.droppedEvents).toBe(0);
      events += sent.length;
    }
    const last = frames.at(-1)!.state;
    expect(last.finished).toBe(true);
    expect(events).toBeGreaterThan(100);
  });

  it('keeps frames small enough to stream to several peers', () => {
    // 20 frames a second to up to 7 peers comes out of the host's upload; a full 8-fighter frame
    // must stay a few kB, not tens.
    const { frames } = recordMatch(3, 'pit', 3000);
    const sizes = frames.map((f) => JSON.stringify({ ...f.frame, e: [] }).length);
    expect(Math.max(...sizes)).toBeLessThan(6000);
  });

  it('refuses frames that do not fit their match', () => {
    const { frames, info } = recordMatch(4, 'pit', 300);
    const map = MAPS.pit!;
    const good = wire(frames.at(-1)!.frame) as Record<string, unknown>;
    expect(decodeFrame(good, info, map)).not.toBeNull();
    const broken = (patch: (f: Record<string, unknown> & { f: unknown[][] }) => void) => {
      const f = structuredClone(good) as Record<string, unknown> & { f: unknown[][] };
      patch(f);
      return decodeFrame(f, info, map);
    };
    expect(broken((f) => (f.m = 8)), 'another match').toBeNull();
    expect(broken((f) => f.f.pop()), 'a fighter missing').toBeNull();
    expect(broken((f) => (f.f[0]![0] = Number.NaN)), 'NaN position').toBeNull();
    expect(broken((f) => (f.f[0]![0] = '12')), 'string for a number').toBeNull();
    expect(broken((f) => (f.f[0]![32] = 99)), 'target index outside the roster').toBeNull();
    expect(broken((f) => (f.f[0]![32] = 0.5)), 'fractional index').toBeNull();
    expect(broken((f) => (f.f[0]![34] = 'x'.repeat(500))), 'huge behaviour name').toBeNull();
    expect(broken((f) => (f.o = [])), 'props not matching the map').toBeNull();
    expect(broken((f) => (f.k = -1)), 'negative tick').toBeNull();
    expect(broken((f) => (f.p = Array.from({ length: 600 }, () => ['p1', 0, 0, 1, 1, 0, 0, 1, 1, 1]))), 'projectile flood').toBeNull();
    expect(broken((f) => (f.x = [1, 0, 0, 0])), 'a fighter placed twice').toBeNull();
    expect(decodeFrame('frame', info, map)).toBeNull();
    expect(decodeFrame(null, info, map)).toBeNull();
  });

  // Stuck arrows follow the body they sit in and the bleed drips: a peer that loses either draws a
  // different fight. Built by hand so the codec is covered whether or not the sim fills them yet.
  it('carries stuck ammo and bleeding exactly as the host has them', () => {
    const match = houseMatch(2, 'pit', 4);
    for (let i = 0; i < 30; i++) match.step();
    const state = structuredClone(match.state);
    state.stuck = [
      { id: 's1', kind: 'arrow', ownerId: 'f1', pos: { x: 100.5, y: 200.25 }, angle: 1.25, in: { kind: 'fighter', fighterId: 'f2', u: 4.5, v: -3, turn: 0.5 }, pickupPos: null, tick: 20 },
      { id: 's2', kind: 'axe', ownerId: null, pos: { x: 10, y: 20 }, angle: -2, in: { kind: 'wall' }, pickupPos: { x: 14, y: 20 }, tick: 21 },
      { id: 's3', kind: 'arrow', ownerId: 'f0', pos: { x: 300, y: 310 }, angle: 0, in: { kind: 'prop', propId: state.props[0]?.id ?? 'crate_1' }, pickupPos: { x: 290, y: 310 }, tick: 22 },
      { id: 's4', kind: 'arrow', ownerId: 'f3', pos: { x: 50, y: 60 }, angle: 3, in: { kind: 'floor' }, pickupPos: { x: 50, y: 60 }, tick: 23 },
    ];
    state.fighters[0]!.bleed = { ticks: 90, damagePerTick: 0.25, sourceId: 'f1' };
    state.fighters[1]!.bleed = null;
    delete state.fighters[2]!.bleed;
    const info = infoFor(state);
    const index = new Map(state.fighters.map((f, i) => [f.id, i]));
    const d = decodeFrame(wire(encodeFrame(7, 500, 1, state, [], index)), info, MAPS.pit!);
    expect(d).not.toBeNull();
    expect(differences(d!.state, state, 0.051)).toEqual([]);
    // A body that is not in the match, or a flood of stuck arrows, refuses the frame.
    const bad = wire(encodeFrame(7, 500, 1, state, [], index)) as WireFrame;
    bad.a[0]![8] = 9;
    expect(decodeFrame(bad, info, MAPS.pit!)).toBeNull();
    const flood = wire(encodeFrame(7, 500, 1, state, [], index)) as WireFrame;
    flood.a = Array.from({ length: 300 }, () => flood.a[1]!);
    expect(decodeFrame(flood, info, MAPS.pit!)).toBeNull();
  });

  it('drops bad events but keeps the frame', () => {
    const { frames, info } = recordMatch(4, 'pit', 300);
    const f = wire(frames.at(-1)!.frame) as Omit<WireFrame, 'e'> & { e: unknown[] };
    const tick = f.k;
    f.e = [
      { type: 'swing', tick, fighterId: 'f0', weapon: 'GREATSWORD' },
      { type: 'swing', tick, fighterId: 'nobody', weapon: 'GREATSWORD' }, // unknown fighter
      { type: 'swing', tick: tick + 5, fighterId: 'f0', weapon: 'GREATSWORD' }, // from the future
      { type: 'launch_nukes', tick },
      { type: 'bark', tick, fighterId: 'f0', kind: 'taunt', text: 'line\u0000break' },
    ];
    const d = decodeFrame(f, info, MAPS.pit!);
    expect(d).not.toBeNull();
    expect(d!.events).toEqual([{ type: 'swing', tick, fighterId: 'f0', weapon: 'GREATSWORD' }]);
    expect(d!.droppedEvents).toBe(4);
  });
});

describe('match announcements', () => {
  const state = houseMatch(1, 'pit', 4).state;

  it('accepts a good one and keeps only known fields', () => {
    const r = parseMatchInfo({ ...infoFor(state), extra: 'ignored' });
    expect('info' in r).toBe(true);
    if ('info' in r) {
      expect(r.map).toBe(MAPS.pit);
      expect(r.info.fighters.map((f) => f.id)).toEqual(['f0', 'f1', 'f2', 'f3']);
      expect('extra' in r.info).toBe(false);
    }
  });

  it('tells a different arena apart from garbage', () => {
    // A peer on another game version must hear "reload", not draw the host's fight on the wrong walls.
    expect(parseMatchInfo({ ...infoFor(state), mapHash: (mapFingerprint(MAPS.pit!) + 1) >>> 0 })).toEqual({ problem: 'map-mismatch' });
    expect(parseMatchInfo({ ...infoFor(state), mapId: 'moon_base' })).toEqual({ problem: 'unknown-map' });
    expect(parseMatchInfo({ ...infoFor(state), mapId: '__proto__' })).toEqual({ problem: 'unknown-map' });
    const dupe = infoFor(state);
    dupe.fighters[1] = { ...dupe.fighters[1]!, id: 'f0' };
    expect(parseMatchInfo(dupe)).toEqual({ problem: 'malformed' });
    expect(parseMatchInfo({ ...infoFor(state), fighters: [] })).toEqual({ problem: 'malformed' });
    const badColor = infoFor(state);
    badColor.fighters[0] = { ...badColor.fighters[0]!, color: 'url(evil)' };
    expect(parseMatchInfo(badColor)).toEqual({ problem: 'malformed' });
  });
});
