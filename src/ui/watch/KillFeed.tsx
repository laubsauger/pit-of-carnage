// Owned by: ui
import type { GameController, UiSnapshot } from '../../core';
import { formatClock } from '../format';
import { KILL_LEAD_IN_TICKS, feedOpacity, segmentFeedText, visibleFeed } from '../hud';

/** Right-side broadcast feed. Lines fade with game time; clicking one replays the moment. */
export function KillFeed({ controller, snap, shifted }: { controller: GameController; snap: UiSnapshot; shifted: boolean }) {
  const items = visibleFeed(snap.feed, snap.tick);
  return (
    <div className={`feed${shifted ? ' shifted' : ''}`} aria-live="polite" aria-label="Kill feed">
      {items.map((item) => (
        <div
          key={`${item.tick}:${item.text}`}
          className={`feed-item ${item.kind}`}
          style={{ opacity: feedOpacity(item.tick, snap.tick) }}
          onClick={() => controller.seek(Math.max(0, item.tick - KILL_LEAD_IN_TICKS))}
          title="Replay from just before this"
        >
          <span className="num">{formatClock(item.tick)}</span>
          <span>
            {segmentFeedText(item.text, snap.fighters, item.ids).map((seg, i) =>
              seg.id ? (
                <b key={i} style={{ color: seg.color }}>
                  {seg.text}
                </b>
              ) : (
                <span key={i}>{seg.text}</span>
              ),
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
