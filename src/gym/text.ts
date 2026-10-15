/**
 * `reportToText`: a compact plain-text battle report for pasting into an LLM, followed by the full
 * report as JSON. The text puts findings and the numbers that explain them first, so a model reads
 * what matters before the raw data; the JSON keeps every detail for follow-up questions, except the
 * heatmaps' raw cells (187 numbers each), which the text already puts into words ("Where: ...") and
 * the JSON trims to each heatmap's busiest cells (`trimHeatmap`).
 */

import { TICK_HZ, displayRating } from '../core';
import type {
  AggregateReport,
  DamageSource,
  DeathRecord,
  FighterReport,
  FighterStats,
  GuardTrip,
  Heatmap,
  KillRecord,
  MatchEnding,
  MatchReport,
  PickupKind,
  StrategyAggregate,
  SuddenDeathShare,
} from '../core';
import type { CompareResult, CompareRow } from './compare';
import { POWER_UPS, guardTripPhrase } from './findings';
import { clock, ordinalPlace, pct, plural, round, versionedName } from './format';
import { heatmapLegend, heatmapPhrase, trimHeatmap } from './heatmap';

const JSON_HEATMAPS = 'In the JSON below each heatmap keeps only its busiest cells.';

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

/**
 * How a fighter died, from its `DeathRecord`: "SHANKED: TWIN_DAGGERS by Kevin [backstab, unseen]",
 * "SAWED: saw", "SAWED: saw, credited to Gary", "KABOOM: a keg set off by Doug",
 * "CRUSHED: the closing wall [crushed]", "OWN GOAL: a keg, own goal".
 */
export function deathPhrase(d: DeathRecord, nameOf: (id: string) => string, victimId: string): string {
  const what = d.cause === 'sudden_death' ? 'the closing wall' : d.cause === 'keg' ? 'a keg' : (d.weapon ?? d.hazard ?? d.cause);
  let by = '';
  if (d.killerId === victimId) by = ', own goal';
  else if (d.killerId && (d.cause === 'hazard' || d.cause === 'sudden_death')) by = `, credited to ${nameOf(d.killerId)}`;
  else if (d.killerId) by = `${d.cause === 'keg' ? ' set off' : ''} by ${nameOf(d.killerId)}`;
  const flags = d.flags.length > 0 ? ` [${d.flags.join(', ')}]` : '';
  return `${d.title}: ${what}${by}${flags}`;
}

/**
 * The movement and engagement numbers as one sentence starting with `lead` ("Moved", "On average
 * moved"). `alive` is the time alive the shares are of (the average survival in an aggregate).
 */
function statsLine(lead: string, s: FighterStats, alive: number, suddenDeath: boolean): string {
  const contact = s.ticksToFirstContact === null ? 'never engaged anyone' : `first contact ${clock(s.ticksToFirstContact)}`;
  const engaged =
    s.ticksEngaged > 0
      ? `engaged ${pct(s.ticksEngaged, alive)} of its time alive (dealt ${s.damageDealtPerSecondEngaged}/s, took ${s.damageTakenPerSecondEngaged}/s)`
      : 'never engaged';
  return (
    `${lead} ${Math.round(s.distanceTravelled)} px; ${engaged}; ${contact}. ` +
    `Idle ${pct(s.ticksIdle, alive)}, stuck ${pct(s.ticksStuck, alive)}, near walls ${pct(s.ticksNearWalls, alive)}` +
    `${suddenDeath ? `, outside the zone ${pct(s.ticksOutsideZone, alive)}` : ''}. ` +
    `Accuracy ${Math.round(s.accuracy * 100)}%, skill hits ${round(s.skillHits, 1)}, assists ${round(s.assists, 1)}, kill participation ${Math.round(s.killParticipation * 100)}%.`
  );
}

