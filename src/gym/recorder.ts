/**
 * MatchRecorder: watches a match tick by tick (events + live state) and turns it into a
 * `MatchReport`. It never touches the simulation; it only reads what the sim publishes.
 *
 * Per tick it counts, for every living fighter, the running behaviour, whether an enemy sees it
 * (`FighterState.seen`) and whether it stands in shadow. From events it collects kills (with both
 * behaviours), damage by source, attacks started, attacks that landed, skill uses, parries,
 * power-ups taken and the kills landed while one ran, when and why sudden death started, and the
 * judges' scorecards. Guard trips come from the sim's result (each brain's last `Decision`).
 *
 * Per-fighter stats (`FighterStats`, thresholds in `REPORT_STATS`):
 * - Distance is the sum of per-tick movement; a Shadowstep's jump is not walking and counts as none.
 * - Engaged: a fighter that starts an attack, or deals damage to or takes damage from an enemy, is
 *   engaged on that tick and the `engagedWindowTicks - 1` ticks after it. Damage per engaged second
 *   counts only enemy damage (hazards, the wall and own goals engage nobody).
 * - Standing still (moved under `stillPxPerTick`) while not attacking, stunned or teleporting is
 *   stuck when its decision's throttle asked to move (`stuckThrottle`), otherwise idle. Without
 *   decisions (see `observe`) every still tick is idle.
 * - Near walls: centre within `nearWallPx` of a map wall or pillar. Outside the zone: during sudden
 *   death, centre outside `SuddenDeathState.warning`.
 * - A skill hit is a skill use that damaged at least one enemy (Whirlwind and Shockwave resolve on
 *   the tick they are used). An assist is damage to an enemy within `assistWindowTicks` before its
 *   death by someone other than the killer; kill participation is (kills + assists) over every
 *   enemy death in the match.
 *
 * Attack accounting:
 * - `swing` starts an attack (the sim emits it for melee swings and ranged shots alike).
 * - A melee swing (or a punch) has landed once it damages at least one enemy; a cleave that hits
 *   three people is still one landed attack.
 * - A ranged shot has landed when its projectile ends on a tick where its owner dealt weapon damage
 *   (direct hit or splash). Matching by projectile keeps overlapping arrows apart.
 */

import { PICKUP_RULES, REPORT_STATS, TICK_HZ, WEAPONS, addToHeatmap, createHeatmap, pointInRect, strategyKey } from '../core';
import type {
  DamageSource,
  Decision,
  DeathRecord,
  FighterReport,
  FighterState,
  FighterStats,
  GameEvent,
  Heatmap,
  JudgedFighter,
  KillRecord,
  MatchConfig,
  MatchReport,
  MatchResult,
  PickupKind,
  Rect,
  ReportRosterEntry,
  Strategy,
  SuddenDeathReason,
  Vec2,
  WorldState,
} from '../core';
import { MAPS } from '../sim';
import { POWER_UPS, matchFindings, type FindingContext } from './findings';
import { round } from './format';

type Tally = {
  squad: number;
  melee: boolean;
  /** Behaviours the strategy defines (own + imported), for `neverWon`. */
  defined: string[];
  behaviourTicks: Record<string, number>;
  ticksAlive: number;
  ticksSeen: number;
  ticksInShadow: number;
  dealt: Partial<Record<DamageSource, number>>;
  taken: Partial<Record<DamageSource, number>>;
  attacks: number;
  hitsLanded: number;
  skillUses: number;
  parries: number;
  /** The current melee swing has not damaged an enemy yet. */
  swingOpen: boolean;
  pickupsTaken: Partial<Record<PickupKind, number>>;
  /** First tick a pedestal power-up of each kind no longer runs (the sim counts buffs down at the start of each tick). */
  buffUntil: Partial<Record<PickupKind, number>>;
  killsWhileBuffed: Partial<Record<PickupKind, number>>;
  heatmap: Heatmap;
  death: DeathRecord | null;
  /** Where it stood after the previous observed tick. */
  last: Vec2;
  distance: number;
  /** Last tick something engaged it (attack started, enemy damage dealt or taken); -Infinity before. */
  engagedAt: number;
  ticksEngaged: number;
  firstContact: number | null;
  dealtToEnemies: number;
  takenFromEnemies: number;
  skillHits: number;
  ticksIdle: number;
  ticksStuck: number;
  ticksNearWalls: number;
  ticksOutsideZone: number;
  /** Last tick each enemy damaged it, by fighter id (assists). */
  damagedAt: Map<string, number>;
  assists: number;
};

