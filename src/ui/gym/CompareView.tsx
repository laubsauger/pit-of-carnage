// Owned by: ui
// A paired comparison from the gym: both strategies played the same seeds, maps, opponents and
// seat without meeting, so the gap is the strategies' and not the draw's. Numbers side by side,
// both heatmaps per map, and every shared seed watchable from either side.
import { strategyKey } from '../../core';
import type { MatchReport, Strategy } from '../../core';
import { compareToText } from '../../gym';
import type { CompareRequest, CompareResult } from '../../gym';
import { MAPS } from '../../sim';
import type { WatchRequest } from '../App';
import { formatPlace, strategyLabel } from '../format';
import { Heatmap } from '../Heatmap';
import { compareCell } from '../reports';
import { configFromReport } from '../setup';
import { copyAndToast, toast } from '../toast';

export type CompareOutcome = { request: CompareRequest; result: CompareResult };

export function CompareView({ outcome, onWatch }: { outcome: CompareOutcome; onWatch: (req: WatchRequest) => void }) {
  const { request, result } = outcome;
  const nameA = strategyLabel(request.a.name, request.a.version);
  const nameB = strategyLabel(request.b.name, request.b.version);
  const maps = [...new Set(result.matches.map((m) => m.mapId))];
  const strategies: Strategy[] = [request.a, request.b, ...request.field];

  const watch = (report: MatchReport | undefined, side: Strategy, i: number) => {
    if (!report) return;
    const config = configFromReport(report, strategies);
    if (!config) {
      toast('One of the strategies in this match is gone, so it cannot be replayed.');
      return;
    }
    const seat = report.roster.find((r) => r.strategyKey === strategyKey(side));
    const label = side === request.a ? nameA : nameB;
    onWatch({ config, focusId: seat?.fighterId ?? null, origin: { label: `Compare, seed ${i + 1} of ${result.matches.length} (${label})`, tab: 'test', matchIndex: null } });
  };

  return (
    <section className="report compare-run" aria-label="Comparison">
      <div className="report-head">
        <h2>
          {nameA} <span className="dim">vs</span> {nameB}
        </h2>
        <span className="faint">
          {result.matches.length} shared seeds on {maps.map((m) => MAPS[m]?.name ?? m).join(', ')}
        </span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={() => copyAndToast(compareToText(result), 'Comparison')}>
          Copy comparison for LLM
        </button>
      </div>
      <p className="report-endings dim">Both played the same seeds, maps, opponents and seat; they never met.</p>

      <div className="compare-score">
        <div className="cs-side">
          <b className="num">{result.aAhead}</b>
          <span>{nameA} ahead</span>
        </div>
        <div className="cs-bar" role="img" aria-label={`${result.aAhead} ahead, ${result.level} level, ${result.bAhead} behind`}>
          <i className="a" style={{ flexGrow: result.aAhead }} />
          <i className="level" style={{ flexGrow: result.level }} />
          <i className="b" style={{ flexGrow: result.bAhead }} />
        </div>
        <div className="cs-side right">
          <b className="num">{result.bAhead}</b>
          <span>{nameB} ahead</span>
        </div>
      </div>

      {result.findings.length ? (
        <ul className="findings">
          {result.findings.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      ) : null}

      <table className="table compare-table">
        <thead>
          <tr>
            <th />
            <th className="r">{nameA}</th>
            <th className="r">{nameB}</th>
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td className={`num${r.better === 'a' ? ' better' : ''}`}>{compareCell(r.a, r.unit)}</td>
              <td className={`num${r.better === 'b' ? ' better' : ''}`}>{compareCell(r.b, r.unit)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {maps.some((m) => (result.a.heatmaps[m]?.total ?? 0) > 0 || (result.b.heatmaps[m]?.total ?? 0) > 0) ? (
        <div className="compare-maps">
          {maps.map((m) => (
            <div key={m} className="compare-pair">
              <h3>{MAPS[m]?.name ?? m}</h3>
              <div className="heatmaps">
                {result.a.heatmaps[m] ? <Heatmap heatmap={result.a.heatmaps[m]!} mapId={m} width={220} title={nameA} /> : null}
                {result.b.heatmaps[m] ? <Heatmap heatmap={result.b.heatmaps[m]!} mapId={m} width={220} title={nameB} /> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="report-head" style={{ marginTop: 22 }}>
        <h2>Seed by seed</h2>
        <span className="dim">Watch either side of any seed: same opponents, same seat.</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th className="rank">#</th>
            <th>Map</th>
            <th className="r">Seed</th>
            <th className="r">{nameA}</th>
            <th className="r">{nameB}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {result.matches.map((m, i) => (
            <tr key={`${m.seed}:${i}`}>
              <td className="rank">{i + 1}</td>
              <td>{MAPS[m.mapId]?.name ?? m.mapId}</td>
              <td className="num faint">{m.seed}</td>
              <td className={`num${m.placeA < m.placeB ? ' better-text' : ''}`}>{formatPlace(m.placeA)}</td>
              <td className={`num${m.placeB < m.placeA ? ' better-text' : ''}`}>{formatPlace(m.placeB)}</td>
              <td className="r">
                <span className="inline">
                  <button type="button" className="btn btn-sm btn-quiet" onClick={() => watch(result.reportsA[i], request.a, i)} title={`Watch ${nameA} on this seed`}>
                    Watch A
                  </button>
                  <button type="button" className="btn btn-sm btn-quiet" onClick={() => watch(result.reportsB[i], request.b, i)} title={`Watch ${nameB} on this seed`}>
                    Watch B
                  </button>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
