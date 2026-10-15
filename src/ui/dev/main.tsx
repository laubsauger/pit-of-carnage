// Owned by: ui (dev harness only)
// ui-dev.html: the real App on a MockController, so every screen can be checked without the sim,
// renderer or gym. URL switches:
//   ?nogpu   pretend WebGPU is missing (shows the "WebGPU required" message)
//   ?end     jump to the end of the first match (end card)
//   ?select  40 s in, select the first fighter (inspector)
//   ?late    into sudden death (zone lines in the inspector), first living fighter selected
//   ?paused  start paused
//   ?crash   the inspector throws, to check the Watch error boundary
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../App';
import { FIXTURE_HOUSE, FIXTURE_SAVED } from './fixtures';
import { createMockController } from './MockController';

const params = new URLSearchParams(window.location.search);
if (params.has('nogpu')) Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: () => undefined });

const controller = createMockController({ saved: FIXTURE_SAVED });
if (params.has('crash')) {
  controller.knowledge = () => {
    throw new Error('Mock knowledge exploded (?crash).');
  };
}

if (params.has('end') || params.has('select') || params.has('late') || params.has('paused')) {
  const off = controller.subscribe(() => {
    const s = controller.getSnapshot();
    if (s.fighters.length === 0) return;
    off();
    // After the UI has finished starting the match (it unpauses right after startMatch).
    window.setTimeout(() => {
      if (params.has('paused')) controller.setPaused(true);
      if (params.has('end')) controller.stepTicks(1_000_000);
      else if (params.has('select')) controller.stepTicks(40 * 60);
      else if (params.has('late')) controller.stepTicks(Math.min(s.timeLimitTicks + 8 * 60, 1_000_000));
      if (params.has('select')) controller.select(s.fighters[0].id);
      if (params.has('late')) {
        const alive = controller.getSnapshot().fighters.find((f) => f.alive);
        if (alive) controller.select(alive.id);
      }
    }, 0);
  });
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App controller={controller} houseStacks={FIXTURE_HOUSE} />
  </StrictMode>,
);
