// Owned by: ui
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { DEFAULT_VIEW_SETTINGS, NO_VIEW_INSETS } from '../../core';
import type { GameController, Strategy, TimelineMark, ViewInsets } from '../../core';
import { MAPS } from '../../sim';
import type { CurrentMatch, WatchOrigin } from '../App';
import { usePane, useSnapshot } from '../hooks';
import type { WebGpuStatus } from '../hooks';
import { countdownText, cycleFighter, finaleStamp, hoverCardPosition, insetsAround, nextFollow, sameInsets, skippable, sortScoreboard, watchInsets } from '../hud';
import { BackIcon } from '../icons';
import { isEditableTarget, keyToAction } from '../keys';
import { paneExtent } from '../panes';
import { buildMatchConfig, randomSeed } from '../setup';
import type { MatchSetup, PoolEntry } from '../setup';
import { toast } from '../toast';
import { describeView, toggleView } from '../view';
import { EndCard } from './EndCard';
import { FighterOverview } from './FighterOverview';
import type { OverviewTab } from './FighterOverview';
import { HoverCard, ObjectCard } from './HoverCard';
import { Inspector } from './Inspector';
import { KillFeed } from './KillFeed';
import { MatchClock } from './MatchClock';
import { MatchSetupDialog } from './MatchSetup';
import { Scoreboard } from './Scoreboard';
import { Timeline } from './Timeline';
import { ViewMenu } from './ViewMenu';

type Props = {
  controller: GameController;
  /** The Watch tab is showing. The arena stays mounted underneath the other screens. */
  active: boolean;
  gpu: WebGpuStatus;
  setup: MatchSetup;
  setSetup: (s: MatchSetup) => void;
  pool: PoolEntry[];
  /** The match the UI last started (its strategies, and the gym report it came from). */
  current: CurrentMatch | null;
  /** Start a match (throws when the gate refuses it). */
  play: (config: CurrentMatch['config'], origin?: WatchOrigin | null) => void;
  onBackToGym: (origin: WatchOrigin) => void;
  onOpenInGym: (s: Strategy) => void;
};

/** CSS --gutter: panels sit this far in from the arena's edges. */
const GUTTER = 12;

