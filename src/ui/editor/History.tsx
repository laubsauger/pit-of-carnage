// Owned by: ui
// The editor's history panel (SPEC "Versions and the library"): every saved version of the open
// strategy, newest first, with when it was saved, where it came from, its parent and what changed;
// open any of them, delete one, or pick two (or one and the editor's draft) and compare them in the
// gym over the same seeds.
import { useMemo, useState } from 'react';
import type { SavedStrategy, Strategy, StrategyHistory } from '../../core';
import { CloseIcon } from '../icons';
import { changeBase, diffStrategies, diffSummary, formatSavedAt, versionOrigin } from './versions';

/** One side of a comparison: what the result calls it, and the strategy that plays. */
export type CompareSide = { label: string; strategy: Strategy };

/** The editor's draft as a pick: "draft". */
const DRAFT = 'draft';
const MAX_PICKS = 2;

type Props = {
  history: StrategyHistory;
  /** The saved version the editor is based on (marked "open"). */
  base: SavedStrategy | null;
  /** The editor's strategy when it is valid and differs from every saved version; it can be compared too. */
  draft: CompareSide | null;
  nowMs: number;
  onOpen: (s: SavedStrategy) => void;
  onDelete: (s: SavedStrategy) => void;
  onCompare: (a: CompareSide, b: CompareSide) => void;
  /** A comparison started here is running. */
  running: { done: number; total: number } | null;
  onStop: () => void;
};

export function HistoryPanel({ history, base, draft, nowMs, onOpen, onDelete, onCompare, running, onStop }: Props) {
  const [picks, setPicks] = useState<string[]>([]);
  const rows = history.entries;
  const sides = useMemo(() => {
    const out = new Map<string, CompareSide>();
    if (draft) out.set(DRAFT, draft);
    for (const r of rows) out.set(r.saved.id, { label: `v${r.saved.version}`, strategy: { ...r.saved.strategy, version: r.saved.version } });
    return out;
  }, [rows, draft]);
  // A pick whose version was deleted (or a draft that was saved) drops out.
  const live = picks.filter((p) => sides.has(p));

  const toggle = (id: string) =>
    setPicks((prev) => {
      const now = prev.filter((p) => sides.has(p));
      if (now.includes(id)) return now.filter((p) => p !== id);
      return [...now, id].slice(-MAX_PICKS);
    });

  // Older first, so the result reads "v2 vs v4" and "v4 vs the editor".
  const order = (id: string) => (id === DRAFT ? Infinity : (rows.find((r) => r.saved.id === id)?.saved.version ?? 0));
  const pair = live.length === MAX_PICKS ? [...live].sort((a, b) => order(a) - order(b)).map((p) => sides.get(p)!) : null;

  const pickBox = (id: string, label: string) => (
    <label className="hv-pick" title={`Pick ${label} to compare`}>
      <input type="checkbox" checked={live.includes(id)} onChange={() => toggle(id)} disabled={running !== null} />
      <span>Compare</span>
    </label>
  );

  return (
    <div className="hv">
      {draft ? (
        <div className={`hv-row hv-draft${live.includes(DRAFT) ? ' picked' : ''}`}>
          <div className="hv-top">
            <span className="hv-v">editor</span>
            <span className="hv-origin">unsaved changes</span>
          </div>
          <div className="hv-actions">{pickBox(DRAFT, 'the editor')}</div>
        </div>
      ) : null}
      <ol className="hv-list" aria-label={`Versions of ${history.name}`}>
        {rows.map((r, i) => {
          const s = r.saved;
          const against = changeBase(rows, i);
          const changes = against ? diffSummary(diffStrategies(against.strategy, s.strategy)) : 'first version';
          const open = base?.id === s.id;
          return (
            <li key={s.id} className={`hv-row${open ? ' open' : ''}${live.includes(s.id) ? ' picked' : ''}`} aria-current={open || undefined}>
              <div className="hv-top">
                <span className="hv-v num">v{s.version}</span>
                <span className="hv-origin">{versionOrigin(s, r.parent)}</span>
                <span className="spacer" />
                <span className="faint num" title={new Date(s.savedAt).toLocaleString()}>
                  {formatSavedAt(s.savedAt, nowMs)}
                </span>
              </div>
              <div className="hv-diff" title={against ? `Compared with v${against.version}` : undefined}>
                {against && against.version !== s.parentVersion ? <span className="faint">vs v{against.version}: </span> : null}
                {changes}
              </div>
              <div className="hv-actions">
                {open ? (
                  <span className="chip">open</span>
                ) : (
                  <button type="button" className="btn btn-sm btn-quiet" onClick={() => onOpen(s)} title={`Open v${s.version} in the editor`}>
                    Open
                  </button>
                )}
                {pickBox(s.id, `v${s.version}`)}
                <span className="spacer" />
                <button type="button" className="btn btn-sm btn-icon btn-quiet" aria-label={`Delete v${s.version}`} title="Delete this version" onClick={() => onDelete(s)}>
                  <CloseIcon size={12} />
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="hv-foot">
        {running ? (
          <>
            <span className="dim num">
              Comparing… {running.done}/{running.total}
            </span>
            <span className="hv-bar" aria-hidden>
              <i style={{ width: `${running.total ? (running.done / running.total) * 100 : 0}%` }} />
            </span>
            <button type="button" className="btn btn-sm" onClick={onStop}>
              Stop
            </button>
          </>
        ) : pair ? (
          <>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => onCompare(pair[0]!, pair[1]!)}>
              Compare {pair[0]!.label} with {pair[1]!.label}
            </button>
            <button type="button" className="btn btn-sm btn-icon btn-quiet" aria-label="Clear the picks" title="Clear the picks" onClick={() => setPicks([])}>
              <CloseIcon size={12} />
            </button>
          </>
        ) : (
          <span className="faint">{rows.length + (draft ? 1 : 0) >= 2 ? 'Pick two to compare them in the gym on the same seeds.' : 'Save another version to compare the two.'}</span>
        )}
      </div>
    </div>
  );
}
