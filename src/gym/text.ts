/**
 * `reportToText`: a compact plain-text battle report for pasting into an LLM, followed by the full
 * report as JSON. The text puts findings and the numbers that explain them first, so a model reads
 * what matters before the raw data; the JSON keeps every detail for follow-up questions.
 */

import { displayRating } from '../core';
import type { AggregateReport, DamageSource, FighterReport, GuardTrip, KillRecord, MatchEnding, MatchReport, PickupKind, StrategyAggregate } from '../core';
import { POWER_UPS, guardTripPhrase } from './findings';
import { clock, ordinalPlace, pct, plural, round, versionedName } from './format';

const ENDING: Record<MatchEnding, string> = {
  elimination: 'Ended by elimination',
  time: 'Ended at the bell (sudden death off), placed by standing',
  judges: "Ended by judges' decision at the hard cap",
  capped: "Stopped at the gym's safety cap, placed by standing",
};

/** "berserk 4 (3 kills while buffed), haste 1 (0 kills while buffed)", or null when none were taken. */
function powerUps(taken: Partial<Record<PickupKind, number>>, kills: Partial<Record<PickupKind, number>>): string | null {
  const parts = POWER_UPS.filter((k) => (taken[k] ?? 0) > 0).map((k) => `${k} ${taken[k]} (${kills[k] ?? 0} ${plural(kills[k] ?? 0, 'kill')} while buffed)`);
  return parts.length > 0 ? parts.join(', ') : null;
}

function guardTrips(trips: readonly GuardTrip[]): string | null {
  return trips.length > 0 ? trips.map(guardTripPhrase).join('; ') : null;
}

