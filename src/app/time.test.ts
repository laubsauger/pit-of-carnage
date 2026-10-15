import { describe, expect, it } from 'vitest';
import { TICK_HZ } from '../core';
import type { GameEvent } from '../core';
import { FINAL_MOMENT, FixedStep, KILL_MOMENT, MAX_FRAME_SECONDS, TimeDirector } from './time';

/** Ticks simulated over `seconds` of real time at a display refresh of `hz`. */
function run(hz: number, seconds: number, rate = 1): number {
  const clock = new FixedStep();
  let ticks = 0;
  for (let i = 0; i < Math.round(seconds * hz); i++) ticks += clock.advance(1 / hz, rate);
  return ticks;
}

describe('FixedStep', () => {
  // The quality bar: a fixed 60 Hz simulation independent of display refresh. A 144 Hz monitor must
  // not play the match faster than a 60 Hz one.
  it('simulates TICK_HZ ticks per real second at 1x on any display refresh', () => {
    for (const hz of [30, 60, 75, 120, 144, 165]) expect(run(hz, 10)).toBe(10 * TICK_HZ);
  });

  it('scales with playback speed', () => {
    expect(run(60, 4, 0.25)).toBe(TICK_HZ);
    expect(run(60, 1, 4)).toBe(4 * TICK_HZ);
  });

  it('does not advance with a rate of 0 (paused, hit-stop)', () => {
    expect(run(60, 2, 0)).toBe(0);
  });

  // A tab that comes back after 30 s must not run 1800 ticks in one frame and skip every kill.
  it('caps a long stall at MAX_FRAME_SECONDS of game time', () => {
    const clock = new FixedStep();
    expect(clock.advance(30, 1)).toBe(Math.floor(MAX_FRAME_SECONDS * TICK_HZ));
  });

  it('keeps the leftover fraction as the interpolation alpha', () => {
    const clock = new FixedStep();
    expect(clock.advance(1.5 / TICK_HZ, 1)).toBe(1);
    expect(clock.alpha).toBeCloseTo(0.5, 5);
    clock.reset();
    expect(clock.alpha).toBe(0);
  });
});

const kill: GameEvent = {
  type: 'kill', tick: 10, killerId: 'f0', victimId: 'f1', cause: 'weapon', pos: { x: 0, y: 0 }, dir: 0, title: 'SPLIT',
  killerBehaviour: null, victimBehaviour: 'brawl', weapon: 'GREATSWORD', flags: [], hazard: null,
};

/** Scale per frame for `seconds` of 60 Hz frames. */
function trace(d: TimeDirector, seconds: number): number[] {
  return Array.from({ length: Math.round(seconds * 60) }, () => d.update(1 / 60));
}

describe('TimeDirector', () => {
  it('runs at full speed when nothing happens', () => {
    expect(trace(new TimeDirector(), 1).every((s) => s === 1)).toBe(true);
  });

  // A death is an event: a beat of hit-stop, then slow motion, then back to normal.
  it('freezes briefly on a kill, slows down, and is back to full speed within about a second', () => {
    const d = new TimeDirector();
    d.onEvents([kill]);
    const s = trace(d, 1.5);
    expect(s[0]).toBe(0);
    expect(s[Math.ceil(KILL_MOMENT.stop * 60) + 2]).toBe(KILL_MOMENT.scale);
    expect(s[s.length - 1]).toBe(1);
  });

  // Five kills in one brawl must not stack into a crawl or a minute of slow motion.
  it('never goes slower or longer than the strongest single moment when kills overlap', () => {
    const one = new TimeDirector();
    one.onEvents([kill]);
    const many = new TimeDirector();
    many.onEvents([kill, kill, kill, kill, kill]);
    expect(trace(many, 2)).toEqual(trace(one, 2));
  });

  it('gives the match-ending kill a longer, slower look than an ordinary kill', () => {
    const d = new TimeDirector();
    d.onEvents([kill, { type: 'match_end', tick: 10, placements: ['f0', 'f1'], ending: 'elimination' }]);
    const s = trace(d, 3);
    const slowFrames = s.filter((x) => x > 0 && x < 1).length;
    expect(Math.min(...s.filter((x) => x > 0))).toBe(FINAL_MOMENT.scale);
    expect(slowFrames / 60).toBeGreaterThan(KILL_MOMENT.hold + 0.5);
    expect(s[s.length - 1]).toBe(1);
  });

  it('forgets pending slow motion on reset (new match or seek)', () => {
    const d = new TimeDirector();
    d.onEvents([kill]);
    d.reset();
    expect(d.update(1 / 60)).toBe(1);
  });
});
