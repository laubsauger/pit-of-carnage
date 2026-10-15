// Owned by: ui
import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_VIEW_SETTINGS } from '../../core';
import type { GameController, TimelineMark } from '../../core';
import { MAPS } from '../../sim';
import { useSnapshot, useWebGpu } from '../hooks';
import { cycleFighter, hoverCardPosition, nextFollow, sortScoreboard } from '../hud';
import { isEditableTarget, keyToAction } from '../keys';
import { buildMatchConfig, randomSeed } from '../setup';
import type { MatchSetup, PoolEntry } from '../setup';
import { toast } from '../toast';
import { describeView, toggleView } from '../view';
import { EndCard } from './EndCard';
import { HoverCard } from './HoverCard';
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
  setup: MatchSetup;
  setSetup: (s: MatchSetup) => void;
  pool: PoolEntry[];
};

/** Let the final kill land (director slow-mo) before the result card covers the arena. */
const END_CARD_DELAY_MS = 1600;

export function WatchScreen({ controller, active, setup, setSetup, pool }: Props) {
  const gpu = useWebGpu();
  const snap = useSnapshot(controller);
  const root = useRef<HTMLDivElement>(null);
  const arena = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement | null>(null);
  const pointer = useRef({ x: -9999, y: -9999 });
  const [overArena, setOverArena] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
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
        controller.startMatch(config);
        controller.setPaused(false);
        return true;
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Could not start the match.');
        return false;
      }
    },
    [controller, pool, setSetup],
  );

  const nextMatch = useCallback(() => start({ ...setup, seed: randomSeed() }), [start, setup]);

  // Autoplay: the first visit to Watch starts a match unless one is already loaded (for example a
  // gym match opened with "Watch").
  const started = useRef(false);
  useEffect(() => {
    if (!active || gpu !== 'ok' || started.current) return;
    started.current = true;
    if (controller.getSnapshot().fighters.length === 0) nextMatch();
  }, [active, gpu, controller, nextMatch]);

  // Leaving Watch pauses the match (nobody is watching, and the gym wants the CPU); coming back
  // resumes it only if we were the ones who paused it.
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
  }, [active, controller]);

  // End card: shown a moment after the match ends; closing it lets you look around until the next
  // ending (seeking back and replaying to the end shows it again).
  useEffect(() => {
    if (!snap.finished) {
      setEndOpen(false);
      return;
    }
    const t = window.setTimeout(() => setEndOpen(true), END_CARD_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [snap.finished]);

  const rows = sortScoreboard(snap.fighters, snap.format);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const modal = setupOpen || endOpen;

  useEffect(() => {
    if (!active || gpu !== 'ok') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const action = keyToAction({
        key: e.key,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        editable: isEditableTarget(e.target),
      });
      if (!action) return;
      if (modal) {
        // Dialogs keep the keyboard. Escape closes the end card; the setup dialog handles its own.
        if (action.type === 'deselect' && endOpen) {
          e.preventDefault();
          setEndOpen(false);
        }
        return;
      }
      e.preventDefault();
      const s = controller.getSnapshot();
      switch (action.type) {
        case 'cycle': {
          const id = cycleFighter(rowsRef.current, s.selectedId, action.dir);
          controller.select(id);
          // Tab while following hands the camera to the next fighter too.
          if (s.followId !== null) controller.follow(id);
          break;
        }
        case 'follow':
          controller.follow(nextFollow(s.selectedId, s.followId));
          break;
        case 'pause':
          controller.setPaused(!s.paused);
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
          if (s.selectedId !== null) controller.select(null);
          else if (s.followId !== null) controller.follow(null);
          break;
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
  }, [active, gpu, controller, modal, endOpen]);

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

  const mapName = MAPS[snap.mapId]?.name ?? snap.mapId;
  const selected = snap.selectedId ? snap.fighters.find((f) => f.id === snap.selectedId) ?? null : null;
  const hovered = snap.hoveredId ? snap.fighters.find((f) => f.id === snap.hoveredId) ?? null : null;
  const showHover = hovered !== null && overArena && hovered.id !== snap.selectedId && !modal;
  const hasMatch = snap.fighters.length > 0;

  return (
    <div
      ref={root}
      className="watch"
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
        if (t.closest('.hud') && !t.closest('.endcard') && t.closest('button, label')) e.preventDefault();
      }}
    >
      <div ref={arena} className="arena" />

      {gpu === 'missing' || snap.arenaError ? <WebGpuRequired detail={snap.arenaError} /> : null}

      {active && gpu === 'ok' && !snap.arenaError ? (
        <div className="hud">
          <MatchClock controller={controller} snap={snap} />
          <div className="hud-actions">
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
          {hasMatch ? <Scoreboard controller={controller} snap={snap} rows={rows} mapName={mapName} /> : null}
          <KillFeed controller={controller} snap={snap} shifted={selected !== null} onLink={setLinked} />
          {selected ? <Inspector key={selected.id} controller={controller} snap={snap} fighter={selected} /> : null}
          {showHover && hovered ? <HoverCard ref={cardRef} controller={controller} fighter={hovered} /> : null}
          {hasMatch ? <Timeline controller={controller} snap={snap} highlight={linked} /> : null}
          {endOpen ? (
            <EndCard
              controller={controller}
              snap={snap}
              mapName={mapName}
              onNextMatch={() => nextMatch()}
              onClose={() => setEndOpen(false)}
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
        This browser does not offer WebGPU, or it is switched off for this machine. Open the Pit in a current Chrome, Edge or
        Safari with WebGPU enabled, then reload.
      </p>
      {detail ? <p className="dim">{detail}</p> : null}
      <p className="dim">The Gym and the Room work without it: write strategies, run batches, read the reports.</p>
      <a className="btn" href="#gym">
        Open the Gym
      </a>
    </div>
  );
}
