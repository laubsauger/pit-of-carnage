import { describe, expect, it } from 'vitest';
import { TICK_HZ } from '../core';
import type { FighterState, GameEvent, WorldState } from '../core';
import type { Cue } from './cues';
import {
  CAMP_TICKS,
  CrowdDirector,
  PROFILE_RANGES,
  REACTION_SOUND,
  bedCutoff,
  bedLevel,
  chantIntensity,
  chantStyle,
  chantTempo,
  crowdProfile,
  stateTension,
} from './crowd';
import type { CrowdProfile } from './crowd';
import { MAP_H, MAP_W, fighter, hitEvent, killEvent, world } from './testkit';

const DT = 1 / TICK_HZ;
const always = () => 0;
const never = () => 0.999;

/** Eight fighters spread over the pit, nobody near anybody. */
function spread(): FighterState[] {
  return Array.from({ length: 8 }, (_, i) => fighter(`f${i}`, 120 + (i % 4) * 360, 150 + Math.floor(i / 4) * 560));
}

/** Eight fighters in four close duels. */
function duels(): FighterState[] {
  return Array.from({ length: 8 }, (_, i) => fighter(`f${i}`, 200 + Math.floor(i / 2) * 300 + (i % 2) * 50, MAP_H / 2));
}

/**
 * Run the director tick by tick for `seconds` (hard bound), feeding the events `each` returns for a
 * tick, and collect every reaction with the second it came.
 */
function run(
  d: CrowdDirector,
  state: WorldState,
  seconds: number,
  each: (tick: number) => GameEvent[] = () => [],
  rand: () => number = always,
): { at: number; cue: Cue }[] {
  const got: { at: number; cue: Cue }[] = [];
  const start = state.tick;
  const ticks = Math.round(seconds * TICK_HZ);
  for (let i = 0; i < ticks; i++) {
    state.tick = start + i;
    const out: Cue[] = [];
    for (const ev of each(state.tick)) d.onEvent(ev, state, out, rand);
    d.observe(state, out, rand);
    d.update(DT);
    for (const cue of out) got.push({ at: i * DT, cue });
  }
  return got;
}

describe('crowdProfile', () => {
  // "The same match sounds the same": restarts and replays keep their crowd.
  it('gives the same seed the same crowd', () => {
    expect(crowdProfile(1234)).toEqual(crowdProfile(1234));
  });

  // "Identical every round" was the complaint: different seeds must give audibly different crowds.
  it('varies density, pitch, pace and chant across rounds, inside sane ranges', () => {
    const ps = Array.from({ length: 40 }, (_, i) => crowdProfile(i * 7919 + 1));
    const distinct = (k: keyof CrowdProfile) => new Set(ps.map((p) => JSON.stringify(p[k]))).size;
    expect(distinct('voices')).toBeGreaterThan(10);
    expect(distinct('pitch')).toBe(40);
    expect(distinct('pace')).toBe(40);
    expect(distinct('chant')).toBe(3);
    for (const p of ps) {
      for (const k of Object.keys(PROFILE_RANGES) as (keyof typeof PROFILE_RANGES)[]) {
        const [lo, hi] = PROFILE_RANGES[k];
        const values = k === 'breath' ? p.breath : [p[k]];
        for (const v of values) {
          expect(v).toBeGreaterThanOrEqual(lo);
          expect(v).toBeLessThanOrEqual(hi);
        }
      }
    }
  });
});

describe('bed', () => {
  // The murmur was too loud and constant: in a lull it must be a whisper of the full swell.
  it('is nearly silent in a lull and full when the pit goes wild', () => {
    for (let s = 1; s < 30; s++) {
      const p = crowdProfile(s);
      expect(bedLevel(0, p)).toBeLessThanOrEqual(0.05);
      expect(bedLevel(1, p)).toBeCloseTo(1, 9);
      let last = -1;
      for (let i = 0; i <= 1.0001; i += 0.05) {
        expect(bedLevel(i, p)).toBeGreaterThan(last);
        last = bedLevel(i, p);
      }
      expect(bedCutoff(1, p)).toBeGreaterThan(bedCutoff(0, p) * 4);
    }
    expect(bedLevel(Number.NaN, crowdProfile(1))).toBe(crowdProfile(1).rest);
  });
});

