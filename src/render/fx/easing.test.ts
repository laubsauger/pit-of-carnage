import { describe, expect, it } from 'vitest';
import { BARK_RULES } from '../../core';
import { BARK_TIMING, STAMP_TIMING, barkDuration, barkEnvelope, elasticOut, stampDuration, stampEnvelope } from './easing';

describe('kill stamp envelope', () => {
  const env = { scale: 0, alpha: 0, rise: 0 };

  // The stamp must slam in past full size and settle back: that overshoot is the punch.
  it('overshoots full size, then settles exactly at 1', () => {
    let peak = 0;
    for (let t = 0; t <= STAMP_TIMING.popIn; t += 0.005) peak = Math.max(peak, stampEnvelope(env, t).scale);
    expect(peak).toBeGreaterThan(1.15);
    expect(stampEnvelope(env, STAMP_TIMING.popIn).scale).toBe(1);
    expect(stampEnvelope(env, STAMP_TIMING.popIn + STAMP_TIMING.hold * 0.5)).toMatchObject({ scale: 1, alpha: 1, rise: 0 });
  });

  it('fades out and drifts up at the end, and is gone at its duration', () => {
    const mid = stampEnvelope(env, stampDuration() - STAMP_TIMING.fadeOut / 2);
    expect(mid.alpha).toBeGreaterThan(0);
    expect(mid.alpha).toBeLessThan(1);
    expect(mid.rise).toBeGreaterThan(0);
    expect(stampEnvelope(env, stampDuration()).alpha).toBeCloseTo(0, 9);
  });

  it('starts invisible and tiny', () => {
    expect(stampEnvelope(env, 0)).toMatchObject({ scale: 0, alpha: 0 });
    expect(elasticOut(0)).toBe(0);
    expect(elasticOut(1)).toBe(1);
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
