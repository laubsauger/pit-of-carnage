// Owned by: ui
import { useRef, useState } from 'react';
import type { GameController, TimelineMark, UiSnapshot } from '../../core';
import { formatClock, formatClockTenths } from '../format';
import { markNear, seekTickForMark, tickAtRatio, timelineDomain } from '../hud';

/** Pixel slop for clicking a mark. */
const MARK_HIT_PX = 6;

const MARK_LABEL: Record<TimelineMark['kind'], string> = { kill: 'Kill', dismember: 'Limb off', big_hit: 'Big hit' };

/**
 * Bottom scrubber. Drag to scrub (the seek happens on release, since seeking re-simulates), click
 * near a kill mark to jump to just before it.
 */
export function Timeline({ controller, snap }: { controller: GameController; snap: UiSnapshot }) {
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ tick: number; startX: number; moved: boolean } | null>(null);
  const [hover, setHover] = useState<{ x: number; tick: number; mark: TimelineMark | null } | null>(null);

  const domain = timelineDomain(snap);
  const pct = (t: number) => `${(Math.min(t, domain) / domain) * 100}%`;

  const locate = (clientX: number) => {
    const el = track.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const ratio = (clientX - r.left) / Math.max(1, r.width);
    const tolerance = (MARK_HIT_PX / Math.max(1, r.width)) * domain;
    const raw = Math.round(Math.min(1, Math.max(0, ratio)) * domain);
    return {
      x: clientX - r.left,
      tick: tickAtRatio(ratio, domain, snap.maxTick),
      mark: markNear(snap.marks, raw, tolerance),
    };
  };

  const markText = (m: TimelineMark) => {
    const line = snap.feed.find((f) => Math.abs(f.tick - m.tick) <= 2 && (m.kind === 'kill' ? f.kind === 'kill' : true));
    return line ? line.text : MARK_LABEL[m.kind];
  };

  const showSd = snap.timeLimitTicks > 0 && snap.timeLimitTicks < domain;
  const head = drag ? drag.tick : snap.tick;

  return (
    <div className="hud-panel timeline">
      <span className="tl-time num">{formatClock(head)}</span>
      <div
        ref={track}
        className="tl-track"
        role="slider"
        aria-label="Match timeline"
        aria-valuemin={0}
        aria-valuemax={snap.maxTick}
        aria-valuenow={snap.tick}
        aria-valuetext={formatClock(snap.tick)}
        tabIndex={-1}
        onPointerDown={(e) => {
          const at = locate(e.clientX);
          if (!at) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag({ tick: at.tick, startX: e.clientX, moved: false });
        }}
        onPointerMove={(e) => {
          const at = locate(e.clientX);
          if (!at) return;
          setHover(at);
          if (drag) setDrag({ ...drag, tick: at.tick, moved: drag.moved || Math.abs(e.clientX - drag.startX) > 3 });
        }}
        onPointerUp={(e) => {
          if (!drag) return;
          const at = locate(e.clientX);
          const target = !drag.moved && at?.mark ? Math.min(seekTickForMark(at.mark), snap.maxTick) : drag.tick;
          setDrag(null);
          controller.seek(target);
        }}
        onPointerCancel={() => setDrag(null)}
        onPointerLeave={() => setHover(null)}
      >
        <div className="tl-rail" />
        <div className="tl-played" style={{ width: pct(snap.maxTick) }} />
        <div className="tl-elapsed" style={{ width: pct(snap.tick) }} />
        {showSd ? (
          <div className="tl-sd" style={{ left: pct(snap.timeLimitTicks) }}>
            <span>Sudden death</span>
          </div>
        ) : null}
        {snap.marks.map((m, i) => (
          <div key={i} className={`tl-mark ${m.kind}`} style={{ left: pct(m.tick) }} />
        ))}
        <div className={`tl-head${drag ? ' ghost' : ''}`} style={{ left: pct(head) }} />
        {hover && !drag ? (
          <div className="tl-tip" style={{ left: hover.x }}>
            {hover.mark ? (
              <>
                <span className="num dim">{formatClock(hover.mark.tick)}</span> {markText(hover.mark)}
              </>
            ) : (
              <span className="num">{formatClockTenths(hover.tick)}</span>
            )}
          </div>
        ) : null}
        {drag ? (
          <div className="tl-tip" style={{ left: `${(drag.tick / domain) * 100}%` }}>
            <span className="num">{formatClockTenths(drag.tick)}</span>
          </div>
        ) : null}
      </div>
      <span className="tl-time num">{formatClock(domain)}</span>
    </div>
  );
}
