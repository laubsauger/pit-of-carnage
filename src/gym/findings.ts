/**
 * Findings: short plain sentences computed from recorded numbers, never invented. They are what a
 * player (or the LLM they paste the report into) reads first, so each one names a cause and a count:
 * "Died 7 of 10 times, 5 of them to LONGBOW, 4 while in lurk." rather than "struggled vs ranged".
 *
 * Weapon and skill ids are written as ids (LONGBOW, DASH) because that is how strategies name them.
 */

import type { FighterReport, KillCause, KillRecord, MatchReport, ReportRosterEntry, StrategyAggregate } from '../core';
import { clock, listing, mostFrequent, ordinalPlace, pct, plural, round } from './format';

export type FindingContext = {
  /** Display name of a map id ("pit" -> "The Pit"); defaults to the id. */
  mapName?: (mapId: string) => string;
};

/** One fighter's part in one match, the unit every aggregate is computed from. */
export type Appearance = { report: MatchReport; entry: ReportRosterEntry; fighter: FighterReport };

const ENVIRONMENT: readonly KillCause[] = ['hazard', 'keg', 'sudden_death'];

const DEATH_BY_CAUSE: Record<KillCause, string> = {
  weapon: 'was killed',
  skill: 'was killed by a skill',
  hazard: 'walked into a hazard',
  keg: 'was caught in a keg blast',
  friendly: 'was killed by a teammate',
  sudden_death: 'was crushed by the closing wall',
};

function mapLabel(ctx: FindingContext, mapId: string): string {
  return ctx.mapName?.(mapId) ?? mapId;
}

// ---------------------------------------------------------------------------------------------
// One match
// ---------------------------------------------------------------------------------------------

export function matchFindings(report: MatchReport, ctx: FindingContext & { capped?: boolean } = {}): string[] {
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

  if (ctx.capped) out.push(`Stopped at the safety cap after ${clock(report.ticks)}; placements by remaining HP.`);
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
  const wins = agg.placementHistogram[0] ?? 0;
  out.push(`Won ${wins} of ${n} (${pct(wins, n)}); average place ${round(agg.avgPlace, 1)}${ofField}.`);

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

  const top = aggs[0];
  if (top && aggs.length >= 2) {
    out.push(`${ctx.nameOfKey(top.key)} tops the batch: average place ${round(top.avgPlace, 1)}, won ${top.placementHistogram[0] ?? 0} of ${top.matches}.`);
  }

  const kills = reports.flatMap((r) => r.kills);
  const byWeapon = mostFrequent(kills.filter((k) => k.weapon).map((k) => k.weapon!));
  if (byWeapon && kills.length >= 5) out.push(`${byWeapon.value} landed ${pct(byWeapon.count, kills.length)} of all kills (${byWeapon.count} of ${kills.length}).`);
  const environmental = kills.filter((k) => ENVIRONMENT.includes(k.cause)).length;
  if (kills.length >= 5 && environmental * 10 >= kills.length) {
    out.push(`The arena itself caused ${environmental} of ${kills.length} deaths.`);
  }
  return out;
}

function sum<T>(xs: readonly T[], f: (x: T) => number): number {
  let s = 0;
  for (const x of xs) s += f(x);
  return s;
}