/** Is the point within `REPORT_STATS.nearWallPx` of one of these rects? */
function nearAny(rects: readonly Rect[], x: number, y: number): boolean {
  const reach = REPORT_STATS.nearWallPx;
  for (const r of rects) {
    const dx = x < r.x ? r.x - x : x > r.x + r.w ? x - r.x - r.w : 0;
    const dy = y < r.y ? r.y - y : y > r.y + r.h ? y - r.y - r.h : 0;
    if (dx * dx + dy * dy <= reach * reach) return true;
  }
  return false;
}

function definedBehaviours(s: Strategy): string[] {
  return [...new Set([...Object.keys(s.behaviours), ...(s.imports ?? [])])];
}

function add(table: Partial<Record<DamageSource, number>>, source: DamageSource, amount: number): void {
  table[source] = (table[source] ?? 0) + amount;
}

function rounded(table: Partial<Record<DamageSource, number>>): Partial<Record<DamageSource, number>> {
  const out: Partial<Record<DamageSource, number>> = {};
  for (const [k, v] of Object.entries(table) as [DamageSource, number][]) out[k] = round(v, 1);
  return out;
}

/**
 * Placements when a match had to be stopped early: survivors by remaining HP (most first), then
 * the dead, latest death first. Mirrors the sim's "reverse order of death" rule.
 */
export function placementsByStanding(fighters: readonly FighterState[]): string[] {
  const alive = fighters.filter((f) => f.alive).sort((a, b) => b.hp / b.maxHp - a.hp / a.maxHp || (a.id < b.id ? -1 : 1));
  const dead = fighters.filter((f) => !f.alive).sort((a, b) => (b.diedAtTick ?? 0) - (a.diedAtTick ?? 0) || (a.id < b.id ? -1 : 1));
  return [...alive, ...dead].map((f) => f.id);
}

export class MatchRecorder {
  private readonly config: MatchConfig;
  private readonly ctx: FindingContext;
  private readonly roster: ReportRosterEntry[] = [];
  private readonly tallies = new Map<string, Tally>();
  private readonly kills: KillRecord[] = [];
  private readonly projectileOwner = new Map<string, string>();
  /** The map's walls and pillars, for `ticksNearWalls`. */
  private readonly blockers: readonly Rect[];
  private suddenDeathStart: { tick: number; reason: SuddenDeathReason } | null = null;
  private judges: JudgedFighter[] | null = null;

  constructor(config: MatchConfig, state: WorldState, ctx: FindingContext = {}) {
    this.config = config;
    // Before sudden death the playable rectangle is the whole map: the heatmaps' extent.
    const map = state.suddenDeath.active ? null : state.suddenDeath.bounds;
    if (!map) throw new Error('MatchRecorder: start recording before sudden death begins (the heatmap needs the whole map).');
    const def = MAPS[config.mapId];
    if (!def) throw new Error(`MatchRecorder: unknown map "${config.mapId}".`);
    this.blockers = [...def.walls, ...def.pillars];
    // The pedestals of this match's map, unless the caller knows better: lets findings say nobody went for them.
    const pedestals = [...new Set(state.pickups.map((p) => p.kind))];
    this.ctx = { mapPickups: () => pedestals, ...ctx };
    for (const f of state.fighters) {
      const entrant = config.entrants.find((e) => e.id === f.entrantId);
      if (!entrant) throw new Error(`MatchRecorder: fighter ${f.id} has no entrant ${f.entrantId} in the config.`);
      const s = entrant.strategy;
      this.roster.push({
        fighterId: f.id,
        entrantId: f.entrantId,
        name: f.name,
        strategyName: s.name,
        strategyVersion: s.version ?? 1,
        strategyKey: strategyKey(s),
        weapon: f.weapon,
        skill: f.skill,
        squad: f.squad,
        color: f.color,
      });
      this.tallies.set(f.id, {
        squad: f.squad,
        melee: WEAPONS[f.weapon].family === 'melee',
        defined: definedBehaviours(s),
        behaviourTicks: {},
        ticksAlive: 0,
        ticksSeen: 0,
        ticksInShadow: 0,
        dealt: {},
        taken: {},
        attacks: 0,
        hitsLanded: 0,
        skillUses: 0,
        parries: 0,
        swingOpen: false,
        pickupsTaken: {},
        buffUntil: {},
        killsWhileBuffed: {},
        heatmap: createHeatmap(map.x + map.w, map.y + map.h),
        death: null,
        last: { x: f.pos.x, y: f.pos.y },
        distance: 0,
        engagedAt: -Infinity,
        ticksEngaged: 0,
        firstContact: null,
        dealtToEnemies: 0,
        takenFromEnemies: 0,
        skillHits: 0,
        ticksIdle: 0,
        ticksStuck: 0,
        ticksNearWalls: 0,
        ticksOutsideZone: 0,
        damagedAt: new Map(),
        assists: 0,
      });
    }
  }

