/**
 * Test fixtures: a small fake WorldQuery with real geometry (walls, light function, circular
 * hazards) and builders for fighters, known enemies and views. Used by brain and strategy tests
 * while the real sim is built in parallel; not imported by game code.
 */

import { MATCH_RULES, SKILL_IDS, WEAPONS, WEAPON_IDS, angleDiff, angleTo, fighterRadius, initialSuddenDeathState, maxHp, segmentCircleT, segmentRectT, zoneBoundsAfter } from '../core';
import type { FighterState, KnownFighter, MapDef, PerceptionView, PickupInfo, Rect, Rng, SuddenDeathState, Vec2, WorldQuery } from '../core';

export type FakeWorldOpts = {
  width?: number;
  height?: number;
  walls?: Rect[];
  pillars?: Rect[];
  /** Light level at a point (default: fully lit everywhere). */
  light?: (p: Vec2) => number;
  /** Active hazards (centre, radius). */
  hazards?: { pos: Vec2; radius: number }[];
  shrine?: { pos: Vec2; ready: boolean } | null;
  /** Answer for coverFrom (default none). */
  cover?: Vec2 | null;
  floorItems?: { kind: string; pos: Vec2 }[];
  /** Power-up pedestals for nearestPickup (nearest of the asked kind wins). */
  pickups?: PickupInfo[];
  /** Vision range and half-angle used by inVisionOf (no shadow rule). */
  visionRange?: number;
  visionHalfFov?: number;
};

export function fakeMap(opts: FakeWorldOpts = {}): MapDef {
  const width = opts.width ?? 1000;
  const height = opts.height ?? 800;
  return {
    id: 'fake', name: 'Fake', width, height, floor: 'stone', ambient: 1,
    walls: opts.walls ?? [], pillars: opts.pillars ?? [], lights: [],
    hazards: (opts.hazards ?? []).map((h, i) => ({ id: `h${i}`, kind: 'acid' as const, pos: h.pos, radius: h.radius })),
    props: [], shrines: opts.shrine ? [{ id: 's0', pos: opts.shrine.pos }] : [], pickups: [], spawns: [],
  };
}

export function fakeWorld(opts: FakeWorldOpts = {}): WorldQuery {
  const map = fakeMap(opts);
  const blockers = [...map.walls, ...map.pillars];
  const hazards = opts.hazards ?? [];
  const range = opts.visionRange ?? 400;
  const half = opts.visionHalfFov ?? 1;
  const losBlocked = (a: Vec2, b: Vec2) => blockers.some((r) => segmentRectT(a, b, r) >= 0);
  const rayDanger = (from: Vec2, dx: number, dy: number, look: number, hit: (a: Vec2, b: Vec2) => number) => {
    const end = { x: from.x + dx * look, y: from.y + dy * look };
    const t = hit(from, end);
    return t < 0 ? 0 : 1 - t;
  };
  return {
    map,
    losBlocked,
    lightAt: (p) => (opts.light ? opts.light(p) : 1),
    inVisionOf: (o, p) => {
      const d = Math.hypot(p.x - o.pos.x, p.y - o.pos.y);
      if (d > range) return false;
      if (d > 1 && Math.abs(angleDiff(o.facing, angleTo(o.pos, p))) > half) return false;
      return !losBlocked(o.pos, p);
    },
    wallDanger: (from, dx, dy, look) =>
      rayDanger(from, dx, dy, look, (a, b) => {
        let best = -1;
        for (const r of blockers) {
          const t = segmentRectT(a, b, r);
          if (t >= 0 && (best < 0 || t < best)) best = t;
        }
        return best;
      }),
    hazardDanger: (from, dx, dy, look) =>
      rayDanger(from, dx, dy, look, (a, b) => {
        let best = -1;
        for (const h of hazards) {
          const t = segmentCircleT(a, b, h.pos, h.radius);
          if (t >= 0 && (best < 0 || t < best)) best = t;
        }
        return best;
      }),
    coverFrom: () => opts.cover ?? null,
    nearestShrine: () => opts.shrine ?? null,
    nearestFloorItem: (p, kinds) => {
      let best: Vec2 | null = null;
      for (const it of opts.floorItems ?? []) {
        if (!kinds.includes(it.kind)) continue;
        if (!best || Math.hypot(it.pos.x - p.x, it.pos.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y)) best = it.pos;
      }
      return best;
    },
    nearestProp: () => null,
    nearestPickup: (p, kind) => {
      let best: PickupInfo | null = null;
      for (const it of opts.pickups ?? []) {
        if (kind !== 'any' && it.kind !== kind) continue;
        if (!best || Math.hypot(it.pos.x - p.x, it.pos.y - p.y) < Math.hypot(best.pos.x - p.x, best.pos.y - p.y)) best = it;
      }
      return best;
    },
    nearestHazard: (p) => {
      let best: { pos: Vec2; radius: number } | null = null;
      for (const h of hazards) {
        if (!best || Math.hypot(h.pos.x - p.x, h.pos.y - p.y) < Math.hypot(best.pos.x - p.x, best.pos.y - p.y)) best = h;
      }
      return best;
    },
    fightsNear: () => 0,
  };
}

