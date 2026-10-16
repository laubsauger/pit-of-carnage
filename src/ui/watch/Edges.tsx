// Owned by: ui
// What the Watch HUD folds to: a small tab at a screen edge and a thin timeline bar (cinematic view,
// narrow screens, a folded kill feed).
import type { GameController, UiSnapshot } from '../../core';
import { formatClock } from '../format';
import { isLive, tickAtRatio, timelineDomain } from '../hud';

/** A panel folded to a small tab at its edge; clicking brings it back. */
export function EdgeTab(props: { side: 'left' | 'right'; label: string; count?: number; title: string; className?: string; onOpen: () => void }) {
  const { side, label, count, title, className = '', onOpen } = props;
  return (
    <button type="button" className={`hud-panel edge-tab ${side} ${className}`} onClick={onOpen} title={title} aria-label={title}>
      <span>{label}</span>
      {count !== undefined && count > 0 ? <b className="num">{count}</b> : null}
    </button>
  );
}

/**
 * The timeline folded to a thin bar: how far the match has run, where the playhead is, and a click
 * seeks there (the full timeline comes back with the HUD).
 */
export function ThinTimeline({ controller, snap }: { controller: GameController; snap: UiSnapshot }) {
  const domain = timelineDomain(snap);
  const played = domain > 0 ? Math.min(1, snap.maxTick / domain) : 0;
  const head = domain > 0 ? Math.min(1, snap.tick / domain) : 0;
  const local = snap.source === 'local';
  return (
    <div
      className={`tl-thin${local ? '' : ' readonly'}`}
      role={local ? 'slider' : undefined}
      aria-label="Match timeline"
      aria-valuemin={0}
      aria-valuemax={snap.maxTick}
      aria-valuenow={snap.tick}
      aria-valuetext={formatClock(snap.tick)}
      title={local ? `${formatClock(snap.tick)}${isLive(snap) ? ', live' : ', replaying'}. Click to jump there.` : formatClock(snap.tick)}
      onClick={(e) => {
        if (!local) return;
        const r = e.currentTarget.getBoundingClientRect();
        controller.seek(tickAtRatio((e.clientX - r.left) / Math.max(1, r.width), domain, snap.maxTick));
      }}
    >
      <i className="tl-thin-played" style={{ width: `${played * 100}%` }} />
      <i className={`tl-thin-head${isLive(snap) ? ' live' : ''}`} style={{ left: `${head * 100}%` }} />
    </div>
  );
}
