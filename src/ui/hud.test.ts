import { describe, expect, it } from 'vitest';
import { STEER_DIRS, TICK_HZ } from '../core';
import type { FeedItem, TimelineMark, UiFighter } from '../core';
import {
  FEED_FADE_TICKS,
  FEED_HOLD_TICKS,
  KILL_LEAD_IN_TICKS,
  MARK_GAP_PX,
  MARK_KINDS,
  SCRUB_SLOP_PX,
  clusterAt,
  clusterMarks,
  clusterSeekTick,
  countdownText,
  cycleFighter,
  deathTick,
  feedOpacity,
  finaleStamp,
  filterMarks,
  hoverCardPosition,
  hudFolds,
  insetsAround,
  isLive,
  laneMarks,
  markForFeed,
  nextFollow,
  ringPoint,
  scoreBars,
  seekTickForMark,
  scrubMove,
  scrubStart,
  scrubTarget,
  scrubTick,
  segmentFeedText,
  skippable,
  watchInsets,
  sortScoreboard,
  tickAtRatio,
  timelineDomain,
  visibleFeed,
} from './hud';

function mark(tick: number, kind: TimelineMark['kind'], actorId: string | null = null, targetId: string | null = null): TimelineMark {
  return { tick, kind, actorId, targetId, text: '', actorBehaviour: null, targetBehaviour: null };
}

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

  it('prefers a kill over a nearby big hit when clicking a busy moment', () => {
    // 5400 ticks over 900 px: 6 ticks per px, so these two share a cluster.
    const [c] = clusterMarks([mark(1000, 'big_hit'), mark(1010, 'kill')], 5400, 900);
    expect(c.marks[0].kind).toBe('kill');
    expect(clusterSeekTick(c)).toBe(1010 - KILL_LEAD_IN_TICKS);
    expect(clusterAt([c], c.x + 2, 6)).toBe(c);
    expect(clusterAt([c], c.x + 40, 6)).toBeNull();
  });

  it('jumps to a lead-in before a kill, so you see the fight and not just the corpse', () => {
    expect(seekTickForMark(mark(1000, 'kill'))).toBe(1000 - KILL_LEAD_IN_TICKS);
    expect(seekTickForMark(mark(30, 'kill'))).toBe(0);
    expect(seekTickForMark(mark(1000, 'dismember'))).toBe(1000 - TICK_HZ / 2);
  });
});

describe('timeline marks', () => {
  const marks = [
    mark(100, 'big_hit', 'gary', 'brenda'),
    mark(400, 'pickup', 'brenda', null),
    mark(900, 'dismember', 'doug', 'gary'),
    mark(1200, 'kill', 'brenda', 'gary'),
    mark(5400, 'sudden_death'),
  ];

  it("shows only one fighter's moments, what they did and what was done to them, when a fighter is picked", () => {
    expect(filterMarks(marks, 'gary', MARK_KINDS).map((m) => m.tick)).toEqual([100, 900, 1200, 5400]);
    expect(filterMarks(marks, 'doug', MARK_KINDS).map((m) => m.tick)).toEqual([900, 5400]);
  });

  it('keeps sudden death under any fighter filter, because it explains the deaths that follow', () => {
    expect(filterMarks(marks, 'nobody', MARK_KINDS).map((m) => m.kind)).toEqual(['sudden_death']);
  });

  it('hides the event types switched off in the legend', () => {
    expect(filterMarks(marks, null, ['kill', 'pickup']).map((m) => m.kind)).toEqual(['pickup', 'kill']);
  });

  it("gives each fighter a lane of their own moments that ends where they died", () => {
    expect(laneMarks(marks, 'gary').map((m) => m.tick)).toEqual([100, 900, 1200]);
    expect(deathTick(marks, 'gary')).toBe(1200);
    expect(deathTick(marks, 'brenda')).toBeNull();
  });

  it('never draws two clusters closer than the gap, and loses no mark doing it', () => {
    const busy = Array.from({ length: 40 }, (_, i) => mark(1000 + i * 7, i % 3 === 0 ? 'kill' : 'big_hit'));
    for (const width of [320, 900, 1600]) {
      const clusters = clusterMarks(busy, 5400, width);
      for (let i = 1; i < clusters.length; i++) expect(clusters[i].x - clusters[i - 1].x).toBeGreaterThanOrEqual(MARK_GAP_PX);
      expect(clusters.flatMap((c) => c.marks).length).toBe(busy.length);
    }
  });

  it('keeps a quiet match unclustered, one mark per moment', () => {
    expect(clusterMarks(marks, 5400, 900).map((c) => c.marks.length)).toEqual([1, 1, 1, 1, 1]);
  });

  it('starts a click on a busy moment at its earliest lead-in, so the whole moment plays', () => {
    const [c] = clusterMarks([mark(1000, 'dismember'), mark(1004, 'kill')], 5400, 900);
    expect(clusterSeekTick(c)).toBe(1004 - KILL_LEAD_IN_TICKS);
  });
});

