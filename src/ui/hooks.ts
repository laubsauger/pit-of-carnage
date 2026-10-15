// Owned by: ui
// Subscriptions to the controller (about 10 Hz, never per frame) and small persistence helpers.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { GameController, SavedStrategy, UiSnapshot } from '../core';
import { initialPane, paneStorageKey, sanitizePane } from './panes';
import type { PaneId, PaneState } from './panes';

/** The controller snapshot. Re-renders only when the controller notifies (about 10 Hz). */
export function useSnapshot(controller: GameController): UiSnapshot {
  const subscribe = useCallback((fn: () => void) => controller.subscribe(fn), [controller]);
  const get = useCallback(() => controller.getSnapshot(), [controller]);
  return useSyncExternalStore(subscribe, get);
}

/**
 * Re-read a value on every controller notification. For live data outside the snapshot
 * (decisions, full fighter state), which `read` must copy because the sim mutates it in place.
 */
export function usePolled<T>(controller: GameController, read: () => T, deps: readonly unknown[]): T {
  const [value, setValue] = useState(read);
  useEffect(() => {
    setValue(read());
    return controller.subscribe(() => setValue(read()));
    // `read` is rebuilt every render; `deps` says when it actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, ...deps]);
  return value;
}

/**
 * Saved strategies. The store has no change events, so the UI calls `refresh` after it saves or
 * removes one (it is the only writer).
 */
export function useSavedStrategies(controller: GameController): [SavedStrategy[], () => void] {
  const [list, setList] = useState<SavedStrategy[]>(() => [...controller.strategies.list()]);
  const refresh = useCallback(() => setList([...controller.strategies.list()]), [controller]);
  return [list, refresh];
}

type GpuLike = { requestAdapter(): Promise<unknown> };
export type WebGpuStatus = 'checking' | 'ok' | 'missing';

function navigatorGpu(): GpuLike | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as Navigator & { gpu?: GpuLike }).gpu ?? null;
}

/**
 * The arena is WebGPU only. `navigator.gpu` alone is not enough: some browsers expose it and then
 * hand out no adapter (blocklisted GPU, disabled flag), so this asks for an adapter once.
 */
export function useWebGpu(): WebGpuStatus {
  const [status, setStatus] = useState<WebGpuStatus>(() => (navigatorGpu() ? 'checking' : 'missing'));
  useEffect(() => {
    const gpu = navigatorGpu();
    if (!gpu) return;
    let live = true;
    gpu.requestAdapter().then(
      (adapter) => live && setStatus(adapter ? 'ok' : 'missing'),
      () => live && setStatus('missing'),
    );
    return () => {
      live = false;
    };
  }, []);
  return status;
}

export function readStored<T>(key: string, fallback: T, sanitize: (v: unknown, fallback: T) => T = (v) => v as T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : sanitize(JSON.parse(raw), fallback);
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or storage full: the setting just will not survive a reload.
  }
}

/** useState backed by localStorage (per-browser convenience only; never game data). */
export function useStoredState<T>(
  key: string,
  init: () => T,
  sanitize?: (v: unknown, fallback: T) => T,
): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readStored(key, init(), sanitize));
  useEffect(() => writeStored(key, value), [key, value]);
  return [value, setValue];
}

/** A resizable side pane's width and collapsed state, persisted per pane (and so per screen). */
export function usePane(id: PaneId): [PaneState, (v: PaneState | ((prev: PaneState) => PaneState)) => void] {
  return useStoredState(paneStorageKey(id), () => initialPane(id), sanitizePane(id));
}

export type Screen = 'watch' | 'gym' | 'room';
const SCREENS: readonly Screen[] = ['watch', 'gym', 'room'];

/** The screen a hash names. A Codex link (`#codex/...`) opens over the screen already showing (`current`). */
function screenFromHash(current: Screen = 'watch'): Screen {
  const h = window.location.hash.replace(/^#\/?/, '');
  if (h === 'codex' || h.startsWith('codex/')) return current;
  return (SCREENS as readonly string[]).includes(h) ? (h as Screen) : 'watch';
}

/** Current screen in the URL hash, so reloads and the back button keep your place. */
export function useHashScreen(): [Screen, (s: Screen) => void] {
  const [screen, setScreen] = useState<Screen>(() => screenFromHash());
  useEffect(() => {
    const onHash = () => setScreen((cur) => screenFromHash(cur));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = useCallback((s: Screen) => {
    if (screenFromHash(s) !== s) window.location.hash = s;
    setScreen(s);
  }, []);
  return [screen, go];
}
