// Owned by: ui
import { Fragment } from 'react';
import type { GameController, UiFighter, UiSnapshot } from '../../core';
import { formatPlace, squadLetter, weaponName } from '../format';
import { hpFraction } from '../hud';
import { WeaponIcon } from '../icons';
import type { PaneState } from '../panes';
import { PaneHandle, PaneToggle } from '../widgets';

type Props = {
  controller: GameController;
  snap: UiSnapshot;
  rows: UiFighter[];
  mapName: string;
  pane: PaneState;
  setPane: (fn: (p: PaneState) => PaneState) => void;
  /** After the match, a click opens the fighter's strategy sheet instead of only selecting it. */
  onSheet: (id: string) => void;
};

/** Top-left standings: the living by kills, the dead greyed with their place. */
export function Scoreboard({ controller, snap, rows, mapName, pane, setPane, onSheet }: Props) {
  const alive = rows.filter((f) => f.alive).length;
  const squads = snap.format === 'squads';
  if (pane.collapsed) {
    // A thin rail: one dot per fighter in scoreboard order, the dead dimmed. Still selects.
    return (
      <section className="hud-panel scoreboard rail" aria-label="Scoreboard, collapsed">
        <PaneToggle side="left" collapsed label="Scoreboard" onToggle={() => setPane((p) => ({ ...p, collapsed: false }))} />
        <span className="rail-count num" title={`${alive} of ${rows.length} standing`}>
          {alive}
        </span>
        <div className="rail-dots" onPointerLeave={() => controller.hover(null)}>
          {rows.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`rail-dot${f.alive ? '' : ' dead'}${snap.selectedId === f.id ? ' selected' : ''}`}
              style={{ background: f.color }}
              onClick={() => (snap.finished ? onSheet(f.id) : controller.select(snap.selectedId === f.id ? null : f.id))}
              onPointerEnter={() => controller.hover(f.id)}
              title={`${f.name}${f.alive ? '' : `, ${f.place ? formatPlace(f.place) : 'out'}`}`}
              aria-label={f.name}
            />
          ))}
        </div>
      </section>
    );
  }
  return (
    <section className="hud-panel scoreboard" aria-label="Scoreboard">
      <PaneHandle id="watch.scoreboard" setPane={setPane} label="Scoreboard" />
      <div className="sb-head">
        <span>
          <strong className="num">{alive}</strong> <span className="dim">of {rows.length} standing</span>
        </span>
        <span className="faint sb-map">{mapName}</span>
        <PaneToggle side="left" collapsed={false} label="Scoreboard" onToggle={() => setPane((p) => ({ ...p, collapsed: true }))} />
      </div>
      <div className="sb-list" onPointerLeave={() => controller.hover(null)}>
        {rows.map((f, i) => {
          const newSquad = squads && (i === 0 || rows[i - 1].squad !== f.squad);
          return (
            <Fragment key={f.id}>
              {newSquad ? <SquadHeader squad={f.squad} rows={rows} /> : null}
              <Row f={f} snap={snap} controller={controller} onSheet={onSheet} />
            </Fragment>
          );
        })}
      </div>
      {snap.finished ? <div className="sb-foot faint">Click anyone for their strategy sheet.</div> : null}
    </section>
  );
}

function SquadHeader({ squad, rows }: { squad: number; rows: UiFighter[] }) {
  const members = rows.filter((r) => r.squad === squad);
  const up = members.filter((r) => r.alive).length;
  return (
    <div className="sb-squad">
      Squad {squadLetter(squad)}, {up === 0 ? 'out' : `${up} standing`}
    </div>
  );
}

function Row({ f, snap, controller, onSheet }: { f: UiFighter; snap: UiSnapshot; controller: GameController; onSheet: (id: string) => void }) {
  const selected = snap.selectedId === f.id;
  const following = snap.followId === f.id;
  const frac = hpFraction(f.hp, f.maxHp);
  const winner = snap.finished && f.place === 1;
  return (
    <button
      type="button"
      className={`sb-row${f.alive ? '' : ' dead'}${selected ? ' selected' : ''}`}
      onClick={() => (snap.finished ? onSheet(f.id) : controller.select(selected ? null : f.id))}
      onDoubleClick={() => {
        controller.select(f.id);
        controller.follow(f.id);
      }}
      onPointerEnter={() => controller.hover(f.id)}
      aria-pressed={selected}
      title={
        snap.finished
          ? `${f.name}. Click for the strategy sheet: how this match went and the strategy itself.`
          : `${f.name}. Click to inspect and show only their moments on the timeline; double-click to follow.`
      }
    >
      <span className="sb-stripe" style={{ background: f.color }} />
      <span className="sb-name">{f.name}</span>
      <span className="sb-weapon" title={weaponName(f.weapon)}>
        <WeaponIcon weapon={f.weapon} />
      </span>
      <span className={`sb-kills${f.kills > 0 ? ' has' : ''}`} title={`${f.kills} ${f.kills === 1 ? 'kill' : 'kills'}`}>
        {f.kills}
      </span>
      <span className="sb-sub">
        {f.alive ? (
          <>
            <span className={`hp${frac < 0.25 ? ' low' : ''}`} title={`${Math.ceil(f.hp)} / ${f.maxHp} HP`}>
              <div style={{ width: `${frac * 100}%`, background: f.color }} />
            </span>
            {following ? <span className="follow-dot" title="Camera follows" /> : null}
            {winner ? <span className="chip">Winner</span> : null}
          </>
        ) : (
          <span className="sb-place">{f.place ? `${formatPlace(f.place)} place` : 'Out'}</span>
        )}
      </span>
    </button>
  );
}
