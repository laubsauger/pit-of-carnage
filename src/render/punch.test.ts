import { describe, expect, it } from 'vitest';
import { KillPunch, PUNCH_RECOVERY } from './punch';

const FRAME = 1 / 60;

/** Play `seconds` of real time at 60 fps with a kill every `every` seconds; returns mean and peak. */
function run(p: KillPunch, seconds: number, every: number, skip = 0): { mean: number; peak: number } {
  const frames = Math.round(seconds / FRAME);
  const killEvery = Math.max(1, Math.round(every / FRAME));
  let sum = 0;
  let peak = 0;
  let counted = 0;
  for (let i = 0; i < frames; i++) {
    if (i % killEvery === 0) p.kick();
    p.update(FRAME);
    if (i * FRAME < skip) continue;
    sum += p.value;
    peak = Math.max(peak, p.value);
    counted++;
  }
  return { mean: sum / counted, peak };
}

describe('KillPunch', () => {
  it('gives an isolated kill the full punch, gone in about a third of a second', () => {
    const p = new KillPunch();
    p.kick();
    expect(p.value).toBe(1);
    for (let t = 0; t < 0.35; t += FRAME) p.update(FRAME);
    expect(p.value).toBe(0);
  });

  // User report: at 4x the kill punch tinted the whole screen red. Kills arrive four times as often
  // in real time there; overlapping full punches must not add up to a screen that stays red.
  it('a 4x kill stream stays a faint flicker instead of a red screen', () => {
    const p = new KillPunch();
    // A brawl at 4x: a kill every 0.2 real seconds for 10 s.
    const { mean, peak } = run(p, 10, 0.2, 1);
    expect(mean).toBeLessThan(0.1);
    expect(peak).toBeLessThan(0.3);
  });

  it('punches fully again once the arena has been quiet for a moment', () => {
    const p = new KillPunch();
    p.kick();
    for (let t = 0; t < PUNCH_RECOVERY + 0.05; t += FRAME) p.update(FRAME);
    p.kick();
    expect(p.value).toBe(1);
  });

  it('two kills in the same frame punch once, not twice as hard', () => {
    const p = new KillPunch();
    p.kick();
    p.kick();
    expect(p.value).toBe(1);
    p.update(0.1);
    expect(p.value).toBeLessThan(1);
  });

  it('the final kill always gets the full punch, even right after another kill', () => {
    const p = new KillPunch();
    p.kick();
    p.update(0.05);
    p.kick(true);
    expect(p.value).toBe(1);
  });

  it('runs on real time: a paused frame (dt 0) neither decays nor recovers it', () => {
    const p = new KillPunch();
    p.kick();
    p.update(0);
    expect(p.value).toBe(1);
  });
});
