// Owned by: ui (dev harness only; never imported by the app)
// A GameController with believable fake data, so every screen can be built and checked without
// the sim, brain, renderer or gym. The match is a script computed from the seed, so pausing,
// stepping and seeking behave like the real deterministic replay.
import {
  DEFAULT_TIME_LIMIT_TICKS,
  DEFAULT_VIEW_SETTINGS,
  FIGHTER_COLORS,
  HAZARD_RULES,
  LOADING_STAGES,
  MATCH_RULES,
  PICKUP_RULES,
  PROP_RULES,
  Rng,
  STEER_DIRS,
  TICK_HZ,
  WEAPONS,
  addToHeatmap,
  clamp,
  createHeatmap,
  displayRating,
  mergeHeatmap,
  fighterRadius,
  hashString,
  initialSuddenDeathState,
  maxHp,
  steerAngle,
  strategyKey,
  zoneEdgeDistance,
  zoneTicksToReach,
} from '../../core';
import type {
  AggregateReport,
  BackgroundJob,
  BatchRequest,
  BatchResult,
  DeathRecord,
  Decision,
  EvolveCandidate,
  EvolveGeneration,
  EvolveRequest,
  EvolveResult,
  FeedItem,
  FighterReport,
  FighterState,
  FighterStats,
  GameController,
  Heatmap,
  GuardTrip,
  KillCause,
  KillFlag,
  KillRecord,
  KnownFighter,
  LeaderboardEntry,
  MapObjectKind,
  MatchConfig,
  MatchEnding,
  MatchPhase,
  MatchReport,
  MoveTerm,
  ObjectInfo,
  Rating,
  SavedStrategy,
  Strategy,
  StrategyAggregate,
  SuddenDeathState,
  TimelineMark,
  UiSnapshot,
  ViewSettings,
  WeaponId,
} from '../../core';
import type { ArchiveCell } from '../../gym';
import { MAPS } from '../../sim';
import { encodeStrategyCode } from '../../strategy';
import { readStored, writeStored } from '../hooks';

// ---------------------------------------------------------------------------------------------
// Match script
// ---------------------------------------------------------------------------------------------

type Hit = { tick: number; amount: number };

type ScriptFighter = {
  id: string;
  entrantId: string;
  name: string;
  color: string;
  squad: number;
  strategy: Strategy;
  maxHp: number;
  hits: Hit[];
  deathTick: number | null;
  place: number | null;
  orbit: { rx: number; ry: number; w: number; phase: number };
};

type Script = {
  config: MatchConfig;
  fighters: ScriptFighter[];
  endTick: number;
  feed: FeedItem[];
  marks: TimelineMark[];
  kills: KillRecord[];
  placements: string[];
};

const KILL_LINES: Record<WeaponId, string[]> = {
  GREATSWORD: ['{k} opened {v} like a letter.', '{k} split {v} down the middle.', '{k} cleared some room, mostly {v}.'],
  WARHAMMER: ["{k} rang {v}'s bell for good.", '{k} flattened {v}.', "{v} met {k}'s hammer, briefly."],
  TWIN_DAGGERS: ["{k} found {v}'s back.", '{v} never saw {k}.', '{k} sent {v} home in pieces.'],
  THROWING_AXES: ["{v} caught {k}'s axe. With the face.", '{k} threw, {v} stopped it.'],
  LONGBOW: ['{k} pinned {v} from across the Pit.', '{v} took one from {k} at four hundred paces.'],
  ARCANE_STAFF: ['{k} turned {v} into a light show.', '{k} lit {v} up.'],
};
const HAZARD_LINES = ['{v} tripped into the saw.', '{v} found the spikes.', '{v} stood in the fire a bit too long.'];
const DISMEMBER_LINES = ["{k} took {v}'s arm off.", '{v} lost a leg to {k}.', "{k} kept a piece of {v}."];

const fill = (line: string, k: string, v: string) => line.replaceAll('{k}', k).replaceAll('{v}', v);

function buildScript(config: MatchConfig): Script {
  const rng = new Rng(config.seed).fork('mock');
  const n = config.entrants.length;
  const fighters: ScriptFighter[] = config.entrants.map((e, i) => ({
    id: `f${i}`,
    entrantId: e.id,
    name: e.name,
    color: e.color,
    squad: e.squad,
    strategy: e.strategy,
    maxHp: maxHp(e.strategy.build.attributes),
    hits: [],
    deathTick: null,
    place: null,
    orbit: {
      rx: 140 + ((i * 97) % 330),
      ry: 90 + ((i * 61) % 220),
      w: (0.18 + (i % 5) * 0.05) * (i % 2 ? 1 : -1),
      phase: (i / n) * Math.PI * 2,
    },
  }));

  const order = rng.shuffle(fighters.map((_, i) => i));
  const winner = fighters[order[n - 1]];
  const endTick = rng.int(58, 112) * TICK_HZ;
  const feed: FeedItem[] = [{ tick: 1, text: `${n} in the Pit. One walks out.`, kind: 'info', ids: [] }];
  const marks: TimelineMark[] = [];
  const kills: KillRecord[] = [];
  const killsAt = new Map<string, number[]>();

  for (let k = 0; k < n - 1; k++) {
    const victim = fighters[order[k]];
    const tick = k === n - 2 ? endTick : Math.round(endTick * (0.14 + (0.84 * (k + 1)) / (n - 1)) - rng.int(0, 4 * TICK_HZ));
    victim.deathTick = tick;
    victim.place = n - k;
    const alive = fighters.filter((f) => f !== victim && (f.deathTick === null || f.deathTick > tick));
    const roll = rng.next();
    const sudden = config.suddenDeath && tick > config.timeLimitTicks;
    let cause: KillCause = 'weapon';
    let killer: ScriptFighter | null = rng.pick(alive);
    let text: string;
    const flags: KillFlag[] = [];
    if (sudden && roll < 0.25) {
      cause = 'sudden_death';
      killer = null;
      text = fill('The wall caught {v}.', '', victim.name);
    } else if (roll < 0.1) {
      cause = 'hazard';
      killer = null;
      text = fill(rng.pick(HAZARD_LINES), '', victim.name);
    } else if (roll < 0.15) {
      cause = 'keg';
      killer = null;
      text = fill('{v} was hit by their own keg. Classic {v}.', '', victim.name);
    } else {
      const weapon = killer.strategy.build.weapon;
      text = fill(rng.pick(KILL_LINES[weapon]), killer.name, victim.name);
      if (weapon === 'TWIN_DAGGERS' && rng.chance(0.6)) flags.push('backstab', 'unseen');
      if (WEAPONS[weapon].family === 'ranged') flags.push('ranged');
      if (rng.chance(0.2)) flags.push('crit');
    }
    // Damage leading up to the death adds up to the victim's whole HP.
    const hitsCount = rng.int(4, 8);
    let left = victim.maxHp;
    for (let h = 0; h < hitsCount; h++) {
      const at = tick - Math.round(((hitsCount - h - 1) / hitsCount) * rng.int(8, 22) * TICK_HZ) - (h === hitsCount - 1 ? 0 : rng.int(0, 30));
      const amount = h === hitsCount - 1 ? left : Math.round(left * rng.range(0.15, 0.35));
      left -= amount;
      victim.hits.push({ tick: Math.max(1, at), amount });
      if (amount >= 30) {
        marks.push({
          tick: Math.max(1, at), kind: 'big_hit', actorId: killer?.id ?? null, targetId: victim.id,
          text: killer ? `${killer.name} hit ${victim.name} for ${amount}.` : `${victim.name} took ${amount}.`,
          actorBehaviour: killer ? 'brawl' : null, targetBehaviour: 'heal',
        });
      }
    }
    if (killer && rng.chance(0.4)) {
      const at = Math.max(2, tick - rng.int(1, 4) * TICK_HZ);
      const line = fill(rng.pick(DISMEMBER_LINES), killer.name, victim.name);
      marks.push({ tick: at, kind: 'dismember', actorId: killer.id, targetId: victim.id, text: line, actorBehaviour: 'brawl', targetBehaviour: 'heal' });
      feed.push({ tick: at, text: line, kind: 'dismember', ids: [killer.id, victim.id] });
    }
    marks.push({ tick, kind: 'kill', actorId: killer?.id ?? null, targetId: victim.id, text, actorBehaviour: killer ? 'brawl' : null, targetBehaviour: 'heal' });
    feed.push({ tick, text, kind: 'kill', ids: killer ? [killer.id, victim.id] : [victim.id] });
    if (killer) killsAt.set(killer.id, [...(killsAt.get(killer.id) ?? []), tick]);
    kills.push({
      tick,
      killerId: killer?.id ?? null,
      victimId: victim.id,
      weapon: killer ? killer.strategy.build.weapon : null,
      cause,
      pos: { x: 680, y: 430 },
      flags,
      killerBehaviour: killer ? Object.keys(killer.strategy.behaviours)[0] ?? null : null,
      victimBehaviour: Object.keys(victim.strategy.behaviours)[0] ?? 'idle',
    });
  }
  // Power-ups: each pedestal first fills at firstSpawnTicks and is taken a little later by whoever is near.
  const map = MAPS[config.mapId] ?? MAPS.pit;
  for (const p of map?.pickups ?? []) {
    const rule = PICKUP_RULES[p.kind];
    for (let at = rule.firstSpawnTicks + rng.int(2, 8) * TICK_HZ; at < endTick; at += rule.cooldownTicks + rng.int(1, 9) * TICK_HZ) {
      const alive = fighters.filter((f) => f.deathTick === null || f.deathTick > at);
      if (alive.length === 0) break;
      const taker = rng.pick(alive);
      const text = `${taker.name} took the ${rule.name.toLowerCase()}.`;
      marks.push({ tick: at, kind: 'pickup', actorId: taker.id, targetId: null, text, actorBehaviour: 'grab_powerup', targetBehaviour: null });
      feed.push({ tick: at, text, kind: 'pickup', ids: [taker.id] });
    }
  }
  if (config.suddenDeath && endTick > config.timeLimitTicks) {
    marks.push({ tick: config.timeLimitTicks, kind: 'sudden_death', actorId: null, targetId: null, text: 'The walls are closing. Somebody do something.', actorBehaviour: null, targetBehaviour: null });
  }

  // The winner takes a beating too, but lives.
  const wHits = rng.int(3, 6);
  for (let h = 0; h < wHits; h++) winner.hits.push({ tick: rng.int(5 * TICK_HZ, endTick - TICK_HZ), amount: Math.round(winner.maxHp * rng.range(0.08, 0.16)) });
  winner.place = 1;
  for (const f of fighters) f.hits.sort((a, b) => a.tick - b.tick);
  if (config.suddenDeath && endTick > config.timeLimitTicks) {
    feed.push({ tick: config.timeLimitTicks, text: 'The walls are closing. Somebody do something.', kind: 'sudden_death', ids: [] });
  }
  feed.sort((a, b) => a.tick - b.tick);
  marks.sort((a, b) => a.tick - b.tick);
  const placements = [winner.id, ...order.slice(0, n - 1).reverse().map((i) => fighters[i].id)];
  return { config, fighters, endTick, feed, marks, kills, placements };
}

