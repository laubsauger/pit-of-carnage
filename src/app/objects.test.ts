import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_LIMIT_TICKS, FIGHTER_COLORS, HAZARD_RULES, PICKUP_RULES, PROP_RULES, TICK_HZ } from '../core';
import type { MatchConfig } from '../core';
import { HOUSE_STACKS, gatedBrainFactory } from '../strategy';
import { inSeconds, objectInfo, seconds } from './objects';
import { MatchSession, validatedConfig } from './session';

function session(mapId: string): MatchSession {
  const config: MatchConfig = validatedConfig({
    seed: 11, mapId, format: 'ffa', friendlyFire: true, timeLimitTicks: DEFAULT_TIME_LIMIT_TICKS, suddenDeath: true,
    entrants: HOUSE_STACKS.slice(0, 4).map((strategy, i) => ({ id: `e${i}`, strategy, squad: i, name: strategy.name, color: FIGHTER_COLORS[i]! })),
  });
  return new MatchSession(config, gatedBrainFactory);
}

describe('map-object hover cards (SPEC: every map object says what it does and its current state)', () => {
  it('cards talk in seconds, never in ticks', () => {
    expect(seconds(320)).toBe('5.3 s');
    expect(seconds(600)).toBe('10 s');
    for (const doc of [...Object.values(HAZARD_RULES), ...Object.values(PICKUP_RULES), ...Object.values(PROP_RULES)].map((r) => r.doc)) {
      expect(inSeconds(doc)).not.toMatch(/tick/);
    }
  });

  it('the shrine reads Ready, then counts its recharge down after a use', () => {
    const s = session('pit');
    const shrine = s.state.shrines[0]!;
    const ready = objectInfo(s.state, 'shrine', shrine.id)!;
    expect(ready.name).toBe('Shrine');
    expect(ready.description).toBe(`Heals 42% of max HP on touch, then recharges for ${seconds(PICKUP_RULES.shrine.cooldownTicks)}.`);
    expect(ready.state).toBe('Ready');
    shrine.cooldown = 3.2 * TICK_HZ;
    expect(objectInfo(s.state, 'shrine', shrine.id)!.state).toBe('Recharging, 3.2 s');
  });

  it('a pedestal says when its power-up comes back (first appearance included)', () => {
    const s = session('pit');
    const p = s.state.pickups[0]!;
    const card = objectInfo(s.state, 'pickup', p.id)!;
    expect(card.name).toBe(PICKUP_RULES[p.kind].name);
    expect(card.state).toBe(`Back in ${seconds(PICKUP_RULES[p.kind].firstSpawnTicks)}`);
    p.cooldown = 0;
    expect(objectInfo(s.state, 'pickup', p.id)!.state).toBe('Up for grabs');
  });

  it('a spike trap tells the rhythm: the countdown to its thrust matches the sim', () => {
    const s = session('pit');
    const spike = s.state.hazards.find((h) => h.kind === 'spike')!;
    expect(spike, 'the pit has spike traps').toBeTruthy();
    // Step until the card promises a thrust within a second, then check it happens on that tick.
    let promised = -1;
    for (let i = 0; i < 400 && promised < 0; i++) {
      s.step();
      const card = objectInfo(s.state, 'hazard', spike.id)!;
      const m = card.state?.match(/^Thrusts in ([\d.]+) s$/);
      if (m && Number(m[1]) <= 1) promised = s.tick + Math.round(Number(m[1]) * TICK_HZ);
    }
    expect(promised, 'no thrust announced within 400 ticks').toBeGreaterThan(0);
    for (let i = 0; i < 120 && s.tick < promised; i++) s.step();
    // Within rounding of the 0.1 s display, the spikes are up.
    let up = false;
    for (let i = 0; i < 8 && !up; i++) {
      up = objectInfo(s.state, 'hazard', spike.id)!.state === 'Spikes up';
      if (!up) s.step();
    }
    expect(up).toBe(true);
  });

  it('a prop shows its HP, and a broken prop or unknown id has no card (a corpse of a crate shows nothing)', () => {
    const s = session('pit');
    const keg = s.state.props.find((p) => p.kind === 'keg')!;
    expect(objectInfo(s.state, 'prop', keg.id)!.state).toBe(`${PROP_RULES.keg.hp} of ${PROP_RULES.keg.hp} HP`);
    keg.alive = false;
    expect(objectInfo(s.state, 'prop', keg.id)).toBeNull();
    expect(objectInfo(s.state, 'hazard', 'nope')).toBeNull();
  });

  it('spilled acid counts down to drying up and says it slows', () => {
    const s = session('pit');
    s.state.hazards.push({ id: 'spill1', kind: 'acid', pos: { x: 100, y: 100 }, radius: 50, phase: 0, active: true, ttl: 120 });
    const card = objectInfo(s.state, 'hazard', 'spill1')!;
    expect(card.name).toBe('Spilled acid pool');
    expect(card.state).toBe('Dries up in 2 s');
    expect(card.description).toMatch(/slow/);
  });
});
