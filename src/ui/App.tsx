// Owned by: ui
// App shell: top bar with the three screens. The Watch arena stays mounted under the Gym and Room
// screens, and those stay mounted while hidden, so a running batch or a half-written strategy
// survives switching tabs.
import { useCallback, useMemo } from 'react';
import type { GameController, MatchConfig, Strategy } from '../core';
import { HOUSE_STACKS } from '../strategy';
import { ErrorBoundary } from './ErrorBoundary';
import { GymScreen } from './gym/GymScreen';
import { useHashScreen, useSavedStrategies, useStoredState } from './hooks';
import type { Screen } from './hooks';
import { RoomScreen } from './room/RoomScreen';
import { buildPool, defaultSetup, randomSeed, sanitizeSetup } from './setup';
import { Toaster, toast } from './toast';
import { WatchScreen } from './watch/WatchScreen';
import './theme.css';

const TABS: { id: Screen; label: string }[] = [
  { id: 'watch', label: 'Watch' },
  { id: 'gym', label: 'Gym' },
  { id: 'room', label: 'Room' },
];

type Props = {
  controller: GameController;
  /** House stacks offered for match slots and gym fields. Defaults to the built-in set. */
  houseStacks?: readonly Strategy[];
};

export function App({ controller, houseStacks = HOUSE_STACKS }: Props) {
  const [screen, go] = useHashScreen();
  const [saved, refreshSaved] = useSavedStrategies(controller);
  const pool = useMemo(() => buildPool(houseStacks, saved), [houseStacks, saved]);
  const [setup, setSetup] = useStoredState('poc.setup.v1', () => defaultSetup(randomSeed()), sanitizeSetup);

  // Watch a match from the Gym. A config the controller refuses (a strategy that fails the gate)
  // stays on the Gym with the reason instead of switching to an empty arena.
  const watch = useCallback(
    (config: MatchConfig) => {
      try {
        controller.startMatch(config);
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Could not start the match.');
        return;
      }
      controller.setPaused(false);
      go('watch');
    },
    [controller, go],
  );

  return (
    <div className="poc">
      <header className="topbar">
        <a className="wordmark" href="#watch" aria-label="Pit of Carnage">
          <i aria-hidden />
          Pit of Carnage
        </a>
        <nav className="tabs" aria-label="Screens">
          {TABS.map((t) => (
            <a key={t.id} href={`#${t.id}`} aria-current={screen === t.id ? 'page' : undefined}>
              {t.label}
            </a>
          ))}
        </nav>
      </header>
      <main className="stage">
        {/* Most of the Watch HUD hangs off the selected fighter, so a retry starts without one. */}
        <ErrorBoundary label="Watch" onReset={() => controller.select(null)}>
          <WatchScreen controller={controller} active={screen === 'watch'} setup={setup} setSetup={setSetup} pool={pool} />
        </ErrorBoundary>
        <section className="screen" hidden={screen !== 'gym'} aria-label="Gym">
          <ErrorBoundary label="Gym">
            <GymScreen controller={controller} houseStacks={houseStacks} saved={saved} refreshSaved={refreshSaved} onWatch={watch} />
          </ErrorBoundary>
        </section>
        <section className="screen" hidden={screen !== 'room'} aria-label="Room">
          <ErrorBoundary label="Room">
            <RoomScreen controller={controller} active={screen === 'room'} />
          </ErrorBoundary>
        </section>
      </main>
      <Toaster />
    </div>
  );
}
