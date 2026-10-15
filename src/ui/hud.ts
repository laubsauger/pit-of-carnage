// Owned by: ui
// Pure HUD logic: scoreboard order, fighter cycling, feed styling, timeline maths, inspector bars.
import { STEER_COS, STEER_SIN, TICK_HZ, clamp } from '../core';
import type { FeedItem, MatchFormat, TimelineMark, UiFighter, UiSnapshot } from '../core';

// ---------------------------------------------------------------------------------------------
// Scoreboard
// ---------------------------------------------------------------------------------------------

/**
 * Scoreboard order. Alive fighters first, by kills, then by entry order; dead fighters after,
 * best place first. HP is deliberately not a sort key: it changes on every hit and rows that jump
 * around at 10 Hz are unreadable. In squads, rows group by squad first so teams stay together.
 */
export function sortScoreboard(fighters: readonly UiFighter[], format: MatchFormat): UiFighter[] {
  const index = new Map(fighters.map((f, i) => [f.id, i]));
  return [...fighters].sort((a, b) => {
    if (format === 'squads' && a.squad !== b.squad) return a.squad - b.squad;
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    if (a.alive) {
      if (a.kills !== b.kills) return b.kills - a.kills;
    } else {
      const pa = a.place ?? Number.MAX_SAFE_INTEGER;
      const pb = b.place ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
    }
    return (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0);
  });
}

/**
 * Next fighter for Tab / Shift+Tab, in scoreboard order, skipping the dead (nobody wants to tab
 * through corpses). With nobody alive it cycles everyone so the end screen is still inspectable.
 */
export function cycleFighter(ordered: readonly UiFighter[], currentId: string | null, dir: 1 | -1): string | null {
  const alive = ordered.filter((f) => f.alive);
  const pool = alive.length > 0 ? alive : ordered;
  if (pool.length === 0) return null;
  const at = pool.findIndex((f) => f.id === currentId);
  if (at < 0) return dir === 1 ? pool[0].id : pool[pool.length - 1].id;
  return pool[(at + dir + pool.length) % pool.length].id;
}

// ---------------------------------------------------------------------------------------------
// Kill feed
// ---------------------------------------------------------------------------------------------

/** A feed line stays fully visible this long (game time), then fades out. */
export const FEED_HOLD_TICKS = 6 * TICK_HZ;
export const FEED_FADE_TICKS = 2 * TICK_HZ;
export const FEED_MAX_ITEMS = 6;

/**
 * Opacity of a feed line at `now`. Measured in game ticks, not wall time, so a paused match keeps
 * its feed on screen and seeking back brings the lines back.
 */
export function feedOpacity(itemTick: number, now: number): number {
  const age = now - itemTick;
  if (age < 0) return 0;
  if (age <= FEED_HOLD_TICKS) return 1;
  return clamp(1 - (age - FEED_HOLD_TICKS) / FEED_FADE_TICKS, 0, 1);
}

/** Lines to show at `now`, newest first: nothing from the future (after a seek back), nothing faded. */
export function visibleFeed(feed: readonly FeedItem[], now: number, max = FEED_MAX_ITEMS): FeedItem[] {
  const out: FeedItem[] = [];
  for (let i = feed.length - 1; i >= 0 && out.length < max; i--) {
    const item = feed[i];
    if (feedOpacity(item.tick, now) > 0) out.push(item);
  }
  return out.sort((a, b) => b.tick - a.tick);
}

export type FeedSegment = { text: string; id?: string; color?: string };

/**
 * Split a broadcast line into plain text and fighter-name segments so names can be drawn in their
 * fighter colour. Longest names match first: "Gary" must not steal the start of "Gary II".
 * Only fighters listed in `ids` are matched when given, so a coincidental word is never coloured.
 */
