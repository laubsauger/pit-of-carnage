// Owned by: integrator
/**
 * One watched match: the sim, its battle-report recorder, and the broadcast feed and timeline marks
 * built from its events. Seeking rebuilds the match from its config and steps it headless (the sim
 * is deterministic, so tick N is always the same tick N).
 */

import { PICKUP_RULES, strategyKey } from '../core';
import type { BrainFactory, FeedItem, GameEvent, Limb, Match, MatchConfig, MatchReport, TimelineMark, WorldState } from '../core';
import { MatchRecorder } from '../gym';
import { MAPS, announcements, createMatch, killLine } from '../sim';
import { HOUSE_STACKS, loadStrategy } from '../strategy';

/**
 * A hit at least this big gets a timeline mark. Measured with the house stacks: about 10 per
 * 8-fighter match (of about 95 hits), next to about 7 kills and 8 lost limbs.
 */
export const BIG_HIT_DAMAGE = 45;

/**
 * The config with every strategy run through the one gate (`loadStrategy`), which also normalizes
 * it. The gym plays gated strategies too, so a gym match replayed here is the same fight. Throws on
 * the first invalid strategy, naming the fighter.
 */
export function validatedConfig(config: MatchConfig): MatchConfig {
  const house = new Set(HOUSE_STACKS.map(strategyKey));
  const entrants = config.entrants.map((e) => {
    // Malformed input still reaches the gate, which explains what is wrong with it.
    const isHouse = typeof e.strategy === 'object' && e.strategy !== null && house.has(strategyKey(e.strategy));
    const r = loadStrategy(e.strategy, isHouse ? 'house' : 'config');
    if (!r.strategy) {
      const first = r.errors[0];
      throw new Error(`${e.name} cannot fight: ${first ? `${first.path || '(top level)'}: ${first.message}` : 'invalid strategy'}.`);
    }
    return { ...e, strategy: r.strategy };
  });
  return { ...config, entrants };
}

/** "The Pit" -> "the Pit", for the middle of a sentence. */
function inSentence(mapName: string): string {
  return mapName.replace(/^The /, 'the ');
}

/** "Gary" -> "Gary's", "Aunt Carol Finishes Things" -> "Aunt Carol Finishes Things'". */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/** {k} killer, {v} victim, {v's} victim possessive. */
const LIMB_LINES: Readonly<Record<Limb, { by: string; solo: string }>> = {
  armR: { by: "{k} took {v's} weapon arm. Fists it is.", solo: '{v} lost the weapon arm. Fists it is.' },
  armL: { by: "{k} took {v's} left arm.", solo: '{v} is down an arm.' },
  legL: { by: "{k} took {v's} leg. {v} is hopping now.", solo: '{v} lost a leg and is hopping now.' },
  legR: { by: "{k} took {v's} leg. {v} is hopping now.", solo: '{v} lost a leg and is hopping now.' },
};

export class MatchSession {
  readonly config: MatchConfig;
  private readonly brainFactory: BrainFactory;
  private recorder: MatchRecorder;
  private _match: Match;
  private _report: MatchReport | null = null;
  /** Every feed line up to `maxTick`; the UI hides the ones after the current tick. */
  readonly feed: FeedItem[] = [];
  readonly marks: TimelineMark[] = [];
  /** Highest tick simulated so far (the timeline spans 0..maxTick). */
  maxTick = 0;

  /** `config` must already be validated (see `validatedConfig`): brains refuse invalid strategies. */
  constructor(config: MatchConfig, brainFactory: BrainFactory) {
    this.config = config;
    this.brainFactory = brainFactory;
    this._match = createMatch(config, brainFactory);
    this.recorder = this.newRecorder();
    this.feed.push({ tick: 0, text: this.openingLine(), kind: 'info', ids: [] });
  }

  get match(): Match {
    return this._match;
  }

  get state(): WorldState {
    return this._match.state;
  }

  get tick(): number {
    return this._match.state.tick;
  }

  get over(): boolean {
    return this._match.isOver;
  }

  /** The battle report, once the match has been played to the end (kept across seeks). */
  get report(): MatchReport | null {
    return this._report;
  }

  /** Advance one tick; returns that tick's events (the sim's own array: read it before the next step). */
  step(): GameEvent[] {
    const events = this._match.step();
    const state = this._match.state;
    if (!this._report) {
      // Decisions tell a fighter that wants to move but cannot (stuck) from one standing still (idle).
      this.recorder.observe(events, state, (id) => this._match.lastDecision(id));
      if (this._match.isOver) this._report = this.recorder.finish(this._match.result());
    }
    if (state.tick > this.maxTick) {
      this.maxTick = state.tick;
      this.chronicle(events, state);
    }
    return events;
  }

  /**
   * Jump to `tick` (clamped to the match). Forward jumps keep stepping; backward jumps rebuild the
   * match from its config first. Returns every event on the way, for catch-up rendering, and
   * whether the match was rebuilt (the renderer must then clear what it drew).
   */
  seek(tick: number): { events: GameEvent[]; rebuilt: boolean } {
    const target = Math.max(0, Math.floor(tick));
    if (target < this.tick) return { events: this.rebuildTo(target), rebuilt: true };
    return { events: this.stepTo(target), rebuilt: false };
  }

  /** Re-simulate from tick 0 to `tick` with fresh brains. Returns every event on the way. */
  rebuildTo(tick: number): GameEvent[] {
    this._match = createMatch(this.config, this.brainFactory);
    this.recorder = this.newRecorder();
    return this.stepTo(tick);
  }

