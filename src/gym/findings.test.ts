import { describe, expect, it } from 'vitest';
import { MATCH_RULES, PICKUP_RULES, TICK_HZ } from '../core';
import type { FighterReport, KillRecord, MatchReport, PickupKind } from '../core';
import { aggregateReports } from './aggregate';
import { matchFindings } from './findings';
import { RatingBook } from './ratings';
import { placedReport } from './testkit';

/** Gary (f0) 1st, Brenda (f1) 2nd, Doug (f2) 3rd on `mapId`; `edit` adjusts the fighters and the match. */
function match(edit: (r: MatchReport, gary: FighterReport, brenda: FighterReport, doug: FighterReport) => void = () => {}, mapId = 'pit'): MatchReport {
  const r = placedReport(['Gary@v1', 'Brenda@v1', 'Doug@v1'], [0, 1, 2]);
  r.mapId = mapId;
  edit(r, r.fighters[0]!, r.fighters[1]!, r.fighters[2]!);
  return r;
}

function kill(tick: number, killerId: string, victimId: string): KillRecord {
  return { tick, killerId, victimId, weapon: 'GREATSWORD', cause: 'weapon', pos: { x: 0, y: 0 }, flags: [], killerBehaviour: 'brawl', victimBehaviour: 'lurk' };
}

const BOTH: readonly PickupKind[] = ['haste', 'berserk'];
const firstUp = Math.min(PICKUP_RULES.haste.firstSpawnTicks, PICKUP_RULES.berserk.firstSpawnTicks);
const pitOnly = (id: string): readonly PickupKind[] => (id === 'pit' ? BOTH : []);

function garyFindings(reports: MatchReport[], mapPickups?: (id: string) => readonly PickupKind[]): string[] {
  const agg = aggregateReports(reports, { seed: 1, mapIds: ['pit'], book: new RatingBook(), mapPickups });
  return agg.strategies.find((s) => s.key === 'Gary@v1')!.findings;
}

describe('matchFindings', () => {
  // "Took berserk 4 times, 3 kills while berserk": a report must say what the power-ups bought,
  // and call it out when a map's power-ups went untouched all match.
  it('says what each power-up bought, or that nobody went for them', () => {
    const r = match((_, gary, brenda) => {
      gary.pickupsTaken = { berserk: 2 };
      gary.killsWhileBuffed = { berserk: 1 };
      brenda.pickupsTaken = { haste: 1 };
    });
    const found = matchFindings(r, { mapPickups: pitOnly });
    expect(found).toContain('Gary took berserk twice, 1 kill while berserk.');
    expect(found).toContain('Brenda took haste once, 0 kills while hasted.');

    const untouched = match((m) => (m.ticks = firstUp + 60));
    expect(matchFindings(untouched, { mapPickups: pitOnly })).toContain('Nobody touched the power-ups (haste and berserk) all match.');
    // Over before the first power-up appeared, or on a map without pedestals: nothing to ignore.
    expect(matchFindings(match((m) => (m.ticks = firstUp - 1)), { mapPickups: pitOnly }).join(' ')).not.toContain('power-ups');
    expect(matchFindings(match((m) => (m.ticks = firstUp + 60), 'catacombs'), { mapPickups: pitOnly }).join(' ')).not.toContain('power-ups');
  });

  // Guard trips, stalemates and judges' decisions are never silent (spec: "Logged in the report").
  it('reports guard trips, a stalemate start and the judges scorecards', () => {
    const r = match((m, gary) => {
      gary.guardTrips = [
        { path: 'behaviours.lurk.score', kind: 'div_zero', count: 212 },
        { path: 'target', kind: 'nan', count: 3 },
      ];
      m.suddenDeathStart = { tick: 20 * TICK_HZ, reason: 'stalemate' };
      m.ending = 'judges';
      m.ticks = 150 * TICK_HZ;
    });
    const found = matchFindings(r, {
      judges: [
        { id: 'f0', hpFraction: 0.64, damageDealt: 120, kills: 1 },
        { id: 'f1', hpFraction: 0.12, damageDealt: 300, kills: 0 },
      ],
    });
    expect(found).toContain("Guard trips: Gary's behaviours.lurk.score hit division by zero 212 times (and 1 more).");
    expect(found).toContain(`Stalemate: nobody hurt anyone for ${MATCH_RULES.stalemateTicks / TICK_HZ} s, so the walls started closing at 0:20.`);
    expect(found).toContain("Judges' decision at 2:30: still standing at the hard cap, ranked by HP left, then damage dealt, then kills: Gary 64% HP, Brenda 12% HP.");
  });

  it('counts who was still standing when the time limit started sudden death', () => {
    const r = match((m, _gary, _brenda, doug) => {
      m.suddenDeathStart = { tick: 90 * TICK_HZ, reason: 'time' };
      doug.diedAtTick = 30 * TICK_HZ;
    });
    expect(matchFindings(r)).toContain('Sudden death at 1:30 with 2 still standing.');
  });
});

