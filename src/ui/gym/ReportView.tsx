// Owned by: ui
import { Fragment, useEffect, useRef, useState } from 'react';
import { TICK_HZ, displayRating } from '../../core';
import type { AggregateReport, KillCause, MatchEnding, MatchReport, StrategyAggregate, SuddenDeathReason } from '../../core';
import { compareRows, pickMatches, reportToText } from '../../gym';
import type { MatchPick, MatchPicks } from '../../gym';
import { MAPS } from '../../sim';
import type { WatchRequest } from '../App';
import { formatClock, formatPercent, formatPlace, keyLabel, strategyLabel, weaponName } from '../format';
import { Heatmap } from '../Heatmap';
import { ChevronIcon } from '../icons';
import {
  CAUSE_LABEL,
  candidatePlaces,
  compareCell,
  headToHead,
  histogramHeights,
  howOut,
  isProvisional,
  leadInTick,
  statLines,
  winRows,
} from '../reports';
import { configFromReport } from '../setup';
import { copyAndToast, toast } from '../toast';
import type { BatchOutcome } from './GymScreen';
import { mapNames } from './options';

/** Rows shown in the match list before "Show all". */
const MATCH_ROWS = 25;
/** Opponent rows per strategy card (worst matchups first). */
const OPPONENT_ROWS = 6;

type Props = {
  outcome: BatchOutcome;
  onWatch: (req: WatchRequest) => void;
  /** Bring a match row back into view (returning from the arena); `n` changes per request. */
  focus: { matchIndex: number | null; n: number } | null;
};

