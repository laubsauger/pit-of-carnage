// Owned by: ui
// What the splash screen shows, from the controller snapshot and the UI's own WebGPU check. The
// splash itself is static markup in index.html (it paints before any script); src/ui/SplashScreen.tsx
// drives it with this model.
import type { LoadingStage, UiSnapshot } from '../core';
import type { WebGpuStatus } from './hooks';

/**
 * - `loading`: real stages still running; progress bar and the current stage.
 * - `ready`: everything loaded; "Enter the pit" (button, Enter, Space).
 * - `nogpu`: this browser has no usable WebGPU; a message naming supported browsers instead of the button.
 * - `failed`: an adapter was found but the renderer failed to start; the reason instead of the button.
 * - `gone`: entered (or dismissed without WebGPU); the splash fades out.
 */
export type SplashMode = 'loading' | 'ready' | 'nogpu' | 'failed' | 'gone';

export type SplashView = {
  mode: SplashMode;
  /** 0..1, the share of loading stages done. */
  progress: number;
  /** The stage in progress ("Warming up shaders"), or a closing word once nothing is left. */
  stage: string;
};

/**
 * Stages as the splash shows them. The controller reports `webgpu` done only once the renderer is
 * up; the UI's own adapter request (`useWebGpu`) is an equally real check, so a found adapter
 * ticks that stage off as soon as it answers.
 */
export function splashStages(loading: readonly LoadingStage[], gpu: WebGpuStatus): LoadingStage[] {
  return loading.map((s) => (s.id === 'webgpu' && gpu === 'ok' && !s.done ? { ...s, done: true } : s));
}

export function splashView(snap: Pick<UiSnapshot, 'phase' | 'loading' | 'arenaError'>, gpu: WebGpuStatus, dismissed: boolean): SplashView {
  const stages = splashStages(snap.loading, gpu);
  const done = stages.filter((s) => s.done).length;
  const progress = stages.length > 0 ? done / stages.length : 0;
  const next = stages.find((s) => !s.done);
  const entered = snap.phase !== 'loading' && snap.phase !== 'splash';
  if (dismissed || entered) return { mode: 'gone', progress: 1, stage: 'In the pit' };
  if (gpu === 'missing') return { mode: 'nogpu', progress, stage: 'No WebGPU here' };
  if (snap.arenaError) return { mode: 'failed', progress, stage: 'The renderer would not start' };
  if (snap.phase === 'splash') return { mode: 'ready', progress: 1, stage: 'The crowd is ready' };
  return { mode: 'loading', progress, stage: next ? next.label : 'Opening the gates' };
}