  /**
   * Call once per `match.step()` with the events it returned and the state after the step.
   * `decisionOf` is the match's `lastDecision`: it tells a fighter stuck against something (its
   * decision asks to move) from one standing still on purpose. Without it every still tick is idle.
   */
  observe(events: readonly GameEvent[], state: WorldState, decisionOf?: (fighterId: string) => Decision | null): void {
    const shotEnds = new Map<string, { ends: number; direct: number }>();
    const rangedHitters = new Set<string>();
    const skillHitters = new Set<string>();
    const teleported = new Set<string>();
    const tick = state.tick;

    for (const ev of events) {
      switch (ev.type) {
        case 'swing': {
          const t = this.tallies.get(ev.fighterId);
          if (t) {
            t.attacks++;
            t.swingOpen = true;
            this.engage(t, ev.tick);
          }
          break;
        }
        case 'hit': {
          const victim = this.tallies.get(ev.victimId);
          if (victim) add(victim.taken, ev.source, ev.amount);
          const attacker = ev.attackerId ? this.tallies.get(ev.attackerId) : undefined;
          if (!attacker || ev.attackerId === ev.victimId) break;
          add(attacker.dealt, ev.source, ev.amount);
          const enemy = !victim || victim.squad !== attacker.squad;
          if (enemy && ev.source === 'skill') skillHitters.add(ev.attackerId!);
          if (!enemy || ev.amount <= 0) break;
          attacker.dealtToEnemies += ev.amount;
          this.engage(attacker, ev.tick);
          if (victim) {
            victim.takenFromEnemies += ev.amount;
            victim.damagedAt.set(ev.attackerId!, ev.tick);
            this.engage(victim, ev.tick);
          }
          if (ev.source === 'punch' || (ev.source === 'weapon' && attacker.melee)) {
            if (attacker.swingOpen) {
              attacker.hitsLanded++;
              attacker.swingOpen = false;
            }
          } else if (ev.source === 'weapon') {
            rangedHitters.add(ev.attackerId!);
          }
          break;
        }
        case 'projectile':
          this.projectileOwner.set(ev.projectileId, ev.ownerId);
          break;
        case 'projectile_end': {
          const owner = this.projectileOwner.get(ev.projectileId);
          this.projectileOwner.delete(ev.projectileId);
          if (!owner) break;
          const e = shotEnds.get(owner) ?? { ends: 0, direct: 0 };
          e.ends++;
          const hit = ev.hitId ? this.tallies.get(ev.hitId) : undefined;
          if (hit && hit.squad !== this.tallies.get(owner)?.squad) e.direct++;
          shotEnds.set(owner, e);
          break;
        }
        case 'skill': {
          const t = this.tallies.get(ev.fighterId);
          if (t) t.skillUses++;
          if (ev.skill === 'SHADOWSTEP') teleported.add(ev.fighterId);
          break;
        }
        case 'parry': {
          const t = this.tallies.get(ev.fighterId);
          if (t) t.parries++;
          break;
        }
        case 'pickup': {
          const t = this.tallies.get(ev.fighterId);
          if (!t || (ev.kind !== 'haste' && ev.kind !== 'berserk')) break;
          t.pickupsTaken[ev.kind] = (t.pickupsTaken[ev.kind] ?? 0) + 1;
          t.buffUntil[ev.kind] = ev.tick + PICKUP_RULES[ev.kind].durationTicks;
          break;
        }
        case 'sudden_death':
          this.suddenDeathStart = { tick: ev.tick, reason: ev.reason };
          break;
        case 'judges_decision':
          this.judges = ev.survivors.map((j) => ({ ...j }));
          break;
        case 'kill': {
          const killer = ev.killerId && ev.killerId !== ev.victimId ? this.tallies.get(ev.killerId) : undefined;
          if (killer) {
            for (const kind of POWER_UPS) {
              if (ev.tick < (killer.buffUntil[kind] ?? -1)) killer.killsWhileBuffed[kind] = (killer.killsWhileBuffed[kind] ?? 0) + 1;
            }
          }
          const victim = this.tallies.get(ev.victimId);
          if (victim) {
            for (const [id, at] of victim.damagedAt) {
              const helper = this.tallies.get(id);
              if (id !== ev.killerId && helper && helper.squad !== victim.squad && ev.tick - at <= REPORT_STATS.assistWindowTicks) helper.assists++;
            }
            victim.death = {
              tick: ev.tick,
              cause: ev.cause,
              killerId: ev.killerId,
              weapon: ev.weapon,
              hazard: ev.hazard,
              flags: [...ev.flags],
              title: ev.title,
            };
          }
          this.kills.push({
            tick: ev.tick,
            killerId: ev.killerId,
            victimId: ev.victimId,
            weapon: ev.weapon,
            cause: ev.cause,
            pos: { x: round(ev.pos.x, 0), y: round(ev.pos.y, 0) },
            flags: [...ev.flags],
            killerBehaviour: ev.killerBehaviour,
            victimBehaviour: ev.victimBehaviour,
          });
          break;
        }
        default:
          break;
      }
    }

    for (const [owner, e] of shotEnds) {
      const t = this.tallies.get(owner);
      if (!t || !rangedHitters.has(owner)) continue;
      t.hitsLanded += Math.min(e.ends, Math.max(1, e.direct));
    }

    for (const id of skillHitters) {
      const t = this.tallies.get(id);
      if (t) t.skillHits++;
    }

    const zone = state.suddenDeath;
    for (const f of state.fighters) {
      if (!f.alive) continue;
      const t = this.tallies.get(f.id);
      if (!t) continue;
      t.ticksAlive++;
      addToHeatmap(t.heatmap, f.pos.x, f.pos.y);
      if (f.seen) t.ticksSeen++;
      if (f.inShadow) t.ticksInShadow++;
      // Before its first think a fighter has no behaviour yet (empty name); that time is not a choice.
      if (f.behaviour) t.behaviourTicks[f.behaviour] = (t.behaviourTicks[f.behaviour] ?? 0) + 1;

      if (tick - t.engagedAt < REPORT_STATS.engagedWindowTicks) t.ticksEngaged++;
      const moved = Math.hypot(f.pos.x - t.last.x, f.pos.y - t.last.y);
      t.last.x = f.pos.x;
      t.last.y = f.pos.y;
      if (!teleported.has(f.id)) {
        t.distance += moved;
        if (moved < REPORT_STATS.stillPxPerTick && f.anim.phase === 'idle' && f.stunTicks <= 0) {
          const d = decisionOf?.(f.id);
          if (d && d.speed >= REPORT_STATS.stuckThrottle) t.ticksStuck++;
          else t.ticksIdle++;
        }
      }
      if (nearAny(this.blockers, f.pos.x, f.pos.y)) t.ticksNearWalls++;
      if (zone.active && !pointInRect(f.pos, zone.warning)) t.ticksOutsideZone++;
    }
  }