describe('stateTension', () => {
  it('reads nothing from a spread-out field and rises with close fights, low HP and the last two', () => {
    expect(stateTension(world(spread()))).toBe(0);
    const close = stateTension(world(duels()));
    expect(close).toBeGreaterThan(0.2);
    const hurt = duels().map((f, i) => (i === 0 ? { ...f, hp: 40 } : f));
    expect(stateTension(world(hurt))).toBeGreaterThan(close);
    const lastTwo = spread().map((f, i) => (i < 6 ? { ...f, alive: false } : f));
    expect(stateTension(world(lastTwo))).toBeGreaterThan(0.1);
    // Squadmates standing together are not a fight.
    const squad = duels().map((f) => ({ ...f, squad: 1 }));
    expect(stateTension(world(squad))).toBe(0);
  });
});

describe('CrowdDirector: breathing', () => {
  it('stays nearly silent while nobody fights', () => {
    const d = new CrowdDirector(crowdProfile(7));
    run(d, world(spread(), 0), 10);
    expect(d.intensity).toBeLessThan(0.05);
  });

  // The crowd follows the action: up in a brawl, back down within seconds once it stops.
  it('swells in a brawl and falls back once the fighting stops', () => {
    const d = new CrowdDirector(crowdProfile(7));
    const brawl = world(duels(), 0);
    run(d, brawl, 6, (t) => (t % 24 === 0 ? [hitEvent('f0', 'f1', 20, t), hitEvent('f3', 'f2', 20, t)] : []), never);
    expect(d.intensity).toBeGreaterThan(0.6);
    const lull = world(spread(), brawl.tick + 1);
    run(d, lull, 8, () => [], never);
    expect(d.intensity).toBeLessThan(0.15);
  });

  it('builds through the countdown and lets loose on FIGHT', () => {
    const d = new CrowdDirector(crowdProfile(3));
    d.onSignal({ type: 'countdown', value: 3 });
    const three = d.energy;
    d.onSignal({ type: 'countdown', value: 1 });
    expect(d.energy).toBeGreaterThan(three);
    d.onSignal({ type: 'fight' });
    expect(d.energy).toBeGreaterThanOrEqual(0.75);
  });
});

