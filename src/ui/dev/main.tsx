// Owned by: ui (dev harness only)
// ui-dev.html: the real App on a MockController, so every screen can be checked without the sim,
// renderer or gym. URL switches:
//   ?nogpu   pretend WebGPU is missing (shows the "WebGPU required" message)
//   ?end     jump to the end of the first match (end card)
//   ?select  40 s in, select the first fighter (inspector)
//   ?late    into sudden death (zone lines in the inspector), first living fighter selected
//   ?paused  start paused
//   ?crash   the inspector throws, to check the Watch error boundary
//   ?splash  start on the splash: loading stages, then "Enter the pit" (needs the splash markup,
//            which only index.html has; here the phase still walks loading -> splash -> countdown)
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../App';
import { FIXTURE_HOUSE, FIXTURE_SAVED } from './fixtures';
import { createMockController } from './MockController';

const params = new URLSearchParams(window.location.search);
if (params.has('nogpu')) Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: () => undefined });

const controller = createMockController({ saved: FIXTURE_SAVED, splash: params.has('splash') });
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

// ?splash: borrow the real static splash (markup and styles) from index.html, so the harness shows it.
async function borrowSplash(): Promise<void> {
  if (!params.has('splash') || document.getElementById('splash')) return;
  try {
    const html = await (await fetch('/index.html')).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const splash = doc.getElementById('splash');
    for (const style of doc.head.querySelectorAll('style')) document.head.appendChild(style);
    if (splash) document.body.prepend(splash);
  } catch {
    // The harness still works without it; the phase just waits on the splash.
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
await borrowSplash();
createRoot(root).render(
  <StrictMode>
    <App controller={controller} houseStacks={FIXTURE_HOUSE} />
  </StrictMode>,
);
