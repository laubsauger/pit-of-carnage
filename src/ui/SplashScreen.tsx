// Owned by: ui
// Drives the static splash in index.html (it paints before any script): real loading progress,
// "Enter the pit" (the first user gesture, so sound can start), or the no-WebGPU message. The
// markup and its styles live in index.html; this only fills in the parts that change.
import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GameController } from '../core';
import { useSnapshot } from './hooks';
import type { WebGpuStatus } from './hooks';
import { splashView } from './splash';

/** Matches the splash's fade in index.html. */
const FADE_MS = 650;

type Props = {
  controller: GameController;
  gpu: WebGpuStatus;
  /** Without WebGPU the Gym and the Room still work; the message offers the way there. */
  onOpenGym: () => void;
};

export function SplashScreen({ controller, gpu, onOpenGym }: Props) {
  const snap = useSnapshot(controller);
  const [dismissed, setDismissed] = useState(false);
  // The UI dev harness has no static splash; then there is nothing to drive.
  const [root] = useState(() => (typeof document === 'undefined' ? null : document.getElementById('splash')));
  const view = splashView(snap, gpu, dismissed);
  const action = root?.querySelector<HTMLElement>('#splash-action') ?? null;

  useLayoutEffect(() => {
    if (!root) return;
    const fill = root.querySelector<HTMLElement>('#splash-fill');
    const stage = root.querySelector<HTMLElement>('#splash-stage');
    if (fill) fill.style.transform = `scaleX(${Math.max(0.04, view.progress)})`;
    if (stage) stage.textContent = view.stage;
    root.dataset.mode = view.mode;
    root.setAttribute('aria-label', view.mode === 'loading' ? 'Pit of Carnage is loading' : 'Pit of Carnage');
  }, [root, view.progress, view.stage, view.mode]);

  // Fade into the countdown, then take the splash out of the way for good.
  useEffect(() => {
    if (!root || view.mode !== 'gone') return;
    root.classList.add('splash-out');
    const t = window.setTimeout(() => {
      root.hidden = true;
    }, FADE_MS);
    return () => window.clearTimeout(t);
  }, [root, view.mode]);

  // Enter and Space work anywhere on the splash, not only on the focused button. Captured first so
  // the Watch screen's Space (pause) never sees the key that entered the pit.
  useEffect(() => {
    if (!root || view.mode !== 'ready') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      controller.enter();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [root, view.mode, controller]);

  if (!root || !action || view.mode === 'gone' || view.mode === 'loading') return null;

  const toGym = () => {
    // Still a user gesture: sound may start, and the splash goes away for good.
    controller.enter();
    setDismissed(true);
    onOpenGym();
  };

  return createPortal(
    view.mode === 'ready' ? (
      <div className="splash-ready">
        <button type="button" className="splash-enter" autoFocus onClick={() => controller.enter()}>
          Enter the pit
        </button>
        <span className="splash-hint">or press Enter</span>
      </div>
    ) : (
      <div className="splash-message" role="alert">
        <h2>{view.mode === 'nogpu' ? 'The arena needs WebGPU' : 'The arena would not start'}</h2>
        {view.mode === 'nogpu' ? (
          <p>
            This browser does not offer WebGPU, or it is switched off on this machine. Open the Pit in Chrome or Edge 113 or newer,
            Safari 26, or Firefox 141 on Windows, then reload.
          </p>
        ) : (
          <p>
            WebGPU is here, but the renderer failed to start: <span className="splash-detail">{snap.arenaError}</span>
          </p>
        )}
        <p className="splash-dim">The Gym and the Room work without it: write strategies, run batches, read the reports.</p>
        <div className="splash-buttons">
          <button type="button" className="splash-enter small" autoFocus onClick={toGym}>
            Open the Gym
          </button>
          {view.mode === 'failed' ? (
            <button type="button" className="splash-quiet" onClick={() => window.location.reload()}>
              Reload
            </button>
          ) : null}
        </div>
      </div>
    ),
    action,
  );
}
