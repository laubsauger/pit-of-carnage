// Owned by: ui
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { GameController, TimelineMark, TimelineMarkKind, UiFighter, UiSnapshot } from '../../core';
import { formatClock, formatClockTenths } from '../format';
import { useStoredState } from '../hooks';
import {
  MARK_KINDS,
  clusterAt,
  clusterMarks,
  deathTick,
  filterMarks,
  isLive,
  laneMarks,
  scrubMove,
  scrubStart,
  scrubTarget,
  scrubTick,
  segmentFeedText,
  tickAtRatio,
  timelineDomain,
} from '../hud';
import type { MarkCluster, Scrub } from '../hud';
import { CloseIcon, LanesIcon } from '../icons';

/** Pixel slop for pointing at a mark. */
const MARK_HIT_PX = 7;
/** Shapes stacked per cluster before the rest become "+n". */
const STACK_MAX = 3;
/** Marks listed in one tooltip. */
const TIP_MAX = 4;

export const MARK_LABEL: Record<TimelineMarkKind, string> = {
  kill: 'Kills',
  dismember: 'Lost limbs',
  big_hit: 'Big hits',
  pickup: 'Power-ups',
  sudden_death: 'Sudden death',
};

const asKinds = (v: unknown, fallback: TimelineMarkKind[]): TimelineMarkKind[] =>
  Array.isArray(v) ? MARK_KINDS.filter((k) => v.includes(k)) : fallback;
const asBool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

type Hover = { x: number; y: number; tick: number; cluster: MarkCluster | null };

type TrackEvents = {
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: () => void;
  onPointerLeave: () => void;
};

type Props = {
  controller: GameController;
  snap: UiSnapshot;
  /** A mark to point out (the kill feed line under the pointer). */
  highlight: TimelineMark | null;
};

/**
 * Bottom scrubber. Marks are shaped by event type and coloured by the fighter who caused it; dense
 * moments stack. Picking a fighter (scoreboard or arena) narrows it to their moments; the lanes view
 * gives every fighter a row. Drag to scrub (the seek happens on release, since seeking
 * re-simulates); click a mark to replay from just before it; Back to live (End) returns.
 */
