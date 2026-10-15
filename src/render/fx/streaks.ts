// Owned by: render-fx
/**
 * Blood streaks left by sliding gibs and limbs. A bloody piece skidding across the floor stamps
 * overlapping smears along its path. Faster pieces leave longer, wider, more widely spaced smears;
 * as the piece slows the smear thins, and once it is slow (or nearly out of blood) the trail breaks
 * into irregular flecks before stopping. Stamping is driven by distance travelled, never by frame
 * count, so the trail looks the same at any frame rate or time scale.
 */

export type StreakState = {
  /** Distance travelled since the last stamp (px). */
  carry: number;
  /** Distance from the last stamp to the next one (px); 0 = not chosen yet. */
  gap: number;
  /** Blood left on the piece: 1 = dripping, 0 = dry (no more stamps). */
  wet: number;
  /** Width of a full-speed smear for this piece (px). */
  width: number;
};

/** One stamp. The object passed to `emit` is reused: copy what you need before returning. */
export type StreakStamp = {
  x: number;
  y: number;
  /** Direction of travel (radians). */
  angle: number;
  /** Extent along the direction of travel (px). */
  length: number;
  /** Extent across the direction of travel (px). */
  width: number;
  alpha: number;
  /** Wetness of the piece when stamped (drives colour and highlight). */
  wet: number;
  fleck: boolean;
};

export const STREAK = {
  /** Below this speed (px/s) nothing is stamped: the piece is about to settle. */
  stopSpeed: 14,
  /** Below this speed the smear breaks into flecks. */
  fleckSpeed: 75,
  /** Below this wetness the smear breaks into flecks. */
  fleckWet: 0.22,
  /** Speed at which a smear reaches its full width (px/s). */
  fullSpeed: 260,
  /** Continuous smears overlap: spacing = stamp length x overlap. */
  overlap: 0.3,
  /** Wetness used per continuous stamp and per fleck. */
  wetPerStamp: 0.01,
  wetPerFleck: 0.025,
};

export function createStreak(width: number, wet = 1): StreakState {
  return { carry: 0, gap: 0, wet, width };
}

export function resetStreak(s: StreakState, width: number, wet = 1): void {
  s.carry = 0;
  s.gap = 0;
  s.wet = wet;
  s.width = width;
}

function isFleck(s: StreakState, speed: number): boolean {
  return speed < STREAK.fleckSpeed || s.wet < STREAK.fleckWet;
}

/** Width of a continuous smear at this speed and wetness: thinner as the piece slows or dries. */
export function streakWidth(s: StreakState, speed: number): number {
  const sf = Math.min(1, Math.max(0.3, speed / STREAK.fullSpeed));
  return s.width * sf * (0.45 + 0.55 * s.wet);
}

/** Length of a continuous smear: stretched along the path by speed. */
export function streakLength(s: StreakState, speed: number): number {
  return streakWidth(s, speed) * (1.2 + speed / 180);
}

function nextGap(s: StreakState, speed: number, rand: () => number): number {
  if (isFleck(s, speed)) {
    const slow = 1 - Math.min(1, speed / STREAK.fleckSpeed);
    return 5 + rand() * 12 * (1 + slow);
  }
  return Math.max(0.75, streakLength(s, speed) * STREAK.overlap);
}

const stamp: StreakStamp = { x: 0, y: 0, angle: 0, length: 0, width: 0, alpha: 0, wet: 0, fleck: false };

/**
 * Advance a sliding piece from (x0, y0) to (x1, y1) at `speed` px/s and emit the stamps that fall on
 * that segment. Returns the number of stamps emitted.
 */
export function streakStep(
  s: StreakState,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  speed: number,
  rand: () => number,
  emit: (st: StreakStamp) => void,
): number {
  if (s.wet <= 0 || speed < STREAK.stopSpeed) {
    s.carry = 0;
    s.gap = 0;
    return 0;
  }
  const dx = x1 - x0;
  const dy = y1 - y0;
  const seg = Math.hypot(dx, dy);
  if (seg <= 0) return 0;
  const angle = Math.atan2(dy, dx);
  const px = -dy / seg;
  const py = dx / seg;
  if (s.gap <= 0) s.gap = nextGap(s, speed, rand);

  let travelled = 0;
  let emitted = 0;
  while (s.carry + (seg - travelled) >= s.gap) {
    travelled += s.gap - s.carry;
    s.carry = 0;
    const t = travelled / seg;
    const fleck = isFleck(s, speed);
    stamp.angle = angle;
    stamp.wet = s.wet;
    stamp.fleck = fleck;
    if (fleck) {
      const size = (0.8 + rand() * 1.6) * (0.5 + 0.5 * s.wet) * Math.max(0.6, s.width / 7);
      const side = (rand() - 0.5) * s.width * 0.8;
      stamp.x = x0 + dx * t + px * side;
      stamp.y = y0 + dy * t + py * side;
      stamp.width = size;
      stamp.length = size * (1 + rand() * 0.6);
      stamp.alpha = 0.5 + 0.4 * s.wet;
      s.wet -= STREAK.wetPerFleck;
    } else {
      stamp.x = x0 + dx * t;
      stamp.y = y0 + dy * t;
      stamp.width = streakWidth(s, speed);
      stamp.length = streakLength(s, speed);
      stamp.alpha = 0.35 + 0.5 * s.wet;
      s.wet -= STREAK.wetPerStamp;
    }
    emit(stamp);
    emitted++;
    if (s.wet <= 0) {
      s.wet = 0;
      s.carry = 0;
      s.gap = 0;
      return emitted;
    }
    s.gap = nextGap(s, speed, rand);
  }
  s.carry += seg - travelled;
  return emitted;
}
