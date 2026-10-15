/**
 * Findings: short plain sentences computed from recorded numbers, never invented. They are what a
 * player (or the LLM they paste the report into) reads first, so each one names a cause and a count:
 * "Died 7 of 10 times, 5 of them to LONGBOW, 4 while in lurk." rather than "struggled vs ranged".
 *
 * Weapon and skill ids are written as ids (LONGBOW, DASH) because that is how strategies name them.
 */

import { JUDGES_ORDER, MATCH_RULES, PICKUP_RULES, TICK_HZ } from '../core';
import type { FighterReport, GuardTrip, GuardTripKind, JudgeCriterion, JudgedFighter, KillCause, KillRecord, MatchReport, PickupKind, ReportRosterEntry, StrategyAggregate } from '../core';
import { clock, listing, mostFrequent, ordinalPlace, pct, plural, round } from './format';

export type FindingContext = {
  /** Display name of a map id ("pit" -> "The Pit"); defaults to the id. */
  mapName?: (mapId: string) => string;
  /**
   * Power-up kinds on a map's pedestals. Without it nobody can be blamed for ignoring power-ups
   * (a map may have none), so the "never took a power-up" findings stay quiet.
   */
  mapPickups?: (mapId: string) => readonly PickupKind[];
};

/** One fighter's part in one match, the unit every aggregate is computed from. */
export type Appearance = { report: MatchReport; entry: ReportRosterEntry; fighter: FighterReport };

/** Pedestal power-ups (spent ammo picked off the floor is not one). */
export const POWER_UPS: readonly PickupKind[] = ['haste', 'berserk'];

const ENVIRONMENT: readonly KillCause[] = ['hazard', 'keg', 'sudden_death'];

/** "while berserk", "while hasted". */
const BUFFED: Record<PickupKind, string> = { haste: 'hasted', berserk: 'berserk' };

const TRIP: Record<GuardTripKind, string> = {
  nan: 'produced NaN or infinity',
  div_zero: 'hit division by zero',
  clamped: 'went out of bounds and was clamped',
  cost: 'ran over the evaluation budget',
};

const JUDGED_BY: Record<JudgeCriterion, string> = { hp_fraction: 'HP left', damage_dealt: 'damage dealt', kills: 'kills' };

/** Seconds of no fighter-on-fighter damage that start sudden death early. */
const STALEMATE_SECONDS = MATCH_RULES.stalemateTicks / TICK_HZ;

