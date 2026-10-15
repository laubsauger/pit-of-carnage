import { describe, expect, it } from 'vitest';
import { affine, applyX, applyY, setChild, setFrame, setSpan } from './affine';
import { SPIKE_WARNING, spikeCycle, spikeWarning } from './hazards';

describe('rig transforms', () => {
  it('points a body frame along the facing: forward (u) follows the world angle, right (v) is clockwise', () => {
    // World angles turn from +x toward +y (south). A fighter facing south must have its weapon
    // hand (+v) on the west side, or every swing would be drawn mirrored.
    const B = setFrame(affine(), 100, 50, Math.PI / 2, 1);
    expect(applyX(B, 10, 0)).toBeCloseTo(100, 6);
    expect(applyY(B, 10, 0)).toBeCloseTo(60, 6);
    expect(applyX(B, 0, 10)).toBeCloseTo(90, 6);
    expect(applyY(B, 0, 10)).toBeCloseTo(50, 6);
  });

  it('composes child parts in the parent frame (offset, rotation and scale all inherited)', () => {
    const B = setFrame(affine(), 0, 0, Math.PI / 2, 2);
    const W = setChild(affine(), B, 5, 0, Math.PI / 2, 1, 1);
    // Weapon tip at local (10, 0): rotated a further 90° from the body, scaled by the body scale.
    expect(applyX(W, 10, 0)).toBeCloseTo(-20, 6);
    expect(applyY(W, 10, 0)).toBeCloseTo(10, 6);
  });

  it('stretches a unit bar exactly between two points (arms reach the hands)', () => {
    const B = setFrame(affine(), 30, 40, 0.7, 1.3);
    const S = setSpan(affine(), B, 0, 12, 18, -4, 1);
    expect(applyX(S, 0, 0)).toBeCloseTo(applyX(B, 0, 12), 6);
    expect(applyY(S, 0, 0)).toBeCloseTo(applyY(B, 0, 12), 6);
    expect(applyX(S, 1, 0)).toBeCloseTo(applyX(B, 18, -4), 6);
    expect(applyY(S, 1, 0)).toBeCloseTo(applyY(B, 18, -4), 6);
  });
});

describe('spike telegraph', () => {
  it('glows up only in the stretch before the thrust, so the rhythm can be read', () => {
    const trigger = 0.88;
    expect(spikeWarning(0.2, trigger)).toBe(0);
    expect(spikeWarning(trigger - SPIKE_WARNING / 2, trigger)).toBeCloseTo(0.5, 6);
    expect(spikeWarning(trigger, trigger)).toBeCloseTo(1, 6);
    expect(spikeWarning(0.95, trigger)).toBe(0);
  });

  it('reads the hazard phase as a cycle fraction, or as ticks into the period when above 1', () => {
    expect(spikeCycle({ phase: 0.4, period: undefined }, 165)).toBe(0.4);
    expect(spikeCycle({ phase: 165 + 33, period: undefined }, 165)).toBeCloseTo(0.2, 6);
    expect(spikeCycle({ phase: 50, period: 100 }, 165)).toBeCloseTo(0.5, 6);
  });
});