const hpAt = (f: ScriptFighter, tick: number) => Math.max(0, f.maxHp - f.hits.reduce((s, h) => (h.tick <= tick ? s + h.amount : s), 0));
const aliveAt = (f: ScriptFighter, tick: number) => f.deathTick === null || tick < f.deathTick;

/** Where a scripted fighter actually went, sampled twice a second, as a report heatmap. */
function pathHeatmap(f: ScriptFighter, s: Script): Heatmap {
  const map = MAPS[s.config.mapId] ?? MAPS.pit!;
  const h = createHeatmap(map.width, map.height);
  const end = f.deathTick ?? s.endTick;
  for (let t = 0; t < end; t += 30) {
    const p = posAt(f, t, map.width, map.height);
    addToHeatmap(h, p.x, p.y, Math.min(30, end - t));
  }
  return h;
}

function posAt(f: ScriptFighter, tick: number, w: number, h: number): { x: number; y: number } {
  const t = (f.deathTick !== null ? Math.min(tick, f.deathTick) : tick) / TICK_HZ;
  const o = f.orbit;
  return {
    x: w / 2 + Math.cos(o.w * t + o.phase) * o.rx + Math.sin(t * 0.7 + o.phase) * 30,
    y: h / 2 + Math.sin(o.w * 1.3 * t + o.phase) * o.ry + Math.cos(t * 0.5 + o.phase) * 24,
  };
}

function behaviourAt(f: ScriptFighter, tick: number): string {
  const names = Object.keys(f.strategy.behaviours);
  if (names.length === 0) return 'idle';
  const segment = Math.floor(tick / (3 * TICK_HZ));
  return names[hashString(`${f.id}:${segment}`) % names.length];
}

function termLabel(t: MoveTerm): string {
  if ('seek' in t) return `seek ${t.seek}`;
  if ('flee' in t) return `flee ${t.flee}`;
  if ('keep_range' in t) return `keep_range ${t.keep_range[0]} ${t.keep_range[1]}-${t.keep_range[2]}`;
  if ('orbit' in t) return `orbit ${t.orbit[0]} ${t.orbit[1]}`;
  if ('avoid' in t) return `avoid ${t.avoid}`;
  return `prefer ${t.prefer}`;
}

// ---------------------------------------------------------------------------------------------
// Fake gym
// ---------------------------------------------------------------------------------------------

function abortError(): Error {
  const err = new Error('Stopped');
  err.name = 'AbortError';
  return err;
}

function rating(avgPlace: number, fighters: number, matches: number): Rating {
  const mu = 25 + (fighters / 2 - avgPlace) * 2.4;
  const sigma = Math.max(1.4, 8.333 / Math.sqrt(1 + matches / 3));
  return { mu, sigma, ordinal: mu - 3 * sigma };
}

/** Fake strength per strategy so the same names win and lose consistently across batches. */
const strength = (s: Strategy) => (hashString(strategyKey(s)) % 1000) / 1000;

/** Kill stamps as the sim would title a death, by weapon or cause (mock only). */
const STAMPS: Record<WeaponId, string> = {
  GREATSWORD: 'SPLIT', WARHAMMER: 'FLATTENED', TWIN_DAGGERS: 'BACKSTAB', THROWING_AXES: 'AXED', LONGBOW: 'PINNED', ARCANE_STAFF: 'VAPORIZED',
};
const CAUSE_STAMPS: Partial<Record<KillCause, string>> = { hazard: 'SAWED', keg: 'KABOOM', sudden_death: 'CLOSED IN', friendly: 'OOPS' };

function deathRecord(k: KillRecord | undefined): DeathRecord | null {
  if (!k) return null;
  return {
    tick: k.tick, cause: k.cause, killerId: k.killerId, weapon: k.weapon, hazard: k.cause === 'hazard' ? 'saw' : null, flags: k.flags,
    title: CAUSE_STAMPS[k.cause] ?? (k.weapon ? STAMPS[k.weapon] : 'DOWN'),
  };
}

/** Believable movement and engagement numbers for `alive` ticks of a match. */
function fakeStats(rng: Rng, alive: number, attacks: number, hits: number, kills: number, enemyDeaths: number): FighterStats {
  const engaged = Math.round(alive * rng.range(0.15, 0.55));
  const assists = rng.int(0, 2);
  return {
    distanceTravelled: Math.round(alive * rng.range(0.6, 1.5)),
    accuracy: attacks > 0 ? Math.min(1, hits / attacks) : 0,
    skillHits: rng.int(0, 4),
    ticksEngaged: engaged,
    damageDealtPerSecondEngaged: Math.round(rng.range(8, 40) * 10) / 10,
    damageTakenPerSecondEngaged: Math.round(rng.range(8, 40) * 10) / 10,
    ticksToFirstContact: rng.chance(0.93) ? rng.int(2, 15) * TICK_HZ : null,
    ticksIdle: rng.int(0, 420),
    ticksStuck: rng.chance(0.4) ? rng.int(0, 160) : 0,
    ticksNearWalls: Math.round(alive * rng.range(0.05, 0.5)),
    ticksOutsideZone: rng.chance(0.3) ? rng.int(10, 240) : 0,
    assists,
    killParticipation: enemyDeaths > 0 ? Math.min(1, (kills + assists) / enemyDeaths) : 0,
  };
}

/** A home spot it keeps going back to, plus wandering, so heatmaps have a shape worth reading. */
function fakeHeatmap(rng: Rng, mapId: string, alive: number): Heatmap {
  const map = MAPS[mapId] ?? MAPS.pit!;
  const h = createHeatmap(map.width, map.height);
  const hx = rng.range(0.1, 0.9) * map.width;
  const hy = rng.range(0.1, 0.9) * map.height;
  const homeShare = rng.range(0.3, 0.8);
  for (let t = 0; t < alive; t += 30) {
    const home = rng.chance(homeShare);
    addToHeatmap(h, home ? hx + rng.normal(0, 70) : rng.range(0, map.width), home ? hy + rng.normal(0, 60) : rng.range(0, map.height), Math.min(30, alive - t));
  }
  return h;
}

function averageStats(list: readonly FighterStats[]): FighterStats {
  const n = Math.max(1, list.length);
  const avg = (f: (s: FighterStats) => number) => list.reduce((a, s) => a + f(s), 0) / n;
  const contacts = list.map((s) => s.ticksToFirstContact).filter((v): v is number => v !== null);
  return {
    distanceTravelled: avg((s) => s.distanceTravelled),
    accuracy: avg((s) => s.accuracy),
    skillHits: avg((s) => s.skillHits),
    ticksEngaged: avg((s) => s.ticksEngaged),
    damageDealtPerSecondEngaged: avg((s) => s.damageDealtPerSecondEngaged),
    damageTakenPerSecondEngaged: avg((s) => s.damageTakenPerSecondEngaged),
    ticksToFirstContact: contacts.length ? contacts.reduce((a, v) => a + v, 0) / contacts.length : null,
    ticksIdle: avg((s) => s.ticksIdle),
    ticksStuck: avg((s) => s.ticksStuck),
    ticksNearWalls: avg((s) => s.ticksNearWalls),
    ticksOutsideZone: avg((s) => s.ticksOutsideZone),
    assists: avg((s) => s.assists),
    killParticipation: avg((s) => s.killParticipation),
  };
}

