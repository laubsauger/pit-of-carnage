// Owned by: ui
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { DEFAULT_VIEW_SETTINGS, NO_VIEW_INSETS } from '../../core';
import type { GameController, QuickMatchup, SavedStrategy, Strategy, TimelineMark, ViewInsets } from '../../core';
import { MAPS } from '../../sim';
import type { CurrentMatch, MatchStarter, WatchOrigin } from '../App';
import { codexHash, objectCodexId } from '../codexLink';
import { useNarrow, usePane, useSnapshot, useStoredState } from '../hooks';
import type { WebGpuStatus } from '../hooks';
import {
  NARROW_PX, countdownText, cycleFighter, finaleStamp, hoverCardPosition, hudFolds, insetsAround, nextFollow, sameInsets, skippable, sortScoreboard, watchInsets,
} from '../hud';
import { BackIcon } from '../icons';
import { exitsCinematic, isEditableTarget, keyToAction, modalOpen } from '../keys';
import { lineupOfStored } from '../lineup';
import type { StoredMatchup } from '../lineup';
import { paneExtent } from '../panes';
import type { PaneState } from '../panes';
import { randomSeed } from '../setup';
import { toast } from '../toast';
import { describeView, toggleView } from '../view';
import { EdgeTab, ThinTimeline } from './Edges';
import { EndCard } from './EndCard';
import { FighterOverview } from './FighterOverview';
import type { OverviewTab } from './FighterOverview';
import { HoverCard, ObjectCard } from './HoverCard';
import { Inspector } from './Inspector';
import { KillFeed } from './KillFeed';
import { MatchClock } from './MatchClock';
import { KeyboardHelp } from './KeyboardHelp';
import { QuickMatchupDialog } from './QuickMatchup';
import { Scoreboard } from './Scoreboard';
import { Timeline } from './Timeline';
import { ViewMenu } from './ViewMenu';

type Props = {
  controller: GameController;
  /** The Watch tab is showing. The arena stays mounted underneath the other screens. */
  active: boolean;
  gpu: WebGpuStatus;
  /** The lineup and rules kept between visits (the first match plays them). */
  matchup: StoredMatchup;
  houseStacks: readonly Strategy[];
  saved: readonly SavedStrategy[];
  /** The match the UI last started (its strategies, and the gym report it came from). */
  current: CurrentMatch | null;
  /** Starts matches (each throws when the gate refuses a strategy). */
  starter: MatchStarter;
  /** "Quick matchup" from the top bar: a new number opens the dialog. */
  matchupRequest: number;
  onBackToGym: (origin: WatchOrigin) => void;
  onOpenInGym: (s: Strategy) => void;
};

/** CSS --gutter: panels sit this far in from the arena's edges. */
const GUTTER = 12;
/** Height of the folded timeline bar (CSS .tl-thin), for the camera's bottom inset. */
const THIN_TIMELINE_PX = 6;