function sources(table: Partial<Record<DamageSource, number>>): string {
  const parts = Object.entries(table)
    .filter(([, v]) => (v ?? 0) > 0)
    .sort((a, b) => b[1]! - a[1]!)
    .map(([k, v]) => `${k} ${Math.round(v!)}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

function behaviourShare(f: FighterReport): string {
  const total = Object.values(f.behaviourTicks).reduce((s, v) => s + v, 0);
  const parts = Object.entries(f.behaviourTicks)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([name, ticks]) => `${name} ${pct(ticks, total)}`);
  return parts.length > 0 ? parts.join(', ') : 'none recorded';
}

function killLine(k: KillRecord, nameOf: (id: string) => string): string {
  const victim = `${nameOf(k.victimId)} (in ${k.victimBehaviour})`;
  const flags = k.flags.length > 0 ? ` [${k.flags.join(', ')}]` : '';
  if (!k.killerId || k.killerId === k.victimId) return `${clock(k.tick)} ${victim} died: ${k.cause}${flags}`;
  const how = [k.weapon ?? k.cause, k.killerBehaviour].filter(Boolean).join(', ');
  return `${clock(k.tick)} ${nameOf(k.killerId)} (${how}) killed ${victim}${k.cause !== 'weapon' ? `, cause ${k.cause}` : ''}${flags}`;
}

function matchText(r: MatchReport): string[] {
  const roster = new Map(r.roster.map((e) => [e.fighterId, e]));
  const nameOf = (id: string) => roster.get(id)?.name ?? id;
  const fighters = [...r.fighters].sort((a, b) => a.place - b.place);
  const lines = [
    'PIT OF CARNAGE: MATCH REPORT',
    `Map ${r.mapId}, ${r.format.toUpperCase()}, ${r.roster.length} fighters, ${clock(r.ticks)} (${r.ticks} ticks), seed ${r.seed}.`,
    `${ENDING[r.ending]}. ${r.suddenDeathStart ? `Sudden death from ${clock(r.suddenDeathStart.tick)} (${r.suddenDeathStart.reason === 'time' ? 'time limit' : 'stalemate'}).` : 'No sudden death.'}`,
    '',
    'Findings',
    ...(r.findings.length > 0 ? r.findings.map((f) => `- ${f}`) : ['- none']),
    '',
    'Placements',
  ];
  for (const f of fighters) {
    const e = roster.get(f.fighterId);
    const strategy = e ? `${versionedName(e.strategyName, e.strategyVersion)}; ${e.weapon} + ${e.skill}` : f.fighterId;
    const fate = f.diedAtTick === null ? 'survived' : `died ${clock(f.diedAtTick)}`;
    const x = f.exposure;
    const ups = powerUps(f.pickupsTaken, f.killsWhileBuffed);
    const trips = guardTrips(f.guardTrips);
    lines.push(
      `${f.place}. ${nameOf(f.fighterId)} [${strategy}]: ${f.kills} ${plural(f.kills, 'kill')}, ${fate}. ` +
        `Dealt ${Math.round(f.damageDealt)} (${sources(f.damageDealtBySource)}), took ${Math.round(f.damageTaken)} (${sources(f.damageTakenBySource)}). ` +
        `Attacks ${f.attacks}, landed ${f.hitsLanded}, skill ${f.skillUses}, parries ${f.parries}. ` +
        `Seen ${pct(x.ticksSeen, x.ticksAlive)}, in shadow ${pct(x.ticksInShadow, x.ticksAlive)}. ` +
        `Behaviours: ${behaviourShare(f)}.${f.neverWon.length > 0 ? ` Never won: ${f.neverWon.join(', ')}.` : ''}` +
        `${ups ? ` Power-ups: ${ups}.` : ''}${trips ? ` Guard trips: ${trips}.` : ''}`,
    );
  }
  lines.push('', 'Kills', ...(r.kills.length > 0 ? r.kills.map((k) => killLine(k, nameOf)) : ['none']));
  return lines;
}

function strategyText(s: StrategyAggregate, rank: number, nameOfKey: (key: string) => string): string[] {
  const r = s.rating;
  const places = s.placementHistogram.map((n, i) => `${ordinalPlace(i + 1)} ${n}`).join(', ');
  const maps = Object.entries(s.byMap)
    .map(([id, w]) => `${id} won ${w.wins} of ${w.matches}`)
    .join('; ');
  const deaths = Object.entries(s.deathsByCause)
    .map(([cause, n]) => `${cause} ${n}`)
    .join(', ');
  const ups = powerUps(s.pickupsTaken, s.killsWhileBuffed);
  const trips = guardTrips(s.guardTrips);
  return [
    `${rank}. ${versionedName(s.name, s.version)}: rating ${displayRating(r)} (mu ${round(r.mu, 1)}, sigma ${round(r.sigma, 1)}). ` +
      `${s.matches} matches, won ${pct(Math.round(s.winRate * s.matches), s.matches)}, average place ${round(s.avgPlace, 1)}.`,
    `   Places: ${places}.`,
    `   Per match: ${round(s.avgKills, 1)} kills, ${Math.round(s.avgDamageDealt)} damage, survived ${clock(s.avgSurvivalTicks)}.` +
      ` Deaths: ${deaths || 'none'}.${s.killedMostBy ? ` Killed most by ${nameOfKey(s.killedMostBy.key)} (${s.killedMostBy.count}).` : ''}`,
    `   Maps: ${maps || 'none'}.`,
    `   Power-ups taken: ${ups ?? 'none'}.`,
    ...(trips ? [`   Guard trips: ${trips}.`] : []),
    ...s.findings.map((f) => `   - ${f}`),
  ];
}

function aggregateText(a: AggregateReport): string[] {
  const names = new Map(a.strategies.map((s) => [s.key, versionedName(s.name, s.version)]));
  const nameOfKey = (k: string) => names.get(k) ?? k;
  return [
    'PIT OF CARNAGE: BATCH REPORT',
    `${a.matches} matches on ${a.mapIds.join(', ')}; seed ${a.seed}.`,
    '',
    'Findings',
    ...(a.findings.length > 0 ? a.findings.map((f) => `- ${f}`) : ['- none']),
    '',
    'Strategies, best rating first',
    ...a.strategies.flatMap((s, i) => strategyText(s, i + 1, nameOfKey)),
  ];
}

/** Compact plain-text summary for pasting into an LLM, followed by the full report as JSON. */
export function reportToText(report: MatchReport | AggregateReport): string {
  const lines = 'roster' in report ? matchText(report) : aggregateText(report);
  return [...lines, '', 'JSON', JSON.stringify(report)].join('\n');
}