export function ReportView({ outcome, onWatch, focus }: Props) {
  const { aggregate, reports } = outcome.result;
  const [allMatches, setAllMatches] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [flash, setFlash] = useState<number | null>(null);
  const rows = useRef(new Map<number, HTMLTableRowElement>());
  const candidateKeys = new Set(outcome.candidateKeys);
  const byKey = new Map(aggregate.strategies.map((s) => [s.key, s]));
  const nameOfKey = (key: string) => {
    const s = byKey.get(key);
    return s ? strategyLabel(s.name, s.version) : keyLabel(key);
  };
  const tested = aggregate.strategies.filter((s) => candidateKeys.has(s.key));
  const shown = allMatches ? reports : reports.slice(0, MATCH_ROWS);

  /** Open match `index` in the arena, optionally at a tick and with a fighter picked; "Back to the report" returns here. */
  const watch = (index: number, tick = 0, focusId: string | null = null) => {
    const report = reports[index];
    if (!report) return;
    const config = configFromReport(report, outcome.strategies);
    if (!config) {
      toast('One of the strategies in this match is gone, so it cannot be replayed.');
      return;
    }
    onWatch({ config, tick, focusId, origin: { label: `Test report, match ${index + 1} of ${reports.length}`, tab: 'test', matchIndex: index } });
  };

  // Back from the arena: open that match's row, scroll to it and flash it once.
  const handled = useRef(0);
  useEffect(() => {
    if (!focus || focus.n === handled.current) return;
    handled.current = focus.n;
    const i = focus.matchIndex;
    if (i === null || i < 0 || i >= reports.length) return;
    if (i >= MATCH_ROWS) setAllMatches(true);
    setOpen(i);
    setFlash(i);
    const t = window.setTimeout(() => rows.current.get(i)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 30);
    const t2 = window.setTimeout(() => setFlash(null), 1600);
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(t2);
    };
  }, [focus, reports.length]);

  return (
    <section className="report" aria-label="Batch report">
      <div className="report-head">
        <h2>
          {aggregate.matches} {aggregate.matches === 1 ? 'match' : 'matches'} on {mapNames(aggregate.mapIds)}
        </h2>
        <span className="faint num">seed {aggregate.seed}</span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={() => copyAndToast(reportToText(aggregate), 'Report')}>
          Copy report for LLM
        </button>
      </div>
      <p className="report-endings dim">{endingsLine(aggregate)}</p>

      {aggregate.findings.length ? (
        <ul className="findings">
          {aggregate.findings.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      ) : null}

      <table className="table standings">
        <thead>
          <tr>
            <th className="rank">#</th>
            <th>Strategy</th>
            <th className="r" title="1000 + 40 x (mu - 3 sigma). Rises as the rating settles.">
              Rating
            </th>
            <th className="r">Wins</th>
            <th className="r">Avg place</th>
            <th className="r">Kills</th>
            <th className="r">Damage</th>
            <th className="r">Survived</th>
          </tr>
        </thead>
        <tbody>
          {aggregate.strategies.map((s, i) => (
            <tr key={s.key} className={candidateKeys.has(s.key) ? 'mine' : undefined}>
              <td className="rank">{i + 1}</td>
              <td>{strategyLabel(s.name, s.version)}</td>
              <td className="num">
                {displayRating(s.rating)}
                {isProvisional(s.rating) ? <span className="faint" title="Still settling: few rated matches."> ?</span> : null}
              </td>
              <td className="num">{formatPercent(s.winRate)}</td>
              <td className="num">{s.avgPlace.toFixed(1)}</td>
              <td className="num">{s.avgKills.toFixed(1)}</td>
              <td className="num">{Math.round(s.avgDamageDealt)}</td>
              <td className="num">{formatClock(s.avgSurvivalTicks)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {tested.map((s) => (
        <AggregateCard key={s.key} agg={s} nameOfKey={nameOfKey} picks={pickMatches(reports, s.key, { mapName: (id) => MAPS[id]?.name ?? id })} onWatch={watch} />
      ))}

      {aggregate.strategies.length >= 2 ? <Compare aggregate={aggregate} reports={reports} tested={tested} /> : null}

      <div className="report-head" style={{ marginTop: 22 }}>
        <h2>Matches</h2>
        <span className="dim">Watch any of them in the arena, same seed, same fight. Open a row for every fighter's numbers and kills.</span>
      </div>
      <table className="table matches">
        <thead>
          <tr>
            <th className="rank">#</th>
            <th>Map</th>
            <th>Winner</th>
            <th>Tested</th>
            <th className="r">Length</th>
            <th className="r">Seed</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => {
            const winnerId = r.placements[0];
            const winner = r.roster.find((x) => x.fighterId === winnerId);
            const places = candidatePlaces(r, candidateKeys);
            const expanded = open === i;
            return (
              <Fragment key={`${r.seed}:${i}`}>
                <tr
                  ref={(el) => {
                    if (el) rows.current.set(i, el);
                    else rows.current.delete(i);
                  }}
                  className={`match-row${expanded ? ' open' : ''}${flash === i ? ' flash' : ''}`}
                  onClick={() => setOpen(expanded ? null : i)}
                >
                  <td className="rank">{i + 1}</td>
                  <td>{MAPS[r.mapId]?.name ?? r.mapId}</td>
                  <td>
                    {winner ? (
                      <>
                        <span className="swatch" style={{ background: winner.color }} /> {winner.name}
                      </>
                    ) : (
                      <span className="faint">nobody</span>
                    )}
                    {r.ending === 'judges' ? <span className="chip" title="Decided by the judges at the hard cap"> judges</span> : null}
                  </td>
                  <td className="dim">{places.map((p) => `${formatPlace(p.place)} ${p.name}`).join(', ') || '-'}</td>
                  <td className="num">{formatClock(r.ticks)}</td>
                  <td className="num faint">{r.seed}</td>
                  <td className="r">
                    <span className="inline">
                      <button
                        type="button"
                        className="btn btn-sm btn-quiet"
                        onClick={(e) => {
                          e.stopPropagation();
                          watch(i);
                        }}
                      >
                        Watch
                      </button>
                      <span className="row-chevron" aria-hidden>
                        <ChevronIcon dir={expanded ? 'up' : 'down'} size={12} />
                      </span>
                    </span>
                  </td>
                </tr>
                {expanded ? (
                  <tr className="match-detail">
                    <td colSpan={7}>
                      <MatchDetail report={r} index={i} candidateKeys={candidateKeys} onWatch={watch} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {reports.length > MATCH_ROWS && !allMatches ? (
        <button type="button" className="btn btn-sm btn-quiet" style={{ marginTop: 8 }} onClick={() => setAllMatches(true)}>
          Show all {reports.length} matches
        </button>
      ) : null}
    </section>
  );
}

/** Who "got" a fighter when no fighter gets the credit. */
const NOBODY_KILLER: Record<KillCause, string> = {
  weapon: 'Someone',
  skill: 'Someone',
  hazard: 'The arena',
  keg: 'A keg',
  friendly: 'A teammate',
  sudden_death: 'The wall',
};

const ENDING_WORDS: Record<MatchEnding, string> = { elimination: 'by elimination', judges: 'by the judges', time: 'at the bell', capped: 'by the safety cap' };
const REASON_WORDS: Record<SuddenDeathReason, string> = { time: 'time', stalemate: 'stalemate' };

/** "17 ended by elimination, 3 by the judges. Sudden death in 12 of 20 (9 time, 3 stalemate), on average at 1:31." */
function endingsLine(a: AggregateReport): string {
  const endings = (Object.entries(a.endings) as [MatchEnding, number][]).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]);
  const first = endings.map(([e, n], i) => `${n} ${i === 0 ? 'ended ' : ''}${ENDING_WORDS[e]}`).join(', ');
  const sd = a.suddenDeath;
  if (!sd || sd.matches === 0) return `${first || 'No endings recorded'}. Sudden death never started.`;
  const reasons = (Object.entries(sd.byReason) as [SuddenDeathReason, number][]).filter(([, n]) => n > 0).map(([r, n]) => `${n} ${REASON_WORDS[r]}`).join(', ');
  const when = sd.avgStartTick !== null ? `, on average at ${formatClock(sd.avgStartTick)}` : '';
  return `${first}. Sudden death in ${sd.matches} of ${a.matches}${reasons ? ` (${reasons})` : ''}${when}.`;
}

function AggregateCard(props: {
  agg: StrategyAggregate;
  nameOfKey: (key: string) => string;
  picks: MatchPicks;
  onWatch: (index: number, tick?: number, focusId?: string | null) => void;
}) {
  const { agg, nameOfKey, picks, onWatch } = props;
  const heights = histogramHeights(agg.placementHistogram);
  const maps = winRows(agg.byMap);
  const opponents = winRows(agg.byOpponent).slice(0, OPPONENT_ROWS);
  const causes = (Object.entries(agg.deathsByCause) as [KillCause, number][]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const deaths = causes.reduce((n, [, c]) => n + c, 0);
  const heatmaps = Object.entries(agg.heatmaps ?? {}).filter(([, h]) => h.total > 0);
  // Each pick opens a little before its moment (the death, the last kill), with the fighter picked.
  const watchPick = (p: MatchPick | null) => p && onWatch(p.reportIndex, p.focusTick === null ? 0 : leadInTick(p.focusTick), p.fighterId);
  const pickNote = (p: MatchPick | null, what: string) => (p ? `${what}, match ${p.reportIndex + 1}: ${p.summary}` : `No ${what.toLowerCase()} in this batch.`);
  return (
    <article className="agg">
      <div className="agg-head">
        <div className="agg-name">
          {agg.name} <span className="dim">v{agg.version}</span>
        </div>
        <span className="spacer" />
        <Stat label={isProvisional(agg.rating) ? 'rating, settling' : 'rating'} value={String(displayRating(agg.rating))} />
        <Stat label="won" value={formatPercent(agg.winRate)} />
        <Stat label="avg place" value={agg.avgPlace.toFixed(1)} />
        <Stat label="kills per match" value={agg.avgKills.toFixed(1)} />
        <Stat label="alive for" value={`${Math.round(agg.avgSurvivalTicks / TICK_HZ)} s`} />
      </div>
      <div className="agg-watch">
        <span className="dim">Watch why</span>
        <button type="button" className="btn btn-sm" disabled={!picks.worstLoss} title={pickNote(picks.worstLoss, 'Worst loss')} onClick={() => watchPick(picks.worstLoss)}>
          Worst loss{picks.worstLoss ? <span className="faint num"> {formatPlace(picks.worstLoss.place)}</span> : null}
        </button>
        <button type="button" className="btn btn-sm" disabled={!picks.bestWin} title={pickNote(picks.bestWin, 'Best win')} onClick={() => watchPick(picks.bestWin)}>
          Best win
        </button>
        <button type="button" className="btn btn-sm" disabled={!picks.typical} title={pickNote(picks.typical, 'Typical match')} onClick={() => watchPick(picks.typical)}>
          A typical match{picks.typical ? <span className="faint num"> {formatPlace(picks.typical.place)}</span> : null}
        </button>
        <span className="faint">The timeline opens filtered to {agg.name}.</span>
      </div>
      <div className="agg-body">
        <div className="agg-cell">
          <h3>Placements over {agg.matches} matches</h3>
          <div className="histo" role="img" aria-label={agg.placementHistogram.map((n, i) => `${formatPlace(i + 1)}: ${n}`).join(', ')}>
            {agg.placementHistogram.map((n, i) => (
              <div key={i} className={`histo-col${i === 0 ? ' first' : ''}`} title={`${formatPlace(i + 1)}: ${n}`}>
                <div style={{ height: `${heights[i] * 100}%` }} />
                <span>{i + 1}</span>
              </div>
            ))}
          </div>
          <p className="side-note">{endingNote(agg)}</p>
        </div>
        <div className="agg-cell">
          <h3>Wins by map</h3>
          <div className="barlist">
            {maps.map((m) => (
              <WinBar key={m.key} label={MAPS[m.key]?.name ?? m.key} wins={m.wins} matches={m.matches} rate={m.rate} losing={false} />
            ))}
          </div>
        </div>
        <div className="agg-cell">
          <h3>Finished ahead of, worst first</h3>
          <div className="barlist">
            {opponents.length === 0 ? <span className="faint">No opponents recorded.</span> : null}
            {opponents.map((o) => (
              <WinBar key={o.key} label={nameOfKey(o.key)} wins={o.wins} matches={o.matches} rate={o.rate} losing={o.rate < LOSING_RATE} />
            ))}
          </div>
        </div>
        <div className="agg-cell">
          <h3>How it died</h3>
          {deaths === 0 ? <span className="faint">Never died. Rude.</span> : null}
          <div className="barlist">
            {causes.map(([cause, n]) => (
              <div key={cause} className="barrow">
                <span>{CAUSE_LABEL[cause]}</span>
                <span className="minibar">
                  <div style={{ width: `${(n / deaths) * 100}%` }} />
                </span>
                <span className="num">{n}</span>
              </div>
            ))}
          </div>
          {agg.killedMostBy ? (
            <p className="side-note">
              Killed most by <b>{nameOfKey(agg.killedMostBy.key)}</b>, {agg.killedMostBy.count} {agg.killedMostBy.count === 1 ? 'time' : 'times'}.
            </p>
          ) : null}
        </div>
        <div className="agg-cell wide">
          <h3>Per appearance, on average</h3>
          <StatGrid lines={statLines(agg.stats)} />
        </div>
        {heatmaps.length ? (
          <div className="agg-cell wide">
            <h3>Where it spent its time</h3>
            <div className="heatmaps">
              {heatmaps.map(([mapId, h]) => (
                <Heatmap key={mapId} heatmap={h} mapId={mapId} title={MAPS[mapId]?.name ?? mapId} />
              ))}
            </div>
          </div>
        ) : null}
        {agg.findings.length ? (
          <div className="agg-cell wide">
            <h3>Findings</h3>
            <ul className="agg-findings">
              {agg.findings.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </article>
  );
}

/** "Reached sudden death in 40% of its matches; the judges decided 2 of them (won 1)." */
function endingNote(agg: StrategyAggregate): string {
  const sd = agg.suddenDeath;
  const parts: string[] = [];
  parts.push(sd && sd.matches > 0 ? `Reached sudden death in ${formatPercent(sd.share)} of its matches` : 'Never reached sudden death');
  if (agg.judges && agg.judges.matches > 0) parts.push(`the judges decided ${agg.judges.matches} (won ${agg.judges.wins})`);
  return `${parts.join('; ')}.`;
}

function StatGrid({ lines }: { lines: ReturnType<typeof statLines> }) {
  return (
    <dl className="stat-grid">
      {lines.map((l) => (
        <div key={l.label} title={l.hint}>
          <dt>{l.label}</dt>
          <dd className="num">{l.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Two strategies of the batch side by side: same seeds, the numbers above and their heatmaps. */
function Compare({ aggregate, reports, tested }: { aggregate: AggregateReport; reports: readonly MatchReport[]; tested: StrategyAggregate[] }) {
  const all = aggregate.strategies;
  const [aKey, setA] = useState(() => (tested[0] ?? all[0])!.key);
  const [bKey, setB] = useState(() => (tested[1] ?? all.find((s) => s.key !== (tested[0] ?? all[0])!.key) ?? all[1])!.key);
  const a = all.find((s) => s.key === aKey) ?? all[0]!;
  const b = all.find((s) => s.key === bKey) ?? all[1]!;
  const rows = compareRows(a, b);
  const h2h = headToHead(reports, a.key, b.key);
  const maps = Object.keys(a.heatmaps ?? {}).filter((m) => (a.heatmaps[m]?.total ?? 0) > 0 && (b.heatmaps?.[m]?.total ?? 0) > 0);
  const label = (s: StrategyAggregate) => strategyLabel(s.name, s.version);
  return (
    <article className="agg compare">
      <div className="agg-head">
        <div className="agg-name">Compare</div>
        <select className="select" value={aKey} onChange={(e) => setA(e.target.value)} aria-label="First strategy">
          {all.map((s) => (
            <option key={s.key} value={s.key}>
              {label(s)}
            </option>
          ))}
        </select>
        <span className="dim">with</span>
        <select className="select" value={bKey} onChange={(e) => setB(e.target.value)} aria-label="Second strategy">
          {all.map((s) => (
            <option key={s.key} value={s.key}>
              {label(s)}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <span className="dim">
          {a.key === b.key
            ? 'Pick two different strategies.'
            : h2h.shared === 0
              ? 'They never met in this batch.'
              : `Same seeds: met in ${h2h.shared} ${h2h.shared === 1 ? 'match' : 'matches'}; ${label(a)} finished ahead ${h2h.aAhead}, ${label(b)} ${h2h.bAhead}.`}
        </span>
      </div>
      <p className="compare-hint faint">
        {tested.length < 2 ? 'Test two strategies (or two versions) together and every match seats both. ' : 'These two shared their matches and fought each other. '}
        For a clean head-to-head on the same seeds where they never meet, use Compare two above.
      </p>
      <table className="table compare-table">
        <thead>
          <tr>
            <th />
            <th className="r">{label(a)}</th>
            <th className="r">{label(b)}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td className={`num${r.better === 'a' ? ' better' : ''}`}>{compareCell(r.a, r.unit)}</td>
              <td className={`num${r.better === 'b' ? ' better' : ''}`}>{compareCell(r.b, r.unit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {maps.length ? (
        <div className="compare-maps">
          {maps.map((m) => (
            <div key={m} className="compare-pair">
              <h3>{MAPS[m]?.name ?? m}</h3>
              <div className="heatmaps">
                <Heatmap heatmap={a.heatmaps[m]!} mapId={m} width={220} title={label(a)} />
                <Heatmap heatmap={b.heatmaps[m]!} mapId={m} width={220} title={label(b)} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

/** Every fighter of one match with its numbers and how it went out; every kill with Watch. */
function MatchDetail(props: { report: MatchReport; index: number; candidateKeys: ReadonlySet<string>; onWatch: (index: number, tick?: number, focusId?: string | null) => void }) {
  const { report, index, candidateKeys, onWatch } = props;
  const roster = new Map(report.roster.map((r) => [r.fighterId, r]));
  const nameOf = (id: string) => roster.get(id)?.name ?? 'someone';
  const ordered = report.placements.map((id) => report.fighters.find((f) => f.fighterId === id)).filter((f): f is NonNullable<typeof f> => !!f);
  const mine = ordered.filter((f) => candidateKeys.has(roster.get(f.fighterId)?.strategyKey ?? ''));
  return (
    <div className="match-detail-body">
      <table className="table fighters-table">
        <thead>
          <tr>
            <th className="rank">#</th>
            <th>Fighter</th>
            <th className="r">Kills</th>
            <th className="r" title="Damage dealt / taken">
              Damage
            </th>
            <th className="r">Accuracy</th>
            <th className="r" title="px moved while alive">
              Moved
            </th>
            <th className="r" title="Time spent fighting someone">
              Engaged
            </th>
            <th>How it ended</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {ordered.map((f) => {
            const r = roster.get(f.fighterId);
            const died = f.diedAtTick;
            const how = died === null ? 'survived' : `${f.death?.title ? `${f.death.title}, ` : ''}${howOut(f.fighterId, report.kills, nameOf) || 'out'} at ${formatClock(died)}`;
            return (
              <tr key={f.fighterId} className={candidateKeys.has(r?.strategyKey ?? '') ? 'mine' : undefined}>
                <td className="rank">{f.place}</td>
                <td>
                  <span className="swatch" style={{ background: r?.color }} /> {r?.name ?? f.fighterId}
                  <span className="faint"> {r ? weaponName(r.weapon) : ''}</span>
                </td>
                <td className="num">{f.kills}</td>
                <td className="num">
                  {Math.round(f.damageDealt)}
                  <span className="faint"> / {Math.round(f.damageTaken)}</span>
                </td>
                <td className="num">{f.attacks > 0 ? formatPercent(f.stats?.accuracy ?? f.hitsLanded / f.attacks) : '-'}</td>
                <td className="num">{Math.round(f.stats?.distanceTravelled ?? 0).toLocaleString('en-US')}</td>
                <td className="num">{((f.stats?.ticksEngaged ?? 0) / TICK_HZ).toFixed(0)} s</td>
                <td className="dim how-cell">{how}</td>
                <td className="r">
                  <button
                    type="button"
                    className="btn btn-sm btn-quiet"
                    title={died === null ? `Watch with ${r?.name} picked` : `Watch ${r?.name} go out, from a few seconds before`}
                    onClick={() => onWatch(index, died === null ? 0 : leadInTick(died), f.fighterId)}
                  >
                    {died === null ? 'Watch' : 'Its death'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="detail-cols">
        <div>
          <h3>Kills</h3>
          {report.kills.length === 0 ? <p className="faint">Nobody died. The judges are furious.</p> : null}
          <ol className="kill-list">
            {[...report.kills]
              .sort((x, y) => x.tick - y.tick)
              .map((k, i) => {
                const killer = k.killerId ? roster.get(k.killerId) : undefined;
                const victim = roster.get(k.victimId);
                return (
                  <li key={i}>
                    <span className="num faint">{formatClock(k.tick)}</span>
                    <span>
                      {killer ? <b style={{ color: killer.color }}>{killer.name}</b> : <span className="dim">{NOBODY_KILLER[k.cause]}</span>}
                      <span className="faint"> {killer && k.killerId === k.victimId ? 'own goal' : 'got'} </span>
                      <b style={{ color: victim?.color }}>{victim?.name ?? k.victimId}</b>
                      {k.flags.length ? <span className="faint"> ({k.flags.join(', ')})</span> : null}
                    </span>
                    <button type="button" className="btn btn-sm btn-quiet" onClick={() => onWatch(index, leadInTick(k.tick), k.victimId)} title="Watch this kill, from a few seconds before">
                      Watch
                    </button>
                  </li>
                );
              })}
          </ol>
        </div>
        {mine.length ? (
          <div>
            <h3>Where yours went</h3>
            <div className="heatmaps">
              {mine.map((f) => (
                <Heatmap key={f.fighterId} heatmap={f.heatmap} mapId={report.mapId} width={220} title={roster.get(f.fighterId)?.name} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {report.findings.length ? (
        <ul className="agg-findings detail-findings">
          {report.findings.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

/**
 * Head-to-head below this rate turns red: the strategy finishes behind that opponent more often
 * than not. Map win rates are not flagged; in an 8-way free-for-all a fair share of wins is 1 in 8.
 */
const LOSING_RATE = 0.5;

function WinBar({ label, wins, matches, rate, losing }: { label: string; wins: number; matches: number; rate: number; losing: boolean }) {
  return (
    <div className="barrow" title={`${label}: ${wins} of ${matches}`}>
      <span>{label}</span>
      <span className={`minibar${losing ? ' bad' : ''}`}>
        <div style={{ width: `${rate * 100}%` }} />
      </span>
      <span className="num">
        {wins}/{matches}
      </span>
    </div>
  );
}
