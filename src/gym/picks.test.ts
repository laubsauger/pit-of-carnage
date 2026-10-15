import { describe, expect, it } from 'vitest';
import type { KillRecord, MatchReport } from '../core';
import { fighterMoments, pickMatches } from './picks';
import { placedReport } from './testkit';

/**
 * A match where Lurker (f0) places `place` of `n`, dies at `died` (killed by f1) or survives, lands
 * kills at `killTicks` and deals `damage`. Everyone else is "Field".
 */
function lurkerMatch(seed: number, n: number, place: number, opts: { died?: number; killTicks?: number[]; damage?: number; ticks?: number } = {}): MatchReport {
  const keys = ['Lurker@v1', ...Array.from({ length: n - 1 }, (_, i) => `Field${i}@v1`)];
  const others = Array.from({ length: n - 1 }, (_, i) => i + 1);
  const order = [...others.slice(0, place - 1), 0, ...others.slice(place - 1)];
  const r = placedReport(keys, order);
  r.seed = seed;
  r.ticks = opts.ticks ?? 1000;
  const lurker = r.fighters[0]!;
  lurker.damageDealt = opts.damage ?? 0;
  const kills: KillRecord[] = (opts.killTicks ?? []).map((tick, i) => ({
    tick, killerId: 'f0', victimId: `f${n - 1 - i}`, weapon: 'TWIN_DAGGERS', cause: 'weapon', pos: { x: 0, y: 0 }, flags: [], killerBehaviour: 'stab', victimBehaviour: 'kite',
  }));
  lurker.kills = kills.length;
  if (opts.died !== undefined) {
    lurker.diedAtTick = opts.died;
    kills.push({ tick: opts.died, killerId: 'f1', victimId: 'f0', weapon: 'LONGBOW', cause: 'weapon', pos: { x: 0, y: 0 }, flags: ['ranged'], killerBehaviour: 'snipe', victimBehaviour: 'lurk' });
    lurker.death = { tick: opts.died, cause: 'weapon', killerId: 'f1', weapon: 'LONGBOW', hazard: null, flags: ['ranged'], title: 'PINCUSHION' };
  }
  r.kills = kills.sort((a, b) => a.tick - b.tick);
  return r;
}

describe('pickMatches', () => {
  // "Watch worst loss / best win / a typical match": the buttons must open the match that teaches
  // the most, at the moment that matters, judged fairly across field sizes.
  it('picks the worst loss, the best win and a typical match, each with where to look', () => {
    const reports = [
      lurkerMatch(10, 8, 7, { died: 500 }), // 7th of 8: bad, but not last
      lurkerMatch(11, 3, 3, { died: 900 }), // last of 3
      lurkerMatch(12, 3, 3, { died: 300 }), // last of 3, and dead sooner: the worst
      lurkerMatch(13, 3, 1, { killTicks: [100, 400], damage: 200, ticks: 600 }),
      lurkerMatch(14, 3, 1, { killTicks: [150, 450], damage: 300, ticks: 800 }), // same kills, more damage: the best
      lurkerMatch(15, 3, 2, { died: 700, killTicks: [200], damage: 90 }), // middle of the pack, like its average
    ];
    const picks = pickMatches(reports, 'Lurker@v1', { mapName: () => 'the Pit' });

    expect(picks.worstLoss).toMatchObject({ kind: 'worst_loss', reportIndex: 2, seed: 12, fighterId: 'f0', place: 3, focusTick: 300 });
    expect(picks.worstLoss!.summary).toBe('3rd of 3 on the Pit, seed 12: died at 0:05 (PINCUSHION: LONGBOW by Field0 [ranged]).');
    expect(picks.bestWin).toMatchObject({ kind: 'best_win', reportIndex: 4, place: 1, focusTick: 450 });
    expect(picks.bestWin!.summary).toBe('Won on the Pit, seed 14: 2 kills and 300 damage in 0:13.');
    expect(picks.typical).toMatchObject({ kind: 'typical', reportIndex: 5, place: 2, focusTick: 700 });
  });

  // A strategy that never won (or never lost) has no such match: say so instead of a wrong one.
  it('returns null for what never happened, and never repeats a pick as typical when it can avoid it', () => {
    const losses = [lurkerMatch(1, 3, 3, { died: 100 }), lurkerMatch(2, 3, 2, { died: 400 })];
    const picks = pickMatches(losses, 'Lurker@v1');
    expect(picks.bestWin).toBeNull();
    expect(picks.worstLoss!.reportIndex).toBe(0);
    expect(picks.typical!.reportIndex).toBe(1);

    const one = pickMatches([lurkerMatch(3, 3, 1, { killTicks: [50] })], 'Lurker@v1');
    expect(one.worstLoss).toBeNull();
    expect(one.bestWin!.reportIndex).toBe(0);
    // Only one match: typical has to be that one, opened at its first kill since it survived.
    expect(one.typical).toMatchObject({ reportIndex: 0, focusTick: 50 });
    expect(pickMatches(losses, 'Nobody@v1')).toEqual({ worstLoss: null, bestWin: null, typical: null });
  });
});

describe('fighterMoments', () => {
  it("lists a fighter's kills and its death in time order, for jumping straight to them", () => {
    const r = lurkerMatch(1, 4, 2, { died: 900, killTicks: [300, 120] });
    expect(fighterMoments(r, 'f0')).toEqual([
      { tick: 120, kind: 'kill', otherId: 'f2', label: 'Killed Field1 (TWIN_DAGGERS)' },
      { tick: 300, kind: 'kill', otherId: 'f3', label: 'Killed Field2 (TWIN_DAGGERS)' },
      { tick: 900, kind: 'death', otherId: 'f1', label: 'Died: PINCUSHION: LONGBOW by Field0 [ranged]' },
    ]);
  });
});
