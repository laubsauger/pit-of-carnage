import { describe, expect, it } from 'vitest';
import type { MatchSignal } from '../core';
import { COUNTDOWN_BEATS, COUNTDOWN_BEAT_SECONDS, FIGHT_FLASH_SECONDS, FINAL_SECONDS, RoundFlow } from './round';

/** Run `seconds` of real time in 60 Hz frames, collecting every signal sent. */
function run(flow: RoundFlow, seconds: number, out: MatchSignal[] = []): MatchSignal[] {
  const frames = Math.round(seconds * 60);
  for (let i = 0; i < frames; i++) {
    flow.update(1 / 60);
    out.push(...flow.takeSignals());
  }
  return out;
}

const COUNTDOWN_SECONDS = COUNTDOWN_BEATS * COUNTDOWN_BEAT_SECONDS;

describe('RoundFlow: the round is framed, never just started mid-air', () => {
  it('holds the match behind the splash: nothing simulates or counts down before "Enter the pit"', () => {
    const flow = new RoundFlow();
    flow.begin();
    expect(run(flow, 5)).toEqual([]);
    expect(flow.holds).toBe(true);
    expect(flow.phase(true, false)).toBe('splash');
    expect(flow.phase(false, false)).toBe('loading');
  });

  it('counts 3, 2, 1 with the sim held, then FIGHT! releases it (spec: about 2.5 s)', () => {
    const flow = new RoundFlow();
    flow.begin();
    flow.enter();
    const sent = flow.takeSignals();
    expect(sent).toEqual([{ type: 'countdown', value: 3 }]);
    expect(flow.phase(true, false)).toBe('countdown');
    expect(flow.countdown()).toBe(3);
    // Every frame of the countdown holds the sim.
    const frames = Math.round(COUNTDOWN_SECONDS * 60) - 2;
    for (let i = 0; i < frames; i++) {
      flow.update(1 / 60);
      sent.push(...flow.takeSignals());
      expect(flow.holds, `frame ${i}`).toBe(true);
    }
    sent.push(...run(flow, 0.1));
    expect(sent).toEqual([{ type: 'countdown', value: 3 }, { type: 'countdown', value: 2 }, { type: 'countdown', value: 1 }, { type: 'fight' }]);
    expect(flow.holds).toBe(false);
    expect(flow.phase(true, false)).toBe('live');
    expect(flow.countdown()).toBe(0); // FIGHT! still on screen
    run(flow, FIGHT_FLASH_SECONDS);
    expect(flow.countdown()).toBeNull();
    expect(COUNTDOWN_SECONDS).toBeGreaterThanOrEqual(2.2);
    expect(COUNTDOWN_SECONDS).toBeLessThanOrEqual(2.8);
  });

  it('a match started after entering counts down at once; one built before waits for the entry', () => {
    const late = new RoundFlow();
    late.enter();
    expect(late.takeSignals()).toEqual([]); // no match yet: nothing to count down
    late.begin();
    expect(late.takeSignals()).toEqual([{ type: 'countdown', value: 3 }]);
    expect(late.enter()).toBe(false); // a second entry is a no-op
    expect(late.takeSignals()).toEqual([]);
  });

  it('skip during the countdown starts the fight now (Space or a click)', () => {
    const flow = new RoundFlow();
    flow.begin();
    flow.enter();
    flow.takeSignals();
    run(flow, 0.5);
    flow.skip();
    expect(flow.takeSignals()).toEqual([{ type: 'fight' }]);
    expect(flow.holds).toBe(false);
    expect(flow.phase(true, false)).toBe('live');
  });

  it('a jump into the match (gym Watch at a kill) ends the countdown silently: no FIGHT hit over a replayed death', () => {
    const flow = new RoundFlow();
    flow.begin();
    flow.enter();
    flow.skip(); // the app skips, then seeks, in one go
    flow.jumped(false);
    expect(flow.takeSignals()).toEqual([]);
    expect(flow.countdown()).toBeNull();
    expect(flow.holds).toBe(false);
  });

  it('the decided match holds the final moment about 3 s before the end card; skip shows the card now', () => {
    const flow = new RoundFlow();
    flow.begin();
    flow.enter();
    flow.skip();
    run(flow, 10);
    flow.decided();
    expect(flow.phase(true, true)).toBe('final');
    run(flow, FINAL_SECONDS - 0.2);
    expect(flow.phase(true, true)).toBe('final');
    run(flow, 0.3);
    expect(flow.phase(true, true)).toBe('ended');

    const again = new RoundFlow();
    again.begin();
    again.enter();
    again.skip();
    again.decided();
    again.skip();
    expect(again.phase(true, true)).toBe('ended');
  });

  it('a replay to the end goes straight to the end card: the moment is admired once per match', () => {
    const flow = new RoundFlow();
    flow.begin();
    flow.enter();
    flow.skip();
    flow.decided();
    run(flow, FINAL_SECONDS + 0.5);
    // Seek back into the match: live again.
    flow.jumped(false);
    expect(flow.phase(true, false)).toBe('live');
    // Play to the end again.
    flow.decided();
    expect(flow.phase(true, true)).toBe('ended');
    // A new match gets its own moment.
    flow.begin();
    flow.skip();
    flow.decided();
    expect(flow.phase(true, true)).toBe('final');
  });

  it('seeking straight onto the decided end skips the moment as well', () => {
    const flow = new RoundFlow();
    flow.begin();
    flow.enter();
    flow.jumped(true);
    flow.decided();
    expect(flow.phase(true, true)).toBe('ended');
  });

  it('the countdown waits while the game is paused (leaving Watch) instead of running out behind it', () => {
    const flow = new RoundFlow();
    flow.begin();
    flow.enter();
    for (let i = 0; i < 600; i++) flow.update(1 / 60, true);
    expect(flow.phase(true, false)).toBe('countdown');
    expect(flow.countdown()).toBe(3);
  });

  it('the final moment runs in real time even while paused, so a match stepped to its end reaches the end card', () => {
    const flow = new RoundFlow();
    flow.begin();
    flow.enter();
    flow.skip();
    flow.decided();
    for (let i = 0; i < Math.round((FINAL_SECONDS + 0.2) * 60); i++) flow.update(1 / 60, true);
    expect(flow.phase(true, true)).toBe('ended');
  });

  it('queued signals are sent once, in order, and a seek drops them', () => {
    const flow = new RoundFlow();
    flow.begin();
    flow.enter();
    flow.signal({ type: 'final_kill', killerId: 'f0', victimId: 'f1', pos: { x: 1, y: 2 } });
    expect(flow.takeSignals().map((s) => s.type)).toEqual(['countdown', 'final_kill']);
    expect(flow.takeSignals()).toEqual([]);
    flow.signal({ type: 'fight' });
    flow.jumped(false);
    expect(flow.takeSignals()).toEqual([]);
  });
});
