// Owned by: ai
// Placeholder stub from the architect: walks at the first known enemy. Replace wholesale.
import { STEER_DIRS, angleTo } from '../core';
import type { Brain, Decision, Strategy } from '../core';

export function createBrain(strategy: Strategy): Brain {
  const memory: Record<string, number> = { ...(strategy.memory ?? {}) };
  const name = Object.keys(strategy.behaviours)[0] ?? 'idle';
  return {
    memory,
    think(view): Decision {
      const target = view.known[0] ?? null;
      return {
        behaviour: name, scores: { [name]: 1 }, targetId: target?.id ?? null,
        heading: target ? angleTo(view.self.pos, target.pos) : view.self.facing, speed: target ? 1 : 0,
        ring: new Array<number>(STEER_DIRS).fill(0), terms: [],
        attack: target !== null, parry: true, useSkill: false, stance: 'normal', sensors: {},
      };
    },
  };
}
