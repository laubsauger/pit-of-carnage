/**
 * Test helpers for the sim (used only by *.test.ts). The real brain is built elsewhere; these
 * stand-ins are just smart enough to make matches happen: walk at the nearest known enemy, avoid
 * walls a little, attack in range.
 */

import { FIGHTER_COLORS, STEER_COS, STEER_DIRS, STEER_SIN, WEAPONS, angleTo } from '../core';
import type { Attributes, Brain, BrainFactory, Decision, GameEvent, MatchConfig, PerceptionView, SkillId, Stance, Strategy, WeaponId } from '../core';
import { createMatch } from './match';

export const BALANCED: Attributes = { vitality: 20, power: 16, agility: 20, perception: 16, armor: 14, haste: 14 };

export function testStrategy(name: string, weapon: WeaponId, opts: { skill?: SkillId; attributes?: Partial<Attributes>; barks?: Strategy['barks'] } = {}): Strategy {
  return {
    schema: 'pit-strategy/2',
    name,
    build: { weapon, skill: opts.skill ?? 'DASH', attributes: { ...BALANCED, ...opts.attributes } },
    target: 'it.distance',
    behaviours: { hunt: { score: '1', move: [{ seek: 'target', weight: 1 }], attack: 'in_range' } },
    commit: 30,
    ...(opts.barks ? { barks: opts.barks } : {}),
  };
}

const WEAPON_CYCLE: readonly WeaponId[] = ['GREATSWORD', 'WARHAMMER', 'TWIN_DAGGERS', 'THROWING_AXES', 'LONGBOW', 'ARCANE_STAFF'];

export function testConfig(opts: { seed: number; mapId?: string; fighters?: number; weapons?: WeaponId[]; suddenDeath?: boolean; timeLimitTicks?: number }): MatchConfig {
  const n = opts.fighters ?? 8;
  const weapons = opts.weapons ?? WEAPON_CYCLE;
  return {
    seed: opts.seed,
    mapId: opts.mapId ?? 'pit',
    format: 'ffa',
    entrants: Array.from({ length: n }, (_, i) => ({
      id: `e${i}`,
      strategy: testStrategy(`Fighter ${i}`, weapons[i % weapons.length]!),
      squad: i,
      name: `Fighter ${i}`,
      color: FIGHTER_COLORS[i]!,
    })),
    friendlyFire: true,
    timeLimitTicks: opts.timeLimitTicks ?? 5400,
    suddenDeath: opts.suddenDeath ?? true,
  };
}

function decision(d: Partial<Decision> & Pick<Decision, 'heading' | 'speed'>, ring: number[]): Decision {
  return {
    behaviour: 'hunt',
    scores: {},
    targetId: null,
    ring,
    terms: [],
    attack: false,
    parry: true,
    useSkill: false,
    stance: 'normal',
    sensors: {},
    guardTrips: [],
    ...d,
  };
}

