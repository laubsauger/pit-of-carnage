// Owned by: ui
import { forwardRef } from 'react';
import type { GameController, MatchReport, UiFighter, UiSnapshot } from '../../core';
import { reportToText } from '../../gym';
import { BRAND_URL } from '../brand';
import { formatClock, formatPlace, squadLetter } from '../format';
import { usePolled } from '../hooks';
import { CloseIcon } from '../icons';
import { lineupSummary, pinnedCount } from '../lineup';
import { howOut, inSentence } from '../reports';
import { copyAndToast } from '../toast';
import { BuildLinks } from '../widgets';

type Props = {
  controller: GameController;
  snap: UiSnapshot;
  mapName: string;
  /** Same lineup, new seed. */
  onNextMatch: () => void;
  /** Keep the pinned fighters, redraw the rest, play. */
  onShuffle: () => void;
  /** Open Quick matchup with this lineup. */
  onMatchup: () => void;
  onClose: () => void;
  /** Open a fighter's strategy sheet: this match's overview plus the strategy itself. */
  onSheet: (id: string) => void;
};

/**
 * End-of-match card. It slides in from the right edge instead of covering the middle, and the
 * arena framing makes room for it (view insets), so the kill spot and the winner stay in view.
 */
export const EndCard = forwardRef<HTMLElement, Props>(function EndCard({ controller, snap, mapName, onNextMatch, onShuffle, onMatchup, onClose, onSheet }, ref) {
  const report = usePolled<MatchReport | null>(controller, () => controller.lastReport(), []);
  // A room's match has no report of its own here: the host's text arrives with the stream.
  const roomText = usePolled<string | null>(controller, () => (snap.source === 'room' ? controller.lastReportText() : null), [snap.source]);
  const lineup = usePolled(controller, () => controller.getLineup(), []);
  const local = snap.source === 'local';
  const field = lineup.fighters.length - pinnedCount(lineup);

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
    <section ref={ref} className="hud-panel endcard" role="dialog" aria-label="Match result">
      <div className="ec-top">
        <div className="ec-band" style={{ background: winner?.color ?? 'var(--stone-4)' }} />
        <div className="ec-kicker-row">
          <div className="ec-kicker">{report?.ending === 'judges' ? "The judges' decision" : 'Final'}</div>
          <img className="ec-wordmark" src={`${BRAND_URL}wordmark.webp`} alt="" draggable={false} />
          <button type="button" className="btn btn-sm btn-icon btn-quiet" onClick={onClose} title="Close and look around (Esc)" aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <h2 className="ec-title" style={{ color: winner?.color }}>
          {title}
        </h2>
        {winner ? (
          <div className="ec-sub">
            {squads ? winningSquad.map((f) => f.name).join(', ') : <BuildLinks weapon={winner.weapon} skill={winner.skill} />}
            {!squads ? (
              <button type="button" className="linkish ec-sheet" onClick={() => onSheet(winner.id)}>
                Strategy sheet
              </button>
            ) : null}
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

      <div className="ec-scroll">
        {findings.length ? (
          <ul className="ec-findings">
            {findings.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}

        <div className="ec-places" onPointerLeave={() => controller.hover(null)}>
          {order.map((f, i) => (
            <button
              type="button"
              className={`ec-place${i === 0 ? ' winner' : ''}`}
              key={f.id}
              onClick={() => onSheet(f.id)}
              onPointerEnter={() => controller.hover(f.id)}
              title={`${f.name}: the strategy sheet for this match`}
            >
              <span className="num">{formatPlace(i + 1)}</span>
              <span className="swatch" style={{ background: f.color }} />
              <span className="ec-name">
                {f.name}
                {f.kills > 0 ? <span className="faint"> {f.kills} {f.kills === 1 ? 'kill' : 'kills'}</span> : null}
              </span>
              <span className="how">{i === 0 ? (f.alive ? 'last one standing' : '') : report ? howOut(f.id, report.kills, nameOf) : ''}</span>
            </button>
          ))}
        </div>
      </div>

      {local ? (
        <div className="ec-lineup faint">
          Next match keeps this lineup ({lineupSummary(lineup, snap.format)}) with a new seed.{' '}
          <button type="button" className="linkish" onClick={onMatchup}>
            Change it
          </button>
        </div>
      ) : null}
      <div className="ec-actions">
        {local ? (
          <>
            <button type="button" className="btn btn-primary" onClick={onNextMatch} title="Same lineup, new seed">
              Next match
            </button>
            <button
              type="button"
              className="btn"
              onClick={onShuffle}
              disabled={field === 0}
              title={field === 0 ? 'Every fighter is pinned: there is no field to shuffle.' : 'Keep your pinned fighters, draw new house stacks for the rest, and play'}
            >
              Shuffle field
            </button>
            <button type="button" className="btn" onClick={() => controller.restart()}>
              Watch again
            </button>
          </>
        ) : null}
        <span className="spacer" />
        <button
          type="button"
          className="btn"
          disabled={!report && !roomText}
          title={report || roomText ? 'Battle report as text plus JSON, ready to paste into an LLM' : 'The report is still being written.'}
          onClick={() => {
            const text = report ? reportToText(report) : roomText;
            if (text) copyAndToast(text, 'Report');
          }}
        >
          Copy report for LLM
        </button>
      </div>
    </section>
  );
});
