// Owned by: render-fx
/**
 * How much blood there is, and the shape of a death on the floor. Pure, no three.js.
 *
 * A death is a comic explosion, not a wound: a fat central splat, a ring of long sprays thrown out
 * in every direction (longest along the killing blow) and flecks flung far across the floor.
 */

import type { BloodAmount } from '../../core';

/**
 * The View setting "blood amount": multipliers for how many drops and stamps an event makes
 * (`count`) and how big its stamps are (`size`). Cosmetic only.
 */
export const BLOOD_AMOUNT: Readonly<Record<BloodAmount, { count: number; size: number }>> = {
  light: { count: 0.45, size: 0.8 },
  normal: { count: 1, size: 1 },
  carnage: { count: 1.9, size: 1.3 },
};

export type SplatterStamp = {
  /** Direction from the body (radians). */
  angle: number;
  /** Distance from the body to the stamp's centre (px). */
  dist: number;
  /** Half extents along and across `angle` (px). */
  halfLen: number;
  halfWid: number;
  /** Spray arm (true) or a fleck flung on its own (false). */
  arm: boolean;
};

export const SPLATTER = {
  /** Spray arms at normal amount (more with more blood). */
  arms: 11,
  /** Arm length range (px) before the kill-direction bias. */
  armLen: [60, 135] as const,
  /** Arms along the killing blow are up to this much longer, against it this much shorter. */
  bias: 0.55,
  /** Flecks at normal amount. */
  flecks: 26,
  /** Fleck distance range (px). */
  fleckDist: [45, 230] as const,
};

function makeStamp(): SplatterStamp {
  return { angle: 0, dist: 0, halfLen: 0, halfWid: 0, arm: false };
}

/**
 * Fill `out` with the radial splatter of a death along `dir` (radians), scaled by a blood amount.
 * `out` is grown once and reused; returns the number of stamps written.
 */
export function deathSplatter(out: SplatterStamp[], dir: number, amount: { count: number; size: number }, rand: () => number): number {
  const s = SPLATTER;
  const arms = Math.max(6, Math.round(s.arms * Math.sqrt(amount.count)));
  const flecks = Math.round(s.flecks * amount.count);
  const n = arms + flecks;
  while (out.length < n) out.push(makeStamp());
  const step = (Math.PI * 2) / arms;
  const start = rand() * step;
  for (let i = 0; i < arms; i++) {
    const st = out[i];
    st.angle = start + i * step + (rand() - 0.5) * step * 0.6;
    const along = 1 + s.bias * Math.cos(st.angle - dir);
    const len = (s.armLen[0] + rand() * (s.armLen[1] - s.armLen[0])) * along * amount.size;
    st.halfLen = len / 2;
    st.halfWid = (9 + rand() * 9) * amount.size;
    st.dist = 16 * amount.size + st.halfLen;
    st.arm = true;
  }
  for (let i = arms; i < n; i++) {
    const st = out[i];
    // Flecks cluster around the blow's direction but still land all around.
    const a = rand() < 0.6 ? dir + (rand() + rand() - 1) * 1.1 : rand() * Math.PI * 2;
    st.angle = a;
    const along = 1 + s.bias * Math.cos(a - dir);
    st.dist = (s.fleckDist[0] + rand() * (s.fleckDist[1] - s.fleckDist[0])) * along * Math.sqrt(amount.size);
    const r = (2.2 + rand() * 4.5) * amount.size;
    st.halfLen = r * (1 + rand() * 0.8);
    st.halfWid = r;
    st.arm = false;
  }
  return n;
}
