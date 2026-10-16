// Owned by: audio
/** Test-only helpers: minimal fighters and worlds for the cue and crowd tests. */

import { initialSuddenDeathState } from '../core';
import type { FighterState, GameEvent, WorldState } from '../core';

export const MAP_W = 1360;
export const MAP_H = 860;

export function fighter(id: string, x: number, y = MAP_H / 2, opts: Partial<FighterState> = {}): FighterState {
  return {
    id, entrantId: id, squad: Number(id.replace(/\D/g, '')) || 0, name: id, color: '#ffffff', weapon: 'GREATSWORD', skill: 'DASH',
    attributes: { vitality: 20, power: 16, agility: 20, perception: 16, armor: 14, haste: 14 },
    pos: { x, y }, vel: { x: 0, y: 0 }, facing: 0, headAngle: 0, radius: 18, hp: 300, maxHp: 300,
    alive: true, diedAtTick: null, anim: { phase: 'idle', t: 0, dur: 0 }, walkPhase: 0, attackCd: 0, skillCd: 0,
    parryTicks: 0, parryCd: 0, stunTicks: 0, ammo: 4, maxAmmo: 4, buffs: { haste: 0, berserk: 0, slow: 0 },
    limbs: { armL: true, armR: true, legL: true, legR: true }, helmet: true, inShadow: false, seen: false,
    stance: 'normal', hitFlash: 0, eyePop: 0, behaviour: 'brawl', targetId: null, kills: 0, damageDealt: 0,
    damageTaken: 0, lastHitBy: null, lastHitTick: null, place: null,
    ...opts,
  };
}

export function world(fighters: FighterState[], tick = 600): WorldState {
  return {
    tick, mapId: 'pit', fighters, projectiles: [], floor: [], props: [], hazards: [],
    shrines: [], stuck: [], pickups: [], suddenDeath: initialSuddenDeathState({ width: MAP_W, height: MAP_H }),
    finished: false, ending: null, placements: [],
  };
}

export function hitEvent(attackerId: string, victimId: string, amount: number, tick: number, extra: Partial<Extract<GameEvent, { type: 'hit' }>> = {}): GameEvent {
  return {
    type: 'hit', tick, attackerId, victimId, amount, pos: { x: MAP_W / 2, y: MAP_H / 2 }, dir: 0, crit: false,
    backstab: false, weapon: 'GREATSWORD', knockback: 5, source: 'weapon', ...extra,
  };
}

export function killEvent(killerId: string | null, victimId: string, tick: number, extra: Partial<Extract<GameEvent, { type: 'kill' }>> = {}): GameEvent {
  return {
    type: 'kill', tick, killerId, victimId, cause: 'weapon', pos: { x: MAP_W / 2, y: MAP_H / 2 }, dir: 0,
    title: 'SPLIT', killerBehaviour: 'brawl', victimBehaviour: 'lurk', weapon: 'GREATSWORD', flags: [], hazard: null,
    final: false, ...extra,
  };
}
