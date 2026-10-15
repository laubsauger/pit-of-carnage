// Owned by: ui
import { useState } from 'react';
import { TICK_HZ, displayRating } from '../../core';
import type { KillCause, MatchConfig, StrategyAggregate } from '../../core';
import { reportToText } from '../../gym';
import { MAPS } from '../../sim';
import { formatClock, formatPercent, formatPlace, keyLabel, strategyLabel } from '../format';
import { CAUSE_LABEL, candidatePlaces, histogramHeights, isProvisional, winRows } from '../reports';
import { configFromReport } from '../setup';
import { copyAndToast, toast } from '../toast';
import type { BatchOutcome } from './GymScreen';
import { mapNames } from './options';

/** Rows shown in the match list before "Show all". */
const MATCH_ROWS = 25;
/** Opponent rows per strategy card (worst matchups first). */
const OPPONENT_ROWS = 6;

export function ReportView({ outcome, onWatch }: { outcome: BatchOutcome; onWatch: (config: MatchConfig) => void }) {
  const { aggregate, reports } = outcome.result;
  const [allMatches, setAllMatches] = useState(false);
  const candidateKeys = new Set(outcome.candidateKeys);
  const byKey = new Map(aggregate.strategies.map((s) => [s.key, s]));
  const nameOfKey = (key: string) => {
    const s = byKey.get(key);
    return s ? strategyLabel(s.name, s.version) : keyLabel(key);
  };
  const tested = aggregate.strategies.filter((s) => candidateKeys.has(s.key));
  const shown = allMatches ? reports : reports.slice(0, MATCH_ROWS);

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
        <AggregateCard key={s.key} agg={s} nameOfKey={nameOfKey} />
      ))}

      <div className="report-head" style={{ marginTop: 22 }}>
        <h2>Matches</h2>
        <span className="dim">Watch any of them in the arena, same seed, same fight.</span>
      </div>
      <table className="table">
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
            return (
              <tr key={`${r.seed}:${i}`}>
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
                </td>
                <td className="dim">{places.map((p) => `${formatPlace(p.place)} ${p.name}`).join(', ') || '-'}</td>
                <td className="num">{formatClock(r.ticks)}</td>
                <td className="num faint">{r.seed}</td>
                <td className="r">
                  <button
                    type="button"
                    className="btn btn-sm btn-quiet"
                    onClick={() => {
                      const config = configFromReport(r, outcome.strategies);
                      if (config) onWatch(config);
                      else toast('One of the strategies in this match is gone, so it cannot be replayed.');
                    }}
                  >
                    Watch
                  </button>
                </td>
              </tr>
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

function AggregateCard({ agg, nameOfKey }: { agg: StrategyAggregate; nameOfKey: (key: string) => string }) {
  const heights = histogramHeights(agg.placementHistogram);
  const maps = winRows(agg.byMap);
  const opponents = winRows(agg.byOpponent).slice(0, OPPONENT_ROWS);
  const causes = (Object.entries(agg.deathsByCause) as [KillCause, number][]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const deaths = causes.reduce((n, [, c]) => n + c, 0);
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