export function WatchScreen({ controller, active, gpu, setup, setSetup, pool, current, play, onBackToGym, onOpenInGym }: Props) {
  const snap = useSnapshot(controller);
  const root = useRef<HTMLDivElement>(null);
  const arena = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement | null>(null);
  const pointer = useRef({ x: -9999, y: -9999 });
  const [overArena, setOverArena] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [overview, setOverview] = useState<{ id: string; tab: OverviewTab } | null>(null);
  const [scoreboardPane, setScoreboardPane] = usePane('watch.scoreboard');
  const [inspectorPane, setInspectorPane] = usePane('watch.inspector');
  const [timelineH, setTimelineH] = useState<number | null>(null);
  const [endW, setEndW] = useState<number | null>(null);
  const [pip, setPip] = useState<DOMRect | null>(null);
  // The timeline mark of the feed line under the pointer.
  const [linked, setLinked] = useState<TimelineMark | null>(null);
  // Volume to bring back when M unmutes.
  const lastVolume = useRef(DEFAULT_VIEW_SETTINGS.volume);
  useEffect(() => {
    if (snap.view.volume > 0) lastVolume.current = snap.view.volume;
  }, [snap.view.volume]);

  // The canvas mounts once WebGPU is confirmed and stays mounted while other screens are open:
  // re-creating a WebGPU renderer recompiles every pipeline.
  useEffect(() => {
    if (gpu !== 'ok' || !arena.current) return;
    return controller.mountCanvas(arena.current);
  }, [controller, gpu]);

  const start = useCallback(
    (next: MatchSetup) => {
      try {
        const config = buildMatchConfig(next, pool);
        setSetup(next);
        play(config);
        controller.setPaused(false);
        return true;
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Could not start the match.');
        return false;
      }
    },
    [controller, pool, setSetup, play],
  );

  const nextMatch = useCallback(() => start({ ...setup, seed: randomSeed() }), [start, setup]);

  // The first match is built as soon as WebGPU is confirmed, whatever screen is showing: the splash
  // counts it as a loading stage, and it waits behind the splash for "Enter the pit". A match already
  // loaded (a gym match opened with Watch) is left alone.
  const started = useRef(false);
  useEffect(() => {
    if (gpu !== 'ok' || started.current) return;
    started.current = true;
    if (controller.getSnapshot().fighters.length === 0) nextMatch();
  }, [gpu, controller, nextMatch]);

  // Leaving Watch pauses the match (nobody is watching, and the gym wants the CPU); coming back
  // resumes it only if we were the ones who paused it.
  const hasMatch = snap.fighters.length > 0;
  const autoPaused = useRef(false);
  useEffect(() => {
    const s = controller.getSnapshot();
    if (!active) {
      if (!s.paused && !s.finished && s.fighters.length > 0) {
        controller.setPaused(true);
        autoPaused.current = true;
      }
    } else if (autoPaused.current) {
      autoPaused.current = false;
      controller.setPaused(false);
    }
  }, [active, controller, hasMatch]);

  // End card: up once the match reaches `ended` (after the final moment has been admired, or at
  // once when a decided match is replayed to its end). Closing it lets you look around until the
  // next ending.
  const prevPhase = useRef(snap.phase);
  useEffect(() => {
    if (snap.phase === 'ended' && prevPhase.current !== 'ended') setEndOpen(true);
    if (snap.phase !== 'ended') setEndOpen(false);
    prevPhase.current = snap.phase;
  }, [snap.phase]);

  // A new match closes the overview of a fighter from the old one (fighter ids repeat across
  // matches, so the id alone would quietly show a stranger).
  useEffect(() => {
    setOverview(null);
    setPip(null);
  }, [current]);
  useEffect(() => {
    setOverview((o) => (o && !snap.fighters.some((f) => f.id === o.id) ? null : o));
  }, [snap.fighters]);

  const rows = sortScoreboard(snap.fighters, snap.format);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // The overview borrows the camera: it follows the fighter inside the arena window, and gives the
  // camera back as it found it on close.
  const followBefore = useRef<string | null>(null);
  const overviewOpen = useRef(false);
  overviewOpen.current = overview !== null;
  const openOverview = useCallback(
    (id: string, tab: OverviewTab = 'overview') => {
      if (!overviewOpen.current) followBefore.current = controller.getSnapshot().followId;
      overviewOpen.current = true;
      setOverview({ id, tab });
      controller.select(id);
    },
    [controller],
  );
  const closeOverview = useCallback(() => {
    setOverview(null);
    setPip(null);
    controller.follow(followBefore.current);
  }, [controller]);
  const overviewFighter = overview ? snap.fighters.find((f) => f.id === overview.id) ?? null : null;
  const overviewAlive = overviewFighter?.alive ?? false;
  useEffect(() => {
    if (overview && overviewAlive) controller.follow(overview.id);
  }, [controller, overview?.id, overviewAlive]); // eslint-disable-line react-hooks/exhaustive-deps

  const modal = setupOpen;
  const phase = snap.phase;

  useEffect(() => {
    if (!active || gpu !== 'ok') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const s = controller.getSnapshot();
      // The splash owns the keyboard until the pit is entered.
      if (s.phase === 'loading' || s.phase === 'splash') return;
      const action = keyToAction({
        key: e.key,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        editable: isEditableTarget(e.target),
      });
      if (!action) return;
      // The setup dialog keeps the keyboard and handles its own Escape; so does any modal over the arena (the Codex).
      if (modal || document.querySelector('[aria-modal="true"]:not([hidden])')) return;
      e.preventDefault();
      switch (action.type) {
        case 'cycle': {
          const id = cycleFighter(rowsRef.current, s.selectedId, action.dir);
          controller.select(id);
          if (overview && id) openOverview(id, overview.tab);
          // Tab while following hands the camera to the next fighter too.
          else if (s.followId !== null) controller.follow(id);
          break;
        }
        case 'follow':
          controller.follow(nextFollow(s.selectedId, s.followId));
          break;
        case 'pause':
          // During the countdown and the final moment, Space skips ahead instead.
          if (skippable(s.phase)) controller.skip();
          else controller.setPaused(!s.paused);
          break;
        case 'step':
          if (!s.paused) controller.setPaused(true);
          if (action.ticks > 0) controller.stepTicks(action.ticks);
          else controller.seek(Math.max(0, s.tick + action.ticks));
          break;
        case 'speed':
          controller.setSpeed(action.speed);
          break;
        case 'deselect':
          if (overview) closeOverview();
          else if (endOpen) setEndOpen(false);
          else if (s.selectedId !== null) controller.select(null);
          else if (s.followId !== null) controller.follow(null);
          break;
        case 'overview': {
          if (overview) {
            closeOverview();
            break;
          }
          const id = s.selectedId ?? s.hoveredId ?? rowsRef.current.find((f) => f.alive)?.id ?? rowsRef.current[0]?.id ?? null;
          if (id) openOverview(id);
          break;
        }
        case 'live':
          if (s.tick < s.maxTick) controller.seek(s.maxTick);
          break;
        case 'camera':
          if (s.cameraManual || s.followId !== null) {
            controller.resetCamera();
            toast('Camera: director');
          }
          break;
        case 'view': {
          const patch = toggleView(s.view, action.key, lastVolume.current);
          controller.setView(patch);
          toast(describeView({ ...s.view, ...patch }, action.key));
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, gpu, controller, modal, endOpen, overview, openOverview, closeOverview]);

  const placeCard = useCallback(() => {
    const el = card.current;
    const r = root.current;
    if (!el || !r) return;
    const b = r.getBoundingClientRect();
    const p = hoverCardPosition(
      { x: pointer.current.x - b.left, y: pointer.current.y - b.top },
      { w: el.offsetWidth, h: el.offsetHeight },
      { w: b.width, h: b.height },
    );
    el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
  }, []);

  const cardRef = useCallback(
    (el: HTMLDivElement | null) => {
      card.current = el;
      if (el) placeCard();
    },
    [placeCard],
  );

  // The end card slides in from the right; the arena framing makes room for it.
  const endObserver = useRef<ResizeObserver | null>(null);
  const endRef = useCallback((el: HTMLElement | null) => {
    endObserver.current?.disconnect();
    endObserver.current = null;
    if (!el) {
      setEndW(null);
      return;
    }
    // State set from a ResizeObserver waits a frame, so it never feeds back into the same layout pass.
    const ro = new ResizeObserver(() => requestAnimationFrame(() => setEndW(el.offsetWidth)));
    ro.observe(el);
    endObserver.current = ro;
    setEndW(el.offsetWidth);
  }, []);

  const mapName = MAPS[snap.mapId]?.name ?? snap.mapId;
  const selected = snap.selectedId ? snap.fighters.find((f) => f.id === snap.selectedId) ?? null : null;
  const hovered = snap.hoveredId ? snap.fighters.find((f) => f.id === snap.hoveredId) ?? null : null;
  const hudShown = active && gpu === 'ok' && !snap.arenaError;
  const entered = phase !== 'loading' && phase !== 'splash';
  const panels = hudShown && entered && !overview;
  // A corpse shows nothing: dead fighters stay inspectable from the scoreboard, feed and end card.
  const showHover = panels && hovered !== null && hovered.alive && overArena && hovered.id !== snap.selectedId && !modal;
  const obj = snap.hoveredObject;
  const showObject = panels && !showHover && obj !== null && overArena && !modal;
  const endShown = panels && endOpen;

  // Report what the HUD covers, so the camera frames the action in the part of the arena in view.
  const insets = useRef<ViewInsets>({ ...NO_VIEW_INSETS });
  useEffect(() => {
    if (gpu !== 'ok') return;
    let next: ViewInsets;
    if (overview && pip && arena.current) next = insetsAround(arena.current.getBoundingClientRect(), pip);
    else
      next = watchInsets(
        {
          scoreboard: panels && hasMatch ? paneExtent(scoreboardPane) : null,
          inspector: panels && selected ? paneExtent(inspectorPane) : null,
          endCard: endShown ? endW : null,
          timeline: hudShown && entered && hasMatch ? timelineH : null,
        },
        GUTTER,
      );
    if (!sameInsets(next, insets.current)) {
      insets.current = next;
      controller.setViewInsets(next);
      // Big beats (countdown, FIGHT!) centre on the part of the arena in view, like the camera.
      const el = root.current;
      if (el) {
        el.style.setProperty('--view-l', `${next.left}px`);
        el.style.setProperty('--view-r', `${next.right}px`);
        el.style.setProperty('--view-b', `${next.bottom}px`);
      }
    }
  });

  // The fighter's strategy, from the config the UI started (checked against the live match, so a
  // match started elsewhere never shows the wrong strategy).
  const strategyOf = (id: string): Strategy | null => {
    const config = current?.config;
    if (!config || config.seed !== snap.seed || config.mapId !== snap.mapId || config.entrants.length !== snap.fighters.length) return null;
    const entrantId = controller.fighter(id)?.entrantId ?? null;
    return config.entrants.find((e) => e.id === entrantId)?.strategy ?? null;
  };
  const origin = current?.origin ?? null;
  const beat = countdownText(snap.countdown);
  const finale = finaleStamp(snap);

  return (
    <div
      ref={root}
      className="watch"
      style={{ '--ins-w': `${paneExtent(inspectorPane)}px`, '--sb-w': `${paneExtent(scoreboardPane)}px` } as CSSProperties}
      onPointerMove={(e) => {
        pointer.current = { x: e.clientX, y: e.clientY };
        const over = !!arena.current && arena.current.contains(e.target as Node);
        if (over !== overArena) setOverArena(over);
        placeCard();
      }}
      onPointerLeave={() => setOverArena(false)}
      onMouseDown={(e) => {
        // HUD buttons never keep focus: Space must pause the match, not re-press the last button.
        const t = e.target as HTMLElement;
        if (t.closest('.hud') && !t.closest('.endcard, .overview') && t.closest('button, label')) e.preventDefault();
      }}
    >
      <div ref={arena} className="arena" />

      {gpu === 'missing' || snap.arenaError ? <WebGpuRequired detail={snap.arenaError} /> : null}

      {hudShown ? (
        <div className="hud">
          <MatchClock controller={controller} snap={snap} />
          <div className="hud-actions">
            {origin ? (
              <button type="button" className="btn btn-sm origin-chip" onClick={() => onBackToGym(origin)} title="Back to the Gym, at the same report">
                <BackIcon size={13} />
                <span>{origin.label}</span>
              </button>
            ) : null}
            {snap.cameraManual ? (
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => controller.resetCamera()} title="Back to the director's camera (C)">
                Reset camera
              </button>
            ) : null}
            <ViewMenu controller={controller} view={snap.view} />
            <button type="button" className="btn btn-sm" onClick={() => setSetupOpen(true)} title="Pick map, format and fighters">
              New match
            </button>
          </div>
          {panels && hasMatch ? (
            <Scoreboard
              controller={controller}
              snap={snap}
              rows={rows}
              mapName={mapName}
              pane={scoreboardPane}
              setPane={setScoreboardPane}
              onSheet={(id) => openOverview(id)}
            />
          ) : null}
          {panels && !endShown ? <KillFeed controller={controller} snap={snap} shifted={selected !== null} onLink={setLinked} /> : null}
          {panels && selected && !endShown ? (
            <Inspector
              key={selected.id}
              controller={controller}
              snap={snap}
              fighter={selected}
              pane={inspectorPane}
              setPane={setInspectorPane}
              onExpand={() => openOverview(selected.id)}
            />
          ) : null}
          {showHover && hovered ? <HoverCard ref={cardRef} controller={controller} fighter={hovered} /> : null}
          {showObject && obj ? <ObjectCard ref={cardRef} key={`${obj.kind}:${obj.id}`} controller={controller} kind={obj.kind} id={obj.id} /> : null}
          {entered && hasMatch ? <Timeline controller={controller} snap={snap} highlight={linked} onHeight={setTimelineH} /> : null}
          {beat !== null ? (
            <div className={`countdown${snap.countdown === 0 ? ' fight' : ''}`} aria-live="assertive" key={beat}>
              {beat}
            </div>
          ) : null}
          {finale ? (
            <div className="finale" aria-live="assertive">
              <div className="finale-title">{finale.title}</div>
              {finale.name ? (
                <div className="finale-name" style={finale.color ? ({ '--who': finale.color } as CSSProperties) : undefined}>
                  {finale.name}
                </div>
              ) : null}
            </div>
          ) : null}
          {skippable(phase) ? (
            <div className="skip-catcher" onClick={() => controller.skip()} role="button" aria-label="Skip">
              <span>{phase === 'countdown' ? 'Space or click to start now' : 'Space or click for the result'}</span>
            </div>
          ) : null}
          {endShown ? (
            <EndCard
              ref={endRef}
              controller={controller}
              snap={snap}
              mapName={mapName}
              onNextMatch={() => nextMatch()}
              onClose={() => setEndOpen(false)}
              onSheet={(id) => openOverview(id)}
            />
          ) : null}
          {overview && overviewFighter && entered ? (
            <FighterOverview
              controller={controller}
              snap={snap}
              fighter={overviewFighter}
              strategy={strategyOf(overviewFighter.id)}
              tab={overview.tab}
              setTab={(tab) => setOverview((o) => (o ? { ...o, tab } : o))}
              onClose={closeOverview}
              onPip={setPip}
              onOpenInGym={onOpenInGym}
            />
          ) : null}
        </div>
      ) : null}

      {setupOpen ? (
        <MatchSetupDialog
          initial={{ ...setup, seed: randomSeed() }}
          currentSeed={hasMatch ? snap.seed : null}
          pool={pool}
          onClose={() => setSetupOpen(false)}
          onFight={(s) => {
            if (start(s)) setSetupOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

/** `detail`: why the renderer failed to start after an adapter was found (null when WebGPU is simply missing). */
function WebGpuRequired({ detail }: { detail: string | null }) {
  return (
    <div className="gpu-missing" role="alert">
      <h2>The arena needs WebGPU</h2>
      <p>
        This browser does not offer WebGPU, or it is switched off for this machine. Open the Pit in Chrome or Edge 113 or newer, Safari 26,
        or Firefox 141 on Windows, then reload.
      </p>
      {detail ? <p className="dim">{detail}</p> : null}
      <p className="dim">The Gym and the Room work without it: write strategies, run batches, read the reports.</p>
      <a className="btn" href="#gym">
        Open the Gym
      </a>
    </div>
  );
}