export function Timeline({ controller, snap, highlight }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const scrub = useRef<Scrub | null>(null);
  const [width, setWidth] = useState(0);
  const [ghost, setGhost] = useState<{ tick: number; domain: number } | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [kinds, setKinds] = useStoredState<TimelineMarkKind[]>('poc.timeline.kinds', () => [...MARK_KINDS], asKinds);
  const [lanes, setLanes] = useStoredState<boolean>('poc.timeline.lanes', () => false, asBool);
  // Selecting a fighter narrows the timeline to them until the player asks for everyone again.
  const [dismissed, setDismissed] = useState<string | null>(null);

  const liveDomain = timelineDomain(snap);
  // While the pointer is down the scale stays as it was at the press (see Scrub in hud.ts).
  const domain = ghost ? ghost.domain : liveDomain;
  const focusId = snap.selectedId !== null && dismissed !== snap.selectedId ? snap.selectedId : null;
  const focus = focusId ? snap.fighters.find((f) => f.id === focusId) ?? null : null;
  const byId = useMemo(() => new Map(snap.fighters.map((f) => [f.id, f])), [snap.fighters]);

  const shown = useMemo(() => filterMarks(snap.marks, focusId, kinds), [snap.marks, focusId, kinds]);
  const clusters = useMemo(() => clusterMarks(shown, domain, width), [shown, domain, width]);
  const typed = useMemo(() => filterMarks(snap.marks, null, kinds), [snap.marks, kinds]);
  const laneRows = useMemo(
    () =>
      lanes
        ? snap.fighters.map((f) => ({
            f,
            clusters: clusterMarks(laneMarks(typed, f.id), domain, width),
            died: deathTick(snap.marks, f.id),
          }))
        : [],
    [lanes, snap.fighters, snap.marks, typed, domain, width],
  );

  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // The inspector and scoreboard keep clear of the timeline, however tall the lanes make it.
  useLayoutEffect(() => {
    const el = panel.current;
    const hud = el?.parentElement;
    if (!el || !hud) return;
    const ro = new ResizeObserver(() => hud.style.setProperty('--tl-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      hud.style.removeProperty('--tl-h');
    };
  }, []);

  const live = isLive(snap);
  const head = ghost ? ghost.tick : snap.tick;
  const pct = (t: number) => `${(Math.min(t, domain) / domain) * 100}%`;
  const sdMark = snap.marks.find((m) => m.kind === 'sudden_death') ?? null;
  const sdTick = sdMark ? sdMark.tick : snap.timeLimitTicks > 0 && snap.timeLimitTicks < domain ? snap.timeLimitTicks : null;
  const highlightAt = highlight ? clusters.find((c) => c.marks.includes(highlight)) ?? null : null;

  const pointHover = (el: HTMLElement, clientX: number, cl: readonly MarkCluster[]) => {
    const p = panel.current;
    if (!p) return;
    const r = el.getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    const x = clientX - r.left;
    setHover({ x: clientX - pr.left, y: r.top - pr.top, tick: tickAtRatio(x / Math.max(1, r.width), domain, snap.maxTick), cluster: clusterAt(cl, x, MARK_HIT_PX) });
  };

  const trackEvents = (cl: readonly MarkCluster[]): TrackEvents => ({
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const r = e.currentTarget.getBoundingClientRect();
      const s = scrubStart(e.clientX, r, liveDomain, snap.maxTick, clusterAt(cl, e.clientX - r.left, MARK_HIT_PX));
      // A ref, not state: the release must see this press even if React has not re-rendered yet.
      scrub.current = s;
      e.currentTarget.setPointerCapture(e.pointerId);
      setGhost({ tick: scrubTick(s), domain: s.domain });
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      const s = scrub.current;
      if (s) {
        scrub.current = scrubMove(s, e.clientX);
        setGhost({ tick: scrubTick(scrub.current), domain: s.domain });
      } else pointHover(e.currentTarget, e.clientX, cl);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
      const s = scrub.current;
      if (!s) return;
      scrub.current = null;
      setGhost(null);
      controller.seek(scrubTarget(scrubMove(s, e.clientX)));
    },
    onPointerCancel: () => {
      scrub.current = null;
      setGhost(null);
    },
    onPointerLeave: () => {
      if (!scrub.current) setHover(null);
    },
  });

  const toggleKind = (k: TimelineMarkKind) => setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : MARK_KINDS.filter((x) => x === k || kinds.includes(x)));
  const goLive = () => controller.seek(snap.maxTick);

  return (
    <div
      ref={panel}
      className={`hud-panel timeline${lanes ? ' with-lanes' : ''}`}
      style={laneRows.length ? { gridTemplateRows: `repeat(${laneRows.length}, 15px) 40px` } : undefined}
    >
      {laneRows.map(({ f, clusters: lc, died }, i) => (
        <LaneRow key={f.id} f={f} row={i + 1} selected={snap.selectedId === f.id} clusters={lc} died={died} pct={pct} maxTick={snap.maxTick} byId={byId}
          events={trackEvents(lc)} onSelect={() => controller.select(snap.selectedId === f.id ? null : f.id)} />
      ))}
      {lanes ? (
        <div className="tl-lanes-head" style={{ gridRow: `1 / span ${laneRows.length}` }} aria-hidden>
          <i style={{ left: pct(head) }} />
        </div>
      ) : null}

      <div className="tl-left" style={{ gridRow: laneRows.length + 1 }}>
        {live ? (
          <span className={`tl-state${snap.finished ? '' : ' live'}`} title={snap.finished ? 'At the end of the match' : 'Watching live'}>
            <i />
            {snap.finished ? 'Final' : 'Live'}
          </span>
        ) : (
          <button type="button" className="btn btn-sm tl-golive" onClick={goLive} title="Back to the live edge (End)">
            {snap.finished ? 'Jump to end' : 'Back to live'}
          </button>
        )}
        <span className="tl-time num">{formatClock(head)}</span>
      </div>

      <div
        ref={track}
        className="tl-track"
        style={{ gridRow: laneRows.length + 1 }}
        role="slider"
        aria-label="Match timeline"
        aria-valuemin={0}
        aria-valuemax={snap.maxTick}
        aria-valuenow={snap.tick}
        aria-valuetext={`${formatClock(snap.tick)}${live ? ', live' : ', replay'}`}
        tabIndex={-1}
        {...trackEvents(clusters)}
      >
        <div className="tl-rail" />
        <div className="tl-played" style={{ width: pct(snap.maxTick) }} />
        <div className={`tl-elapsed${live ? ' live' : ''}`} style={{ width: pct(snap.tick) }} />
        {sdTick !== null ? (
          <div className="tl-sd" style={{ left: pct(sdTick) }}>
            <span>Sudden death</span>
          </div>
        ) : null}
        {clusters.map((c) => (
          <ClusterView key={`${c.tick}:${c.marks.length}`} c={c} byId={byId} lane={null} />
        ))}
        {highlightAt ? <div className="tl-pulse" style={{ left: highlightAt.x }} /> : null}
        <div className={`tl-head ${ghost ? 'ghost' : live ? 'live' : 'replay'}`} style={{ left: pct(head) }} />
      </div>

      <div className="tl-right" style={{ gridRow: laneRows.length + 1 }}>
        <span className="tl-time num">{formatClock(domain)}</span>
        <div className="tl-legend" role="group" aria-label="Event types on the timeline">
          {MARK_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kinds.includes(k)}
              onClick={() => toggleKind(k)}
              title={`${MARK_LABEL[k]}: ${kinds.includes(k) ? 'shown, click to hide' : 'hidden, click to show'}`}
            >
              <MarkShape kind={k} color="currentColor" />
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-sm btn-icon btn-quiet"
          aria-pressed={lanes}
          onClick={() => setLanes(!lanes)}
          title={lanes ? 'One track for everyone' : 'One lane per fighter'}
        >
          <LanesIcon />
        </button>
      </div>

      {focus ? (
        <div className="tl-filter" style={{ gridRow: laneRows.length + 1 }}>
          <span>
            Only <b style={{ color: focus.color }}>{focus.name}</b>
          </span>
          <button type="button" className="btn btn-sm btn-icon btn-quiet" onClick={() => setDismissed(focus.id)} title="Show everyone's moments" aria-label="Show everyone's moments">
            <CloseIcon size={12} />
          </button>
        </div>
      ) : null}

      {hover && !ghost ? <Tip hover={hover} panel={panel.current} byId={byId} fighters={snap.fighters} /> : null}
      {ghost ? (
        <div className="tl-tip in-track" style={{ gridRow: laneRows.length + 1, left: (Math.min(ghost.tick, ghost.domain) / ghost.domain) * width }}>
          <span className="num">{formatClockTenths(ghost.tick)}</span>
        </div>
      ) : null}
    </div>
  );
}

