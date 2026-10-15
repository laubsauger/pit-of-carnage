// Owned by: integrator
// Placeholder stub from the architect: no game loop yet; holds a static snapshot. Replace wholesale.
import { DEFAULT_MAP_ID, DEFAULT_TIME_LIMIT_TICKS } from '../core';
import type { GameController, Match, SavedStrategy, Strategy, UiSnapshot } from '../core';
import { createBrain } from '../brain';
import { createGymApi } from '../gym';
import { createRenderer } from '../render';
import { createFx } from '../render/fx';
import { createMatch } from '../sim';
import { encodeStrategyCode } from '../strategy';

export function createController(): GameController {
  const listeners = new Set<() => void>();
  const saved: SavedStrategy[] = [];
  let match: Match | null = null;
  let snapshot: UiSnapshot = {
    tick: 0, speed: 1, paused: false, mapId: DEFAULT_MAP_ID, format: 'ffa', seed: 1,
    timeLimitTicks: DEFAULT_TIME_LIMIT_TICKS, suddenDeath: false, maxTick: 0,
    fighters: [], feed: [], marks: [], selectedId: null, hoveredId: null, followId: null,
    overlay: { cones: 'selected', rings: true, names: true, fog: false }, finished: false, placements: [],
  };
  const update = (patch: Partial<UiSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((fn) => fn());
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    startMatch(config) {
      match = createMatch(config, createBrain);
      update({ mapId: config.mapId, format: config.format, seed: config.seed, timeLimitTicks: config.timeLimitTicks, tick: 0 });
    },
    restart() {
      if (match) this.startMatch(match.config);
    },
    setPaused: (paused) => update({ paused }),
    stepTicks() {},
    setSpeed: (speed) => update({ speed }),
    seek() {},
    select: (selectedId) => update({ selectedId }),
    hover: (hoveredId) => update({ hoveredId }),
    follow: (followId) => update({ followId }),
    setOverlay: (o) => update({ overlay: { ...snapshot.overlay, ...o } }),
    decision: (id) => match?.lastDecision(id) ?? null,
    fighter: (id) => match?.state.fighters.find((f) => f.id === id) ?? null,
    lastReport: () => null,
    mountCanvas(el) {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'display:block;width:100%;height:100%';
      el.appendChild(canvas);
      const renderer = createRenderer(canvas, createFx());
      renderer.resize(el.clientWidth, el.clientHeight);
      return () => {
        renderer.dispose();
        canvas.remove();
      };
    },
    strategies: {
      list: () => saved,
      save(s: Strategy) {
        const version = saved.filter((x) => x.name === s.name).length + 1;
        const entry: SavedStrategy = { id: `${s.name}@v${version}`, name: s.name, version, savedAt: Date.now(), strategy: s, code: encodeStrategyCode(s) };
        saved.push(entry);
        return entry;
      },
      versions: (name) => saved.filter((x) => x.name === name).reverse(),
      remove(id) {
        const i = saved.findIndex((x) => x.id === id);
        if (i >= 0) saved.splice(i, 1);
      },
    },
    gym: createGymApi(),
  };
}