/** Seek the nearest known enemy (else the centre), steer around walls, attack in range, skill up close. */
export const seekerBrain: BrainFactory = (strategy) => {
  const ring = new Array<number>(STEER_DIRS).fill(0);
  const w = WEAPONS[strategy.build.weapon];
  return {
    memory: {},
    think(view: PerceptionView): Decision {
      const self = view.self;
      let best = null;
      let bestD = Infinity;
      for (const k of view.known) {
        const d = Math.hypot(k.pos.x - self.pos.x, k.pos.y - self.pos.y);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      const reach = w.family === 'melee' || self.ammo <= 0 ? w.range + 18 : w.range * 0.85;
      const goal = best ? best.pos : { x: view.world.map.width / 2, y: view.world.map.height / 2 };
      const want = angleTo(self.pos, goal);
      // Context steering light: prefer directions near the goal, away from walls.
      let bi = 0;
      let bv = -Infinity;
      for (let i = 0; i < STEER_DIRS; i++) {
        const c = STEER_COS[i]!;
        const s = STEER_SIN[i]!;
        const v = c * Math.cos(want) + s * Math.sin(want) - 1.5 * view.world.wallDanger(self.pos, c, s, self.radius + 40);
        ring[i] = v;
        if (v > bv) {
          bv = v;
          bi = i;
        }
      }
      const ranged = w.family === 'ranged' && self.ammo > 0;
      const close = best !== null && bestD < reach * (ranged ? 0.7 : 0.6);
      const nearGoal = !best && Math.hypot(goal.x - self.pos.x, goal.y - self.pos.y) < 60;
      return decision(
        {
          targetId: best?.id ?? null,
          heading: Math.atan2(STEER_SIN[bi]!, STEER_COS[bi]!),
          speed: close || nearGoal ? 0 : 1,
          attack: best !== null && bestD <= reach && (best.seen || !ranged),
          useSkill: best !== null && bestD < 110,
        },
        ring,
      );
    },
  };
};

export type Script = { heading?: number; speed?: number; attack?: boolean; targetId?: string | null; parry?: boolean; stance?: Stance; useSkill?: boolean };

/**
 * Brains driven by a per-fighter script, for staged scenarios. Scripts are keyed by strategy name
 * and read at every think, so tests can change them between steps. Every view is recorded.
 */
export function scriptedBrains(scripts: Record<string, Script>, views: Record<string, PerceptionView[]> = {}): BrainFactory {
  return (strategy): Brain => {
    const ring = new Array<number>(STEER_DIRS).fill(0);
    return {
      memory: {},
      think(view): Decision {
        const s = scripts[strategy.name] ?? {};
        (views[strategy.name] ??= []).push({ ...view, known: view.known.map((k) => ({ ...k, pos: { ...k.pos } })) });
        return decision(
          {
            heading: s.heading ?? view.self.facing,
            speed: s.speed ?? 0,
            attack: s.attack ?? false,
            targetId: s.targetId ?? null,
            parry: s.parry ?? false,
            stance: s.stance ?? 'normal',
            useSkill: s.useSkill ?? false,
          },
          ring,
        );
      },
    };
  };
}

export type StageFighter = {
  name: string;
  weapon: WeaponId;
  pos: [number, number];
  facing: number;
  script?: Script;
  skill?: SkillId;
  attributes?: Partial<Attributes>;
};

/**
 * A staged scenario: fighters placed by hand on a real map, driven by scripts. `run(n)` steps n
 * ticks (or until the match ends) and collects every event; `f(name)` is that fighter's live state.
 */
export function stage(fighters: StageFighter[], opts: { mapId?: string; seed?: number; timeLimitTicks?: number; suddenDeath?: boolean } = {}) {
  const scripts: Record<string, Script> = {};
  const views: Record<string, PerceptionView[]> = {};
  for (const s of fighters) scripts[s.name] = s.script ?? {};
  const config: MatchConfig = {
    seed: opts.seed ?? 1,
    mapId: opts.mapId ?? 'pit',
    format: 'ffa',
    entrants: fighters.map((s, i) => ({
      id: `e${i}`,
      strategy: testStrategy(s.name, s.weapon, { skill: s.skill, attributes: s.attributes }),
      squad: i,
      name: s.name,
      color: FIGHTER_COLORS[i]!,
    })),
    friendlyFire: true,
    timeLimitTicks: opts.timeLimitTicks ?? 5400,
    suddenDeath: opts.suddenDeath ?? true,
  };
  const match = createMatch(config, scriptedBrains(scripts, views));
  fighters.forEach((s, i) => {
    const f = match.state.fighters[i]!;
    f.pos.x = s.pos[0];
    f.pos.y = s.pos[1];
    f.facing = s.facing;
    f.headAngle = s.facing;
  });
  const events: GameEvent[] = [];
  const byName = (name: string) => match.state.fighters.find((f) => f.name === name)!;
  return {
    match,
    scripts,
    views,
    events,
    f: byName,
    /** Latest view `name`'s brain received. */
    lastView: (name: string) => views[name]![views[name]!.length - 1]!,
    run(ticks: number) {
      for (let i = 0; i < ticks && !match.isOver; i++) events.push(...match.step());
      return events;
    },
  };
}
