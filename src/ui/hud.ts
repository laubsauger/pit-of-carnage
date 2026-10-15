// Owned by: ui
// Pure HUD logic: scoreboard order, fighter cycling, feed styling, timeline maths, inspector bars.
import { STEER_COS, STEER_SIN, TICK_HZ, clamp } from '../core';
import type { FeedItem, MatchFormat, MatchPhase, TimelineMark, TimelineMarkKind, UiFighter, UiSnapshot, ViewInsets } from '../core';

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

/** Where clicking a mark seeks to. */
export function seekTickForMark(mark: TimelineMark): number {
  return Math.max(0, mark.tick - (mark.kind === 'kill' ? KILL_LEAD_IN_TICKS : TICK_HZ / 2));
}

/** Every mark kind, in legend order. */
export const MARK_KINDS: readonly TimelineMarkKind[] = ['kill', 'dismember', 'big_hit', 'pickup', 'sudden_death'];

/** Which mark of a dense moment is drawn on top and named first: deaths matter most. */
const MARK_RANK: Readonly<Record<TimelineMarkKind, number>> = { kill: 0, sudden_death: 1, dismember: 2, pickup: 3, big_hit: 4 };

/**
 * Marks to show. With a fighter picked, only the moments they caused or suffered, plus sudden
 * death, which happens to everyone and explains the deaths around it.
 */
export function filterMarks(marks: readonly TimelineMark[], fighterId: string | null, kinds: readonly TimelineMarkKind[]): TimelineMark[] {
  return marks.filter(
    (m) => kinds.includes(m.kind) && (fighterId === null || m.kind === 'sudden_death' || m.actorId === fighterId || m.targetId === fighterId),
  );
}

/** Marks in one fighter's lane: what they did and what was done to them. */
export function laneMarks(marks: readonly TimelineMark[], fighterId: string): TimelineMark[] {
  return marks.filter((m) => m.actorId === fighterId || m.targetId === fighterId);
}

/** Tick a fighter died, from the kill marks, or null while they live (their lane ends there). */
export function deathTick(marks: readonly TimelineMark[], fighterId: string): number | null {
  return marks.find((m) => m.kind === 'kill' && m.targetId === fighterId)?.tick ?? null;
}

/** Closest two marks may be drawn, in px, before they share a cluster. */
export const MARK_GAP_PX = 9;

/** Marks drawn as one stack. `x` (px) and `tick` are the earliest member's; `marks` are by importance. */
export type MarkCluster = { x: number; tick: number; marks: TimelineMark[] };

/**
 * Group marks so dense moments never overlap: a cluster starts at its earliest mark and takes every
 * mark within `gapPx` of it, so clusters are always at least `gapPx` apart and none grows into a
 * smear across a busy minute.
 */
export function clusterMarks(marks: readonly TimelineMark[], domain: number, width: number, gapPx = MARK_GAP_PX): MarkCluster[] {
  const scale = width / Math.max(1, domain);
  const sorted = [...marks].sort((a, b) => a.tick - b.tick);
  const out: MarkCluster[] = [];
  let cur: MarkCluster | null = null;
  for (const m of sorted) {
    const x = m.tick * scale;
    if (cur && x - cur.x < gapPx) cur.marks.push(m);
    else {
      cur = { x, tick: m.tick, marks: [m] };
      out.push(cur);
    }
  }
  for (const c of out) c.marks.sort((a, b) => MARK_RANK[a.kind] - MARK_RANK[b.kind] || a.tick - b.tick);
  return out;
}