  /** Mark a fighter engaged from this tick on (first contact included). */
  private engage(t: Tally, tick: number): void {
    t.engagedAt = tick;
    if (t.firstContact === null) t.firstContact = tick;
  }

  /** The finished `FighterStats` of one fighter. */
  private stats(fighterId: string, t: Tally): FighterStats {
    const enemyDeaths = this.kills.filter((k) => this.tallies.get(k.victimId)?.squad !== t.squad);
    const kills = enemyDeaths.filter((k) => k.killerId === fighterId).length;
    const engagedSeconds = t.ticksEngaged / TICK_HZ;
    return {
      distanceTravelled: Math.round(t.distance),
      accuracy: t.attacks > 0 ? round(t.hitsLanded / t.attacks, 3) : 0,
      skillHits: t.skillHits,
      ticksEngaged: t.ticksEngaged,
      damageDealtPerSecondEngaged: engagedSeconds > 0 ? round(t.dealtToEnemies / engagedSeconds, 1) : 0,
      damageTakenPerSecondEngaged: engagedSeconds > 0 ? round(t.takenFromEnemies / engagedSeconds, 1) : 0,
      ticksToFirstContact: t.firstContact,
      ticksIdle: t.ticksIdle,
      ticksStuck: t.ticksStuck,
      ticksNearWalls: t.ticksNearWalls,
      ticksOutsideZone: t.ticksOutsideZone,
      assists: t.assists,
      killParticipation: enemyDeaths.length > 0 ? round((kills + t.assists) / enemyDeaths.length, 3) : 0,
    };
  }

