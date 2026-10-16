// Owned by: ui
// App shell: top bar with the three screens. The Watch arena stays mounted under the Gym and Room
// screens, and those stay mounted while hidden, so a running batch or a half-written strategy
// survives switching tabs.
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { rulesFromConfig } from '../core';
import type { BackgroundJob, GameController, Lineup, LineupSource, MatchConfig, MatchRules, QuickMatchup, Strategy } from '../core';
import { HOUSE_STACKS } from '../strategy';
import { ErrorBoundary } from './ErrorBoundary';
import { GymScreen } from './gym/GymScreen';
import type { GymTab } from './gym/GymScreen';
import { useHashScreen, useSavedStrategies, useSnapshot, useStoredState, useWebGpu } from './hooks';
import type { Screen } from './hooks';
import { RoomScreen } from './room/RoomScreen';
import { BRAND_URL } from './brand';
import { codexIdFromHash } from './codexLink';
import { isEditableTarget } from './keys';
import { MATCHUP_STORAGE_KEY, defaultMatchup, lineupForWatch, sanitizeMatchup, storeMatchup } from './lineup';
import type { StoredMatchup } from './lineup';
import { SplashScreen } from './SplashScreen';
import { Toaster, toast } from './toast';
import { WatchScreen } from './watch/WatchScreen';
import './theme.css';

// The Codex (every rule, sensor and word) loads on first open, with the editor's CodeMirror-free card code.
const CodexDialog = lazy(() => import('./codex/Codex').then((m) => ({ default: m.CodexDialog })));

const TABS: { id: Screen; label: string }[] = [
  { id: 'watch', label: 'Watch' },
  { id: 'gym', label: 'Gym' },
  { id: 'room', label: 'Room' },
];

/** Where a match watched from the Gym came from, so the Watch screen can lead back to it. */
export type WatchOrigin = {
  /** "Test report, match 7 of 20". */
  label: string;
  tab: 'test' | 'evolve';
  /** Row in the batch report's match list to bring back into view, or null. */
  matchIndex: number | null;
};

/**
 * Open a match in the arena. `tick`: start there instead of at the countdown (a kill or a death
 * with its lead-in). `focusId`: select that fighter, which narrows the timeline to their moments.
 */
export type WatchRequest = {
  config: MatchConfig;
  tick?: number;
  focusId?: string | null;
  origin?: WatchOrigin | null;
  /**
   * The strategies the player brought in (`strategyKey`s: the ones under test, the editor's draft):
   * pinned in the lineup with `source`, so "Next match" keeps them. Without it every entrant is kept.
   */
  pin?: { keys: readonly string[]; source: LineupSource };
};

/**
 * The match the UI last put in the arena: each fighter's strategy in entrant order (fighter i is
 * entrant i), the seed it was started with (a match started elsewhere has another), and the gym
 * report it came from.
 */
export type CurrentMatch = { strategies: readonly Strategy[]; seed: number; origin: WatchOrigin | null };

/** How the Watch screen starts matches; each throws when the gate refuses a strategy. */
export type MatchStarter = {
  /** Quick matchup's Fight, and the first match from the stored matchup. */
  matchup: (m: QuickMatchup) => void;
  /** Same lineup, new seed (the next map with rotation on). */
  next: () => void;
  /** Redraw the unpinned field, then play. */
  shuffle: () => void;
};

const asGymTab = (v: unknown, fallback: GymTab): GymTab => (v === 'editor' || v === 'test' || v === 'evolve' ? v : fallback);

type Props = {
  controller: GameController;
  /** House stacks offered for match slots and gym fields. Defaults to the built-in set. */
  houseStacks?: readonly Strategy[];
};