  private stepTo(target: number): GameEvent[] {
    const all: GameEvent[] = [];
    while (this.tick < target && !this.over) {
      for (const e of this.step()) all.push(e);
    }
    return all;
  }

  private newRecorder(): MatchRecorder {
    return new MatchRecorder(this.config, this._match.state, { mapName: (id) => MAPS[id]?.name ?? id });
  }

  private name(state: WorldState, id: string | null): string {
    return state.fighters.find((f) => f.id === id)?.name ?? '';
  }

  /** Behaviour running right now, or null for no such fighter (or one that has not thought yet). */
  private behaviour(state: WorldState, id: string | null): string | null {
    return state.fighters.find((f) => f.id === id)?.behaviour || null;
  }

  private openingLine(): string {
    const n = this.config.entrants.length;
    const where = inSentence(this._match.map.name);
    if (this.config.format === 'duel') {
      const [a, b] = this.config.entrants;
      return `${a!.name} and ${b!.name} in ${where}. One of them walks out.`;
    }
    if (this.config.format === 'squads') {
      const squads = new Set(this.config.entrants.map((e) => e.squad)).size;
      return `${squads} squads, ${n} fighters, ${where}. Last squad standing takes it.`;
    }
    return `${n} fighters in ${where}. One walks out.`;
  }

  /**
   * Feed lines and timeline marks for one newly simulated tick. Every mark has a feed line on the
   * same tick, of the same kind, naming the same fighters, so the feed can link to it.
   */
  private chronicle(events: readonly GameEvent[], state: WorldState): void {
    // The arena's own moments (sudden death, the wall, the judges, power-ups back), in the sim's voice.
    const said = announcements(events, state);
    for (const f of said) this.feed.push(f);
    for (const e of events) {
      switch (e.type) {
        case 'kill': {
          const text = killLine(e, state);
          this.feed.push({ tick: e.tick, text, kind: 'kill', ids: e.killerId ? [e.killerId, e.victimId] : [e.victimId] });
          this.marks.push({
            tick: e.tick, kind: 'kill', actorId: e.killerId, targetId: e.victimId, text,
            actorBehaviour: e.killerBehaviour, targetBehaviour: e.victimBehaviour,
          });
          break;
        }
        case 'dismember': {
          const by = e.attackerId;
          const lines = LIMB_LINES[e.limb];
          const v = this.name(state, e.victimId);
          const text = (by ? lines.by : lines.solo).replaceAll('{k}', this.name(state, by)).replaceAll("{v's}", possessive(v)).replaceAll('{v}', v);
          this.feed.push({ tick: e.tick, text, kind: 'dismember', ids: by ? [by, e.victimId] : [e.victimId] });
          this.marks.push({
            tick: e.tick, kind: 'dismember', actorId: by, targetId: e.victimId, text,
            actorBehaviour: this.behaviour(state, by), targetBehaviour: this.behaviour(state, e.victimId),
          });
          break;
        }
        case 'hit':
          if (e.attackerId && e.amount >= BIG_HIT_DAMAGE) {
            this.marks.push({
              tick: e.tick, kind: 'big_hit', actorId: e.attackerId, targetId: e.victimId,
              text: `${this.name(state, e.attackerId)} hit ${this.name(state, e.victimId)} for ${Math.round(e.amount)}.`,
              actorBehaviour: this.behaviour(state, e.attackerId), targetBehaviour: this.behaviour(state, e.victimId),
            });
          }
          break;
        case 'pickup': {
          if (e.kind !== 'haste' && e.kind !== 'berserk') break; // spent ammo off the floor: not news
          const text = `${this.name(state, e.fighterId)} took the ${PICKUP_RULES[e.kind].name.toLowerCase()}.`;
          this.feed.push({ tick: e.tick, text, kind: 'pickup', ids: [e.fighterId] });
          this.marks.push({
            tick: e.tick, kind: 'pickup', actorId: e.fighterId, targetId: null, text,
            actorBehaviour: this.behaviour(state, e.fighterId), targetBehaviour: null,
          });
          break;
        }
        case 'sudden_death': {
          // Same text as the announcement on this tick, so the feed line links to the mark.
          const text = said.find((f) => f.kind === 'sudden_death')?.text ?? 'The walls are closing.';
          this.marks.push({ tick: e.tick, kind: 'sudden_death', actorId: null, targetId: null, text, actorBehaviour: null, targetBehaviour: null });
          break;
        }
        case 'match_end':
          this.feed.push({ tick: e.tick, ...this.winnerLine(e.placements, state) });
          break;
        default:
          break;
      }
    }
  }

  private winnerLine(placements: readonly string[], state: WorldState): Omit<FeedItem, 'tick'> {
    const where = inSentence(this._match.map.name);
    const winner = state.fighters.find((f) => f.id === placements[0]);
    if (!winner) return { text: `Nobody leaves ${where}.`, kind: 'info', ids: [] };
    if (this.config.format === 'squads') {
      const squad = state.fighters.filter((f) => f.squad === winner.squad);
      const kills = squad.reduce((n, f) => n + f.kills, 0);
      return { text: `Squad ${String.fromCharCode(65 + winner.squad)} takes ${where}, ${kills} kills between them.`, kind: 'info', ids: squad.map((f) => f.id) };
    }
    const kills = winner.kills === 0 ? 'without a single kill' : winner.kills === 1 ? 'with 1 kill' : `with ${winner.kills} kills`;
    return { text: `${winner.name} takes ${where} ${kills}.`, kind: 'info', ids: [winner.id] };
  }
}
