import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../core';
import type { CrowdProfile } from './crowd';
import type { Cue } from './cues';
import { SoundDriver } from './driver';
import type { AudioEngine } from './engine';
import { MAP_H, fighter, hitEvent, killEvent, world } from './testkit';

/** Records what the driver asks of the engine; no WebAudio needed. */
function fakeEngine() {
  const calls = {
    played: [] as Cue[],
    babbles: [] as AudioBuffer[],
    crowd: [] as number[],
    grind: [] as { fighters: number; pan: number }[],
    profiles: [] as CrowdProfile[],
  };
  const engine = {
    ctx: { currentTime: 0, sampleRate: 48000 },
    startAmbience: () => undefined,
    setBabble: (b: AudioBuffer) => void calls.babbles.push(b),
    setProfile: (p: CrowdProfile) => void calls.profiles.push(p),
    setWallMoving: () => undefined,
    setGrind: (fighters: number, pan: number) => void calls.grind.push({ fighters, pan }),
    setCrowd: (i: number) => void calls.crowd.push(i),
    setRate: () => undefined,
    tick: () => undefined,
    stopAll: () => undefined,
    play: (cue: Cue) => {
      calls.played.push(cue);
      return true;
    },
  };
  return { engine: engine as unknown as AudioEngine, calls, ctx: engine.ctx };
}

/** A babble loader whose renders finish when the test says so. */
function slowLoader() {
  const pending: { seed: number; resolve: (b: AudioBuffer) => void }[] = [];
  const load = (p: CrowdProfile) => new Promise<AudioBuffer>((resolve) => pending.push({ seed: p.seed, resolve }));
  return { load, pending };
}

const buffer = (tag: number) => ({ tag }) as unknown as AudioBuffer;
const flush = () => new Promise((r) => setTimeout(r, 0));

const finalKill = (): GameEvent[] => [
  { ...killEvent('f0', 'f1', 3000, { final: true }) },
  { type: 'match_end', tick: 3000, placements: ['f0', 'f1'], ending: 'elimination' },
];

describe('SoundDriver', () => {
  // The kill event and the controller's final_kill signal arrive in the same frame in either order.
  it('plays the final sting once per final kill, whichever arrives first, and again next match', () => {
    const { engine, calls } = fakeEngine();
    const d = new SoundDriver(engine, 1, slowLoader().load);
    const s = world([fighter('f0', 400), fighter('f1', 500, MAP_H / 2, { alive: false })], 3000);
    const stings = () => calls.played.filter((c) => c.sound === 'final_sting').length;
    d.onEvents(finalKill(), s);
    d.onSignal({ type: 'final_kill', killerId: 'f0', victimId: 'f1', pos: { x: 500, y: 430 } });
    expect(stings()).toBe(1);
    d.startRound(2);
    d.onSignal({ type: 'final_kill', killerId: 'f0', victimId: 'f1', pos: { x: 500, y: 430 } });
    d.onEvents(finalKill(), s);
    expect(stings()).toBe(2);
  });

  // A restart keeps its crowd (same seed, same match); a new match gets a new one, and a slow
  // render for an old round never replaces the new round's crowd.
  it('renders one crowd per seed and never lets a stale render win', async () => {
    const { engine, calls } = fakeEngine();
    const loader = slowLoader();
    const d = new SoundDriver(engine, 5, loader.load);
    expect(loader.pending.map((p) => p.seed)).toEqual([5]);
    d.startRound(5);
    expect(loader.pending.length).toBe(1);
    d.startRound(6);
    expect(loader.pending.map((p) => p.seed)).toEqual([5, 6]);
    expect(d.profile.seed).toBe(6);
    loader.pending[1]!.resolve(buffer(6));
    loader.pending[0]!.resolve(buffer(5));
    await flush();
    expect(calls.babbles).toEqual([buffer(6)]);
  });

  // The crowd breathes: up in a brawl, down to almost nothing once it stops; frozen while paused.
  it('swells the bed in a brawl, lets it fall in a lull and holds it through a pause', () => {
    const { engine, calls } = fakeEngine();
    const d = new SoundDriver(engine, 9, slowLoader().load);
    const duel = world([fighter('f0', 600), fighter('f1', 650)], 600);
    for (let i = 0; i < 300; i++) {
      duel.tick++;
      d.onEvents(i % 20 === 0 ? [hitEvent('f0', 'f1', 25, duel.tick)] : [], duel);
      d.frame(1 / 60, 1);
    }
    const hot = calls.crowd.at(-1)!;
    expect(hot).toBeGreaterThan(0.5);
    for (let i = 0; i < 60; i++) d.frame(1 / 60, 0);
    expect(calls.crowd.at(-1)).toBeCloseTo(hot, 6);
    const apart = world([fighter('f0', 100), fighter('f1', 1200)], duel.tick);
    for (let i = 0; i < 600; i++) {
      apart.tick++;
      d.onEvents([], apart);
      d.frame(1 / 60, 1);
    }
    expect(calls.crowd.at(-1)).toBeLessThan(0.1);
  });

  it('holds the grind loop open while someone touches the wall, toward their side', () => {
    const { engine, calls } = fakeEngine();
    const d = new SoundDriver(engine, 3, slowLoader().load);
    const s = world([fighter('f0', 60)], 4000);
    d.onEvents([{ type: 'wall_contact', tick: 4000, fighterId: 'f0', damage: 2, pos: { x: 40, y: 430 } }], s);
    expect(calls.grind.at(-1)!.fighters).toBe(1);
    expect(calls.grind.at(-1)!.pan).toBeLessThan(-0.4);
    d.onEvents([], s);
    expect(calls.grind.at(-1)!.fighters).toBe(0);
  });
});