function fakeReports(req: { candidates: Strategy[]; field: Strategy[]; mapIds: string[]; matches: number; fighters: number; seed: number }, boost: number): MatchReport[] {
  const rng = new Rng(req.seed).fork('batch');
  const reports: MatchReport[] = [];
  for (let m = 0; m < req.matches; m++) {
    const lineup = [...req.candidates];
    while (lineup.length < req.fighters && req.field.length) lineup.push(rng.pick(req.field));
    const seen = new Map<string, number>();
    const roster = lineup.map((s, i) => {
      const c = (seen.get(s.name) ?? 0) + 1;
      seen.set(s.name, c);
      return {
        fighterId: `f${i}`,
        entrantId: `e${i}`,
        name: c === 1 ? s.name : `${s.name} ${['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'][c] ?? c}`,
        strategyName: s.name,
        strategyVersion: s.version ?? 1,
        strategyKey: strategyKey(s),
        weapon: s.build.weapon,
        skill: s.build.skill,
        squad: i,
        color: FIGHTER_COLORS[i % FIGHTER_COLORS.length],
      };
    });
    const score = lineup.map((s, i) => strength(s) + (i < req.candidates.length ? boost : 0) + rng.normal(0, 0.35));
    const placements = roster.map((r) => r.fighterId).sort((a, b) => score[Number(b.slice(1))] - score[Number(a.slice(1))]);
    const ticks = rng.int(45, 115) * TICK_HZ;
    const n = placements.length;
    const kills: KillRecord[] = [];
    const killCount = new Map<string, number>();
    for (let p = n - 1; p >= 1; p--) {
      const victimId = placements[p];
      const killerId = rng.chance(0.88) ? placements[rng.int(0, p - 1)] : null;
      const tick = Math.round(ticks * (1 - (p - 1) / n) * rng.range(0.85, 1));
      if (killerId) killCount.set(killerId, (killCount.get(killerId) ?? 0) + 1);
      const killer = roster.find((r) => r.fighterId === killerId);
      kills.push({
        tick,
        killerId,
        victimId,
        weapon: killer?.weapon ?? null,
        cause: killerId ? (rng.chance(0.15) ? 'skill' : 'weapon') : rng.pick(['hazard', 'keg', 'sudden_death'] as KillCause[]),
        pos: { x: 680, y: 430 },
        flags: [],
        killerBehaviour: killerId ? 'brawl' : null,
        victimBehaviour: 'heal',
      });
    }
    const mapId = req.mapIds[m % req.mapIds.length];
    const fighters: FighterReport[] = placements.map((id, p) => {
      const died = kills.find((k) => k.victimId === id);
      const attacks = rng.int(8, 40);
      const hitsLanded = rng.int(3, Math.max(3, Math.min(attacks, 20)));
      const aliveTicks = died ? died.tick : ticks;
      return {
        fighterId: id,
        place: p + 1,
        kills: killCount.get(id) ?? 0,
        damageDealt: Math.round(rng.range(60, 360) * (1 + (n - p) / n)),
        damageTaken: Math.round(rng.range(150, 380)),
        diedAtTick: died ? died.tick : null,
        behaviourTicks: { brawl: rng.int(400, 2400), heal: rng.int(0, 900), lurk: rng.int(0, 1400) },
        neverWon: rng.chance(0.15) ? ['guard_corner'] : [],
        exposure: { ticksAlive: died ? died.tick : ticks, ticksSeen: rng.int(200, 2000), ticksInShadow: rng.int(0, 1800) },
        damageDealtBySource: { weapon: rng.int(40, 300), skill: rng.int(0, 80) },
        damageTakenBySource: { weapon: rng.int(80, 300), hazard: rng.int(0, 40) },
        attacks,
        hitsLanded,
        skillUses: rng.int(0, 6),
        parries: rng.int(0, 4),
        pickupsTaken: rng.chance(0.5) ? { berserk: rng.int(1, 3) } : {},
        killsWhileBuffed: {},
        guardTrips: [],
        stats: fakeStats(rng, aliveTicks, attacks, hitsLanded, killCount.get(id) ?? 0, n - 1),
        death: deathRecord(died),
        heatmap: fakeHeatmap(rng, mapId, aliveTicks),
      };
    });
    const ending: MatchEnding = rng.chance(0.08) ? 'judges' : 'elimination';
    const sdStart = rng.chance(0.45) ? { tick: rng.int(60, 90) * TICK_HZ, reason: rng.chance(0.7) ? ('time' as const) : ('stalemate' as const) } : null;
    const winner = roster.find((r) => r.fighterId === placements[0])!;
    reports.push({
      seed: (req.seed + m * 7919) >>> 0,
      mapId,
      format: 'ffa',
      timeLimitTicks: DEFAULT_TIME_LIMIT_TICKS,
      suddenDeath: true,
      friendlyFire: true,
      ticks,
      ending,
      suddenDeathStart: ending === 'judges' ? { tick: DEFAULT_TIME_LIMIT_TICKS, reason: 'time' } : sdStart,
      judges: ending === 'judges' ? [{ id: placements[0]!, hpFraction: 0.4, damageDealt: 300, kills: killCount.get(placements[0]!) ?? 0 }] : null,
      roster,
      placements,
      kills,
      fighters,
      findings: [`${winner.name} won with ${killCount.get(winner.fighterId) ?? 0} kills.`],
    });
  }
  return reports;
}