  /**
   * Build the report from the sim's result. Totals (kills, damage, death tick, place) come from the
   * sim so the report agrees with the scoreboard; breakdowns come from the recorded events.
   */
  finish(result: MatchResult, opts: { capped?: boolean } = {}): MatchReport {
    const placements = [...result.placements];
    const byId = new Map(result.fighters.map((f) => [f.id, f]));
    const fighters: FighterReport[] = this.roster.map((r) => {
      const t = this.tallies.get(r.fighterId)!;
      const res = byId.get(r.fighterId);
      const place = res?.place || placements.indexOf(r.fighterId) + 1 || this.roster.length;
      return {
        fighterId: r.fighterId,
        place,
        kills: res?.kills ?? this.kills.filter((k) => k.killerId === r.fighterId).length,
        damageDealt: round(res?.damageDealt ?? 0, 1),
        damageTaken: round(res?.damageTaken ?? 0, 1),
        diedAtTick: res?.diedAtTick ?? this.kills.find((k) => k.victimId === r.fighterId)?.tick ?? null,
        behaviourTicks: { ...t.behaviourTicks },
        neverWon: t.defined.filter((b) => !t.behaviourTicks[b]),
        exposure: { ticksAlive: t.ticksAlive, ticksSeen: t.ticksSeen, ticksInShadow: t.ticksInShadow },
        damageDealtBySource: rounded(t.dealt),
        damageTakenBySource: rounded(t.taken),
        attacks: t.attacks,
        hitsLanded: t.hitsLanded,
        skillUses: t.skillUses,
        parries: t.parries,
        pickupsTaken: { ...t.pickupsTaken },
        killsWhileBuffed: { ...t.killsWhileBuffed },
        guardTrips: (res?.guardTrips ?? []).map((g) => ({ ...g })).sort((a, b) => b.count - a.count),
        stats: this.stats(r.fighterId, t),
        death: t.death ? { ...t.death, flags: [...t.death.flags] } : null,
        heatmap: { ...t.heatmap, counts: [...t.heatmap.counts] },
      };
    });

    const report: MatchReport = {
      seed: this.config.seed,
      mapId: result.mapId,
      format: this.config.format,
      timeLimitTicks: this.config.timeLimitTicks,
      suddenDeath: this.config.suddenDeath,
      friendlyFire: this.config.friendlyFire,
      ticks: result.ticks,
      ending: opts.capped ? 'capped' : result.ending,
      suddenDeathStart: this.suddenDeathStart ? { ...this.suddenDeathStart } : null,
      judges: this.judges ? this.judges.map((j) => ({ ...j })) : null,
      roster: this.roster.map((r) => ({ ...r })),
      placements,
      kills: [...this.kills],
      fighters,
      findings: [],
    };
    report.findings = matchFindings(report, { ...this.ctx, capped: opts.capped, judges: this.judges ?? undefined });
    return report;
  }
}