describe('CrowdDirector: reactions', () => {
  // Sparse reactions instead of a loop: even a non-stop gore fest gets them spaced out.
  it('keeps reactions sparse in the bloodiest brawl', () => {
    const p = crowdProfile(11);
    const d = new CrowdDirector(p);
    const s = world(duels(), 600);
    const got = run(d, s, 60, (t) => {
      if (t % 12 !== 0) return [];
      return [
        hitEvent('f0', 'f1', 90, t, { backstab: true }),
        { type: 'dismember', tick: t, attackerId: 'f2', victimId: 'f3', limb: 'armL', pos: { x: 500, y: 430 }, vel: { x: 1, y: 0 } },
        { type: 'parry', tick: t, fighterId: 'f4', attackerId: 'f5', pos: { x: 800, y: 430 } },
      ];
    });
    const reactions = got.filter((g) => g.cue.sound !== 'crowd_chant');
    expect(reactions.length).toBeGreaterThan(5);
    expect(reactions.length).toBeLessThanOrEqual(Math.ceil(60 / p.reactionGap) + 1);
    for (let i = 1; i < reactions.length; i++) expect(reactions[i]!.at - reactions[i - 1]!.at).toBeGreaterThanOrEqual(p.reactionGap - DT);
    const kinds = new Set(reactions.map((r) => r.cue.sound));
    expect(kinds.has(REACTION_SOUND.gasp)).toBe(true);
    expect(kinds.has(REACTION_SOUND.whistle)).toBe(true);
  });

  // A camper is booed, and the boo comes from its side of the pit.
  it('boos a fighter that stands still without dealing damage while others fight', () => {
    const fs = duels().slice(0, 6);
    fs.push(fighter('f7', MAP_W - 80, 120));
    const s = world(fs, 600);
    const got = run(d0(), s, 20, (t) => {
      if (t % 30 !== 0) return [];
      for (const f of fs.slice(0, 6)) f.damageDealt += 5;
      return [hitEvent('f0', 'f1', 5, t), hitEvent('f2', 'f3', 5, t), hitEvent('f4', 'f5', 5, t)];
    });
    const boos = got.filter((g) => g.cue.sound === 'crowd_boo');
    expect(boos.length).toBeGreaterThan(0);
    expect(boos[0]!.at).toBeGreaterThanOrEqual(CAMP_TICKS / TICK_HZ - 1);
    expect(boos[0]!.cue.pan).toBeGreaterThan(0.2);
  });

  // A planted archer that keeps scoring is not camping.
  it('never boos a fighter that holds still but keeps dealing damage', () => {
    const fs = duels().slice(0, 6);
    const archer = fighter('f7', MAP_W - 80, 120, { weapon: 'LONGBOW' });
    fs.push(archer);
    const s = world(fs, 600);
    const got = run(d0(), s, 30, (t) => {
      if (t % 30 !== 0) return [];
      for (const f of fs) f.damageDealt += 5;
      return [hitEvent('f0', 'f1', 5, t), hitEvent('f7', 'f3', 5, t)];
    });
    expect(got.filter((g) => g.cue.sound === 'crowd_boo')).toEqual([]);
  });

  it('gets restless when nobody has hurt anybody for a while', () => {
    const got = run(d0(), world(spread(), 0), 25);
    expect(got.some((g) => g.cue.sound === 'crowd_boo' || g.cue.sound === 'crowd_whistle')).toBe(true);
  });

  // Chants on a streak: from the third kill on, once per new kill, never for the same count twice.
  it('chants for a fighter on a streak, once per new kill', () => {
    const d = d0();
    const fs = spread();
    fs[0] = { ...fs[0]!, kills: 3 };
    const s = world(fs, 1200);
    const chants = (ev: GameEvent) => {
      const out: Cue[] = [];
      d.onEvent(ev, s, out, always);
      return out.filter((c) => c.sound === 'crowd_chant');
    };
    const first = chants(killEvent('f0', 'f1', 1200));
    expect(first.length).toBe(1);
    expect(first[0]!.delay).toBeGreaterThan(0.5);
    expect(chantTempo(first[0]!.intensity)).toBeCloseTo(d.profile.chantTempo, 6);
    expect(chantStyle(first[0]!.variant)).toBe(d.profile.chant);
    expect(chants(killEvent('f0', 'f2', 1201))).toEqual([]);
    run(d, s, 12);
    fs[0]!.kills = 4;
    expect(chants(killEvent('f0', 'f3', s.tick)).length).toBe(1);
    // Two kills is not a streak yet.
    const early = spread();
    early[0] = { ...early[0]!, kills: 2 };
    const out: Cue[] = [];
    d0().onEvent(killEvent('f0', 'f1', 2000), world(early, 2000), out, always);
    expect(out.filter((c) => c.sound === 'crowd_chant')).toEqual([]);
  });

  it('gasps once when a fighter is knocked to the edge of death, not on every scratch after', () => {
    const d = d0();
    const fs = duels();
    fs[1] = { ...fs[1]!, hp: 30 };
    const s = world(fs, 900);
    const gasps = (amount: number) => {
      const out: Cue[] = [];
      d.onEvent(hitEvent('f0', 'f1', amount, s.tick), s, out, always);
      return out.filter((c) => c.sound === 'crowd_gasp').length;
    };
    expect(gasps(5)).toBe(1);
    run(d, s, 10);
    expect(gasps(5)).toBe(0);
  });

  // The final kill belongs to the final sting and the biggest roar; no whistles or chants on top.
  it('saves the final kill from sparse reactions', () => {
    const d = d0();
    const fs = spread();
    fs[0] = { ...fs[0]!, kills: 5 };
    const out: Cue[] = [];
    d.onEvent(killEvent('f0', 'f1', 3000, { final: true, flags: ['multi'] }), world(fs, 3000), out, always);
    expect(out).toEqual([]);
    expect(d.energy).toBeGreaterThan(0.4);
  });
});

describe('chant tempo encoding', () => {
  it('round-trips a tempo through a cue intensity', () => {
    for (const t of [1.7, 2, 2.4]) expect(chantTempo(chantIntensity(t))).toBeCloseTo(t, 9);
    expect(chantStyle(undefined)).toBe('hey');
    expect(chantStyle(9)).toBe('stomp');
  });
});

/** A director for a fixed, average-ish crowd. */
function d0(): CrowdDirector {
  return new CrowdDirector(crowdProfile(42));
}