/** "Sudden death in 3 of 10 matches (30%; time 2, stalemate 1), on average from 1:31." */
function suddenDeathLine(sd: SuddenDeathShare, matches: number): string {
  if (sd.matches === 0) return `No sudden death in ${matches} ${plural(matches, 'match', 'matches')}.`;
  const why = (['time', 'stalemate'] as const).filter((r) => sd.byReason[r]).map((r) => `${r} ${sd.byReason[r]}`);
  return `Sudden death in ${sd.matches} of ${matches} (${Math.round(sd.share * 100)}%; ${why.join(', ')}), on average from ${clock(sd.avgStartTick ?? 0)}.`;
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
    ...(r.judges ? [`Judges' scorecards: ${r.judges.map((j, i) => `${ordinalPlace(i + 1)} ${nameOf(j.id)} (${Math.round(j.hpFraction * 100)}% HP, ${Math.round(j.damageDealt)} damage, ${j.kills} ${plural(j.kills, 'kill')})`).join('; ')}.`] : []),
    '',
    'Findings',
    ...(r.findings.length > 0 ? r.findings.map((f) => `- ${f}`) : ['- none']),
    '',
    'Placements',
    ...(r.fighters[0] ? [`${heatmapLegend(r.fighters[0].heatmap)} ${JSON_HEATMAPS}`] : []),
  ];
  for (const f of fighters) {
    const e = roster.get(f.fighterId);
    const strategy = e ? `${versionedName(e.strategyName, e.strategyVersion)}; ${e.weapon} + ${e.skill}` : f.fighterId;
    const fate =
      f.diedAtTick === null ? 'survived' : `died ${clock(f.diedAtTick)}${f.death ? ` (${deathPhrase(f.death, nameOf, f.fighterId)})` : ''}`;
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
      `   ${statsLine('Moved', f.stats, x.ticksAlive, r.suddenDeathStart !== null)}`,
      `   Where: ${heatmapPhrase(f.heatmap)}.`,
    );
  }
  lines.push('', 'Kills', ...(r.kills.length > 0 ? r.kills.map((k) => killLine(k, nameOf)) : ['none']));
  return lines;
}

function strategyText(s: StrategyAggregate, rank: number, nameOfKey: (key: string) => string): string[] {
  const j = s.judges;
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
    `   ${statsLine('On average moved', s.stats, s.avgSurvivalTicks, s.suddenDeath.matches > 0)}`,
    `   ${suddenDeathLine(s.suddenDeath, s.matches)}${j.matches > 0 ? ` The judges decided ${j.matches}; it won ${j.wins} of those.` : ''}`,
    ...Object.entries(s.heatmaps).map(([mapId, h]) => `   Where on ${mapId}: ${heatmapPhrase(h)}.`),
    `   Power-ups taken: ${ups ?? 'none'}.`,
    ...(trips ? [`   Guard trips: ${trips}.`] : []),
    ...s.findings.map((f) => `   - ${f}`),
  ];
}

/** Batch-level endings: how the matches ended, sudden death, and every judges' decision. */
function endingsText(a: AggregateReport, nameOfKey: (key: string) => string): string[] {
  const endings = (['elimination', 'judges', 'time', 'capped'] as const).filter((e) => a.endings[e]).map((e) => `${e} ${a.endings[e]}`);
  return [
    `Endings: ${endings.join(', ') || 'none'}. ${suddenDeathLine(a.suddenDeath, a.matches)}`,
    ...a.judges.decisions.map(
      (d) =>
        `Judges' decision, seed ${d.seed} on ${d.mapId}: ` +
        d.survivors.map((f, i) => `${ordinalPlace(i + 1)} ${nameOfKey(f.strategyKey)} (${Math.round(f.hpFraction * 100)}% HP, ${Math.round(f.damageDealt)} damage, ${f.kills} ${plural(f.kills, 'kill')})`).join('; ') +
        '.',
    ),
  ];
}

function aggregateText(a: AggregateReport): string[] {
  const names = new Map(a.strategies.map((s) => [s.key, versionedName(s.name, s.version)]));
  const nameOfKey = (k: string) => names.get(k) ?? k;
  const firstHeatmap = a.strategies.flatMap((s) => Object.values(s.heatmaps))[0];
  return [
    'PIT OF CARNAGE: BATCH REPORT',
    `${a.matches} matches on ${a.mapIds.join(', ')}; seed ${a.seed}.`,
    ...endingsText(a, nameOfKey),
    '',
    'Findings',
    ...(a.findings.length > 0 ? a.findings.map((f) => `- ${f}`) : ['- none']),
    '',
    'Strategies, best rating first',
    ...(firstHeatmap ? [`${heatmapLegend(firstHeatmap)} ${JSON_HEATMAPS}`] : []),
    ...a.strategies.flatMap((s, i) => strategyText(s, i + 1, nameOfKey)),
  ];
}