describe('strategy findings', () => {
  it('sums what the power-ups bought over the batch', () => {
    const reports = [1, 2].map((kills) =>
      match((_, gary) => {
        gary.pickupsTaken = { berserk: 2 };
        gary.killsWhileBuffed = { berserk: kills };
      }),
    );
    expect(garyFindings(reports)).toContain('Took berserk 4 times, 3 kills while berserk.');
  });

  // Flag strategies that never touch power-ups, but only for matches where one was actually up
  // while the fighter lived: dying first, or a map without pedestals, is not ignoring them.
  it('flags a strategy that never takes a power-up that was there to take', () => {
    const lived = () => match((m) => (m.ticks = firstUp + 600));
    const diedEarly = match((m, gary) => (gary.diedAtTick = firstUp - 1));
    const noPedestals = match((m) => (m.ticks = firstUp + 600), 'catacombs');
    const reports = [lived(), lived(), lived(), diedEarly, noPedestals];
    expect(garyFindings(reports, pitOnly)).toContain('Never took a power-up in 3 matches where one was up.');
    // Without map knowledge the gym cannot know power-ups existed, so it says nothing.
    expect(garyFindings(reports).join(' ')).not.toContain('power-up');
  });

  // Hiding until the walls close is a plan the stalemate rule exists to break; the report names it
  // with the numbers that show it (no kills before the wall, rarely seen) and what it earned.
  it('flags a strategy that hides until sudden death', () => {
    const sd = 90 * TICK_HZ;
    const hiding = (place: number) =>
      match((m, gary) => {
        m.suddenDeathStart = { tick: sd, reason: 'time' };
        gary.place = place;
        gary.exposure = { ticksAlive: 6000, ticksSeen: 600, ticksInShadow: 5000 };
      });
    const fighting = match((m, gary) => {
      m.suddenDeathStart = { tick: sd, reason: 'time' };
      gary.exposure = { ticksAlive: 6000, ticksSeen: 600, ticksInShadow: 5000 };
      m.kills = [kill(sd - 600, 'f0', 'f2')];
    });
    // Found and killed early twice: that does not make the matches it reached the walls any less hidden.
    const foundEarly = () => match((m, gary) => ((m.suddenDeathStart = { tick: sd, reason: 'time' }), (gary.diedAtTick = sd - 600)));
    expect(garyFindings([hiding(1), hiding(2), fighting, foundEarly(), foundEarly()])).toContain(
      'Reached sudden death in 3 of 5 matches and hid until then in 2: no kill before the walls, seen 10% of the time; average place 1.5 in those.',
    );
    // Seen most of the time: that is surviving, not hiding.
    const seen = [hiding(1), hiding(2)].map((r) => ((r.fighters[0]!.exposure.ticksSeen = 4000), r));
    expect(garyFindings(seen).join(' ')).not.toContain('hid until');
    // Killing before the walls in most of the matches it reached them: a fighter, not a hider.
    expect(garyFindings([hiding(1), fighting, fighting]).join(' ')).not.toContain('hid until');
  });

  // "Guard trips: behaviours.lurk.score hit division by zero 212 times" in the LLM summary.
  it('lists the worst guard trips over the batch', () => {
    const reports = [3, 3].map((n) =>
      match((_, gary) => {
        gary.guardTrips = [
          { path: 'target', kind: 'nan', count: 25 },
          { path: 'behaviours.lurk.score', kind: 'div_zero', count: n },
        ];
      }),
    );
    expect(garyFindings(reports)).toContain('Guard trips in 2 matches: target produced NaN or infinity 50 times and behaviours.lurk.score hit division by zero 6 times.');
  });
});

describe('batch findings', () => {
  // How often the walls had to close, and why, tells whether matches resolve on their own.
  it('reports the sudden-death share with its reasons and every judges decision', () => {
    const reports = [
      match((m) => (m.suddenDeathStart = { tick: 5400, reason: 'time' })),
      match((m) => (m.suddenDeathStart = { tick: 5400, reason: 'time' })),
      match((m) => {
        m.suddenDeathStart = { tick: 1500, reason: 'stalemate' };
        m.ending = 'judges';
      }),
      match(),
    ];
    const agg = aggregateReports(reports, { seed: 1, mapIds: ['pit'], book: new RatingBook() });
    expect(agg.findings).toContain(`Sudden death in 3 of 4 matches (75%): 2 at the time limit, 1 after ${MATCH_RULES.stalemateTicks / TICK_HZ} s without damage.`);
    expect(agg.findings).toContain('The judges decided 1 of 4 matches: fighters were still standing at the hard cap.');
  });
});