function times(n: number): string {
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`;
}

/** "took berserk 4 times, 3 kills while berserk; took haste once, 0 kills while hasted", or null if none taken. */
export function powerUpPhrase(taken: Partial<Record<PickupKind, number>>, kills: Partial<Record<PickupKind, number>>): string | null {
  const parts = POWER_UPS.filter((k) => (taken[k] ?? 0) > 0).map((k) => {
    const n = kills[k] ?? 0;
    return `took ${k} ${times(taken[k]!)}, ${n} ${plural(n, 'kill')} while ${BUFFED[k]}`;
  });
  return parts.length > 0 ? parts.join('; ') : null;
}

/** "behaviours.lurk.score hit division by zero 212 times". */
export function guardTripPhrase(g: GuardTrip): string {
  return `${g.path} ${TRIP[g.kind]} ${g.count} ${plural(g.count, 'time')}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Earliest tick a power-up of these kinds can be on its pedestal, or null when there are none. */
function firstPowerUpTick(kinds: readonly PickupKind[]): number | null {
  return kinds.length > 0 ? Math.min(...kinds.map((k) => PICKUP_RULES[k].firstSpawnTicks)) : null;
}

function pickupTotal(t: Partial<Record<PickupKind, number>>): number {
  return POWER_UPS.reduce((s, k) => s + (t[k] ?? 0), 0);
}

const DEATH_BY_CAUSE: Record<KillCause, string> = {
  weapon: 'was killed',
  skill: 'was killed by a skill',
  hazard: 'walked into a hazard',
  keg: 'was caught in a keg blast',
  friendly: 'was killed by a teammate',
  sudden_death: 'was crushed by the closing wall',
};

/** Map name as it reads mid-sentence: "The Pit" becomes "the Pit". */
function mapLabel(ctx: FindingContext, mapId: string): string {
  return (ctx.mapName?.(mapId) ?? mapId).replace(/^The /, 'the ');
}

// ---------------------------------------------------------------------------------------------
// One match
// ---------------------------------------------------------------------------------------------

export type MatchFindingContext = FindingContext & {
  /** The gym stopped the match at its safety cap. */
  capped?: boolean;
  /** The scorecards from the sim's `judges_decision` event, judged order. */
  judges?: readonly JudgedFighter[];
};

export function matchFindings(report: MatchReport, ctx: MatchFindingContext = {}): string[] {
  const out: string[] = [];
  const nameOf = new Map(report.roster.map((r) => [r.fighterId, r.name]));
  const fighters = new Map(report.fighters.map((f) => [f.fighterId, f]));
  const map = mapLabel(ctx, report.mapId);

  const winnerId = report.placements[0];
  const winner = winnerId ? fighters.get(winnerId) : undefined;
  if (winner && winnerId) {
    const who = nameOf.get(winnerId) ?? winnerId;
    const seen = winner.exposure.ticksSeen === 0 ? 'never seen once' : `seen ${pct(winner.exposure.ticksSeen, winner.exposure.ticksAlive)} of the time`;
    out.push(
      winner.kills === 0
        ? `${who} takes ${map} without a single kill, ${seen}.`
        : `${who} takes ${map}: ${winner.kills} ${plural(winner.kills, 'kill')}, ${seen}.`,
    );
  }

  const first = [...report.kills].sort((a, b) => a.tick - b.tick)[0];
  if (first) {
    const victim = nameOf.get(first.victimId) ?? first.victimId;
    const killer = first.killerId && first.killerId !== first.victimId ? nameOf.get(first.killerId) : undefined;
    out.push(
      killer
        ? `First blood at ${clock(first.tick)}: ${killer}${first.weapon ? ` (${first.weapon})` : ''} killed ${victim}, who was in ${first.victimBehaviour}.`
        : `First death at ${clock(first.tick)}: ${victim} ${DEATH_BY_CAUSE[first.cause]}.`,
    );
  }

  const topDamage = [...report.fighters].sort((a, b) => b.damageDealt - a.damageDealt)[0];
  if (topDamage && topDamage.damageDealt > 0 && topDamage.fighterId !== winnerId) {
    out.push(`Most damage: ${nameOf.get(topDamage.fighterId)} with ${Math.round(topDamage.damageDealt)}, finished ${ordinalPlace(topDamage.place)}.`);
  }

  const environmental = report.kills.filter((k) => ENVIRONMENT.includes(k.cause)).length;
  if (environmental > 0) {
    out.push(`${environmental} of ${report.kills.length} ${plural(report.kills.length, 'death')} came from the arena itself (hazards, kegs, the closing wall).`);
  }

  const unseen = report.kills.filter((k) => k.flags.includes('unseen')).length;
  if (unseen >= 2) out.push(`${unseen} kills landed on fighters who never saw their killer coming.`);

  // Power-ups: what each taker got out of them, or that nobody bothered.
  const takers = report.fighters
    .map((f) => ({ f, taken: pickupTotal(f.pickupsTaken) }))
    .filter((t) => t.taken > 0)
    .sort((a, b) => b.taken - a.taken || a.f.place - b.f.place);
  for (const { f } of takers.slice(0, 3)) out.push(`${nameOf.get(f.fighterId)} ${powerUpPhrase(f.pickupsTaken, f.killsWhileBuffed)}.`);
  const kinds = ctx.mapPickups?.(report.mapId) ?? [];
  const firstUp = firstPowerUpTick(kinds);
  if (takers.length === 0 && firstUp !== null && report.ticks > firstUp) out.push(`Nobody touched the power-ups (${listing(kinds)}) all match.`);

  // Guard trips are never silent: each one is an expression the gate should have caught.
  for (const f of report.fighters) {
    const [top, ...rest] = f.guardTrips;
    if (!top) continue;
    out.push(`Guard trips: ${nameOf.get(f.fighterId)}'s ${guardTripPhrase(top)}${rest.length > 0 ? ` (and ${rest.length} more)` : ''}.`);
  }

  const sd = report.suddenDeathStart;
  if (sd?.reason === 'stalemate') {
    out.push(`Stalemate: nobody hurt anyone for ${STALEMATE_SECONDS} s, so the walls started closing at ${clock(sd.tick)}.`);
  } else if (sd) {
    const standing = report.fighters.filter((f) => f.diedAtTick === null || f.diedAtTick > sd.tick).length;
    out.push(`Sudden death at ${clock(sd.tick)} with ${standing} still standing.`);
  }

  if (report.ending === 'judges') {
    const cards = (ctx.judges ?? []).map((j) => `${nameOf.get(j.id) ?? j.id} ${Math.round(j.hpFraction * 100)}% HP`);
    out.push(
      `Judges' decision at ${clock(report.ticks)}: still standing at the hard cap, ranked by ${JUDGES_ORDER.map((c) => JUDGED_BY[c]).join(', then ')}${cards.length > 0 ? `: ${cards.join(', ')}` : ''}.`,
    );
  }
  if (ctx.capped || report.ending === 'capped') out.push(`Stopped at the safety cap after ${clock(report.ticks)}; placements by remaining HP.`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// One strategy across a batch
// ---------------------------------------------------------------------------------------------

export type StrategyFindingContext = FindingContext & { nameOfKey: (key: string) => string };

function deathOf(app: Appearance): KillRecord | undefined {
  return app.report.kills.find((k) => k.victimId === app.entry.fighterId);
}

export function strategyFindings(agg: StrategyAggregate, apps: readonly Appearance[], ctx: StrategyFindingContext): string[] {
  const out: string[] = [];
  const n = apps.length;
  if (n === 0) return out;

  const sizes = new Set(apps.map((a) => a.report.roster.length));
  const ofField = sizes.size === 1 ? ` of ${[...sizes][0]}` : '';
  const wins = Math.round(agg.winRate * agg.matches);
  out.push(`Won ${wins} of ${agg.matches} (${pct(wins, agg.matches)}); average place ${round(agg.avgPlace, 1)}${ofField}.`);

  // Deaths: how, to what, doing what.
  const deaths = apps.map(deathOf).filter((k): k is KillRecord => k !== undefined);
  if (deaths.length > 0) {
    const byWeapon = mostFrequent(deaths.filter((k) => k.weapon).map((k) => k.weapon!));
    let line = `Died ${deaths.length} of ${n} times`;
    if (byWeapon && byWeapon.count >= 2) {
      const toWeapon = deaths.filter((k) => k.weapon === byWeapon.value);
      const doing = mostFrequent(toWeapon.map((k) => k.victimBehaviour));
      line += `, ${byWeapon.count === deaths.length ? 'all' : byWeapon.count} to ${byWeapon.value}`;
      if (doing && doing.count >= 2 && doing.count * 2 >= toWeapon.length) {
        line += doing.count === toWeapon.length ? ` while in ${doing.value}` : `, ${doing.count} while in ${doing.value}`;
      }
    }
    out.push(`${line}.`);
    if (agg.killedMostBy) {
      out.push(`Killed most by ${ctx.nameOfKey(agg.killedMostBy.key)}: ${agg.killedMostBy.count} of ${deaths.length} ${plural(deaths.length, 'death')}.`);
    }
    const environmental = deaths.filter((k) => ENVIRONMENT.includes(k.cause)).length;
    if (environmental >= 2 && environmental * 4 >= deaths.length) {
      out.push(`${environmental} of ${deaths.length} deaths came from the arena itself (hazards, kegs, the closing wall).`);
    }
  }

  // Behaviours that never won a think in any match: usually a score that can never be highest.
  if (n >= 2) {
    const never = apps.reduce<string[] | null>((acc, a) => (acc === null ? [...a.fighter.neverWon] : acc.filter((b) => a.fighter.neverWon.includes(b))), null) ?? [];
    if (never.length > 0) out.push(`${listing(never)} never won a think in ${n} matches.`);
  }

  // Exposure.
  const alive = sum(apps, (a) => a.fighter.exposure.ticksAlive);
  const seen = sum(apps, (a) => a.fighter.exposure.ticksSeen);
  const shadow = sum(apps, (a) => a.fighter.exposure.ticksInShadow);
  if (alive > 0 && seen / alive <= 0.2) out.push(`Seen by enemies only ${pct(seen, alive)} of the time alive.`);
  else if (alive > 0 && seen / alive >= 0.6) out.push(`Seen by enemies ${pct(seen, alive)} of the time alive; ${pct(shadow, alive)} in shadow.`);

  // Attacks and skill use.
  const attacks = sum(apps, (a) => a.fighter.attacks);
  const landed = sum(apps, (a) => a.fighter.hitsLanded);
  if (attacks === 0 && n >= 2) out.push(`Never attacked in ${n} matches; check the attack policy.`);
  else if (attacks >= 10) out.push(`Landed ${landed} of ${attacks} attacks (${pct(landed, attacks)}).`);
  if (n >= 2 && sum(apps, (a) => a.fighter.skillUses) === 0) out.push(`Never used ${apps[0]!.entry.skill} in ${n} matches.`);

  // Power-ups: what they bought, or that it never went for one while one was there to take.
  const bought = powerUpPhrase(agg.pickupsTaken, agg.killsWhileBuffed);
  if (bought) out.push(`${capitalize(bought)}.`);
  else if (ctx.mapPickups) {
    // Only matches where a power-up had appeared before this fighter died: dying first is not ignoring them.
    const chances = apps.filter((a) => {
      const firstUp = firstPowerUpTick(ctx.mapPickups!(a.report.mapId));
      return firstUp !== null && (a.fighter.diedAtTick ?? a.report.ticks) > firstUp;
    }).length;
    if (chances >= 2) out.push(`Never took a power-up in ${chances} matches where one was up.`);
  }

  // Hiding until sudden death: of the matches it was still alive when the walls started, most were
  // spent hiding (no kill before the walls, rarely seen). Matches it died in earlier do not dilute
  // this: a hider that sometimes gets found still relies on hiding.
  const reached = apps.filter((a) => {
    const sd = a.report.suddenDeathStart;
    return sd !== null && (a.fighter.diedAtTick === null || a.fighter.diedAtTick > sd.tick);
  });
  const hid = reached.filter((a) => {
    const sd = a.report.suddenDeathStart!;
    const f = a.fighter;
    if (a.report.kills.some((k) => k.killerId === a.entry.fighterId && k.victimId !== k.killerId && k.tick < sd.tick)) return false;
    return f.exposure.ticksSeen <= 0.25 * f.exposure.ticksAlive;
  });
  if (hid.length >= 2 && hid.length * 2 >= reached.length) {
    const seenH = sum(hid, (a) => a.fighter.exposure.ticksSeen);
    const aliveH = sum(hid, (a) => a.fighter.exposure.ticksAlive);
    const placeH = sum(hid, (a) => a.fighter.place) / hid.length;
    out.push(
      `Reached sudden death in ${reached.length} of ${n} matches and hid until then in ${hid.length}: no kill before the walls, seen ${pct(seenH, aliveH)} of the time; average place ${round(placeH, 1)} in those.`,
    );
  }

  // Guard trips: each one is a runtime guard catching an expression the gate let through.
  if (agg.guardTrips.length > 0) {
    const shown = agg.guardTrips.slice(0, 3).map(guardTripPhrase);
    const more = agg.guardTrips.length - shown.length;
    out.push(`Guard trips in ${n} ${plural(n, 'match', 'matches')}: ${listing(shown)}${more > 0 ? ` (and ${more} more)` : ''}.`);
  }

  // Matchups: the opponent it most often finishes behind.
  const worst = Object.entries(agg.byOpponent)
    .filter(([, r]) => r.matches >= 3 && r.winRate <= 0.3)
    .sort((a, b) => a[1].winRate - b[1].winRate || b[1].matches - a[1].matches || (a[0] < b[0] ? -1 : 1))[0];
  if (worst) out.push(`Finished behind ${ctx.nameOfKey(worst[0])} in ${worst[1].matches - worst[1].wins} of ${worst[1].matches} meetings.`);

  // Maps: a big split in average place.
  const maps = [...new Set(apps.map((a) => a.report.mapId))]
    .map((id) => {
      const on = apps.filter((a) => a.report.mapId === id);
      return { id, matches: on.length, avg: sum(on, (a) => a.fighter.place) / on.length };
    })
    .filter((m) => m.matches >= 2)
    .sort((a, b) => a.avg - b.avg || (a.id < b.id ? -1 : 1));
  const best = maps[0];
  const worstMap = maps[maps.length - 1];
  if (best && worstMap && worstMap.avg - best.avg >= 1.5) {
    out.push(`Average place ${round(best.avg, 1)} on ${mapLabel(ctx, best.id)} but ${round(worstMap.avg, 1)} on ${mapLabel(ctx, worstMap.id)}.`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// A whole batch
// ---------------------------------------------------------------------------------------------

export type BatchFindingContext = StrategyFindingContext & {
  mapIds: readonly string[];
  /** Strategies under test; the rest of each lineup is "the field". */
  candidateKeys?: readonly string[];
  /** How to call the non-candidates, e.g. "the house stacks". */
  fieldLabel?: string;
};

export function batchFindings(aggs: readonly StrategyAggregate[], reports: readonly MatchReport[], ctx: BatchFindingContext): string[] {
  const out: string[] = [];
  if (reports.length === 0) return out;
  const maps = [...new Set(reports.map((r) => r.mapId))];
  const where = maps.length === 1 ? `on ${mapLabel(ctx, maps[0]!)}` : `across ${maps.length} maps`;
  const candidates = new Set(ctx.candidateKeys ?? []);

  // Candidate vs field: finished ahead of every non-candidate fighter in the match.
  for (const key of candidates) {
    let played = 0;
    let beat = 0;
    for (const r of reports) {
      const placeOf = new Map(r.fighters.map((f) => [f.fighterId, f.place]));
      const mine = r.roster.filter((e) => e.strategyKey === key);
      const field = r.roster.filter((e) => !candidates.has(e.strategyKey));
      if (mine.length === 0 || field.length === 0) continue;
      played++;
      const bestMine = Math.min(...mine.map((e) => placeOf.get(e.fighterId) ?? Infinity));
      const bestField = Math.min(...field.map((e) => placeOf.get(e.fighterId) ?? Infinity));
      if (bestMine < bestField) beat++;
    }
    if (played > 0) out.push(`${ctx.nameOfKey(key)} beats ${ctx.fieldLabel ?? 'the field'} ${beat} of ${played} ${where}.`);
  }

  // Best average place (ties: more wins), not best rating: the sentence quotes these numbers.
  const top = [...aggs].sort((a, b) => a.avgPlace - b.avgPlace || b.winRate - a.winRate || (a.key < b.key ? -1 : 1))[0];
  if (top && aggs.length >= 2) {
    out.push(`${ctx.nameOfKey(top.key)} tops the batch: average place ${round(top.avgPlace, 1)}, won ${Math.round(top.winRate * top.matches)} of ${top.matches}.`);
  }

  const kills = reports.flatMap((r) => r.kills);
  const byWeapon = mostFrequent(kills.filter((k) => k.weapon).map((k) => k.weapon!));
  if (byWeapon && kills.length >= 5) out.push(`${byWeapon.value} landed ${pct(byWeapon.count, kills.length)} of all kills (${byWeapon.count} of ${kills.length}).`);
  const environmental = kills.filter((k) => ENVIRONMENT.includes(k.cause)).length;
  if (kills.length >= 5 && environmental * 10 >= kills.length) {
    out.push(`The arena itself caused ${environmental} of ${kills.length} deaths.`);
  }

  // How matches ended: how often the walls had to close and why, and anything the judges or the cap decided.
  const n = reports.length;
  const sd = reports.filter((r) => r.suddenDeathStart !== null);
  if (sd.length > 0) {
    const time = sd.filter((r) => r.suddenDeathStart!.reason === 'time').length;
    const stalemate = sd.length - time;
    const why = [time > 0 ? `${time} at the time limit` : '', stalemate > 0 ? `${stalemate} after ${STALEMATE_SECONDS} s without damage` : ''].filter(Boolean);
    out.push(`Sudden death in ${sd.length} of ${n} matches (${pct(sd.length, n)}): ${why.join(', ')}.`);
  }
  const judged = reports.filter((r) => r.ending === 'judges').length;
  if (judged > 0) out.push(`The judges decided ${judged} of ${n} matches: fighters were still standing at the hard cap.`);
  const capped = reports.filter((r) => r.ending === 'capped').length;
  if (capped > 0) out.push(`${capped} of ${n} matches hit the gym's safety cap, which a healthy sim never reaches.`);
  return out;
}

function sum<T>(xs: readonly T[], f: (x: T) => number): number {
  let s = 0;
  for (const x of xs) s += f(x);
  return s;
}