/** The cluster nearest `x` (px) within `hitPx`, or null. */
export function clusterAt(clusters: readonly MarkCluster[], x: number, hitPx: number): MarkCluster | null {
  let best: MarkCluster | null = null;
  let bestD = hitPx;
  for (const c of clusters) {
    const d = Math.abs(c.x - x);
    if (d <= bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/** Where clicking a cluster seeks: the earliest lead-in among its marks, so the whole moment plays. */
export function clusterSeekTick(c: MarkCluster): number {
  return Math.min(...c.marks.map(seekTickForMark));
}

/** At the newest simulated tick (or the end of a finished match), as opposed to replaying. */
export function isLive(s: Pick<UiSnapshot, 'tick' | 'maxTick'>): boolean {
  return s.tick >= s.maxTick;
}

/**
 * The timeline mark a feed line is about: same tick, same kind, same fighters. The session writes
 * both from one event, so this links a kill line to its kill mark rather than to a big hit landed
 * on the same tick. Null for lines with no mark (the opening line, the winner line).
 */
export function markForFeed(item: FeedItem, marks: readonly TimelineMark[]): TimelineMark | null {
  for (const m of marks) {
    if (m.tick !== item.tick || m.kind !== item.kind) continue;
    const ids = [m.actorId, m.targetId].filter((id): id is string => id !== null);
    if (ids.length === 0 || ids.some((id) => item.ids.includes(id))) return m;
  }
  return null;
}

// Scrubbing. A press records the track geometry and the scale (`domain`) the player is looking at;
// the release is measured against that same record. While the match runs past the time limit the
// domain grows every notification, so measuring a release against the newer scale would land the
// seek somewhere other than where the player pressed.

/** Pointer travel (px) that turns a click into a drag. */
export const SCRUB_SLOP_PX = 3;

export type Scrub = {
  left: number;
  width: number;
  domain: number;
  maxTick: number;
  startX: number;
  x: number;
  moved: boolean;
  /** Cluster under the press, if any. A click on it seeks to its lead-in instead of the raw tick. */
  cluster: MarkCluster | null;
};

export function scrubStart(clientX: number, track: { left: number; width: number }, domain: number, maxTick: number, cluster: MarkCluster | null): Scrub {
  return { left: track.left, width: Math.max(1, track.width), domain, maxTick, startX: clientX, x: clientX, moved: false, cluster };
}

export function scrubMove(s: Scrub, clientX: number): Scrub {
  return { ...s, x: clientX, moved: s.moved || Math.abs(clientX - s.startX) > SCRUB_SLOP_PX };
}

/** Tick under the pointer right now (the ghost playhead while dragging). */
export function scrubTick(s: Scrub): number {
  return tickAtRatio((s.x - s.left) / s.width, s.domain, s.maxTick);
}

/** Tick to seek to on release: a clicked mark's lead-in, otherwise the tick under the pointer. */
export function scrubTarget(s: Scrub): number {
  if (!s.moved && s.cluster) return Math.min(clusterSeekTick(s.cluster), s.maxTick);
  return scrubTick(s);
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

// ---------------------------------------------------------------------------------------------
// Hover card and camera follow
// ---------------------------------------------------------------------------------------------

type Size = { w: number; h: number };
type Point = { x: number; y: number };

/**
 * Top-left corner for the hover card. It sits below-right of the pointer and flips to the other
 * side near an edge, so it never covers the fighter being pointed at and never leaves the stage.
 */
export function hoverCardPosition(pointer: Point, card: Size, bounds: Size, gap = 18, margin = 8): Point {
  let x = pointer.x + gap;
  if (x + card.w > bounds.w - margin) x = pointer.x - gap - card.w;
  let y = pointer.y + gap;
  if (y + card.h > bounds.h - margin) y = pointer.y - gap - card.h;
  return {
    x: clamp(x, margin, Math.max(margin, bounds.w - card.w - margin)),
    y: clamp(y, margin, Math.max(margin, bounds.h - card.h - margin)),
  };
}

/**
 * What F does. It toggles the camera on the selected fighter; with nobody selected it releases
 * the camera, because a follow you cannot see the subject of is just a confusing camera.
 */
export function nextFollow(selectedId: string | null, followId: string | null): string | null {
  if (selectedId === null) return null;
  return followId === selectedId ? null : selectedId;
}

// ---------------------------------------------------------------------------------------------
// Arena framing and match beats
// ---------------------------------------------------------------------------------------------

/**
 * Widths (CSS px) of the panels over the arena: null when a panel is not shown. `timeline` is its
 * height. The scoreboard hugs the left edge, the inspector and the end card the right, the
 * timeline the bottom; each sits one gutter in from the edge.
 */
export type HudCover = { scoreboard: number | null; inspector: number | null; endCard: number | null; timeline: number | null };

/**
 * What the HUD covers, for `GameController.setViewInsets`: the camera then frames the action in
 * the part of the arena the viewer can see, instead of behind the inspector or the end card.
 * A panel's inset is its size plus a gutter on both sides, so the framed action keeps clear of it.
 */
export function watchInsets(c: HudCover, gutter: number): ViewInsets {
  const side = (w: number | null) => (w === null ? 0 : Math.round(w + gutter * 2));
  return {
    left: side(c.scoreboard),
    right: Math.max(side(c.inspector), side(c.endCard)),
    top: 0,
    bottom: side(c.timeline),
  };
}

export function sameInsets(a: ViewInsets, b: ViewInsets): boolean {
  return a.left === b.left && a.right === b.right && a.top === b.top && a.bottom === b.bottom;
}

/** Insets that leave exactly `hole` visible inside `arena` (both client rects), never negative. */
export function insetsAround(arena: { left: number; top: number; right: number; bottom: number }, hole: { left: number; top: number; right: number; bottom: number }): ViewInsets {
  return {
    left: Math.max(0, Math.round(hole.left - arena.left)),
    right: Math.max(0, Math.round(arena.right - hole.right)),
    top: Math.max(0, Math.round(hole.top - arena.top)),
    bottom: Math.max(0, Math.round(arena.bottom - hole.bottom)),
  };
}

/** The round-start beat as shown: "3", "2", "1", then "FIGHT!" (countdown 0). */
export function countdownText(countdown: number | null): string | null {
  if (countdown === null || !Number.isFinite(countdown) || countdown < 0) return null;
  return countdown === 0 ? 'FIGHT!' : String(Math.ceil(countdown));
}

/** Phases where Space and a click skip ahead (countdown to FIGHT, final moment to the end card). */
export function skippable(phase: MatchPhase): boolean {
  return phase === 'countdown' || phase === 'final';
}

/** The stamp over the final moment: the title in the broadcast voice and who it is about. */
export type FinaleStamp = { title: string; name: string | null; color: string | null };

/**
 * What the final moment stamps over the arena (SPEC round end): WINNER and the winner's name in
 * their colour; the judges' decision when the hard cap decided it; the squad for squads. Null
 * outside the final moment.
 */
export function finaleStamp(snap: Pick<UiSnapshot, 'phase' | 'ending' | 'placements' | 'fighters' | 'format'>): FinaleStamp | null {
  if (snap.phase !== 'final') return null;
  const winner = snap.fighters.find((f) => f.id === snap.placements[0]) ?? null;
  if (!winner) return { title: 'NOBODY WINS', name: null, color: null };
  const judged = snap.ending === 'judges';
  if (snap.format === 'squads') return { title: judged ? "JUDGES' DECISION" : 'WINNERS', name: `Squad ${String.fromCharCode(65 + winner.squad)}`, color: winner.color };
  return { title: judged ? "JUDGES' DECISION" : 'WINNER', name: winner.name, color: winner.color };
}