function aggregate(reports: MatchReport[], seed: number, mapIds: string[], fighters: number): AggregateReport {
  type Acc = {
    key: string; name: string; version: number; places: number[]; byMap: Map<string, [number, number]>; byOpp: Map<string, [number, number]>;
    kills: number; dmg: number; surv: number; deaths: Map<KillCause, number>; killers: Map<string, number>;
    stats: FighterStats[]; heat: Map<string, Heatmap>; sd: number; judged: number; judgedWins: number; matchesSeen: Set<number>;
  };
  const accs = new Map<string, Acc>();
  for (const r of reports) {
    const keyOf = new Map(r.roster.map((x) => [x.fighterId, x.strategyKey]));
    for (const entry of r.roster) {
      let a = accs.get(entry.strategyKey);
      if (!a) {
        a = {
          key: entry.strategyKey, name: entry.strategyName, version: entry.strategyVersion, places: [], byMap: new Map(), byOpp: new Map(), kills: 0, dmg: 0, surv: 0,
          deaths: new Map(), killers: new Map(), stats: [], heat: new Map(), sd: 0, judged: 0, judgedWins: 0, matchesSeen: new Set(),
        };
        accs.set(entry.strategyKey, a);
      }
      const fr = r.fighters.find((f) => f.fighterId === entry.fighterId)!;
      a.places.push(fr.place);
      a.stats.push(fr.stats);
      const heat = a.heat.get(r.mapId);
      if (heat) mergeHeatmap(heat, fr.heatmap);
      else a.heat.set(r.mapId, { ...fr.heatmap, counts: [...fr.heatmap.counts] });
      const ri = reports.indexOf(r);
      if (!a.matchesSeen.has(ri)) {
        a.matchesSeen.add(ri);
        if (r.suddenDeathStart) a.sd++;
        if (r.ending === 'judges') {
          a.judged++;
          if (fr.place === 1) a.judgedWins++;
        }
      }
      const m = a.byMap.get(r.mapId) ?? [0, 0];
      a.byMap.set(r.mapId, [m[0] + 1, m[1] + (fr.place === 1 ? 1 : 0)]);
      for (const other of r.roster) {
        if (other.strategyKey === entry.strategyKey) continue;
        const of = r.fighters.find((f) => f.fighterId === other.fighterId)!;
        const o = a.byOpp.get(other.strategyKey) ?? [0, 0];
        a.byOpp.set(other.strategyKey, [o[0] + 1, o[1] + (fr.place < of.place ? 1 : 0)]);
      }
      a.kills += fr.kills;
      a.dmg += fr.damageDealt;
      a.surv += fr.diedAtTick ?? r.ticks;
      const death = r.kills.find((k) => k.victimId === entry.fighterId);
      if (death) {
        a.deaths.set(death.cause, (a.deaths.get(death.cause) ?? 0) + 1);
        const kk = death.killerId ? keyOf.get(death.killerId) : undefined;
        if (kk) a.killers.set(kk, (a.killers.get(kk) ?? 0) + 1);
      }
    }
  }
  const strategies: StrategyAggregate[] = [...accs.values()].map((a) => {
    const matches = a.places.length;
    const hist = Array.from({ length: fighters }, (_, i) => a.places.filter((p) => p === i + 1).length);
    const avgPlace = a.places.reduce((s, p) => s + p, 0) / matches;
    const top = [...a.killers.entries()].sort((x, y) => y[1] - x[1])[0];
    const toRecord = (m: Map<string, [number, number]>) =>
      Object.fromEntries([...m.entries()].map(([k, [mt, w]]) => [k, { matches: mt, wins: w, winRate: mt ? w / mt : 0 }]));
    const winRate = hist[0] / matches;
    const findings = [
      winRate >= 0.3 ? `${a.name} v${a.version} won ${hist[0]} of ${matches}. That is not luck.` : `${a.name} v${a.version} won ${hist[0]} of ${matches}.`,
      top ? `Died to ${top[0].replace(/@v(\d+)$/, ' v$1')} more than anyone else (${top[1]} times).` : 'Nobody killed it twice.',
    ];
    if (a.deaths.get('hazard')) findings.push(`Walked into hazards ${a.deaths.get('hazard')} times. Check the avoid terms.`);
    return {
      key: a.key,
      name: a.name,
      version: a.version,
      matches,
      placementHistogram: hist,
      avgPlace,
      winRate,
      byMap: toRecord(a.byMap),
      byOpponent: toRecord(a.byOpp),
      killedMostBy: top ? { key: top[0], count: top[1] } : null,
      avgKills: a.kills / matches,
      avgDamageDealt: a.dmg / matches,
      avgSurvivalTicks: a.surv / matches,
      deathsByCause: Object.fromEntries(a.deaths),
      pickupsTaken: {},
      killsWhileBuffed: {},
      guardTrips: [],
      stats: averageStats(a.stats),
      heatmaps: Object.fromEntries(a.heat),
      suddenDeath: { matches: a.sd, share: a.sd / Math.max(1, a.matchesSeen.size), byReason: { time: a.sd }, avgStartTick: a.sd ? 80 * TICK_HZ : null },
      judges: { matches: a.judged, share: a.judged / Math.max(1, a.matchesSeen.size), wins: a.judgedWins },
      findings,
      rating: rating(avgPlace, fighters, matches),
    };
  });
  strategies.sort((x, y) => y.rating.ordinal - x.rating.ordinal);
  const judged = reports.filter((r) => r.ending === 'judges');
  const sd = reports.filter((r) => r.suddenDeathStart);
  const byReason: Partial<Record<'time' | 'stalemate', number>> = {};
  for (const r of sd) byReason[r.suddenDeathStart!.reason] = (byReason[r.suddenDeathStart!.reason] ?? 0) + 1;
  return {
    matches: reports.length,
    seed,
    mapIds,
    endings: { elimination: reports.length - judged.length, ...(judged.length ? { judges: judged.length } : {}) },
    suddenDeath: {
      matches: sd.length,
      share: sd.length / Math.max(1, reports.length),
      byReason,
      avgStartTick: sd.length ? sd.reduce((n, r) => n + r.suddenDeathStart!.tick, 0) / sd.length : null,
    },
    judges: {
      matches: judged.length,
      share: judged.length / Math.max(1, reports.length),
      decisions: judged.map((r) => ({
        seed: r.seed,
        mapId: r.mapId,
        survivors: (r.judges ?? []).map((j) => ({ ...j, strategyKey: r.roster.find((x) => x.fighterId === j.id)?.strategyKey ?? '?' })),
      })),
    },
    strategies,
    findings: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------------------------

/**
 * `splash`: start on the splash (loading stages tick off one by one, then "Enter the pit"), like the
 * real app. Off by default so the harness opens straight onto the match.
 */
export type MockOptions = { saved?: { strategy: Strategy; ageMs: number }[]; splash?: boolean };

/** Round start: three beats, then FIGHT! for a moment. The final moment lasts about 3 s. */
const BEAT_MS = 800;
const FIGHT_MS = 600;
const FINAL_MS = 3000;
/** Each loading stage takes this long in the mock splash. */
const STAGE_MS = 450;

/** Rule docs talk in ticks; hover cards talk in seconds. */
const inSeconds = (doc: string) => doc.replace(/(\d+) ticks/g, (_, n: string) => `${(Number(n) / TICK_HZ).toFixed(1)} s`);

export function createMockController(opts: MockOptions = {}): GameController {
  const listeners = new Set<() => void>();
  let script: Script | null = null;
  let tick = 0;
  let maxTick = 0;
  let paused = false;
  let speed = 1;
  let selectedId: string | null = null;
  let hoveredId: string | null = null;
  let followId: string | null = null;
  let hoveredObject: { kind: MapObjectKind; id: string } | null = null;
  let insets = { left: 0, right: 0, top: 0, bottom: 0 };
  // Match flow: splash, countdown, final moment (wall-clock, like the real controller).
  const bootAt = performance.now();
  let entered = !opts.splash;
  let countdownEnd = 0;
  let fightUntil = 0;
  let finalUntil = 0;
  /** The final moment of this match was already shown; replaying to the end goes straight to the card. */
  let admired = false;
  let jobs: BackgroundJob[] = [];
  let nextJobId = 1;
  // Persisted like the real controller does, under a dev-only key.
  let view: ViewSettings = readStored('poc.dev.view', { ...DEFAULT_VIEW_SETTINGS }, (v, fallback) =>
    typeof v === 'object' && v !== null ? { ...fallback, ...pickKnown(v as Record<string, unknown>) } : fallback,
  );
  let dirty = true;
  let snapshot: UiSnapshot = build();

  function mapSize() {
    const m = MAPS[script?.config.mapId ?? 'pit'] ?? MAPS.pit;
    return { w: m?.width ?? 1360, h: m?.height ?? 860 };
  }

  function build(): UiSnapshot {
    const t = Math.floor(tick);
    const s = script;
    const fighters = s
      ? s.fighters.map((f) => {
          const alive = aliveAt(f, t);
          return {
            id: f.id,
            name: f.name,
            color: f.color,
            hp: alive ? hpAt(f, t) : 0,
            maxHp: f.maxHp,
            alive,
            kills: s.kills.filter((k) => k.killerId === f.id && k.tick <= t).length,
            weapon: f.strategy.build.weapon,
            skill: f.strategy.build.skill,
            behaviour: alive ? behaviourAt(f, t) : 'dead',
            place: !alive ? f.place : t >= s.endTick ? f.place : null,
            squad: f.squad,
          };
        })
      : [];
    const finished = !!s && t >= s.endTick;
    const loading = loadingNow();
    const phase = phaseNow(loading.every((st) => st.done), finished);
    const now = performance.now();
    return {
      phase,
      countdown: phase === 'countdown' ? Math.max(1, Math.ceil((countdownEnd - now) / BEAT_MS)) : phase === 'live' && now < fightUntil ? 0 : null,
      loading,
      jobs: jobs.map((j) => ({ ...j })),
      tick: t,
      speed,
      paused,
      mapId: s?.config.mapId ?? 'pit',
      format: s?.config.format ?? 'ffa',
      seed: s?.config.seed ?? 0,
      timeLimitTicks: s?.config.timeLimitTicks ?? DEFAULT_TIME_LIMIT_TICKS,
      suddenDeath: !!s && s.config.suddenDeath && t >= s.config.timeLimitTicks,
      maxTick,
      fighters,
      feed: s ? s.feed.filter((x) => x.tick <= maxTick) : [],
      marks: s ? s.marks.filter((x) => x.tick <= maxTick) : [],
      selectedId,
      hoveredId,
      hoveredObject,
      followId,
      // The mock has no arena camera to take over.
      cameraManual: false,
      view,
      finished,
      placements: finished && s ? s.placements : [],
      ending: finished ? 'elimination' : null,
      source: 'local',
      arenaError: null,
    };
  }

  function loadingNow() {
    const ms = performance.now() - bootAt;
    return LOADING_STAGES.map((st, i) => ({
      id: st.id,
      label: st.label,
      done: (!opts.splash || ms > (i + 1) * STAGE_MS) && (st.id !== 'match' || script !== null),
    }));
  }

  function phaseNow(loaded: boolean, finished: boolean): MatchPhase {
    if (!loaded) return 'loading';
    if (!entered) return 'splash';
    const now = performance.now();
    if (countdownEnd > now) return 'countdown';
    if (finished) return finalUntil > now ? 'final' : 'ended';
    return 'live';
  }

  /** Every match starts with "3, 2, 1, FIGHT!" once the splash has been entered. */
  function beginRound() {
    admired = false;
    finalUntil = 0;
    if (!entered) return;
    const now = performance.now();
    countdownEnd = now + 3 * BEAT_MS;
    fightUntil = countdownEnd + FIGHT_MS;
  }

  function publish() {
    if (!dirty) return;
    dirty = false;
    snapshot = build();
    listeners.forEach((fn) => fn());
  }
  const change = () => {
    dirty = true;
    publish();
  };

  // Game loop: advance at 60 ticks per second times speed; notify at most 10 times a second.
  let lastFrame = performance.now();
  let lastNotify = 0;
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    const phase = snapshot.phase;
    // The sim holds behind the splash and during the countdown.
    if (script && !paused && tick < script.endTick && entered && countdownEnd <= now) {
      tick = Math.min(script.endTick, tick + dt * TICK_HZ * speed);
      if (Math.floor(tick) > maxTick) maxTick = Math.floor(tick);
      if (tick >= script.endTick && !admired) {
        admired = true;
        finalUntil = now + FINAL_MS;
      }
      dirty = true;
    }
    // Wall-clock beats (loading stages, countdown, FIGHT!, the final moment) need notifications too.
    if (phase === 'loading' || phase === 'countdown' || phase === 'final' || now < fightUntil + 200 || (phase === 'splash' && !entered)) dirty = true;
    if (now - lastNotify >= 100) {
      lastNotify = now;
      publish();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  const fighterById = (id: string) => script?.fighters.find((f) => f.id === id) ?? null;

  function fighterState(id: string): FighterState | null {
    const f = fighterById(id);
    if (!f || !script) return null;
    const t = Math.floor(tick);
    const { w, h } = mapSize();
    const pos = posAt(f, t, w, h);
    const next = posAt(f, t + 1, w, h);
    const a = f.strategy.build.attributes;
    const weapon = f.strategy.build.weapon;
    const alive = aliveAt(f, t);
    const hash = hashString(`${id}:${Math.floor(t / 90)}`);
    const facing = Math.atan2(next.y - pos.y, next.x - pos.x);
    const maxAmmo = WEAPONS[weapon].ammo;
    return {
      id,
      entrantId: f.entrantId,
      squad: f.squad,
      name: f.name,
      color: f.color,
      weapon,
      skill: f.strategy.build.skill,
      attributes: { ...a },
      pos,
      vel: { x: next.x - pos.x, y: next.y - pos.y },
      facing,
      headAngle: facing,
      radius: fighterRadius(a),
      hp: alive ? hpAt(f, t) : 0,
      maxHp: f.maxHp,
      alive,
      diedAtTick: alive ? null : f.deathTick,
      anim: { phase: 'idle', t: 0, dur: 0 },
      walkPhase: t * 0.2,
      attackCd: hash % 40,
      skillCd: (hash >> 3) % 300,
      parryTicks: 0,
      parryCd: 0,
      stunTicks: hash % 11 === 0 ? 20 : 0,
      ammo: maxAmmo > 0 ? hash % (maxAmmo + 1) : 0,
      maxAmmo,
      buffs: { haste: hash % 7 === 0 ? 80 : 0, berserk: hash % 13 === 0 ? 90 : 0, slow: 0 },
      limbs: { armL: true, armR: true, legL: hash % 17 !== 0, legR: true },
      helmet: true,
      inShadow: hash % 3 === 0,
      seen: hash % 2 === 0,
      stance: f.strategy.behaviours[behaviourAt(f, t)]?.stance ?? 'normal',
      hitFlash: 0,
      eyePop: 0,
      behaviour: alive ? behaviourAt(f, t) : 'dead',
      targetId: null,
      kills: script.kills.filter((k) => k.killerId === id && k.tick <= t).length,
      damageDealt: Math.round(t * 0.06 * (0.5 + (hashString(id) % 10) / 10)),
      damageTaken: f.maxHp - hpAt(f, t),
      lastHitBy: null,
      lastHitTick: null,
      place: alive ? null : f.place,
    };
  }

  /** The closing zone as the sim would have it at `t` (the wall starts at the time limit). */
  function zoneAt(t: number): SuddenDeathState {
    const { w, h } = mapSize();
    const z = initialSuddenDeathState({ width: w, height: h });
    const tl = script?.config.timeLimitTicks ?? DEFAULT_TIME_LIMIT_TICKS;
    if (!script?.config.suddenDeath || t < tl) return z;
    const d = (t - tl) * MATCH_RULES.suddenDeathInsetPerTick;
    const x = Math.min(z.final.x, d);
    const y = Math.min(z.final.y, d);
    z.active = true;
    z.reason = 'time';
    z.startedAtTick = tl;
    z.inset = d;
    z.bounds = { x, y, w: w - 2 * x, h: h - 2 * y };
    if (x >= z.final.x && y >= z.final.y) z.closedAtTick = tl + Math.ceil(Math.max(z.final.x, z.final.y) / MATCH_RULES.suddenDeathInsetPerTick);
    return z;
  }

  function zoneSensors(me: { x: number; y: number }, t: number): Record<string, number> {
    const z = zoneAt(t);
    const reach = zoneTicksToReach(z, me);
    return { sudden_death: z.active ? 1 : 0, 'zone.distance': Math.round(zoneEdgeDistance(z, me)), 'zone.time_to_reach': Number.isFinite(reach) ? Math.round((reach / TICK_HZ) * 10) / 10 : 9999 };
  }

  function pickupSensors(me: { x: number; y: number }, t: number): Record<string, number> {
    const map = MAPS[script?.config.mapId ?? 'pit'];
    const out: Record<string, number> = {};
    let any = 9999;
    let respawn = 0;
    for (const kind of ['haste', 'berserk'] as const) {
      const rule = PICKUP_RULES[kind];
      const pads = (map?.pickups ?? []).filter((p) => p.kind === kind);
      const d = pads.length ? Math.min(...pads.map((p) => Math.hypot(p.pos.x - me.x, p.pos.y - me.y))) : 9999;
      const cycle = (t - rule.firstSpawnTicks) % (rule.cooldownTicks + 300);
      const ready = t >= rule.firstSpawnTicks && cycle < 300;
      out[`pickup.${kind}.distance`] = Math.round(d);
      out[`pickup.${kind}.ready`] = ready ? 1 : 0;
      if (d < any) {
        any = d;
        respawn = ready ? 0 : ((t < rule.firstSpawnTicks ? rule.firstSpawnTicks - t : rule.cooldownTicks + 300 - cycle) / TICK_HZ);
      }
    }
    out['pickup.any.distance'] = Math.round(any);
    out['pickup.respawn_in'] = Math.round(respawn * 10) / 10;
    return out;
  }

  function targetSensors(id: string, targetId: string | null, t: number): Record<string, number> {
    const k = targetId ? knowledgeAt(id, t).find((x) => x.id === targetId) : undefined;
    return {
      'target.visible': k?.seen ? 1 : 0,
      'target.heard': k?.heard ? 1 : 0,
      'target.last_seen_age': k && k.lastSeenTick >= 0 ? Math.round(((t - k.lastSeenTick) / TICK_HZ) * 10) / 10 : 9999,
    };
  }

  /** Some fighters' brains trip guards, so the inspector badge has something to show. */
  function guardTripsFor(f: ScriptFighter, t: number): GuardTrip[] {
    if (hashString(f.id + f.name) % 3 !== 0) return [];
    const b = Object.keys(f.strategy.behaviours)[0] ?? 'brawl';
    const trips: GuardTrip[] = [
      { path: `behaviours.${b}.score`, kind: 'div_zero', count: Math.floor(t / 24) },
      { path: `behaviours.${b}.move[0].weight`, kind: 'clamped', count: Math.floor(t / 300) },
    ];
    return trips.filter((x) => x.count > 0);
  }

  /**
   * What fighter `id` knows at `t`: close and in front is seen (exact), a bit further is heard (a
   * fuzzy estimate, refreshed every half second), and some others are remembered where last seen.
   */
  function knowledgeAt(id: string, t: number): KnownFighter[] {
    const me = fighterById(id);
    if (!me || !script || !aliveAt(me, t)) return [];
    const { w, h } = mapSize();
    const p = posAt(me, t, w, h);
    const out: KnownFighter[] = [];
    for (const o of script.fighters) {
      if (o === me || o.squad === me.squad || !aliveAt(o, t)) continue;
      const q = posAt(o, t, w, h);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      const hash = hashString(`${id}:${o.id}:${Math.floor(t / 30)}`);
      const weapon = o.strategy.build.weapon;
      const base = {
        id: o.id, squad: o.squad, vel: { x: 0, y: 0 }, facing: 0, hp: hpAt(o, t), maxHp: o.maxHp, weapon, family: WEAPONS[weapon].family,
        fighting: false, ammo: 0, kills: script.kills.filter((k) => k.killerId === o.id && k.tick <= t).length, windingUp: false,
      };
      if (d < 330) {
        out.push({ ...base, pos: q, seen: true, heard: false, estimateError: 0, lastSeenTick: t, lastSeenPos: q });
      } else if (d < 520) {
        const err = 24 + d * 0.2;
        const a = (hash % 628) / 100;
        const r = err * (0.5 + ((hash >> 10) % 50) / 100);
        const seenAt = hash % 4 === 0 ? -1 : Math.max(0, t - 90 - (hash % 600));
        out.push({ ...base, pos: { x: q.x + Math.cos(a) * r, y: q.y + Math.sin(a) * r }, seen: false, heard: true, estimateError: err, lastSeenTick: seenAt, lastSeenPos: q });
      } else if (hashString(`${id}:${o.id}`) % 3 === 0) {
        const seenAt = Math.max(0, t - 60 - (hashString(`${o.id}:${id}`) % 420));
        const last = posAt(o, seenAt, w, h);
        out.push({ ...base, pos: last, seen: false, heard: false, estimateError: 0, lastSeenTick: seenAt, lastSeenPos: last });
      }
    }
    return out;
  }

  const knowledge = (id: string): readonly KnownFighter[] => knowledgeAt(id, Math.floor(tick));

  function decision(id: string): Decision | null {
    const f = fighterById(id);
    if (!f || !script) return null;
    const t = Math.floor(tick);
    if (!aliveAt(f, t)) return null;
    const think = Math.floor(t / 6) * 6;
    const active = behaviourAt(f, think);
    const names = Object.keys(f.strategy.behaviours);
    const scores: Record<string, number> = {};
    for (const n of names) scores[n] = Math.round((0.2 + ((hashString(n + id) % 50) / 100) + 0.15 * Math.sin(think / 40 + n.length)) * 100) / 100;
    scores[active] = Math.max(...Object.values(scores)) + 0.18;
    const { w, h } = mapSize();
    const me = posAt(f, think, w, h);
    const others = script.fighters.filter((o) => o !== f && aliveAt(o, think));
    let target: ScriptFighter | null = null;
    let best = Infinity;
    for (const o of others) {
      const p = posAt(o, think, w, h);
      const d = Math.hypot(p.x - me.x, p.y - me.y);
      if (d < best) {
        best = d;
        target = o;
      }
    }
    const toTarget = target ? Math.atan2(posAt(target, think, w, h).y - me.y, posAt(target, think, w, h).x - me.x) : 0;
    const terms = (f.strategy.behaviours[active]?.move ?? []).map((term, k) => {
      const negative = 'avoid' in term || 'flee' in term;
      const centre = toTarget + ('orbit' in term ? Math.PI / 2 : 0) + k * 0.9 + Math.sin(think / 50) * 0.4;
      const ratings = Array.from({ length: STEER_DIRS }, (_, i) => {
        const c = Math.cos(steerAngle(i) - centre);
        const v = negative ? -(Math.max(0, c) ** 2) : 'keep_range' in term ? c * 0.8 : Math.max(-0.3, c);
        return Math.round(v * term.weight * 100) / 100;
      });
      return { label: termLabel(term), ratings };
    });
    const ring = Array.from({ length: STEER_DIRS }, (_, i) => clamp(terms.reduce((s, tr) => s + tr.ratings[i], 0), -1, 1));
    let bestDir = 0;
    for (let i = 1; i < STEER_DIRS; i++) if (ring[i] > ring[bestDir]) bestDir = i;
    const hp = hpAt(f, think) / f.maxHp;
    return {
      behaviour: active,
      scores,
      targetId: target?.id ?? null,
      heading: steerAngle(bestDir),
      speed: 0.85,
      ring,
      terms,
      attack: best < 90,
      parry: true,
      useSkill: best < 70 && think % 120 < 6,
      stance: f.strategy.behaviours[active]?.stance ?? 'normal',
      guardTrips: guardTripsFor(f, think),
      sensors: {
        ...zoneSensors(me, think),
        ...pickupSensors(me, think),
        ...targetSensors(id, target?.id ?? null, think),
        'self.hp': Math.round(hp * 100) / 100,
        'self.in_shadow': hashString(`${id}:${Math.floor(think / 90)}`) % 3 === 0 ? 1 : 0,
        'self.light': Math.round((0.3 + 0.5 * Math.abs(Math.sin(think / 200))) * 100) / 100,
        'self.seen': think % 240 < 150 ? 1 : 0,
        'attack.ready': think % 42 < 20 ? 1 : 0,
        'skill.ready': think % 300 < 60 ? 1 : 0,
        'target.distance': Number.isFinite(best) ? Math.round(best) : 0,
        'target.hp': target ? Math.round((hpAt(target, think) / target.maxHp) * 100) / 100 : 0,
        'target.facing_away': think % 180 < 50 ? 1 : 0,
        'target.family_ranged': target && WEAPONS[target.strategy.build.weapon].family === 'ranged' ? 1 : 0,
        enemies_seen: Math.min(others.length, 1 + (think % 3)),
        enemies_known: others.length,
        enemies_near: others.filter((o) => {
          const p = posAt(o, think, w, h);
          return Math.hypot(p.x - me.x, p.y - me.y) < 200;
        }).length,
        'shrine.ready': think % 600 < 300 ? 1 : 0,
        time: Math.round(think / TICK_HZ),
      },
    };
  }

  /** Hover-card data for a map object, with a live state that cycles like the real one would. */
  function objectInfo(kind: MapObjectKind, id: string): ObjectInfo | null {
    const map = MAPS[script?.config.mapId ?? 'pit'];
    if (!map || !script) return null;
    const t = Math.floor(tick);
    const sec = (ticks: number) => `${(Math.max(0, ticks) / TICK_HZ).toFixed(1)} s`;
    switch (kind) {
      case 'shrine': {
        if (!map.shrines.some((x) => x.id === id)) return null;
        const rule = PICKUP_RULES.shrine;
        const cycle = t % 900;
        return {
          kind, id, name: rule.name,
          description: `Heals ${Math.round(rule.amount * 100)}% of max HP on touch, then recharges for ${sec(rule.cooldownTicks)}.`,
          state: cycle < 580 ? 'Ready' : `Recharging, ${sec(900 - cycle)}`,
        };
      }
      case 'pickup': {
        const p = map.pickups.find((x) => x.id === id);
        if (!p) return null;
        const rule = PICKUP_RULES[p.kind];
        const cycle = (t - rule.firstSpawnTicks) % (rule.cooldownTicks + 300);
        const up = t >= rule.firstSpawnTicks && cycle < 300;
        const back = t < rule.firstSpawnTicks ? rule.firstSpawnTicks - t : rule.cooldownTicks + 300 - cycle;
        return { kind, id, name: rule.name, description: inSeconds(rule.doc), state: up ? 'Up for grabs' : `Back in ${sec(back)}` };
      }
      case 'hazard': {
        const h = map.hazards.find((x) => x.id === id);
        if (!h) return null;
        const rule = HAZARD_RULES[h.kind];
        const period = h.period ?? rule.period;
        const state = h.kind === 'spike' ? `Thrusts in ${sec((rule.triggerAt * period - (t % period) + period) % period)}` : h.kind === 'saw' ? 'Rolling its track' : null;
        return { kind, id, name: rule.name, description: inSeconds(rule.doc), state };
      }
      case 'prop': {
        const pr = map.props.find((x) => x.id === id);
        if (!pr) return null;
        const rule = PROP_RULES[pr.kind];
        return { kind, id, name: rule.name, description: inSeconds(rule.doc), state: `${rule.hp} of ${rule.hp} HP` };
      }
    }
  }

  // Strategy store
  const saved: SavedStrategy[] = [];
  const saveAt = (s: Strategy, savedAt: number, meta: Parameters<GameController['strategies']['save']>[1] = {}): SavedStrategy => {
    const version = Math.max(0, ...saved.filter((x) => x.name === s.name).map((x) => x.version)) + 1;
    const strategy = { ...s, version };
    const entry: SavedStrategy = {
      id: `${s.name}@v${version}`,
      name: s.name,
      version,
      savedAt,
      strategy,
      code: encodeStrategyCode(strategy),
      parentId: meta?.parentId ?? null,
      origin: meta?.origin ?? null,
    };
    saved.push(entry);
    return entry;
  };
  for (const f of opts.saved ?? []) saveAt(f.strategy, Date.now() - f.ageMs);

  // Gym
  const board = new Map<string, LeaderboardEntry>();
  let job: { stop: () => void } | null = null;
  const remember = (agg: AggregateReport) => {
    for (const s of agg.strategies) {
      const prev = board.get(s.key);
      const matches = (prev?.matches ?? 0) + s.matches;
      board.set(s.key, {
        key: s.key,
        name: s.name,
        version: s.version,
        rating: s.rating,
        matches,
        wins: (prev?.wins ?? 0) + s.placementHistogram[0],
        avgPlace: prev ? (prev.avgPlace * prev.matches + s.avgPlace * s.matches) / matches : s.avgPlace,
        lastPlayedAt: Date.now(),
      });
    }
  };

  /** Background job for the top-bar chip, like the real controller wraps the gym. */
  const trackJob = (kind: BackgroundJob['kind'], total: number, label: (done: number) => string) => {
    const id = nextJobId++;
    jobs = [...jobs, { id, kind, label: label(0), done: 0, total }];
    change();
    return {
      update(done: number) {
        jobs = jobs.map((j) => (j.id === id ? { ...j, done, label: label(done) } : j));
        change();
      },
      end() {
        jobs = jobs.filter((j) => j.id !== id);
        change();
      },
    };
  };

  const gym: GameController['gym'] = {
    runBatch(req: BatchRequest, onProgress) {
      const tracked = trackJob('batch', req.matches, (d) => `Testing: ${d} of ${req.matches} matches`);
      return new Promise<BatchResult>((resolve, reject) => {
        let done = 0;
        const timer = window.setInterval(() => {
          done++;
          onProgress?.(done, req.matches);
          tracked.update(done);
          if (done < req.matches) return;
          window.clearInterval(timer);
          tracked.end();
          job = null;
          const reports = fakeReports(req, 0.12);
          const agg = aggregate(reports, req.seed, req.mapIds, req.fighters);
          const c = agg.strategies.find((s) => s.key === strategyKey(req.candidates[0]));
          if (c) {
            const map = req.mapIds.length === 1 ? (MAPS[req.mapIds[0]]?.name ?? req.mapIds[0]).replace(/^The /, 'the ') : 'these maps';
            agg.findings.push(
              `${c.name} v${c.version} finished ahead of the house stacks ${Math.round(c.winRate * 10 + (req.fighters - c.avgPlace))} times in 10 on ${map}.`,
              `Rated ${displayRating(c.rating)} after ${c.matches} matches; the number is still settling.`,
            );
          }
          remember(agg);
          resolve({ reports, aggregate: agg });
        }, 60);
        job = {
          stop: () => {
            window.clearInterval(timer);
            tracked.end();
            job = null;
            reject(abortError());
          },
        };
      });
    },
    evolve(req: EvolveRequest, onGeneration) {
      const tracked = trackJob('evolve', req.generations, (d) => `Evolving: gen ${Math.min(d + 1, req.generations)} of ${req.generations}`);
      return new Promise<EvolveResult>((resolve, reject) => {
        const rng = new Rng(req.seed).fork('evolve');
        let champion: Strategy = { ...req.parent, version: req.parent.version ?? 1 };
        const generations: EvolveGeneration[] = [];
        let g = 0;
        let nextVersion = (champion.version ?? 1) + 1;
        const behaviours = Object.keys(req.parent.behaviours);
        const mutate = (): string[] => {
          const b = rng.pick(behaviours.length ? behaviours : ['brawl']);
          const options = [
            `${b}: score weight ${rng.int(4, 9) / 10} -> ${rng.int(4, 12) / 10}`,
            `build: agility ${rng.int(14, 24)} -> ${rng.int(14, 26)}, armor ${rng.int(6, 16)} -> ${rng.int(4, 14)}`,
            `${b}: keep_range max ${rng.int(26, 32) * 10} -> ${rng.int(28, 36) * 10}`,
            `commit ${rng.int(20, 36)} -> ${rng.int(14, 40)}`,
            `${b}: avoid hazards weight ${rng.int(3, 8) / 10} -> ${rng.int(5, 10) / 10}`,
          ];
          return rng.shuffle(options).slice(0, rng.int(1, 2));
        };
        const timer = window.setInterval(() => {
          g++;
          const champAgg = aggregate(fakeReports({ candidates: [champion], field: req.field, mapIds: req.mapIds, matches: req.matchesPerCandidate, fighters: req.fighters, seed: req.seed + g }, 0.1), req.seed, req.mapIds, req.fighters).strategies.find((s) => s.key === strategyKey(champion))!;
          const candidates: EvolveCandidate[] = Array.from({ length: req.population }, (_, i) => {
            const strategy = { ...champion, version: nextVersion + i };
            const agg = aggregate(fakeReports({ candidates: [strategy], field: req.field, mapIds: req.mapIds, matches: req.matchesPerCandidate, fighters: req.fighters, seed: req.seed + g }, rng.range(-0.1, 0.3)), req.seed, req.mapIds, req.fighters).strategies.find((s) => s.key === strategyKey(strategy))!;
            return { strategy, mutations: mutate(), aggregate: agg };
          });
          const best = [...candidates].sort((a, b) => a.aggregate.avgPlace - b.aggregate.avgPlace)[0];
          const promoted = best && champAgg.avgPlace - best.aggregate.avgPlace > 0.6 ? best : null;
          const label = (s: Strategy) => `${s.name} v${s.version ?? 1}`;
          const summary = promoted
            ? `New contender: ${label(promoted.strategy)} beats ${label(champion)} by ${(champAgg.avgPlace - promoted.aggregate.avgPlace).toFixed(1)} places on the same seeds (${promoted.mutations.join('; ')}).`
            : `${label(champion)} holds. Best mutant was ${(best.aggregate.avgPlace - champAgg.avgPlace).toFixed(1)} places off.`;
          const archive: ArchiveCell[] = [champion, ...candidates.map((c) => c.strategy)].map((st, i) => {
            const family = WEAPONS[st.build.weapon].family;
            const range = (['close', 'mid', 'far'] as const)[(i + g) % 3]!;
            const aggression = (['cautious', 'balanced', 'aggressive'] as const)[(i * 2 + g) % 3]!;
            const agg = i === 0 ? champAgg : candidates[i - 1]!.aggregate;
            return {
              niche: { family, range, aggression },
              nicheKey: `${family}/${range}/${aggression}`,
              key: strategyKey(st),
              name: label(st),
              strategy: st,
              fitness: 1 - (agg.avgPlace - 1) / Math.max(1, req.fighters - 1),
              avgPlace: agg.avgPlace,
              matches: agg.matches,
              bornGeneration: i === 0 ? Math.max(0, g - 1) : g,
              parent: i === 0 ? null : label(champion),
              mutations: i === 0 ? [] : candidates[i - 1]!.mutations,
              champion: i === 0,
            };
          });
          // One elite per niche, like the real archive.
          const elites = archive.filter((c, i) => archive.findIndex((x) => x.nicheKey === c.nicheKey) === i);
          const report: EvolveGeneration & { archive: ArchiveCell[] } = { generation: g, champion: champAgg, candidates, promoted, summary, archive: elites };
          generations.push(report);
          if (promoted) {
            champion = promoted.strategy;
            nextVersion = (champion.version ?? 1) + 1;
          } else {
            nextVersion += req.population;
          }
          onGeneration?.(generations[generations.length - 1], g, req.generations);
          tracked.update(g);
          if (g < req.generations) return;
          window.clearInterval(timer);
          tracked.end();
          job = null;
          const improved = strategyKey(champion) !== strategyKey(req.parent);
          resolve({
            champion,
            improved,
            generations,
            summary: improved
              ? `${label(champion)} is the one to keep: ${generations.filter((x) => x.promoted).length} promotions in ${g} generations.`
              : `Nothing beat ${label(req.parent)} by enough to count. It stays as it is.`,
          });
        }, 450);
        job = {
          stop: () => {
            window.clearInterval(timer);
            tracked.end();
            job = null;
            reject(abortError());
          },
        };
      });
    },
    leaderboard: () => [...board.values()].sort((a, b) => b.rating.ordinal - a.rating.ordinal),
    cancel: () => job?.stop(),
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    enter() {
      if (entered) return;
      entered = true;
      beginRound();
      change();
    },
    skip() {
      const now = performance.now();
      if (countdownEnd > now) {
        countdownEnd = now;
        fightUntil = now + FIGHT_MS;
      } else if (finalUntil > now) finalUntil = 0;
      change();
    },
    startMatch(config) {
      script = buildScript(config);
      tick = 0;
      maxTick = 0;
      selectedId = null;
      hoveredId = null;
      hoveredObject = null;
      followId = null;
      beginRound();
      change();
    },
    restart() {
      if (!script) return;
      // A replay is a fresh run of the same match: nothing simulated yet.
      tick = 0;
      maxTick = 0;
      beginRound();
      change();
    },
    setPaused(p) {
      paused = p;
      change();
    },
    stepTicks(n) {
      if (!script) return;
      tick = Math.min(script.endTick, Math.floor(tick) + n);
      maxTick = Math.max(maxTick, Math.floor(tick));
      change();
    },
    setSpeed(s) {
      speed = s;
      change();
    },
    seek(t) {
      tick = clamp(Math.round(t), 0, maxTick);
      change();
    },
    select(id) {
      selectedId = id;
      change();
    },
    hover(id) {
      if (hoveredId === id) return;
      hoveredId = id;
      change();
    },
    follow(id) {
      followId = id;
      change();
    },
    resetCamera() {
      followId = null;
      change();
    },
    getView: () => view,
    setView(v) {
      view = { ...view, ...v };
      writeStored('poc.dev.view', view);
      change();
    },
    decision,
    knowledge,
    fighter: fighterState,
    objectInfo,
    setViewInsets(v) {
      insets = { ...v };
    },
    lastReport() {
      const s = script;
      if (!s || tick < s.endTick) return null;
      return {
        seed: s.config.seed,
        mapId: s.config.mapId,
        format: s.config.format,
        timeLimitTicks: s.config.timeLimitTicks,
        suddenDeath: s.config.suddenDeath,
        friendlyFire: s.config.friendlyFire,
        ticks: s.endTick,
        ending: 'elimination',
        suddenDeathStart: null,
        judges: null,
        roster: s.fighters.map((f) => ({
          fighterId: f.id,
          entrantId: f.entrantId,
          name: f.name,
          strategyName: f.strategy.name,
          strategyVersion: f.strategy.version ?? 1,
          strategyKey: strategyKey(f.strategy),
          weapon: f.strategy.build.weapon,
          skill: f.strategy.build.skill,
          squad: f.squad,
          color: f.color,
        })),
        placements: s.placements,
        kills: s.kills,
        fighters: s.fighters.map((f) => ({
          fighterId: f.id,
          place: f.place ?? 0,
          kills: s.kills.filter((k) => k.killerId === f.id).length,
          damageDealt: Math.round(f.maxHp * 0.8),
          damageTaken: f.maxHp - hpAt(f, s.endTick),
          diedAtTick: f.deathTick,
          behaviourTicks: Object.fromEntries(Object.keys(f.strategy.behaviours).map((b, i) => [b, 400 + i * 300])),
          neverWon: [],
          exposure: { ticksAlive: f.deathTick ?? s.endTick, ticksSeen: 900, ticksInShadow: 1200 },
          damageDealtBySource: { weapon: Math.round(f.maxHp * 0.7) },
          damageTakenBySource: { weapon: f.maxHp - hpAt(f, s.endTick) },
          attacks: 24,
          hitsLanded: 11,
          skillUses: 3,
          parries: 1,
          pickupsTaken: {},
          killsWhileBuffed: {},
          guardTrips: [],
          stats: fakeStats(new Rng(s.config.seed).fork(f.id), f.deathTick ?? s.endTick, 24, 11, s.kills.filter((k) => k.killerId === f.id).length, s.fighters.length - 1),
          death: deathRecord(s.kills.find((k) => k.victimId === f.id)),
          heatmap: pathHeatmap(f, s),
        })),
        findings: findingsFor(s),
      };
    },
    mountCanvas: (el) => mountPreview(el, () => ({ script, tick: Math.floor(tick), selectedId, hoveredId, followId, insets }), {
      hoverObject: (obj) => {
        if (obj?.kind !== hoveredObject?.kind || obj?.id !== hoveredObject?.id) {
          hoveredObject = obj;
          change();
        }
      },
      hover: (id) => {
        if (hoveredId !== id) {
          hoveredId = id;
          change();
        }
      },
      select: (id) => {
        selectedId = id;
        change();
      },
      follow: (id) => {
        followId = id;
        change();
      },
    }),
    strategies: {
      list: () => [...saved],
      save: (s, meta) => saveAt(s, Date.now(), meta),
      versions: (name) => saved.filter((x) => x.name === name).sort((a, b) => b.version - a.version),
      remove(id) {
        const i = saved.findIndex((x) => x.id === id);
        if (i >= 0) saved.splice(i, 1);
      },
    },
    gym,
  };
}

/** Only the keys ViewSettings has, with the right types (a stale or hand-edited value cannot break the HUD). */
function pickKnown(v: Record<string, unknown>): Partial<ViewSettings> {
  const out: Record<string, unknown> = {};
  for (const [k, d] of Object.entries(DEFAULT_VIEW_SETTINGS)) if (typeof v[k] === typeof d) out[k] = v[k];
  return out as Partial<ViewSettings>;
}

function findingsFor(s: Script): string[] {
  const winner = s.fighters.find((f) => f.id === s.placements[0])!;
  const wk = s.kills.filter((k) => k.killerId === winner.id).length;
  const lines = [`${winner.name} takes it with ${wk} ${wk === 1 ? 'kill' : 'kills'} and ${Math.round(hpAt(winner, s.endTick))} HP to spare.`];
  const firstOut = s.fighters.find((f) => f.id === s.placements[s.placements.length - 1]);
  if (firstOut) lines.push(`${firstOut.name} was first out, ${Math.round((firstOut.deathTick ?? 0) / TICK_HZ)} seconds in.`);
  const env = s.kills.filter((k) => k.killerId === null).length;
  if (env) lines.push(`The arena itself claimed ${env}.`);
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Stand-in arena (2D). Dev harness only: lets hover, click-to-select and follow be exercised.
// ---------------------------------------------------------------------------------------------

type PreviewState = {
  script: Script | null;
  tick: number;
  selectedId: string | null;
  hoveredId: string | null;
  followId: string | null;
  /** What the HUD covers; the stand-in frames the map in the rest, like the real camera. */
  insets: { left: number; right: number; top: number; bottom: number };
};
type PreviewActions = {
  hover: (id: string | null) => void;
  hoverObject: (obj: { kind: MapObjectKind; id: string } | null) => void;
  select: (id: string | null) => void;
  follow: (id: string | null) => void;
};

function mountPreview(el: HTMLElement, read: () => PreviewState, act: PreviewActions): () => void {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%';
  el.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  let view = { s: 1, ox: 0, oy: 0 };
  let raf = 0;

  const pick = (cx: number, cy: number): string | null => {
    const st = read();
    if (!st.script) return null;
    const r = canvas.getBoundingClientRect();
    const map = MAPS[st.script.config.mapId] ?? MAPS.pit;
    const wx = (cx - r.left - view.ox) / view.s;
    const wy = (cy - r.top - view.oy) / view.s;
    for (const f of st.script.fighters) {
      // A corpse is never picked: dead fighters show nothing under the pointer.
      if (!aliveAt(f, st.tick)) continue;
      const p = posAt(f, st.tick, map.width, map.height);
      if (Math.hypot(p.x - wx, p.y - wy) < fighterRadius(f.strategy.build.attributes) + 8) return f.id;
    }
    return null;
  };
  const pickObject = (cx: number, cy: number): { kind: MapObjectKind; id: string } | null => {
    const st = read();
    if (!st.script) return null;
    const r = canvas.getBoundingClientRect();
    const map = MAPS[st.script.config.mapId] ?? MAPS.pit;
    if (!map) return null;
    const wx = (cx - r.left - view.ox) / view.s;
    const wy = (cy - r.top - view.oy) / view.s;
    const near = (p: { x: number; y: number }, rad: number) => Math.hypot(p.x - wx, p.y - wy) < rad;
    for (const s of map.shrines) if (near(s.pos, 40)) return { kind: 'shrine', id: s.id };
    for (const p of map.pickups) if (near(p.pos, 34)) return { kind: 'pickup', id: p.id };
    for (const h of map.hazards) if (near(h.pos, h.radius + 6)) return { kind: 'hazard', id: h.id };
    for (const p of map.props) if (near(p.pos, p.radius + 6)) return { kind: 'prop', id: p.id };
    return null;
  };
  const onMove = (e: PointerEvent) => {
    const id = pick(e.clientX, e.clientY);
    act.hover(id);
    act.hoverObject(id ? null : pickObject(e.clientX, e.clientY));
  };
  const onLeave = () => {
    act.hover(null);
    act.hoverObject(null);
  };
  const onClick = (e: MouseEvent) => act.select(pick(e.clientX, e.clientY));
  const onDbl = (e: MouseEvent) => {
    const id = pick(e.clientX, e.clientY);
    if (id) act.follow(id);
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('dblclick', onDbl);

  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#100f0d';
    ctx.fillRect(0, 0, w, h);
    const st = read();
    const map = MAPS[st.script?.config.mapId ?? 'pit'] ?? MAPS.pit;
    if (!map) return;
    // Frame the map inside what the HUD leaves visible (the real camera does the same with insets).
    const vis = { x: st.insets.left, y: st.insets.top, w: Math.max(80, w - st.insets.left - st.insets.right), h: Math.max(80, h - st.insets.top - st.insets.bottom) };
    const s = Math.min((vis.w - 40) / map.width, (vis.h - 40) / map.height);
    view = { s, ox: vis.x + (vis.w - map.width * s) / 2, oy: vis.y + (vis.h - map.height * s) / 2 };
    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(s, s);
    ctx.fillStyle = '#2a2520';
    ctx.fillRect(0, 0, map.width, map.height);
    for (const l of map.lights) {
      const g = ctx.createRadialGradient(l.pos.x, l.pos.y, 0, l.pos.x, l.pos.y, l.radius);
      g.addColorStop(0, `rgba(255, 196, 120, ${0.22 * l.intensity})`);
      g.addColorStop(1, 'rgba(255, 196, 120, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(l.pos.x - l.radius, l.pos.y - l.radius, l.radius * 2, l.radius * 2);
    }
    ctx.fillStyle = '#4a433b';
    for (const r of [...map.walls, ...map.pillars]) ctx.fillRect(r.x, r.y, r.w, r.h);
    // Map objects, so their hover cards can be found.
    ctx.lineWidth = 4;
    for (const sh of map.shrines) {
      ctx.strokeStyle = 'rgba(111, 191, 115, 0.8)';
      ctx.beginPath();
      ctx.arc(sh.pos.x, sh.pos.y, 26, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const p of map.pickups) {
      ctx.strokeStyle = 'rgba(217, 164, 65, 0.8)';
      ctx.beginPath();
      ctx.arc(p.pos.x, p.pos.y, 20, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const hz of map.hazards) {
      ctx.fillStyle = hz.kind === 'acid' ? 'rgba(120, 200, 80, 0.25)' : 'rgba(196, 48, 43, 0.25)';
      ctx.beginPath();
      ctx.arc(hz.pos.x, hz.pos.y, hz.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#6b4a2e';
    for (const pr of map.props) ctx.fillRect(pr.pos.x - pr.radius, pr.pos.y - pr.radius, pr.radius * 2, pr.radius * 2);
    const sc = st.script;
    if (sc) {
      for (const f of sc.fighters) {
        const p = posAt(f, st.tick, map.width, map.height);
        const rad = fighterRadius(f.strategy.build.attributes);
        const alive = aliveAt(f, st.tick);
        if (!alive) {
          ctx.fillStyle = 'rgba(122, 29, 26, 0.55)';
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, rad * 1.8, rad * 1.3, 0.4, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        if (f.id === st.selectedId || f.id === st.hoveredId) {
          ctx.strokeStyle = f.id === st.selectedId ? '#e8e2d9' : 'rgba(232, 226, 217, 0.5)';
          ctx.lineWidth = 2 / s;
          ctx.beginPath();
          ctx.arc(p.x, p.y, rad + 7, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = '#0e0d0c';
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad + 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = f.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.fill();
        const q = posAt(f, st.tick + 1, map.width, map.height);
        const a = Math.atan2(q.y - p.y, q.x - p.x);
        ctx.strokeStyle = '#0e0d0c';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + Math.cos(a) * rad * 1.6, p.y + Math.sin(a) * rad * 1.6);
        ctx.stroke();
        ctx.fillStyle = 'rgba(232, 226, 217, 0.8)';
        ctx.font = `${12 / s}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(f.name, p.x, p.y - rad - 10);
      }
    }
    ctx.restore();
    ctx.fillStyle = 'rgba(163, 154, 142, 0.5)';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('UI dev harness: stand-in arena, not the WebGPU renderer', 14, h - 64);
  };
  const loop = () => {
    draw();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(raf);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerleave', onLeave);
    canvas.removeEventListener('click', onClick);
    canvas.removeEventListener('dblclick', onDbl);
    canvas.remove();
  };
}
