// Owned by: ui
import type { GameController, TimelineMark, UiSnapshot } from '../../core';
import { formatClock } from '../format';
import { KILL_LEAD_IN_TICKS, feedOpacity, markForFeed, seekTickForMark, segmentFeedText, visibleFeed } from '../hud';

type Props = {
  controller: GameController;
  snap: UiSnapshot;
  shifted: boolean;
  /** The timeline mark of the line under the pointer (null when none), so the timeline can point at it. */
  onLink: (mark: TimelineMark | null) => void;
};

/**
 * Right-side broadcast feed. Lines fade with game time. Each line is linked to its timeline mark:
 * pointing at it lights the mark up, clicking it replays the moment exactly as the mark would.
 */
export function KillFeed({ controller, snap, shifted, onLink }: Props) {
  const items = visibleFeed(snap.feed, snap.tick);
  return (
    <div className={`feed${shifted ? ' shifted' : ''}`} aria-live="polite" aria-label="Kill feed" onPointerLeave={() => onLink(null)}>
      {items.map((item) => {
        const mark = markForFeed(item, snap.marks);
        return (
          <div
            key={`${item.tick}:${item.text}`}
            className={`feed-item ${item.kind}`}
            style={{ opacity: feedOpacity(item.tick, snap.tick) }}
            onPointerEnter={() => onLink(mark)}
            onClick={() => controller.seek(mark ? seekTickForMark(mark) : Math.max(0, item.tick - KILL_LEAD_IN_TICKS))}
            title={mark ? 'Replay this moment (marked on the timeline)' : 'Replay from just before this'}
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
        );
      })}
    </div>
  );
}