describe('live or replay', () => {
  it('is live at the newest simulated tick and replaying anywhere before it', () => {
    expect(isLive({ tick: 600, maxTick: 600 })).toBe(true);
    expect(isLive({ tick: 420, maxTick: 600 })).toBe(false);
  });
});

describe('kill feed links to the timeline', () => {
  const kill = mark(1200, 'kill', 'brenda', 'gary');
  const hit = mark(1200, 'big_hit', 'brenda', 'gary');
  const marks = [hit, kill, mark(5400, 'sudden_death')];

  it("finds the feed line's own mark, not a big hit landed on the same tick", () => {
    expect(markForFeed({ tick: 1200, text: 'Brenda filed Gary.', kind: 'kill', ids: ['brenda', 'gary'] }, marks)).toBe(kill);
  });

  it('links a sudden-death line that names nobody', () => {
    expect(markForFeed({ tick: 5400, text: 'The walls are closing.', kind: 'sudden_death', ids: [] }, marks)?.kind).toBe('sudden_death');
  });

  it('links nothing for lines without a moment (the opening line)', () => {
    expect(markForFeed({ tick: 0, text: '8 fighters in the Pit.', kind: 'info', ids: [] }, marks)).toBeNull();
    expect(markForFeed({ tick: 1200, text: 'Doug took a limb.', kind: 'kill', ids: ['doug'] }, marks)).toBeNull();
  });
});

