import { describe, expect, it } from 'vitest';
import type { FeedItem, TimelineMark } from '../../core';
import { HISTORY_TICKS, commitLeft, fighterLog, pushHistory, scoreRange, sensorRows, sensorValueText, sparkPoints, termLabel } from './overview';
import type { ScorePoint } from './overview';

const pt = (tick: number, behaviour = 'brawl', scores: Record<string, number> = { brawl: 1, heal: 0.2 }): ScorePoint => ({ tick, behaviour, scores });

describe('pushHistory', () => {
  it('keeps about ten seconds of thinks for the sparklines', () => {
    let h: ScorePoint[] = [];
    for (let t = 0; t <= HISTORY_TICKS + 60; t += 6) h = pushHistory(h, pt(t));
    expect(h[0]!.tick).toBeGreaterThanOrEqual(60);
    expect(h[h.length - 1]!.tick).toBe(HISTORY_TICKS + 60);
  });

  it('starts over after a seek back, so a sparkline never joins two different stretches of the match', () => {
    const h = pushHistory([pt(600), pt(606)], pt(120));
    expect(h.map((p) => p.tick)).toEqual([120]);
  });

  it('starts over after a jump forward past the window too', () => {
    expect(pushHistory([pt(0), pt(6)], pt(6 + HISTORY_TICKS + 1)).length).toBe(1);
  });

  it('ignores a repeat of the same think (notifications arrive faster than thinks while paused)', () => {
    const h = [pt(6)];
    expect(pushHistory(h, pt(6))).toBe(h);
  });
});

describe('scoreRange and sparkPoints', () => {
  it('shares one scale across behaviours, always including zero', () => {
    expect(scoreRange([pt(0, 'brawl', { brawl: 2, heal: -1 })])).toEqual({ lo: -1, hi: 2 });
    expect(scoreRange([])).toEqual({ lo: 0, hi: 1 });
  });

  it('puts the newest think at the right edge and older ones to the left', () => {
    const pts = sparkPoints([pt(0, 'brawl', { brawl: 0 }), pt(HISTORY_TICKS, 'brawl', { brawl: 1 })], 'brawl', HISTORY_TICKS, 100, 20, { lo: 0, hi: 1 });
    expect(pts).toBe('0.0,20.0 100.0,0.0');
  });
});

describe('commitLeft', () => {
  it('counts down from the think the running behaviour took over', () => {
    const h = [pt(0, 'heal'), pt(6, 'brawl'), pt(12, 'brawl')];
    expect(commitLeft(h, 30, 18)).toEqual({ left: 18, exact: true });
  });

  it('admits when the takeover happened before the overview opened', () => {
    const h = [pt(6, 'brawl'), pt(12, 'brawl')];
    expect(commitLeft(h, 30, 12)).toEqual({ left: 24, exact: false });
    expect(commitLeft(h, 30, 200)?.left).toBe(0);
    expect(commitLeft([], 30, 0)).toBeNull();
  });
});

describe('sensorRows', () => {
  it('attaches unit, range and doc from the registry, grouped so the target reads apart from you', () => {
    const { sensors } = sensorRows({ 'target.distance': 212, 'self.hp': 0.5, enemies_seen: 2 });
    expect(sensors.map((s) => s.group)).toEqual(['You', 'Target', 'Others']);
    expect(sensors[1]).toMatchObject({ name: 'target.distance', unit: 'px', range: '0..9999' });
    expect(sensors[1]!.doc.length).toBeGreaterThan(0);
  });

  it('treats names the registry does not know as memory slots', () => {
    expect(sensorRows({ grudge: 3, 'self.hp': 1 }).memory).toEqual([{ name: 'grudge', value: 3 }]);
  });
});

describe('sensorValueText', () => {
  it('reads like a player would say it', () => {
    expect(sensorValueText(1, '0/1')).toBe('yes');
    expect(sensorValueText(312.4, 'px')).toBe('312 px');
    expect(sensorValueText(9999, 'px')).toBe('none');
    expect(sensorValueText(0.5, 'fraction')).toBe('0.50');
  });
});

describe('fighterLog', () => {
  const mark = (tick: number, kind: TimelineMark['kind'], actorId: string | null, targetId: string | null, text: string): TimelineMark => ({
    tick, kind, actorId, targetId, text, actorBehaviour: null, targetBehaviour: null,
  });
  const feed = (tick: number, kind: string, ids: string[], text: string): FeedItem => ({ tick, kind, ids, text });

  it('tells its own story newest first, what it did apart from what was done to it', () => {
    const marks = [mark(100, 'big_hit', 'g', 'b', 'Gary hit Brenda.'), mark(300, 'kill', 'b', 'g', 'Brenda got Gary.')];
    const log = fighterLog('g', [], marks);
    expect(log.map((l) => [l.tick, l.role])).toEqual([[300, 'took'], [100, 'did']]);
  });

  it('never lists a moment twice when the feed line and the timeline mark are the same event', () => {
    const marks = [mark(300, 'kill', 'b', 'g', 'Brenda got Gary.')];
    const lines = [feed(300, 'kill', ['b', 'g'], 'Brenda got Gary.'), feed(50, 'info', ['g'], 'Gary waves.'), feed(60, 'info', ['x'], 'Not about Gary.')];
    expect(fighterLog('g', lines, marks).map((l) => l.text)).toEqual(['Brenda got Gary.', 'Gary waves.']);
  });
});

describe('termLabel', () => {
  it('writes a term the way the strategy does', () => {
    expect(termLabel({ keep_range: ['target', 220, 320], weight: 1 })).toBe('keep_range target 220-320 x1');
    expect(termLabel({ orbit: ['target', 'cw'], weight: 0.4 })).toBe('orbit target cw x0.4');
  });
});