function LaneRow(props: {
  f: UiFighter;
  row: number;
  selected: boolean;
  clusters: MarkCluster[];
  died: number | null;
  pct: (t: number) => string;
  maxTick: number;
  byId: Map<string, UiFighter>;
  events: TrackEvents;
  onSelect: () => void;
}) {
  const { f, row, selected, clusters, died, pct, maxTick, byId, events, onSelect } = props;
  const end = died ?? maxTick;
  return (
    <>
      <button type="button" className={`tl-lane-name${selected ? ' selected' : ''}${f.alive ? '' : ' dead'}`} style={{ gridRow: row }} onClick={onSelect} title={`${f.name}: click to inspect`}>
        <i style={{ background: f.color }} />
        <span>{f.name}</span>
      </button>
      <div className="tl-lane" style={{ gridRow: row }} {...events}>
        <div className="tl-lane-rail" style={{ width: pct(end) }} />
        {clusters.map((c) => (
          <ClusterView key={`${c.tick}:${c.marks.length}`} c={c} byId={byId} lane={f.id} />
        ))}
      </div>
      <span className="tl-lane-sum num" style={{ gridRow: row }}>
        {f.kills > 0 ? `${f.kills} ${f.kills === 1 ? 'kill' : 'kills'}` : ''}
        {died !== null ? <span className="faint"> out {formatClock(died)}</span> : null}
      </span>
    </>
  );
}

function markColor(m: TimelineMark, byId: Map<string, UiFighter>): string {
  if (m.kind === 'sudden_death') return 'var(--blood)';
  return (m.actorId ? byId.get(m.actorId)?.color : undefined) ?? 'var(--text-dim)';
}

/**
 * One stack of marks. In a fighter's lane, moments they caused are filled and moments done to them
 * are hollow (in the colour of whoever did it).
 */
