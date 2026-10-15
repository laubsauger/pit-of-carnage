import { describe, expect, it } from 'vitest';
import { STEER_DIRS, TICK_HZ } from '../core';
import type { FeedItem, UiFighter } from '../core';
import {
  FEED_FADE_TICKS,
  FEED_HOLD_TICKS,
  KILL_LEAD_IN_TICKS,
  cycleFighter,
  feedOpacity,
  markNear,
  ringPoint,
  scoreBars,
  seekTickForMark,
  segmentFeedText,
  sortScoreboard,
  tickAtRatio,
  timelineDomain,
  visibleFeed,
} from './hud';

function fighter(id: string, patch: Partial<UiFighter> = {}): UiFighter {
  return {
    id, name: id, color: '#fff', hp: 100, maxHp: 200, alive: true, kills: 0,
    weapon: 'GREATSWORD', skill: 'DASH', behaviour: 'brawl', place: null, squad: 0, ...patch,
  };
}

describe('sortScoreboard', () => {
  it('puts the living first and the dead after, best place first', () => {
    const rows = sortScoreboard(
      [
        fighter('a', { alive: false, place: 6 }),
        fighter('b'),
        fighter('c', { alive: false, place: 5 }),
        fighter('d'),
      ],
      'ffa',
    );
    expect(rows.map((f) => f.id)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('ranks the living by kills', () => {
    const rows = sortScoreboard([fighter('a', { kills: 1 }), fighter('b', { kills: 3 }), fighter('c')], 'ffa');
    expect(rows.map((f) => f.id)).toEqual(['b', 'a', 'c']);
  });

  it('does not reorder on HP changes, so rows stay put while fighters trade blows', () => {
    const before = sortScoreboard([fighter('a', { hp: 200 }), fighter('b', { hp: 10 })], 'ffa');
    const after = sortScoreboard([fighter('a', { hp: 5 }), fighter('b', { hp: 190 })], 'ffa');
    expect(before.map((f) => f.id)).toEqual(['a', 'b']);
    expect(after.map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('keeps squads together in squads mode, so teams read as teams', () => {
    const rows = sortScoreboard(
      [fighter('a1', { squad: 0, alive: false, place: 4 }), fighter('b1', { squad: 1, kills: 2 }), fighter('a2', { squad: 0 })],
      'squads',
    );
    expect(rows.map((f) => f.id)).toEqual(['a2', 'a1', 'b1']);
  });
});

describe('cycleFighter', () => {
  const ordered = [fighter('a'), fighter('b', { alive: false, place: 3 }), fighter('c')];

  it('skips dead fighters, because Tab is for following the action', () => {
    expect(cycleFighter(ordered, 'a', 1)).toBe('c');
    expect(cycleFighter(ordered, 'c', 1)).toBe('a');
    expect(cycleFighter(ordered, 'a', -1)).toBe('c');
  });

  it('starts at the top (or bottom with Shift) when nothing is selected', () => {
    expect(cycleFighter(ordered, null, 1)).toBe('a');
    expect(cycleFighter(ordered, null, -1)).toBe('c');
  });

  it('still cycles everyone after the match, when nobody is alive', () => {
    const allDead = ordered.map((f, i) => ({ ...f, alive: false, place: i + 1 }));
    expect(cycleFighter(allDead, 'a', 1)).toBe('b');
  });
});

describe('kill feed', () => {
  it('holds a line, then fades it, measured in game time', () => {
    expect(feedOpacity(100, 100)).toBe(1);
    expect(feedOpacity(100, 100 + FEED_HOLD_TICKS)).toBe(1);
    expect(feedOpacity(100, 100 + FEED_HOLD_TICKS + FEED_FADE_TICKS / 2)).toBeCloseTo(0.5);
    expect(feedOpacity(100, 100 + FEED_HOLD_TICKS + FEED_FADE_TICKS)).toBe(0);
  });

  it('hides lines from the future after seeking back, so the feed never spoils a kill', () => {
    expect(feedOpacity(500, 400)).toBe(0);
    const feed: FeedItem[] = [
      { tick: 300, text: 'old', kind: 'info', ids: [] },
      { tick: 390, text: 'recent', kind: 'kill', ids: [] },
      { tick: 450, text: 'future', kind: 'kill', ids: [] },
    ];
    expect(visibleFeed(feed, 400).map((f) => f.text)).toEqual(['recent', 'old']);
  });

  it('caps the number of lines and shows the newest first', () => {
    const feed: FeedItem[] = Array.from({ length: 10 }, (_, i) => ({ tick: i, text: `l${i}`, kind: 'info', ids: [] }));
    expect(visibleFeed(feed, 10, 3).map((f) => f.text)).toEqual(['l9', 'l8', 'l7']);
  });

  it('colours fighter names, longest match first, so "Gary II" is not read as "Gary"', () => {
    const fighters = [
      { id: 'g1', name: 'Gary', color: '#a' },
      { id: 'g2', name: 'Gary II', color: '#b' },
    ];
    expect(segmentFeedText('Gary II opened Gary like a letter.', fighters)).toEqual([
      { text: 'Gary II', id: 'g2', color: '#b' },
      { text: ' opened ' },
      { text: 'Gary', id: 'g1', color: '#a' },
      { text: ' like a letter.' },
    ]);
  });

  it('does not colour a name inside another word', () => {
    const segs = segmentFeedText('Dougal fell. Doug laughed.', [{ id: 'd', name: 'Doug', color: '#c' }]);
    expect(segs.filter((s) => s.id).length).toBe(1);
    expect(segs[0]).toEqual({ text: 'Dougal fell. ' });
  });

  it('only colours the fighters the line is about when ids are given', () => {
    const segs = segmentFeedText('Brenda tripped into the saw.', [
      { id: 'b', name: 'Brenda', color: '#b' },
      { id: 's', name: 'saw', color: '#s' },
    ], ['b']);
    expect(segs.map((s) => s.id ?? null)).toEqual(['b', null]);
  });
});

describe('timeline', () => {
  it('spans the full time limit while live, so marks do not slide as the match plays', () => {
    expect(timelineDomain({ maxTick: 600, timeLimitTicks: 5400, finished: false })).toBe(5400);
    expect(timelineDomain({ maxTick: 6000, timeLimitTicks: 5400, finished: false })).toBe(6000);
  });

  it('spans exactly the match once it is over', () => {
    expect(timelineDomain({ maxTick: 2400, timeLimitTicks: 5400, finished: true })).toBe(2400);
  });

  it('cannot seek past what has been simulated', () => {
    expect(tickAtRatio(0.5, 5400, 600)).toBe(600);
    expect(tickAtRatio(0.1, 5400, 600)).toBe(540);
    expect(tickAtRatio(-1, 5400, 600)).toBe(0);
  });

  it('prefers a kill over a nearby big hit when clicking marks', () => {
    const marks = [
      { tick: 1000, kind: 'big_hit' as const },
      { tick: 1010, kind: 'kill' as const },
    ];
    expect(markNear(marks, 1001, 20)?.kind).toBe('kill');
    expect(markNear(marks, 1200, 20)).toBeNull();
  });

  it('jumps to a lead-in before a kill, so you see the fight and not just the corpse', () => {
    expect(seekTickForMark({ tick: 1000, kind: 'kill' })).toBe(1000 - KILL_LEAD_IN_TICKS);
    expect(seekTickForMark({ tick: 30, kind: 'kill' })).toBe(0);
    expect(seekTickForMark({ tick: 1000, kind: 'dismember' })).toBe(1000 - TICK_HZ / 2);
  });
});

describe('inspector', () => {
  it('scales score bars to the best behaviour and keeps strategy order', () => {
    const bars = scoreBars({ lurk: 0.5, brawl: 2, heal: -1 }, 'brawl');
    expect(bars.map((b) => b.name)).toEqual(['lurk', 'brawl', 'heal']);
    expect(bars.map((b) => b.fraction)).toEqual([0.25, 1, 0]);
    expect(bars.find((b) => b.active)?.name).toBe('brawl');
  });

  it('draws empty bars when every score is zero or negative instead of dividing by zero', () => {
    expect(scoreBars({ a: 0, b: -2 }, 'a').map((b) => b.fraction)).toEqual([0, 0]);
  });

  it('orients the steering ring like the arena: index 0 east, a quarter turn later south (down)', () => {
    const east = ringPoint(0, 10);
    const south = ringPoint(STEER_DIRS / 4, 10);
    expect(east.x).toBeCloseTo(10);
    expect(east.y).toBeCloseTo(0);
    expect(south.x).toBeCloseTo(0);
    expect(south.y).toBeCloseTo(10);
  });
});
