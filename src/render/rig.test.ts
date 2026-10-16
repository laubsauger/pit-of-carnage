import { describe, expect, it } from 'vitest';
import { WEAPON_IDS } from '../core';
import type { WeaponId } from '../core';
import {
  HIT_STOP_MAX, IMPACT_PROGRESS, SQUASH_SECONDS, SWING_KEYS, eyeScale, flashAmount, hitSeverity, hitStopSeconds, newWeaponPose,
  VICTORY, squashAmount, squashPeak, victoryHop, victoryPose, victoryWeight, weaponPose,
} from './rig';

const pose = (w: WeaponId, phase: 'idle' | 'windup' | 'strike' | 'recovery', p: number) =>
  weaponPose(w, phase, p, 0, newWeaponPose());

describe('weaponPose', () => {
  it('telegraphs every attack: the glow ramps up through the windup and is full at its end', () => {
    // Readable hits: a viewer must see the blow coming, so glow rises monotonically to 1.
    for (const w of WEAPON_IDS) {
      let last = -1;
      for (let i = 0; i <= 10; i++) {
        const g = pose(w, 'windup', i / 10).glow;
        expect(g).toBeGreaterThanOrEqual(last);
        last = g;
      }
      expect(last).toBeCloseTo(1, 5);
      expect(pose(w, 'idle', 0).glow).toBe(0);
    }
  });

  it('joins phases without jumps, so the weapon never teleports between poses', () => {
    for (const w of WEAPON_IDS) {
      expect(pose(w, 'windup', 1).swing).toBeCloseTo(pose(w, 'strike', 0).swing, 5);
      expect(pose(w, 'strike', 1).swing).toBeCloseTo(pose(w, 'recovery', 0).swing, 5);
      expect(pose(w, 'recovery', 1).swing).toBeCloseTo(SWING_KEYS[w].idle, 5);
      expect(pose(w, 'windup', 0).swing).toBeCloseTo(SWING_KEYS[w].idle, 5);
    }
  });

  it('sweeps the cleaving weapons across the facing direction during the strike', () => {
    // The victim stands in front (angle 0); a sweep that never crosses 0 would miss them visually.
    for (const w of ['GREATSWORD', 'WARHAMMER'] as const) {
      expect(pose(w, 'strike', 0).swing).toBeGreaterThan(0);
      expect(pose(w, 'strike', 1).swing).toBeLessThan(0);
    }
  });

  it('extends daggers and the staff forward on the strike (stabs and thrusts read as reach)', () => {
    for (const w of ['TWIN_DAGGERS', 'ARCANE_STAFF'] as const) {
      expect(pose(w, 'strike', 0.6).reach).toBeGreaterThan(pose(w, 'windup', 1).reach);
    }
  });

  it('draws the bowstring during the windup and releases it on the strike', () => {
    expect(pose('LONGBOW', 'windup', 1).draw).toBeCloseTo(1, 5);
    expect(pose('LONGBOW', 'strike', 0.2).draw).toBe(0);
  });

  it('shows a smear only for sweeping melee strikes, fading as the strike ends', () => {
    expect(pose('GREATSWORD', 'strike', 0.1).smear).toBeGreaterThan(0.5);
    expect(pose('GREATSWORD', 'strike', 0.9).smear).toBe(0);
    expect(pose('LONGBOW', 'strike', 0.1).smear).toBe(0);
  });

  it('lets the thrown axe leave the hand after the release point', () => {
    expect(pose('THROWING_AXES', 'strike', 0.1).released).toBe(false);
    expect(pose('THROWING_AXES', 'strike', 0.5).released).toBe(true);
    expect(pose('THROWING_AXES', 'idle', 0).released).toBe(false);
  });
});

describe('cosmetic counters', () => {
  it('pops eyes while eyePop ticks remain and returns to normal size after', () => {
    expect(eyeScale(0)).toBe(1);
    expect(eyeScale(18)).toBeGreaterThan(1.5);
    expect(eyeScale(4)).toBeLessThan(eyeScale(12));
  });

  it('flashes white at full strength on the first frames of a hit', () => {
    expect(flashAmount(6)).toBe(1);
    expect(flashAmount(0)).toBe(0);
    expect(flashAmount(2)).toBeCloseTo(0.5, 5);
  });
});