const ATTRS = { vitality: 17, power: 17, agility: 17, perception: 17, armor: 16, haste: 16 };

export function fighter(over: Partial<FighterState> = {}): FighterState {
  const weapon = over.weapon ?? 'GREATSWORD';
  const attributes = over.attributes ?? ATTRS;
  return {
    id: 'me', entrantId: 'e-me', squad: 0, name: 'Me', color: '#ffffff', weapon, skill: 'DASH', attributes,
    pos: { x: 300, y: 300 }, vel: { x: 0, y: 0 }, facing: 0, headAngle: 0, radius: fighterRadius(attributes),
    hp: maxHp(attributes), maxHp: maxHp(attributes), alive: true, diedAtTick: null,
    anim: { phase: 'idle', t: 0, dur: 0 }, walkPhase: 0, attackCd: 0, skillCd: 0, parryTicks: 0, parryCd: 0, stunTicks: 0,
    ammo: WEAPONS[weapon].ammo, maxAmmo: WEAPONS[weapon].ammo, buffs: { haste: 0, berserk: 0, slow: 0 },
    limbs: { armL: true, armR: true, legL: true, legR: true }, helmet: true, inShadow: false, seen: false, stance: 'normal',
    hitFlash: 0, eyePop: 0, behaviour: '', targetId: null, kills: 0, damageDealt: 0, damageTaken: 0,
    lastHitBy: null, lastHitTick: null, place: null,
    ...over,
  };
}

export function enemy(id: string, over: Partial<KnownFighter> = {}): KnownFighter {
  const pos = over.pos ?? { x: 500, y: 300 };
  const weapon = over.weapon ?? 'GREATSWORD';
  return {
    id, squad: 1, pos, vel: { x: 0, y: 0 }, facing: Math.PI, hp: 300, maxHp: 300, weapon, family: WEAPONS[weapon].family,
    seen: true, heard: false, estimateError: 0, lastSeenTick: 0, lastSeenPos: { ...pos }, fighting: false, ammo: WEAPONS[weapon].ammo, kills: 0, windingUp: false,
    ...over,
  };
}

export function view(self: FighterState, known: KnownFighter[], world: WorldQuery, over: Partial<PerceptionView> = {}): PerceptionView {
  const zone = initialSuddenDeathState(world.map);
  return { tick: 0, self, known, allies: [], lastAttackerId: null, suddenDeath: false, arena: zone.bounds, zone, world, ...over };
}

/** A sudden-death zone `inset` px in from every side of `map` (clamped at the final square), warning filled in. */
export function closingZone(map: Pick<MapDef, 'width' | 'height'>, inset: number, over: Partial<SuddenDeathState> = {}): SuddenDeathState {
  const z = initialSuddenDeathState(map);
  z.active = true;
  z.reason = 'time';
  z.startedAtTick = 0;
  z.inset = inset;
  const f = z.final;
  const x0 = Math.min(f.x, inset);
  const y0 = Math.min(f.y, inset);
  z.bounds = { x: x0, y: y0, w: map.width - 2 * x0, h: map.height - 2 * y0 };
  Object.assign(z, over);
  zoneBoundsAfter(z, MATCH_RULES.warningTicks, z.warning);
  return z;
}

/**
 * A random but plausible moment of a match, for fuzz and range tests: walls and pillars, patchy
 * light, hazards, pedestals, ammo on the floor, a fighter with a random legal build and state, up
 * to 15 enemies in every state of knowledge (seen, heard with a fuzzy estimate, remembered, never
 * seen), and a zone anywhere from quiet to fully closed. Deterministic for a given rng.
 */