export function WatchScreen({ controller, active, gpu, matchup, houseStacks, saved, current, starter, matchupRequest, onBackToGym, onOpenInGym }: Props) {
  const snap = useSnapshot(controller);
  const root = useRef<HTMLDivElement>(null);
  const arena = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement | null>(null);
  const pointer = useRef({ x: -9999, y: -9999 });
  const [overArena, setOverArena] = useState(false);
  // Quick matchup, with any .json files dropped on the arena to add at once.
  const [matchupOpen, setMatchupOpen] = useState<{ files: File[] } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [feedCollapsed, setFeedCollapsed] = useStoredState<boolean>('poc.watch.feed.collapsed', () => false, (v, d) => (typeof v === 'boolean' ? v : d));
  const narrow = useNarrow(NARROW_PX);
  // On a narrow screen scoreboard and feed start folded; opening one keeps it open until the screen widens.
  const [opened, setOpened] = useState({ scoreboard: false, feed: false });
  useEffect(() => setOpened({ scoreboard: false, feed: false }), [narrow]);
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

  /** Run one of the starter's moves; a strategy the gate refuses becomes a toast, not a blank arena. */
  const start = useCallback(
    (go: () => void) => {
      try {
        go();
        controller.setPaused(false);
        return true;
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Could not start the match.');
        return false;
      }
    },
    [controller],
  );
  const nextMatch = useCallback(() => start(starter.next), [start, starter]);
  const shuffle = useCallback(() => start(starter.shuffle), [start, starter]);
  const fightMatchup = useCallback((m: QuickMatchup) => start(() => starter.matchup(m)), [start, starter]);

  // The first match is built as soon as WebGPU is confirmed, whatever screen is showing: the splash
  // counts it as a loading stage, and it waits behind the splash for "Enter the pit". It plays the
  // kept matchup (the player's pinned picks and rules). A match already loaded (a gym match opened
  // with Watch) is left alone.
  const started = useRef(false);
  const firstMatchup = useRef(matchup);
  useEffect(() => {
    if (gpu !== 'ok' || started.current) return;
    started.current = true;
    if (controller.getSnapshot().fighters.length > 0) return;
    const m = firstMatchup.current;
    // A kept pick that no longer fights (a stricter gate after an update) must not leave the arena empty.
    if (!fightMatchup({ lineup: lineupOfStored(m), rules: m.rules, seed: randomSeed() })) fightMatchup({ lineup: { fighters: [], size: m.size }, rules: m.rules, seed: randomSeed() });
  }, [gpu, controller, fightMatchup]);

  // The top bar's "Quick matchup".
  const lastRequest = useRef(matchupRequest);
  useEffect(() => {
    if (matchupRequest === lastRequest.current) return;
    lastRequest.current = matchupRequest;
    setMatchupOpen({ files: [] });
  }, [matchupRequest]);

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

  const modal = matchupOpen !== null;
  const phase = snap.phase;
  const cinematic = snap.view.cinematic;

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
      // Quick matchup keeps the keyboard and handles its own Escape; so does any dialog showing over
      // the arena (the Codex). The Gym's import dialog on the hidden Gym screen does not count.
      if (modal || modalOpen(document)) return;
      e.preventDefault();
      // Keys that ask for a panel bring the HUD back from cinematic view.
      if (s.view.cinematic && exitsCinematic(action)) controller.setView({ cinematic: false });
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
          if (helpOpen) setHelpOpen(false);
          else if (overview) closeOverview();
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
  }, [active, gpu, controller, modal, endOpen, helpOpen, overview, openOverview, closeOverview]);

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
  const objectEntry = obj ? objectCodexId(MAPS[snap.mapId] ?? null, obj.kind, obj.id) : null;
  const endShown = panels && endOpen;
  const folds = hudFolds({
    cinematic,
    narrow,
    scoreboardCollapsed: scoreboardPane.collapsed,
    feedCollapsed,
    inspectorCollapsed: inspectorPane.collapsed,
    opened,
  });
  // Folded panes are drawn as their rails; opening one from its rail leaves cinematic view.
  const shownScoreboard: PaneState = folds.scoreboard ? { ...scoreboardPane, collapsed: true } : scoreboardPane;
  const shownInspector: PaneState = folds.inspector ? { ...inspectorPane, collapsed: true } : inspectorPane;
  const unfold = (which: 'scoreboard' | 'feed') => {
    if (cinematic) controller.setView({ cinematic: false });
    setOpened((o) => ({ ...o, [which]: true }));
  };
  const setScoreboard = (fn: (p: PaneState) => PaneState) => {
    const next = fn(shownScoreboard);
    if (!next.collapsed) unfold('scoreboard');
    setScoreboardPane(next);
  };
  const setInspector = (fn: (p: PaneState) => PaneState) => {
    const next = fn(shownInspector);
    if (!next.collapsed && cinematic) controller.setView({ cinematic: false });
    setInspectorPane(next);
  };

  // Report what the HUD covers, so the camera frames the action in the part of the arena in view.
  // Cinematic view reports no panels: the folded edges are thin and the camera gets the whole canvas.
  const insets = useRef<ViewInsets>({ ...NO_VIEW_INSETS });
  useEffect(() => {
    if (gpu !== 'ok') return;
    let next: ViewInsets;
    if (overview && pip && arena.current) next = insetsAround(arena.current.getBoundingClientRect(), pip);
    // Cinematic: only the end card, which still slides in over the arena, takes room.
    else if (!folds.reportInsets) next = watchInsets({ scoreboard: null, inspector: null, endCard: endShown ? endW : null, timeline: null }, GUTTER);
    else
      next = watchInsets(
        {
          scoreboard: panels && hasMatch ? paneExtent(shownScoreboard) : null,
          inspector: panels && selected ? paneExtent(shownInspector) : null,
          endCard: endShown ? endW : null,
          timeline: hudShown && entered && hasMatch ? (folds.thinTimeline ? THIN_TIMELINE_PX : timelineH) : null,
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

  // The fighter's strategy, from what the UI started: fighter i is entrant i. Checked against the
  // live match, so a match started elsewhere never shows the wrong strategy.
  const strategyOf = (id: string): Strategy | null => {
    if (!current || current.seed !== snap.seed || current.strategies.length !== snap.fighters.length) return null;
    const i = snap.fighters.findIndex((f) => f.id === id);
    return i < 0 ? null : current.strategies[i] ?? null;
  };
  const origin = current?.origin ?? null;
  const beat = countdownText(snap.countdown);
  const finale = finaleStamp(snap);
  // A press that ends where it started is a click (a drag pans the camera).
  const pressAt = useRef<{ x: number; y: number } | null>(null);

  return (
    <div
      ref={root}
      className={`watch${cinematic ? ' cinematic' : ''}`}
      style={{ '--ins-w': `${paneExtent(shownInspector)}px`, '--sb-w': `${paneExtent(shownScoreboard)}px` } as CSSProperties}
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
        if (t.closest('.hud') && !t.closest('.endcard, .overview, .kbd-help') && t.closest('button, label')) e.preventDefault();
      }}
      onDragOver={(e) => {
        // Files are always taken here: a file dropped anywhere else would make the browser leave the game to show it.
        if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        // .json files dropped on the arena open Quick matchup with them added (several at once);
        // an open Quick matchup takes its own drops.
        if (!modal) setMatchupOpen({ files: [...e.dataTransfer.files] });
      }}
    >
      <div
        ref={arena}
        className="arena"
        onPointerDown={(e) => {
          pressAt.current = { x: e.clientX, y: e.clientY };
        }}
        onClickCapture={(e) => {
          // A click on a map object opens its Codex entry (its card says so). Captured before the
          // canvas sees it, so the click does not also drop the selection.
          const p = pressAt.current;
          const still = p !== null && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 4;
          if (!still || !showObject || !objectEntry) return;
          e.stopPropagation();
          window.location.hash = codexHash(objectEntry);
        }}
      />

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
            <button
              type="button"
              className="btn btn-sm btn-quiet cine-toggle"
              aria-pressed={cinematic}
              onClick={() => controller.setView({ cinematic: !cinematic })}
              title={cinematic ? 'Bring the HUD back (V)' : 'Cinematic view: fold the panels to the edges, keep the clock (V)'}
            >
              {cinematic ? 'Show HUD' : 'Cinematic'}
            </button>
            <button type="button" className="btn btn-sm btn-quiet keys-btn" aria-pressed={helpOpen} onClick={() => setHelpOpen((o) => !o)} title="Every keyboard shortcut">
              Keys
            </button>
            <ViewMenu controller={controller} view={snap.view} onShowKeys={() => setHelpOpen(true)} />
          </div>
          {panels && hasMatch ? (
            <Scoreboard
              controller={controller}
              snap={snap}
              rows={rows}
              mapName={mapName}
              pane={shownScoreboard}
              setPane={setScoreboard}
              onSheet={(id) => openOverview(id)}
            />
          ) : null}
          {panels && !endShown ? (
            folds.feed ? (
              <EdgeTab
                side="right"
                className={`feed-tab${selected ? ' shifted' : ''}`}
                label="Feed"
                count={snap.feed.filter((f) => f.tick <= snap.tick).length}
                title={cinematic ? 'Show the HUD again (V)' : 'Show the kill feed'}
                onOpen={() => {
                  setFeedCollapsed(false);
                  unfold('feed');
                }}
              />
            ) : (
              <KillFeed controller={controller} snap={snap} shifted={selected !== null} onLink={setLinked} onCollapse={() => setFeedCollapsed(true)} />
            )
          ) : null}
          {panels && selected && !endShown ? (
            <Inspector
              key={selected.id}
              controller={controller}
              snap={snap}
              fighter={selected}
              pane={shownInspector}
              setPane={setInspector}
              onExpand={() => openOverview(selected.id)}
            />
          ) : null}
          {showHover && hovered ? <HoverCard ref={cardRef} controller={controller} fighter={hovered} /> : null}
          {showObject && obj ? <ObjectCard ref={cardRef} key={`${obj.kind}:${obj.id}`} controller={controller} kind={obj.kind} id={obj.id} codex={objectEntry !== null} /> : null}
          {entered && hasMatch ? (
            folds.thinTimeline ? (
              <ThinTimeline controller={controller} snap={snap} />
            ) : (
              <Timeline controller={controller} snap={snap} highlight={linked} onHeight={setTimelineH} />
            )
          ) : null}
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
              onNextMatch={nextMatch}
              onShuffle={shuffle}
              onMatchup={() => setMatchupOpen({ files: [] })}
              onClose={() => setEndOpen(false)}
              onSheet={(id) => openOverview(id)}
            />
          ) : null}
          {helpOpen ? <KeyboardHelp onClose={() => setHelpOpen(false)} /> : null}
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

      {matchupOpen ? (
        <QuickMatchupDialog
          initial={{
            lineup: controller.getLineup().fighters.length > 0 ? controller.getLineup() : lineupOfStored(matchup),
            rules: matchup.rules,
            seed: randomSeed(),
          }}
          currentSeed={hasMatch && snap.source === 'local' ? snap.seed : null}
          houseStacks={houseStacks}
          saved={saved}
          initialFiles={matchupOpen.files}
          onClose={() => setMatchupOpen(null)}
          onFight={fightMatchup}
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