/** Busiest cells each heatmap keeps in the LLM paste's JSON. */
export const LLM_HEATMAP_CELLS = 5;

/** The report as the LLM paste carries it: unchanged, except every heatmap trimmed to its busiest cells. */
export function reportForLlm(report: MatchReport | AggregateReport): unknown {
  if ('roster' in report) return { ...report, fighters: report.fighters.map((f) => ({ ...f, heatmap: trimHeatmap(f.heatmap, LLM_HEATMAP_CELLS) })) };
  const trimAll = (hs: Record<string, Heatmap>) => Object.fromEntries(Object.entries(hs).map(([id, h]) => [id, trimHeatmap(h, LLM_HEATMAP_CELLS)]));
  return { ...report, strategies: report.strategies.map((s) => ({ ...s, heatmaps: trimAll(s.heatmaps) })) };
}

/**
 * Compact plain-text summary for pasting into an LLM, followed by the full report as JSON (heatmaps
 * trimmed to their busiest cells, see `reportForLlm`).
 */
export function reportToText(report: MatchReport | AggregateReport): string {
  const lines = 'roster' in report ? matchText(report) : aggregateText(report);
  return [...lines, '', 'JSON', JSON.stringify(reportForLlm(report))].join('\n');
}

function rowValue(r: CompareRow, v: number | null): string {
  if (v === null) return 'none';
  if (r.unit === 'share') return `${Math.round(v * 100)}%`;
  if (r.unit === 'seconds') return clock(v * TICK_HZ);
  if (r.unit === 'px') return `${Math.round(v)} px`;
  return String(round(v, 2));
}

/**
 * A comparison (`runCompare`) as LLM text: findings, the side-by-side rows, where each spent its time
 * per map and the per-seed finishes, then the JSON without the match reports (both aggregates, heatmaps
 * trimmed, rows and per-seed finishes).
 */
export function compareToText(c: CompareResult): string {
  const nameA = versionedName(c.a.name, c.a.version);
  const nameB = versionedName(c.b.name, c.b.version);
  const maps = [...new Set(c.matches.map((m) => m.mapId))];
  const fighters = [...new Set(c.matches.map((m) => m.fighters))];
  const first = Object.values(c.a.heatmaps)[0];
  const lines = [
    'PIT OF CARNAGE: COMPARISON',
    `A = ${nameA}, B = ${nameB}: ${c.matches.length} shared seeds on ${maps.join(', ')}, ${fighters.join('/')} fighters per match. ` +
      'Both played the same seeds, maps, opponents and seat; they never met.',
    '',
    'Findings',
    ...(c.findings.length > 0 ? c.findings.map((f) => `- ${f}`) : ['- none']),
    '',
    'Side by side (A vs B; the better side in brackets where better has a direction)',
    ...c.rows.map((r) => `${r.label}: ${rowValue(r, r.a)} vs ${rowValue(r, r.b)}${r.better ? ` [${r.better.toUpperCase()}]` : ''}`),
    '',
    ...(first ? [heatmapLegend(first)] : []),
    ...maps.flatMap((id) => [
      `Where on ${id}, A: ${c.a.heatmaps[id] ? heatmapPhrase(c.a.heatmaps[id]) : 'no time recorded'}.`,
      `Where on ${id}, B: ${c.b.heatmaps[id] ? heatmapPhrase(c.b.heatmaps[id]) : 'no time recorded'}.`,
    ]),
    '',
    'Per seed (A place vs B place)',
    ...c.matches.map((m) => `seed ${m.seed} on ${m.mapId}: ${ordinalPlace(m.placeA)} vs ${ordinalPlace(m.placeB)}`),
  ];
  const trimAll = (hs: Record<string, Heatmap>) => Object.fromEntries(Object.entries(hs).map(([id, h]) => [id, trimHeatmap(h, LLM_HEATMAP_CELLS)]));
  const { reportsA: _a, reportsB: _b, ...rest } = c;
  const json = { ...rest, a: { ...c.a, heatmaps: trimAll(c.a.heatmaps) }, b: { ...c.b, heatmaps: trimAll(c.b.heatmaps) } };
  return [...lines, '', 'JSON', JSON.stringify(json)].join('\n');
}
