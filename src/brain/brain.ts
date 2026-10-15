/**
 * The strategy runtime. One think (every THINK_EVERY_TICKS ticks):
 *   1. refresh the context (who is known, reach, one random number);
 *   2. choose the target: the target expression rates every known enemy with `it.*`, highest wins;
 *   3. score every behaviour; the running one gets COMMIT_BONUS until `commit` ticks have passed
 *      since it started; highest wins (earlier behaviour on a tie);
 *   4. steer: the winner's move terms rate 16 directions, combined in Steering;
 *   5. attack and skill policies, parry permission and the parry reflex;
 *   6. memory writes (`set`), all computed from the memory as it was at the start of the think.
 * Barks are left to the sim (it owns their triggers, chances and the global chatter limit), so
 * `Decision.bark` stays unset. Deterministic: the only randomness is the rng the sim passes in.
 *
 * Runtime guards (second line of defence; the validator proves a valid strategy never needs them):
 * expressions turn division by zero and non-finite results into 0, scores are cut to
 * ±GUARDS.scoreLimit, and a think stops spending once it has used GUARDS.costBudget units. Every
 * trip is counted and reported in `Decision.guardTrips`.
 */

import { COMMIT_BONUS, SKILLS, WEAPONS, angleDiff, angleTo, v2Dist } from '../core';
import type { Brain, Decision, KnownFighter, PerceptionView, Rng, ValidStrategy } from '../core';
import { compileStrategy, readSensor } from './compile';
import type { CompiledBehaviour, CompiledStrategy } from './compile';
import { prepareContext } from './ctx';
import type { ThinkCtx } from './ctx';
import { SENSORS, inReach, sensorRange } from './registry';
import { Steering } from './steering';
import { GUARDS, STEERING } from './tuning';

const DEG = Math.PI / 180;

export type BrainOptions = {
  /**
   * Fill the inspector's data in every Decision: the sensor table and each term's ratings
   * (default true). Headless runs (the gym) turn it off; choices and guard trips are the same.
   */
  inspect?: boolean;
};

/**
 * Build a brain for one fighter. Takes only a ValidStrategy (from `loadStrategy`), so unvalidated
 * JSON cannot compile; the sim gets brains through `gatedBrainFactory` in src/strategy.
 */
export function createBrain(strategy: ValidStrategy, opts: BrainOptions = {}): Brain {
  return new StrategyBrain(strategy, compileStrategy(strategy), opts.inspect ?? true);
}

const NO_TERMS: readonly CompiledBehaviour['terms'][number][] = [];

class StrategyBrain implements Brain {
  readonly memory: Record<string, number>;
  private readonly s: CompiledStrategy;
  private readonly inspect: boolean;
  private readonly steering = new Steering();
  private ctx: ThinkCtx | null = null;
  private current = -1;
  private startedAt = 0;
  private prevTargetId: string | null = null;
  private readonly setValues: number[] = [];
  /** Each sensor's range for this build, for the inspector's sensor table. */
  private readonly lo: Float64Array;
  private readonly hi: Float64Array;

  constructor(strategy: ValidStrategy, s: CompiledStrategy, inspect: boolean) {
    this.s = s;
    this.inspect = inspect;
    this.memory = { ...s.memory };
    this.lo = new Float64Array(SENSORS.length);
    this.hi = new Float64Array(SENSORS.length);
    for (let i = 0; i < SENSORS.length; i++) {
      const r = sensorRange(i, strategy.build);
      this.lo[i] = r.lo;
      this.hi[i] = r.hi;
    }
  }

  private context(view: PerceptionView): ThinkCtx {
    this.ctx = prepareContext(this.ctx, view, this.memory, this.prevTargetId);
    return this.ctx;
  }

  /** Spend `units` of this think's budget; false (and one counted trip per think) once it would run out. */
  private spend(c: ThinkCtx, units: number): boolean {
    if (c.cost < 0) return false;
    if (c.cost + units > GUARDS.costBudget) {
      this.s.costTrip.n++;
      // Spent: nothing else runs this think.
      c.cost = -1;
      return false;
    }
    c.cost += units;
    return true;
  }

  private chooseTarget(c: ThinkCtx): KnownFighter | null {
    let best: KnownFighter | null = null;
    let bestScore = -Infinity;
    for (const f of c.view.known) {
      if (!this.spend(c, this.s.targetCost)) break;
      c.it = f;
      const v = this.s.target(c);
      if (v > bestScore) {
        bestScore = v;
        best = f;
      }
    }
    c.it = null;
    return best;
  }