export function randomView(rng: Rng): PerceptionView {
  const width = rng.int(600, 1400);
  const height = rng.int(500, 900);
  const pillars: Rect[] = [];
  for (let i = rng.int(0, 6); i > 0; i--) pillars.push({ x: rng.range(40, width - 80), y: rng.range(40, height - 80), w: rng.range(20, 60), h: rng.range(20, 60) });
  const at = (): Vec2 => ({ x: rng.range(10, width - 10), y: rng.range(10, height - 10) });
  const kinds = ['haste', 'berserk'] as const;
  const pickups: PickupInfo[] = [];
  for (let i = rng.int(0, 4); i > 0; i--) {
    const ready = rng.chance(0.5);
    pickups.push({ id: `p${i}`, kind: rng.pick(kinds), pos: at(), ready, respawnIn: ready ? 0 : rng.range(0.1, 10) });
  }
  const darkX = rng.range(0, width);
  const world = fakeWorld({
    width, height, pillars,
    walls: [{ x: 0, y: 0, w: width, h: 16 }, { x: 0, y: height - 16, w: width, h: 16 }, { x: 0, y: 0, w: 16, h: height }, { x: width - 16, y: 0, w: 16, h: height }],
    light: (p) => (p.x < darkX ? 0.1 : 0.9),
    hazards: rng.chance(0.5) ? [{ pos: at(), radius: rng.range(20, 60) }] : [],
    shrine: rng.chance(0.6) ? { pos: at(), ready: rng.chance(0.5) } : null,
    cover: rng.chance(0.5) ? at() : null,
    floorItems: rng.chance(0.5) ? [{ kind: rng.pick(['arrow', 'axe']), pos: at() }] : [],
    pickups,
    visionRange: rng.range(200, 700),
    visionHalfFov: rng.range(0.6, 1.3),
  });
  const weapon = rng.pick(WEAPON_IDS);
  const attributes = randomAttributes(rng);
  const max = maxHp(attributes);
  const tick = rng.int(0, 9000);
  const speed = rng.chance(0.1) ? rng.range(0, 12) : rng.range(0, 2.5);
  const dir = rng.range(-Math.PI, Math.PI);
  const self = fighter({
    weapon, attributes, skill: rng.pick(SKILL_IDS), pos: at(), vel: { x: Math.cos(dir) * speed, y: Math.sin(dir) * speed },
    facing: rng.range(-Math.PI, Math.PI), hp: rng.range(1, max), maxHp: max, ammo: rng.int(0, WEAPONS[weapon].ammo),
    limbs: { armL: rng.chance(0.9), armR: rng.chance(0.9), legL: rng.chance(0.9), legR: rng.chance(0.9) },
    buffs: { haste: rng.chance(0.2) ? rng.int(1, 200) : 0, berserk: rng.chance(0.2) ? rng.int(1, 200) : 0, slow: 0 },
    attackCd: rng.chance(0.5) ? 0 : rng.int(1, 40), skillCd: rng.chance(0.5) ? 0 : rng.int(1, 200), parryCd: rng.chance(0.5) ? 0 : 50,
    stunTicks: rng.chance(0.1) ? 20 : 0, inShadow: rng.chance(0.3), seen: rng.chance(0.5), kills: rng.int(0, 15),
    lastHitTick: rng.chance(0.5) ? null : rng.int(Math.max(0, tick - 2000), tick),
  });
  const known: KnownFighter[] = [];
  for (let i = rng.int(0, 15); i > 0; i--) {
    const w = rng.pick(WEAPON_IDS);
    const truth = at();
    const state = rng.int(0, 3); // 0 seen, 1 heard, 2 remembered, 3 heard but never seen
    const seenTick = state === 3 ? -1 : state === 0 ? tick : rng.int(Math.max(0, tick - 360), tick);
    const err = state === 0 ? 0 : rng.range(24, 300);
    const theirMax = maxHp(randomAttributes(rng));
    known.push(enemy(`e${i}`, {
      pos: state === 0 ? truth : { x: truth.x + rng.range(-err, err), y: truth.y + rng.range(-err, err) },
      vel: { x: rng.range(-3, 3), y: rng.range(-3, 3) }, facing: rng.range(-Math.PI, Math.PI),
      hp: rng.range(0, theirMax), maxHp: theirMax, weapon: w, family: WEAPONS[w].family,
      seen: state === 0, heard: state === 1 || state === 3, estimateError: err, lastSeenTick: seenTick, lastSeenPos: truth,
      fighting: rng.chance(0.4), ammo: rng.int(0, WEAPONS[w].ammo), kills: rng.int(0, 15), windingUp: state === 0 && rng.chance(0.2),
    }));
  }
  const zoneKind = rng.int(0, 3);
  const zone = zoneKind === 0 ? initialSuddenDeathState(world.map) : closingZone(world.map, rng.range(0, Math.max(world.map.width, world.map.height) / 2), zoneKind === 3 ? { closedAtTick: tick, escalation: rng.int(1, 20), everywhere: rng.chance(0.5) } : {});
  const allies = rng.chance(0.2) ? [enemy('ally', { squad: self.squad, pos: at() })] : [];
  return view(self, known, world, { tick, allies, lastAttackerId: known.length && rng.chance(0.5) ? known[0]!.id : null, zone, arena: zone.bounds, suddenDeath: zone.active });
}

/** A random legal build: every attribute in range, spending most or all of the budget. */
export function randomAttributes(rng: Rng): FighterState['attributes'] {
  const keys = ['vitality', 'power', 'agility', 'perception', 'armor', 'haste'] as const;
  const a = { vitality: 4, power: 4, agility: 4, perception: 4, armor: 4, haste: 4 };
  for (let left = rng.int(60, 76); left > 0; left--) {
    const k = rng.pick(keys);
    if (a[k] < 40) a[k]++;
  }
  return a;
}