describe('seeking', () => {
  const track = { left: 40, width: 917.5 };

  it('lands every click within half a pixel of where it was pressed, whatever the scale', () => {
    for (const domain of [600, 5400, 7333]) {
      for (let px = 0; px <= track.width; px += 0.5) {
        const s = scrubStart(track.left + px, track, domain, domain, null);
        const drawnAt = (scrubTarget(s) / domain) * track.width;
        expect(Math.abs(drawnAt - px)).toBeLessThanOrEqual(Math.max(0.5, (0.5 * track.width) / domain) + 1e-9);
      }
    }
  });

  it('lands exactly on a tick when clicking where that tick is drawn', () => {
    const domain = 600; // more than one px per tick
    for (let t = 0; t <= domain; t++) {
      const s = scrubStart(track.left + (t / domain) * track.width, track, domain, domain, null);
      expect(scrubTarget(s)).toBe(t);
    }
  });

  it('never seeks past what has been simulated', () => {
    const s = scrubStart(track.left + track.width, track, 5400, 1800, null);
    expect(scrubTarget(s)).toBe(1800);
    expect(scrubTarget(scrubStart(track.left - 50, track, 5400, 1800, null))).toBe(0);
  });

  it("measures the release against the scale seen at the press, even if the bar grew since", () => {
    const s = scrubStart(track.left + 300, track, 6000, 6000, null);
    // The live match notifies while the button is down; the scrub keeps its own domain.
    expect(scrubTarget(scrubMove(s, track.left + 300))).toBe(Math.round((300 / track.width) * 6000));
  });

  it('jumps to the lead-in of a clicked mark, but a drag that starts on a mark goes where it is released', () => {
    const [c] = clusterMarks([mark(3000, 'kill')], 5400, track.width);
    const press = scrubStart(track.left + c.x, track, 5400, 5400, c);
    expect(scrubTarget(scrubMove(press, track.left + c.x + SCRUB_SLOP_PX))).toBe(3000 - KILL_LEAD_IN_TICKS);
    const dragged = scrubMove(press, track.left + c.x + 120);
    expect(dragged.moved).toBe(true);
    expect(scrubTarget(dragged)).toBe(scrubTick(dragged));
    expect(scrubTarget(dragged)).toBeGreaterThan(3000);
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

describe('hoverCardPosition', () => {
  const card = { w: 236, h: 150 };
  const stage = { w: 1200, h: 800 };

  it('sits below-right of the pointer, off the fighter being pointed at', () => {
    expect(hoverCardPosition({ x: 300, y: 200 }, card, stage)).toEqual({ x: 318, y: 218 });
  });

  it('flips left and up near the far edges instead of running off the stage', () => {
    const p = hoverCardPosition({ x: 1150, y: 760 }, card, stage);
    expect(p.x + card.w).toBeLessThanOrEqual(1150);
    expect(p.y + card.h).toBeLessThanOrEqual(760);
  });

  it('stays inside a stage smaller than the card rather than going negative', () => {
    const p = hoverCardPosition({ x: 50, y: 50 }, card, { w: 200, h: 100 });
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
  });
});

describe('nextFollow', () => {
  it('toggles the camera on the selected fighter', () => {
    expect(nextFollow('a', null)).toBe('a');
    expect(nextFollow('a', 'a')).toBeNull();
  });

  it('moves the camera to a newly selected fighter instead of switching it off', () => {
    expect(nextFollow('b', 'a')).toBe('b');
  });

  it('releases the camera when nobody is selected, so F never locks onto someone you cannot see in the inspector', () => {
    expect(nextFollow(null, 'a')).toBeNull();
    expect(nextFollow(null, null)).toBeNull();
  });
});

describe('watchInsets', () => {
  const none = { scoreboard: null, inspector: null, endCard: null, timeline: null };

  it('reports the inspector, so the camera frames the action beside it instead of under it', () => {
    expect(watchInsets({ ...none, inspector: 316 }, 12)).toEqual({ left: 0, right: 340, top: 0, bottom: 0 });
  });

  it('takes the wider of the inspector and the end card, both hugging the right edge', () => {
    expect(watchInsets({ ...none, inspector: 316, endCard: 420 }, 12).right).toBe(444);
  });

  it('covers the scoreboard on the left and the timeline at the bottom', () => {
    expect(watchInsets({ scoreboard: 252, inspector: null, endCard: null, timeline: 40 }, 12)).toEqual({ left: 276, right: 0, top: 0, bottom: 64 });
  });

  it('is all zero when no panel is shown (the whole arena is visible)', () => {
    expect(watchInsets(none, 12)).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
  });
});

describe('insetsAround', () => {
  it('leaves exactly the picture-in-picture window visible, so the followed fighter is framed inside it', () => {
    const arena = { left: 0, top: 44, right: 1400, bottom: 900 };
    const hole = { left: 980, top: 120, right: 1380, bottom: 370 };
    expect(insetsAround(arena, hole)).toEqual({ left: 980, right: 20, top: 76, bottom: 530 });
  });

  it('never goes negative when the window pokes past the arena', () => {
    expect(insetsAround({ left: 0, top: 0, right: 100, bottom: 100 }, { left: -5, top: -5, right: 120, bottom: 120 })).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
  });
});

describe('countdownText', () => {
  it('counts 3, 2, 1 and then shouts FIGHT!', () => {
    expect([3, 2, 1, 0].map(countdownText)).toEqual(['3', '2', '1', 'FIGHT!']);
  });

  it('shows nothing outside the countdown', () => {
    expect(countdownText(null)).toBeNull();
    expect(countdownText(-1)).toBeNull();
  });
});

describe('skippable', () => {
  it('lets Space and a click skip only the countdown and the final moment, never a live match', () => {
    expect(skippable('countdown')).toBe(true);
    expect(skippable('final')).toBe(true);
    expect(skippable('live')).toBe(false);
    expect(skippable('ended')).toBe(false);
  });
});

describe('finaleStamp (SPEC round end: a WINNER stamp in the broadcast voice over the final moment)', () => {
  const f = (id: string, squad: number, name: string): UiFighter => ({
    id, name, color: `#${id}`, hp: 10, maxHp: 100, alive: true, kills: 1, weapon: 'GREATSWORD', skill: 'DASH', behaviour: 'brawl', place: null, squad,
  });
  const fighters = [f('a1', 0, 'Gary'), f('b2', 1, 'Brenda'), f('c3', 1, 'Pam')];

  it('names the winner in their colour, only during the final moment', () => {
    expect(finaleStamp({ phase: 'final', ending: 'elimination', placements: ['b2', 'a1', 'c3'], fighters, format: 'ffa' })).toEqual({ title: 'WINNER', name: 'Brenda', color: '#b2' });
    expect(finaleStamp({ phase: 'ended', ending: 'elimination', placements: ['b2'], fighters, format: 'ffa' })).toBeNull();
    expect(finaleStamp({ phase: 'live', ending: null, placements: [], fighters, format: 'ffa' })).toBeNull();
  });

  it("says when the judges decided it, and names the squad in squads", () => {
    expect(finaleStamp({ phase: 'final', ending: 'judges', placements: ['a1'], fighters, format: 'ffa' })?.title).toBe("JUDGES' DECISION");
    expect(finaleStamp({ phase: 'final', ending: 'elimination', placements: ['c3', 'b2', 'a1'], fighters, format: 'squads' })).toEqual({ title: 'WINNERS', name: 'Squad B', color: '#c3' });
  });

  it('never stamps a stranger when nobody is left', () => {
    expect(finaleStamp({ phase: 'final', ending: 'elimination', placements: [], fighters, format: 'ffa' })).toEqual({ title: 'NOBODY WINS', name: null, color: null });
  });
});

describe('hudFolds', () => {
  const base = { cinematic: false, narrow: false, scoreboardCollapsed: false, feedCollapsed: false, inspectorCollapsed: false, opened: { scoreboard: false, feed: false } };

  // Cinematic view is for watching the fight: every panel folds and the camera gets the whole canvas.
  it('folds every panel and reports no insets in cinematic view, whatever the panes say', () => {
    expect(hudFolds({ ...base, cinematic: true })).toEqual({ scoreboard: true, feed: true, inspector: true, thinTimeline: true, reportInsets: false });
  });

  it('starts scoreboard and feed folded on a narrow screen, until the viewer opens them', () => {
    const narrow = hudFolds({ ...base, narrow: true });
    expect([narrow.scoreboard, narrow.feed, narrow.thinTimeline, narrow.inspector]).toEqual([true, true, true, false]);
    const opened = hudFolds({ ...base, narrow: true, opened: { scoreboard: true, feed: false } });
    expect([opened.scoreboard, opened.feed]).toEqual([false, true]);
  });

  it('leaves each panel to its own switch on a wide screen', () => {
    expect(hudFolds(base)).toEqual({ scoreboard: false, feed: false, inspector: false, thinTimeline: false, reportInsets: true });
    expect(hudFolds({ ...base, feedCollapsed: true }).feed).toBe(true);
  });
});