export function App({ controller, houseStacks = HOUSE_STACKS }: Props) {
  const [screen, go] = useHashScreen();
  const gpu = useWebGpu();
  const [saved, refreshSaved] = useSavedStrategies(controller);
  // The lineup and rules kept between visits: the player's picks stay pinned across reloads.
  const [matchup, setMatchup] = useStoredState<StoredMatchup>(MATCHUP_STORAGE_KEY, defaultMatchup, sanitizeMatchup);
  const [gymTab, setGymTab] = useStoredState<GymTab>('poc.gym.tab', () => 'editor', asGymTab);
  const [current, setCurrent] = useState<CurrentMatch | null>(null);
  // "Quick matchup" in the top bar: numbered so the same request twice still opens it.
  const [matchupRequest, setMatchupRequest] = useState(0);
  // Requests into the Gym, numbered so the same request twice still lands.
  const [reportFocus, setReportFocus] = useState<{ matchIndex: number | null; n: number } | null>(null);
  const [openRequest, setOpenRequest] = useState<{ strategy: Strategy; n: number } | null>(null);
  // The Codex over any screen: the top-bar entry, the ? key and #codex/<kind>/<word> links.
  const [codexAt, setCodexAt] = useState<string | null>(() => codexIdFromHash(window.location.hash));
  useEffect(() => {
    const onHash = () => {
      const id = codexIdFromHash(window.location.hash);
      if (id !== null) setCodexAt(id);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return;
      e.preventDefault();
      setCodexAt((at) => (at === null ? '' : at));
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  const closeCodex = useCallback(() => {
    setCodexAt(null);
    // Back to where the player was: the screen's own hash, without a history entry for the link.
    if (codexIdFromHash(window.location.hash) !== null) window.history.replaceState(null, '', `#${screen}`);
  }, [screen]);

  /**
   * After every start: what is playing (the controller's lineup is the filled one, in entrant order)
   * and the matchup to keep (the lineup is whatever the last match used, from any source).
   */
  const remember = useCallback(
    (origin: WatchOrigin | null, rules: MatchRules) => {
      const lineup: Lineup = controller.getLineup();
      setCurrent({ strategies: lineup.fighters.map((f) => f.strategy), seed: controller.getSnapshot().seed, origin });
      setMatchup(storeMatchup(lineup, rules));
    },
    [controller, setMatchup],
  );

  /** A match from a config (gym, editor): it brings its lineup with it. Throws when the gate refuses it. */
  const play = useCallback(
    (config: MatchConfig, origin: WatchOrigin | null = null, lineup?: Lineup) => {
      controller.startMatch(config, lineup);
      remember(origin, { ...rulesFromConfig(config), rotateMaps: matchup.rules.rotateMaps });
    },
    [controller, remember, matchup.rules.rotateMaps],
  );

  const starter = useMemo<MatchStarter>(
    () => ({
      matchup: (m) => {
        controller.startMatchup(m);
        remember(null, m.rules);
      },
      next: () => {
        controller.nextMatch();
        remember(null, { ...matchup.rules, mapId: controller.getSnapshot().mapId });
      },
      shuffle: () => {
        controller.shuffleField();
        controller.nextMatch();
        remember(null, { ...matchup.rules, mapId: controller.getSnapshot().mapId });
      },
    }),
    [controller, remember, matchup.rules],
  );

  // Watch a match from the Gym. A config the controller refuses (a strategy that fails the gate)
  // stays on the Gym with the reason instead of switching to an empty arena.
  const watch = useCallback(
    (req: WatchRequest) => {
      try {
        const lineup = req.pin ? lineupForWatch(req.config, new Set(req.pin.keys), req.pin.source, houseStacks) : undefined;
        play(req.config, req.origin ?? null, lineup);
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Could not start the match.');
        return;
      }
      controller.setPaused(false);
      if (req.tick !== undefined && req.tick > 0) {
        // Straight to the moment: no countdown in front of a replayed death.
        controller.skip();
        controller.seek(req.tick);
      }
      if (req.focusId) controller.select(req.focusId);
      go('watch');
    },
    [controller, go, play, houseStacks],
  );

  const backToGym = useCallback(
    (origin: WatchOrigin) => {
      setGymTab(origin.tab);
      setReportFocus((prev) => ({ matchIndex: origin.matchIndex, n: (prev?.n ?? 0) + 1 }));
      go('gym');
    },
    [go, setGymTab],
  );

  const openInGym = useCallback(
    (strategy: Strategy) => {
      setOpenRequest((prev) => ({ strategy, n: (prev?.n ?? 0) + 1 }));
      setGymTab('editor');
      go('gym');
    },
    [go, setGymTab],
  );

  const openJob = useCallback(
    (job: BackgroundJob) => {
      setGymTab(job.kind === 'batch' ? 'test' : 'evolve');
      go('gym');
    },
    [go, setGymTab],
  );

  return (
    <div className="poc" data-screen={screen}>
      <header className="topbar">
        <a className="wordmark" href="#watch" aria-label="Pit of Carnage">
          <img className="emblem" src={`${BRAND_URL}emblem.webp`} alt="" width={30} height={30} draggable={false} />
          <span className="wordmark-text">Pit of Carnage</span>
        </a>
        <nav className="tabs" aria-label="Screens">
          {TABS.map((t) => (
            <a key={t.id} href={`#${t.id}`} aria-current={screen === t.id ? 'page' : undefined}>
              {t.label}
            </a>
          ))}
          <button
            type="button"
            className="tab-matchup"
            onClick={() => {
              go('watch');
              setMatchupRequest((n) => n + 1);
            }}
            title="Set up a fight: your fighters (saved, files, pasted codes), map, format, rules and seed"
          >
            <span className="long">Quick </span>matchup
          </button>
          <a href="#codex" className="tab-codex" title="The Codex: every rule, sensor, place and word, with examples (?)">
            Codex
          </a>
        </nav>
        <JobsChip controller={controller} onOpen={openJob} />
      </header>
      <main className="stage">
        {/* Most of the Watch HUD hangs off the selected fighter, so a retry starts without one. */}
        <ErrorBoundary label="Watch" onReset={() => controller.select(null)}>
          <WatchScreen
            controller={controller}
            active={screen === 'watch'}
            gpu={gpu}
            matchup={matchup}
            houseStacks={houseStacks}
            saved={saved}
            current={current}
            starter={starter}
            matchupRequest={matchupRequest}
            onBackToGym={backToGym}
            onOpenInGym={openInGym}
          />
        </ErrorBoundary>
        <section className="screen" hidden={screen !== 'gym'} aria-label="Gym">
          <ErrorBoundary label="Gym">
            <GymScreen
              controller={controller}
              active={screen === 'gym'}
              houseStacks={houseStacks}
              saved={saved}
              refreshSaved={refreshSaved}
              tab={gymTab}
              setTab={setGymTab}
              reportFocus={reportFocus}
              openRequest={openRequest}
              onWatch={watch}
            />
          </ErrorBoundary>
        </section>
        <section className="screen" hidden={screen !== 'room'} aria-label="Room">
          <ErrorBoundary label="Room">
            <RoomScreen controller={controller} active={screen === 'room'} />
          </ErrorBoundary>
        </section>
      </main>
      {codexAt !== null ? (
        <Suspense fallback={null}>
          {/* Keyed by the entry: a new link while it is open jumps to that entry. */}
          <CodexDialog key={codexAt} initial={codexAt} build={null} onClose={closeCodex} />
        </Suspense>
      ) : null}
      <SplashScreen controller={controller} gpu={gpu} onOpenGym={() => go('gym')} />
      <Toaster />
    </div>
  );
}

/**
 * Running gym jobs, on every screen: a progress ring and the job's own line ("Evolving: gen 4 of
 * 20"). Clicking returns to the job's tab. Subscribes on its own so the shell does not re-render.
 */
function JobsChip({ controller, onOpen }: { controller: GameController; onOpen: (job: BackgroundJob) => void }) {
  const { jobs } = useSnapshot(controller);
  if (jobs.length === 0) return null;
  return (
    <div className="jobs" aria-label="Gym jobs running">
      {jobs.map((job) => {
        const frac = job.total > 0 ? Math.min(1, job.done / job.total) : 0;
        return (
          <button key={job.id} type="button" className="job-chip" onClick={() => onOpen(job)} title={`${job.label}. Open the Gym's ${job.kind === 'batch' ? 'Test' : 'Evolve'} tab.`}>
            <ProgressRing fraction={frac} />
            <span className="job-long">{job.label}</span>
            {/* On Watch the match clock owns the top bar's centre: the chip shrinks to its count. */}
            <span className="job-short">{job.kind === 'evolve' ? `Gen ${Math.min(job.done + 1, job.total)}/${job.total}` : `${job.done}/${job.total}`}</span>
          </button>
        );
      })}
    </div>
  );
}

function ProgressRing({ fraction, size = 16 }: { fraction: number; size?: number }) {
  const r = size / 2 - 2;
  const c = 2 * Math.PI * r;
  return (
    <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--stone-4)" strokeWidth={2} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--blood)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={`${(fraction * c).toFixed(2)} ${c.toFixed(2)}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
