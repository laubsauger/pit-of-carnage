import { describe, expect, it } from 'vitest';
import { BARK_RULES } from '../../core';
import { BARK_TIMING, STAMP_TIMING, barkDuration, barkEnvelope, easeToward, elasticOut, glideUp, stampDuration, stampEnvelope } from './easing';

describe('kill stamp envelope', () => {
  const env = { scale: 0, alpha: 0, rise: 0 };

  // A quick elastic pop past full size and back: that overshoot is the punch.
  it('pops in past full size, then settles exactly at 1', () => {
    let peak = 0;
    for (let t = 0; t <= STAMP_TIMING.popIn; t += 0.005) peak = Math.max(peak, stampEnvelope(env, t).scale);
    expect(peak).toBeGreaterThan(1.15);
    expect(STAMP_TIMING.popIn).toBeLessThanOrEqual(0.3);
    expect(stampEnvelope(env, STAMP_TIMING.popIn)).toMatchObject({ scale: 1, alpha: 1, rise: 0 });
  });

  // Stamps were 2.15 s and sat on the body. They must read, then get out of the way: from about
  // 0.6 s after the kill they shrink and float up while fading, and are gone by about 1.2 s.
  it('starts leaving by about 0.6 s and is gone by about 1.2 s', () => {
    expect(stampDuration()).toBeLessThanOrEqual(1.25);
    const leaving = STAMP_TIMING.popIn + STAMP_TIMING.hold;
    expect(leaving).toBeLessThanOrEqual(0.65);
    let lastScale = 1;
    let lastRise = 0;
    let lastAlpha = 1;
    for (let t = leaving + 0.02; t < stampDuration(); t += 0.02) {
      stampEnvelope(env, t);
      expect(env.scale).toBeLessThan(lastScale);
      expect(env.rise).toBeGreaterThan(lastRise);
      expect(env.alpha).toBeLessThan(lastAlpha);
      lastScale = env.scale;
      lastRise = env.rise;
      lastAlpha = env.alpha;
    }
    expect(stampEnvelope(env, stampDuration()).alpha).toBe(0);
  });

  it('starts invisible and tiny', () => {
    expect(stampEnvelope(env, 0)).toMatchObject({ scale: 0, alpha: 0 });
    expect(elasticOut(0)).toBe(0);
    expect(elasticOut(1)).toBe(1);
  });
});

describe('popup gliding', () => {
  // Bubbles used to jump when what they dodged moved. A placed popup glides, and otherwise stays put.
  it('places a new popup at once, then glides up without jumping', () => {
    expect(glideUp(-1, 30, 1 / 60, 14)).toBe(30);
    const step = glideUp(0, 40, 1 / 60, 14);
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(40 * 0.4);
    let lift = 0;
    for (let i = 0; i < 30; i++) lift = glideUp(lift, 40, 1 / 60, 14);
    expect(lift).toBeGreaterThan(39);
    expect(lift).toBeLessThanOrEqual(40);
  });

  it('stays put when it no longer needs the lift (no bobbing)', () => {
    expect(glideUp(25, 0, 1 / 60, 14)).toBe(25);
    expect(glideUp(25, 10, 1 / 60, 14)).toBe(25);
  });

  it('glides the same at 30 and 144 fps, and not at all while paused', () => {
    let a = 0;
    for (let i = 0; i < 6; i++) a = easeToward(a, 40, 1 / 30, 14);
    let b = 0;
    for (let i = 0; i < 29; i++) b = easeToward(b, 40, 1 / 144, 14);
    expect(Math.abs(a - b)).toBeLessThan(0.6);
    expect(easeToward(5, 40, 0, 14)).toBe(5);
  });
});

describe('bark envelope', () => {
  const env = { scale: 0, alpha: 0, rise: 0 };
  // Barks are small and brief (user feedback): readable for about a second, gone in about 1.5 s.
  it('pops in, holds long enough to read, and is gone after BARK_RULES.visibleSeconds', () => {
    expect(barkEnvelope(env, 0.6).scale).toBe(1);
    expect(barkEnvelope(env, 0.6).alpha).toBe(1);
    expect(BARK_TIMING.hold).toBeGreaterThan(0.8);
    expect(barkDuration()).toBeCloseTo(BARK_RULES.visibleSeconds, 9);
    expect(barkEnvelope(env, barkDuration()).alpha).toBe(0);
  });
});
