// Owned by: ui
import { useEffect, useRef } from 'react';
import type { GameController, MatchReport, UiFighter, UiSnapshot } from '../../core';
import { reportToText } from '../../gym';
import { buildLine, formatClock, formatPlace, squadLetter } from '../format';
import { usePolled } from '../hooks';
import { CloseIcon } from '../icons';
import { howOut, inSentence } from '../reports';
import { copyAndToast } from '../toast';

type Props = {
  controller: GameController;
  snap: UiSnapshot;
  mapName: string;
  onNextMatch: () => void;
  onClose: () => void;
};

/** End-of-match card: who won, how, and what to do next. */
export function EndCard({ controller, snap, mapName, onNextMatch, onClose }: Props) {
  const report = usePolled<MatchReport | null>(controller, () => controller.lastReport(), []);
  const nextBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => nextBtn.current?.focus(), []);

  const byId = new Map(snap.fighters.map((f) => [f.id, f]));
  const nameOf = (id: string) => byId.get(id)?.name ?? report?.roster.find((r) => r.fighterId === id)?.name ?? 'someone';
  const order: UiFighter[] = (snap.placements.length ? snap.placements : [...snap.fighters].sort((a, b) => (a.place ?? 99) - (b.place ?? 99)).map((f) => f.id))
    .map((id) => byId.get(id))
    .filter((f): f is UiFighter => !!f);
  const winner = order[0] ?? null;
  const squads = snap.format === 'squads';
  const winnerReport = winner ? report?.fighters.find((r) => r.fighterId === winner.id) : undefined;
  const winningSquad = winner && squads ? order.filter((f) => f.squad === winner.squad) : [];

  const title = !winner
    ? `Nobody leaves ${inSentence(mapName)}.`
    : squads
      ? `Squad ${squadLetter(winner.squad)} takes ${inSentence(mapName)}.`
      : `${winner.name} takes ${inSentence(mapName)}.`;

  const kills = squads ? winningSquad.reduce((n, f) => n + f.kills, 0) : (winner?.kills ?? 0);
  const findings = report?.findings.slice(0, 3) ?? [];

  return (
    <div
      className="endcard-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section className="endcard" role="dialog" aria-label="Match result">
        <div className="ec-top">
          <div className="ec-band" style={{ background: winner?.color ?? 'var(--stone-4)' }} />
          <button
            type="button"
            className="btn btn-sm btn-icon btn-quiet"
            style={{ position: 'absolute', top: 12, right: 12 }}
            onClick={onClose}
            title="Close and look around (Esc)"
          >
            <CloseIcon />
          </button>
          <h2 className="ec-title" style={{ color: winner?.color }}>
            {title}
          </h2>
          {winner ? (
            <div className="ec-sub">
              {squads ? winningSquad.map((f) => f.name).join(', ') : buildLine(winner.weapon, winner.skill)}
            </div>
          ) : null}
          <div className="ec-stats">
            <div className="ec-stat">
              <b>{kills}</b>
              <span>{kills === 1 ? 'kill' : 'kills'}</span>
            </div>
            {winnerReport && !squads ? (
              <div className="ec-stat">
                <b>{Math.round(winnerReport.damageDealt)}</b>
                <span>damage dealt</span>
              </div>
            ) : null}
            {winner && winner.alive ? (
              <div className="ec-stat">
                <b>{Math.ceil(winner.hp)}</b>
                <span>HP left</span>
              </div>
            ) : null}
            <div className="ec-stat">
              <b>{formatClock(report?.ticks ?? snap.maxTick)}</b>
              <span>match time</span>
            </div>
          </div>
        </div>

        {findings.length ? (
          <ul className="ec-findings">
            {findings.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}

        <div className="ec-places">
          {order.map((f, i) => (
            <div className="ec-place" key={f.id}>
              <span className="num">{formatPlace(i + 1)}</span>
              <span className="swatch" style={{ background: f.color }} />
              <span>
                {f.name}
                {f.kills > 0 ? <span className="faint"> {f.kills} {f.kills === 1 ? 'kill' : 'kills'}</span> : null}
              </span>
              <span className="how">{i === 0 ? (f.alive ? 'last one standing' : '') : report ? howOut(f.id, report.kills, nameOf) : ''}</span>
            </div>
          ))}
        </div>

        <div className="ec-actions">
          <button ref={nextBtn} type="button" className="btn btn-primary" onClick={onNextMatch}>
            Next match
          </button>
          <button type="button" className="btn" onClick={() => controller.restart()}>
            Watch again
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="btn"
            disabled={!report}
            title={report ? 'Battle report as text plus JSON, ready to paste into an LLM' : 'The report is still being written.'}
            onClick={() => report && copyAndToast(reportToText(report), 'Report')}
          >
            Copy report for LLM
          </button>
        </div>
      </section>
    </div>
  );
}