export function segmentFeedText(
  text: string,
  fighters: readonly Pick<UiFighter, 'id' | 'name' | 'color'>[],
  ids?: readonly string[],
): FeedSegment[] {
  const pool = (ids && ids.length > 0 ? fighters.filter((f) => ids.includes(f.id)) : fighters)
    .filter((f) => f.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const out: FeedSegment[] = [];
  let plain = '';
  let i = 0;
  while (i < text.length) {
    const hit = pool.find((f) => text.startsWith(f.name, i) && !isWordChar(text[i + f.name.length]) && !isWordChar(text[i - 1]));
    if (hit) {
      if (plain) out.push({ text: plain });
      plain = '';
      out.push({ text: hit.name, id: hit.id, color: hit.color });
      i += hit.name.length;
    } else {
      plain += text[i];
      i++;
    }
  }
  if (plain) out.push({ text: plain });
  return out;
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}_]/u.test(c);
}

// ---------------------------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------------------------

/** Lead-in when jumping to a kill mark, so you see the fight that led to it. */
export const KILL_LEAD_IN_TICKS = 2 * TICK_HZ;

/**
 * Length the scrubber spans. While regulation time is running the bar is the full time limit, so
 * marks keep their place and the sudden-death line is visible ahead. Once the match ran past
 * that, or ended, the bar is exactly what was played.
 */
export function timelineDomain(s: Pick<UiSnapshot, 'maxTick' | 'timeLimitTicks' | 'finished'>): number {
  if (s.finished) return Math.max(1, s.maxTick);
  return Math.max(1, s.maxTick, s.timeLimitTicks);
}

/** Tick under a pointer at `ratio` (0..1) along the bar; never past what has been simulated. */
export function tickAtRatio(ratio: number, domain: number, maxTick: number): number {
  return clamp(Math.round(clamp(ratio, 0, 1) * domain), 0, Math.max(0, maxTick));
}

/** Closest mark within `tolerance` ticks of `tick`, preferring kills over smaller marks. */
export function markNear(marks: readonly TimelineMark[], tick: number, tolerance: number): TimelineMark | null {
  let best: TimelineMark | null = null;
  let bestScore = Infinity;
  for (const m of marks) {
    const d = Math.abs(m.tick - tick);
    if (d > tolerance) continue;
    const score = d + (m.kind === 'kill' ? 0 : tolerance);
    if (score < bestScore) {
      best = m;
      bestScore = score;
    }
  }
  return best;
}

/** Where clicking a mark seeks to. */
export function seekTickForMark(mark: TimelineMark): number {
  return Math.max(0, mark.tick - (mark.kind === 'kill' ? KILL_LEAD_IN_TICKS : TICK_HZ / 2));
}

// ---------------------------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------------------------

export type ScoreBar = { name: string; score: number; fraction: number; active: boolean };

/**
 * Behaviour score bars. Scores are free-form expressions, so bars are relative to the best
 * positive score this think; negative or zero scores draw an empty bar but still show the number.
 * Order follows the strategy (object key order), not the score, so rows do not jump.
 */
export function scoreBars(scores: Record<string, number>, active: string): ScoreBar[] {
  const names = Object.keys(scores);
  const top = Math.max(0, ...names.map((n) => scores[n]).filter(Number.isFinite));
  return names.map((name) => {
    const score = scores[name];
    const fraction = top > 0 && Number.isFinite(score) ? clamp(score / top, 0, 1) : 0;
    return { name, score, fraction, active: name === active };
  });
}

/**
 * Point for steering direction i at `radius` around the origin in SVG coordinates. The ring uses
 * world angles (0 = east, +y = south) and SVG's y axis also points down, so the ring drawn in the
 * inspector has the same orientation as the arena on screen.
 */
export function ringPoint(i: number, radius: number): { x: number; y: number } {
  const k = ((i % STEER_COS.length) + STEER_COS.length) % STEER_COS.length;
  return { x: STEER_COS[k] * radius, y: STEER_SIN[k] * radius };
}

/** HP fraction 0..1, safe for zero max HP. */
export function hpFraction(hp: number, maxHp: number): number {
  return maxHp > 0 ? clamp(hp / maxHp, 0, 1) : 0;
}