function ClusterView({ c, byId, lane }: { c: MarkCluster; byId: Map<string, UiFighter>; lane: string | null }) {
  const stack = c.marks.length > STACK_MAX ? c.marks.slice(0, STACK_MAX - 1) : c.marks;
  const more = c.marks.length - stack.length;
  return (
    <div className="tl-cluster" style={{ left: c.x }}>
      {stack.map((m, i) => (
        <MarkShape key={i} kind={m.kind} color={markColor(m, byId)} hollow={lane !== null && m.actorId !== lane} />
      ))}
      {more > 0 ? <span className="tl-more num">+{more}</span> : null}
    </div>
  );
}

/** Event shape: diamond kill, downward wedge lost limb, dot big hit, ringed dot power-up, bar sudden death. */
export function MarkShape({ kind, color, hollow = false }: { kind: TimelineMarkKind; color: string; hollow?: boolean }) {
  const fill = hollow ? 'none' : color;
  const stroke = hollow ? color : 'var(--stone-0)';
  const sw = hollow ? 1.6 : 1.1;
  // Deaths are what people scrub for: the kill diamond is drawn a size up.
  const size = kind === 'kill' ? 13 : 10;
  return (
    <svg className="tl-shape" width={size} height={size} viewBox="0 0 10 10" aria-hidden>
      {kind === 'kill' ? (
        <path d="M5 .7 9.3 5 5 9.3.7 5z" fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />
      ) : kind === 'dismember' ? (
        <path d="M1 1.4h8L5 9z" fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />
      ) : kind === 'big_hit' ? (
        <circle cx={5} cy={5} r={2.9} fill={fill} stroke={stroke} strokeWidth={sw} />
      ) : kind === 'pickup' ? (
        <>
          <circle cx={5} cy={5} r={3.7} fill="none" stroke={color} strokeWidth={1.4} />
          {hollow ? null : <circle cx={5} cy={5} r={1.4} fill={color} />}
        </>
      ) : (
        <rect x={2.6} y={0.9} width={4.8} height={8.2} rx={0.6} fill={fill} stroke={stroke} strokeWidth={sw} />
      )}
    </svg>
  );
}

/** Tooltip: the moment in a sentence with names in their colours, and what each side was doing. */
function Tip({ hover, panel, byId, fighters }: { hover: Hover; panel: HTMLDivElement | null; byId: Map<string, UiFighter>; fighters: UiFighter[] }) {
  const w = panel?.clientWidth ?? 0;
  const side = hover.x < 180 ? ' left' : hover.x > w - 180 ? ' right' : '';
  const marks = hover.cluster?.marks ?? [];
  return (
    <div className={`tl-tip${marks.length ? ' story' : ''}${side}`} style={{ left: hover.x, top: hover.y }} role="tooltip">
      {marks.length === 0 ? (
        <span className="num">{formatClockTenths(hover.tick)}</span>
      ) : (
        <>
          {[...marks]
            .sort((a, b) => a.tick - b.tick)
            .slice(0, TIP_MAX)
            .map((m, i) => (
              <div key={i} className="tip-line">
                <span className="num dim">{formatClock(m.tick)}</span>
                <span>
                  <Sentence m={m} fighters={fighters} />
                  <Doing m={m} byId={byId} />
                </span>
              </div>
            ))}
          {marks.length > TIP_MAX ? <div className="faint tip-more">and {marks.length - TIP_MAX} more. Click to replay from here.</div> : null}
        </>
      )}
    </div>
  );
}

function Sentence({ m, fighters }: { m: TimelineMark; fighters: UiFighter[] }) {
  const ids = [m.actorId, m.targetId].filter((x): x is string => x !== null);
  const text = m.text || MARK_LABEL[m.kind];
  return (
    <>
      {segmentFeedText(text, fighters, ids).map((seg, i) =>
        seg.id ? (
          <b key={i} style={{ color: seg.color }}>
            {seg.text}
          </b>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

function Doing({ m, byId }: { m: TimelineMark; byId: Map<string, UiFighter> }) {
  const sides = [
    { id: m.actorId, behaviour: m.actorBehaviour },
    { id: m.targetId, behaviour: m.targetBehaviour },
  ].filter((s) => s.id !== null && s.behaviour);
  if (sides.length === 0) return null;
  return (
    <span className="tip-doing">
      {sides.map((s, i) => {
        const f = byId.get(s.id as string);
        return (
          <span key={i}>
            {i > 0 ? ', ' : ''}
            <b style={{ color: f?.color }}>{f?.name ?? '?'}</b> was in <code>{s.behaviour}</code>
          </span>
        );
      })}
    </span>
  );
}