// User feedback: hits shook the whole screen. Their weight now lands locally: a few frames of
// hit-stop on the two bodies, and the victim squashes and springs back.
describe('local hit weight', () => {
  it('freezes a melee attacker on the pose where its blow lands, not cocked back where the sim resolves it', () => {
    for (const w of ['GREATSWORD', 'WARHAMMER'] as const) {
      const t = IMPACT_PROGRESS[w];
      expect(t).toBeGreaterThan(0.05);
      // Sweeps: the weapon crosses the facing, where the victim stands.
      expect(Math.abs(pose(w, 'strike', t).swing)).toBeLessThan(0.05);
      expect(Math.abs(pose(w, 'strike', 0).swing)).toBeGreaterThan(1);
    }
    // Stabs: the dagger is at full reach.
    const stab = pose('TWIN_DAGGERS', 'strike', IMPACT_PROGRESS.TWIN_DAGGERS).reach;
    for (let i = 0; i <= 20; i++) expect(pose('TWIN_DAGGERS', 'strike', i / 20).reach).toBeLessThanOrEqual(stab + 1e-9);
    expect(stab).toBeGreaterThan(pose('TWIN_DAGGERS', 'strike', 0).reach);
  });

  it('stops longer for bigger blows, but only for a few frames', () => {
    const scratch = hitStopSeconds(hitSeverity(5, false));
    const big = hitStopSeconds(hitSeverity(40, false));
    const crit = hitStopSeconds(hitSeverity(20, true));
    expect(scratch).toBeCloseTo(3 / 60, 6);
    expect(big).toBeGreaterThan(scratch);
    expect(crit).toBeGreaterThan(hitStopSeconds(hitSeverity(20, false)));
    for (const s of [scratch, big, crit]) expect(s).toBeLessThanOrEqual(HIT_STOP_MAX + 1e-9);
  });

  it('holds the squash through the hit-stop, overshoots into a stretch, then settles', () => {
    const peak = squashPeak(1);
    expect(squashAmount(-0.02, peak)).toBe(peak);
    expect(squashAmount(0, peak)).toBeCloseTo(peak, 6);
    let lowest = 0;
    for (let t = 0; t < SQUASH_SECONDS; t += 1 / 240) lowest = Math.min(lowest, squashAmount(t, peak));
    expect(lowest).toBeLessThan(-peak * 0.15);
    expect(Math.abs(squashAmount(SQUASH_SECONDS - 1e-3, peak))).toBeLessThan(peak * 0.05);
    expect(squashAmount(SQUASH_SECONDS, peak)).toBe(0);
    expect(squashPeak(1)).toBeGreaterThan(squashPeak(0));
  });
});

describe('victory pose', () => {
  // The winner's moment must read as "weapon raised" for every weapon: the raised (windup) angle,
  // never the idle carry or a strike, and it must keep moving (a pump), not freeze.
  it('raises every weapon and pumps it', () => {
    for (const w of WEAPON_IDS) {
      const k = SWING_KEYS[w];
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < 40; i++) {
        const p = victoryPose(w, i / 40 / VICTORY.pumpHz, newWeaponPose());
        const towardRaised = Math.abs(p.swing - k.back) <= Math.abs(k.idle - k.back) * VICTORY.pump + 1e-9;
        expect(towardRaised, w).toBe(true);
        expect(p.released, w).toBe(false);
        expect(p.glow, w).toBeGreaterThan(0);
        lo = Math.min(lo, p.reach);
        hi = Math.max(hi, p.reach);
      }
      expect(hi - lo, w).toBeGreaterThan(VICTORY.reach * 0.9);
    }
  });

  it('hops in time with the pump and eases in instead of snapping', () => {
    expect(victoryHop(0)).toBeCloseTo(1, 9);
    expect(victoryHop(0.25 / VICTORY.pumpHz)).toBeCloseTo(1 + VICTORY.hop, 9);
    for (let t = 0; t < 3; t += 0.01) expect(victoryHop(t)).toBeGreaterThanOrEqual(1);
    expect(victoryWeight(0)).toBe(0);
    expect(victoryWeight(VICTORY.easeIn / 4)).toBeGreaterThan(0.2);
    expect(victoryWeight(VICTORY.easeIn / 4)).toBeLessThan(0.8);
    expect(victoryWeight(VICTORY.easeIn)).toBe(1);
    expect(victoryWeight(99)).toBe(1);
  });
});
