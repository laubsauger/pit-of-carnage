// Owned by: net
/** Test helpers for the rooms prototype (used only by *.test.ts). */

import { DEFAULT_TIME_LIMIT_TICKS, FIGHTER_COLORS } from '../core';
import type { GameEvent, Match, Strategy, WorldState } from '../core';
import { createMatch } from '../sim';
import { HOUSE_STACKS, headlessBrainFactory } from '../strategy';

/** A real match of house stacks (real brains, real sim). */
export function houseMatch(seed: number, mapId = 'pit', fighters = 8): Match {
  return createMatch(
    {
      seed,
      mapId,
      format: 'ffa',
      entrants: Array.from({ length: fighters }, (_, i) => ({
        id: `e${i}`,
        strategy: HOUSE_STACKS[i % HOUSE_STACKS.length]!,
        squad: i,
        name: HOUSE_STACKS[i % HOUSE_STACKS.length]!.name,
        color: FIGHTER_COLORS[i]!,
      })),
      friendlyFire: true,
      timeLimitTicks: DEFAULT_TIME_LIMIT_TICKS,
      suddenDeath: true,
    },
    headlessBrainFactory,
  );
}

/** A valid strategy someone might bring to a room: a house stack under a new name. */
export function broughtStrategy(name: string, from = 0): Strategy {
  return { ...structuredClone(HOUSE_STACKS[from % HOUSE_STACKS.length]!), name, version: 1 };
}

/**
 * Step `match` and call `onFrame` every `every` ticks with a deep copy of the state and the events
 * since the previous call (also on the final tick). Stops at the end or after `maxTicks`.
 */
export function stepFrames(match: Match, every: number, maxTicks: number, onFrame: (state: WorldState, events: GameEvent[]) => void): void {
  let events: GameEvent[] = [];
  for (let i = 0; i < maxTicks && !match.isOver; i++) {
    for (const e of match.step()) events.push(structuredClone(e));
    if (match.state.tick % every === 0 || match.isOver) {
      onFrame(structuredClone(match.state), events);
      events = [];
    }
  }
}

/** Every path where two plain values differ (numbers within `tol`), for readable failures. */
export function differences(a: unknown, b: unknown, tol: number, path = ''): string[] {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tol ? [] : [`${path}: ${a} vs ${b}`];
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b) ? [] : [`${path}: ${String(a)} vs ${String(b)}`];
  if (Array.isArray(a) !== Array.isArray(b)) return [`${path}: array vs object`];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (!(k in a) || !(k in b)) {
      out.push(`${path}.${k}: missing on one side`);
      continue;
    }
    out.push(...differences((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tol, `${path}.${k}`));
  }
  return out;
}