  private chooseBehaviour(c: ThinkCtx, scores: Record<string, number>): number {
    const bs = this.s.behaviours;
    const committed = this.current >= 0 && c.tick - this.startedAt < this.s.commit;
    const limit = GUARDS.scoreLimit;
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i]!;
      let v = -limit;
      if (this.spend(c, b.scoreCost)) {
        v = b.score(c);
        if (v > limit || v < -limit) {
          v = v > limit ? limit : -limit;
          b.scoreClamp.n++;
        }
      }
      v += committed && i === this.current ? COMMIT_BONUS : 0;
      scores[b.name] = v;
      if (v > bestScore) {
        bestScore = v;
        best = i;
      }
    }
    if (best !== this.current) {
      this.current = best;
      this.startedAt = c.tick;
    }
    return best;
  }

  /** if_blocked: the nearest seen enemy in front of the heading and within reach. */
  private blocker(c: ThinkCtx, heading: number): KnownFighter | null {
    const reach = c.shooting ? Math.min(c.reach, STEERING.blockedReachRanged) : c.reach;
    const half = STEERING.blockedHalfArcDeg * DEG;
    let best: KnownFighter | null = null;
    let bestD = Infinity;
    for (const f of c.view.known) {
      if (!f.seen) continue;
      const d = v2Dist(c.self.pos, f.pos);
      if (d > reach || d >= bestD) continue;
      if (Math.abs(angleDiff(heading, angleTo(c.self.pos, f.pos))) > half) continue;
      if (c.shooting && c.world.losBlocked(c.self.pos, f.pos)) continue;
      best = f;
      bestD = d;
    }
    return best;
  }

  /** Parry reflex: the nearest melee enemy winding up with you inside its reach and swing. */
  private parryThreat(c: ThinkCtx): KnownFighter | null {
    const self = c.self;
    if (self.parryCd > 0 || self.stunTicks > 0) return null;
    let best: KnownFighter | null = null;
    let bestD = Infinity;
    for (const f of c.view.known) {
      if (!f.windingUp || f.family !== 'melee') continue;
      const w = WEAPONS[f.weapon];
      const d = v2Dist(f.pos, self.pos);
      if (d > w.range + self.radius + STEERING.parryMargin || d >= bestD) continue;
      if (Math.abs(angleDiff(f.facing, angleTo(f.pos, self.pos))) > w.arc / 2) continue;
      best = f;
      bestD = d;
    }
    return best;
  }

  private attackDecision(c: ThinkCtx, b: CompiledBehaviour, heading: number): { attack: boolean; at: KnownFighter | null } {
    const a = b.attack;
    switch (a.kind) {
      case 'never':
        return { attack: false, at: null };
      case 'in_range':
        return { attack: c.target !== null && inReach(c, c.target), at: c.target };
      case 'if_blocked': {
        const f = this.blocker(c, heading);
        return { attack: f !== null, at: f };
      }
      case 'expr':
        return { attack: a.fn(c) > 0, at: c.target };
    }
  }

  private skillDecision(c: ThinkCtx, b: CompiledBehaviour): boolean {
    if (!b.skill) return false;
    const self = c.self;
    if (self.skillCd > 0 || self.stunTicks > 0) return false;
    const rule = SKILLS[self.skill];
    if (rule.needsTarget && (!c.target || v2Dist(self.pos, c.target.pos) > rule.maxRange)) return false;
    return b.skill(c) > 0;
  }

  think(view: PerceptionView, rng: Rng): Decision {
    const c = this.context(view);
    c.random = rng.next();

    c.target = this.chooseTarget(c);

    const scores: Record<string, number> = {};
    const idx = this.chooseBehaviour(c, scores);
    const b = this.s.behaviours[idx]!;

    // A behaviour that would overrun the budget does nothing this think (the rest is cut short).
    const acts = this.spend(c, b.actionCost);
    const terms = acts ? b.terms : NO_TERMS;
    const { heading, speed } = this.steering.run(c, terms, b.weightSum);

    const atk = acts ? this.attackDecision(c, b, heading) : { attack: false, at: null };
    const useSkill = acts && this.skillDecision(c, b);
    const threat = this.parryThreat(c);

    // Memory writes see the memory as it was when the think began. Slots saturate at ±memoryLimit.
    if (acts) {
      const vals = this.setValues;
      const m = GUARDS.memoryLimit;
      for (let i = 0; i < b.set.length; i++) vals[i] = b.set[i]!.fn(c);
      for (let i = 0; i < b.set.length; i++) this.memory[b.set[i]!.slot] = Math.min(m, Math.max(-m, vals[i]!));
    }

    // Who the sim should face and aim at this think.
    const aim = atk.attack && atk.at ? atk.at : threat ?? c.target;

    const sensors: Record<string, number> = {};
    if (this.inspect) {
      for (let i = 0; i < SENSORS.length; i++) {
        if (SENSORS[i]!.scope === 'it') continue;
        sensors[SENSORS[i]!.name] = readSensor(c, i, this.lo[i]!, this.hi[i]!);
      }
      for (const k in this.memory) sensors[k] = this.memory[k]!;
    }

    this.prevTargetId = c.target?.id ?? null;

    return {
      behaviour: b.name,
      scores,
      targetId: aim?.id ?? null,
      heading,
      speed,
      ring: Array.from(this.steering.ring),
      terms: this.inspect
        ? [
            ...terms.map((t) => ({ label: `${t.label} x${t.weight}`, ratings: Array.from(t.buf, (v) => v * t.weight) })),
            { label: 'walls and hazards', ratings: Array.from(this.steering.penalty, (v) => -v) },
          ]
        : [],
      attack: atk.attack,
      parry: view.self.parryCd <= 0 && view.self.stunTicks <= 0,
      useSkill,
      stance: b.stance,
      sensors,
      guardTrips: this.s.guards.trips(),
    };
  }
}
