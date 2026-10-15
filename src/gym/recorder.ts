/**
 * MatchRecorder: watches a match tick by tick (events + live state) and turns it into a
 * `MatchReport`. It never touches the simulation; it only reads what the sim publishes.
 *
 * Per tick it counts, for every living fighter, the running behaviour, whether an enemy sees it
 * (`FighterState.seen`) and whether it stands in shadow. From events it collects kills (with both
 * behaviours), damage by source, attacks started, attacks that landed, skill uses and parries.
 *
 * Attack accounting:
 * - `swing` starts an attack (the sim emits it for melee swings and ranged shots alike).
 * - A melee swing (or a punch) has landed once it damages at least one enemy; a cleave that hits
 *   three people is still one landed attack.
 * - A ranged shot has landed when its projectile ends on a tick where its owner dealt weapon damage
 *   (direct hit or splash). Matching by projectile keeps overlapping arrows apart.
 */

import { WEAPONS, strategyKey } from '../core';
import type {
  DamageSource,
  FighterReport,
  FighterState,
  GameEvent,
  KillRecord,
  MatchConfig,
  MatchReport,
  MatchResult,
  ReportRosterEntry,
  Strategy,
  WorldState,
} from '../core';
import { matchFindings, type FindingContext } from './findings';
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
};

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

  constructor(config: MatchConfig, state: WorldState, ctx: FindingContext = {}) {
    this.config = config;
    this.ctx = ctx;
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
      });
    }
  }

  /** Call once per `match.step()` with the events it returned and the state after the step. */
  observe(events: readonly GameEvent[], state: WorldState): void {
    const shotEnds = new Map<string, { ends: number; direct: number }>();
    const rangedHitters = new Set<string>();

    for (const ev of events) {
      switch (ev.type) {
        case 'swing': {
          const t = this.tallies.get(ev.fighterId);
          if (t) {
            t.attacks++;
            t.swingOpen = true;
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
          if (!enemy || ev.amount <= 0) break;
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
          break;
        }
        case 'parry': {
          const t = this.tallies.get(ev.fighterId);
          if (t) t.parries++;
          break;
        }
        case 'kill':
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
        default:
          break;
      }
    }

    for (const [owner, e] of shotEnds) {
      const t = this.tallies.get(owner);
      if (!t || !rangedHitters.has(owner)) continue;
      t.hitsLanded += Math.min(e.ends, Math.max(1, e.direct));
    }

    for (const f of state.fighters) {
      if (!f.alive) continue;
      const t = this.tallies.get(f.id);
      if (!t) continue;
      t.ticksAlive++;
      if (f.seen) t.ticksSeen++;
      if (f.inShadow) t.ticksInShadow++;
      t.behaviourTicks[f.behaviour] = (t.behaviourTicks[f.behaviour] ?? 0) + 1;
    }
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
      };
    });

    const report: MatchReport = {
      seed: this.config.seed,
      mapId: result.mapId,
      format: this.config.format,
      ticks: result.ticks,
      roster: this.roster.map((r) => ({ ...r })),
      placements,
      kills: [...this.kills],
      fighters,
      findings: [],
    };
    report.findings = matchFindings(report, { ...this.ctx, capped: opts.capped });
    return report;
  }
}
