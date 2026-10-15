import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_BUDGET, ATTRIBUTE_MAX, ATTRIBUTE_MIN, TICK_HZ } from './constants';
import {
  ATTRIBUTE_KEYS,
  BARK_RULES,
  COMBAT,
  COMBAT_DOCS,
  HAZARD_RULES,
  MATCH_RULES,
  MATCH_RULES_DOCS,
  PERCEPTION,
  PERCEPTION_DOCS,
  PICKUP_RULES,
  PROP_RULES,
  SKILLS,
  SKILL_IDS,
  STAT_DOCS,
  WEAPONS,
  WEAPON_IDS,
  armorMitigation,
  attackCooldown,
  attributesLegal,
  deriveStats,
  facingMoveMul,
  fighterRadius,
  hearingRadius,
  initialSuddenDeathState,
  matchHardCapTicks,
  maxHp,
  moveSpeed,
  noiseMultiplier,
  parryChance,
  projectileSpeed,
  projectileTtl,
  resolveDamage,
  shotSpread,
  skillCooldown,
  skillDamage,
  turnRate,
  visionFov,
  visionRange,
  zoneBoundsAfter,
  zoneEdgeDistance,
  zoneTicksToReach,
} from './rules';
import type { Attributes, Rect, SuddenDeathState } from './types';

const balanced: Attributes = { vitality: 17, power: 17, agility: 17, perception: 17, armor: 16, haste: 16 };
const PIT_WIDTH = 1360;

/** Every legal extreme: one attribute at max, the rest spread at the minimum. */
function extremeBuilds(): Attributes[] {
  const builds: Attributes[] = [];
  for (const hi of ATTRIBUTE_KEYS) {
    for (const lo of ATTRIBUTE_KEYS) {
      const a = { vitality: ATTRIBUTE_MIN, power: ATTRIBUTE_MIN, agility: ATTRIBUTE_MIN, perception: ATTRIBUTE_MIN, armor: ATTRIBUTE_MIN, haste: ATTRIBUTE_MIN };
      a[hi] = ATTRIBUTE_MAX;
      if (lo !== hi) a[lo] = Math.min(ATTRIBUTE_MAX, ATTRIBUTE_BUDGET - 4 * ATTRIBUTE_MIN - ATTRIBUTE_MAX);
      builds.push(a);
    }
  }
  return builds;
}

describe('derived stats follow the published formulas (the rulebook quotes them to players)', () => {
  it('matches the spec at a reference build', () => {
    expect(maxHp(balanced)).toBe(Math.round(150 + 17 * 8.5));
    expect(armorMitigation(balanced)).toBeCloseTo(16 * 0.016, 12);
    expect(visionRange(balanced, 'GREATSWORD')).toBeCloseTo(255 + 17 * 9.5, 12);
    expect(visionRange(balanced, 'LONGBOW')).toBeCloseTo(255 + 17 * 9.5 + WEAPONS.LONGBOW.visionBonus, 12);
    expect(hearingRadius(balanced)).toBeCloseTo(115 + 17 * 4.2, 12);
    expect(skillCooldown(balanced)).toBe(Math.round(205 - 16 * 3.1));
    expect(parryChance({ ...balanced, perception: 40 })).toBeCloseTo(0.35, 12);
    expect(skillDamage('WHIRLWIND', balanced)).toBeCloseTo(25 + 17 * 0.55, 12);
  });

  it('caps armor at 48% so no build becomes unkillable', () => {
    expect(armorMitigation({ ...balanced, armor: 40 })).toBe(0.48);
  });

  it('never lets a hit round down to nothing', () => {
    expect(resolveDamage(1, 1, { ...balanced, armor: 40 })).toBe(COMBAT.minDamage);
    expect(resolveDamage(30, 1, { ...balanced, armor: 0 })).toBe(30);
  });

  it('makes haste shorten attack cooldowns but never below the floor', () => {
    expect(attackCooldown({ ...balanced, haste: 30 }, 'GREATSWORD')).toBeLessThan(attackCooldown({ ...balanced, haste: 4 }, 'GREATSWORD'));
    expect(attackCooldown({ ...balanced, haste: 40 }, 'TWIN_DAGGERS')).toBe(COMBAT.minAttackCooldown);
  });

  it('treats creeping and slow targets as quiet, walking ones as noisy', () => {
    expect(noiseMultiplier(2, 'creep')).toBeLessThan(1);
    expect(noiseMultiplier(0.2, 'normal')).toBeLessThan(1);
    expect(noiseMultiplier(2, 'normal')).toBeGreaterThan(1);
  });
});

describe('pace (quality bar: readable fights, ~8-10 s to cross the pit at 1x)', () => {
  it('a balanced build crosses the pit in roughly 8-12 s', () => {
    for (const w of WEAPON_IDS) {
      const seconds = PIT_WIDTH / (moveSpeed(balanced, w) * TICK_HZ);
      expect(seconds, w).toBeGreaterThan(8);
      expect(seconds, w).toBeLessThan(12.5);
    }
  });

  it('even the fastest legal build stays readable (no blur across the arena)', () => {
    const fastest: Attributes = { vitality: 4, power: 4, agility: 40, perception: 4, armor: 4, haste: 4 };
    expect(PIT_WIDTH / (moveSpeed(fastest, 'TWIN_DAGGERS') * TICK_HZ)).toBeGreaterThan(5);
  });

  it('projectiles stay slow enough to see but outrun a sprinting fighter', () => {
    const sprint = moveSpeed({ vitality: 4, power: 4, agility: 40, perception: 4, armor: 4, haste: 4 }, 'TWIN_DAGGERS') * COMBAT.hasteMoveMul;
    for (const w of WEAPON_IDS) {
      if (WEAPONS[w].family !== 'ranged') continue;
      expect(projectileSpeed(w), w).toBeGreaterThan(sprint);
      expect(projectileSpeed(w), w).toBeLessThan(12);
    }
  });
});

describe('every legal build is playable (no degenerate stats the sim would choke on)', () => {
  it('keeps speed, turn rate, FOV and HP in sane ranges for all extremes', () => {
    for (const a of extremeBuilds()) {
      expect(attributesLegal(a)).toBe(true);
      for (const w of WEAPON_IDS) {
        const s = deriveStats(a, w);
        expect(s.moveSpeed).toBeGreaterThan(0.5);
        expect(s.turnRate).toBeGreaterThanOrEqual(1.6);
        expect(s.turnRate).toBeLessThanOrEqual(7.4);
        expect(s.visionFov).toBeGreaterThanOrEqual(1.35);
        expect(s.visionFov).toBeLessThanOrEqual(2.55);
        expect(s.maxHp).toBeGreaterThan(100);
        expect(s.skillCooldown).toBeGreaterThanOrEqual(COMBAT.minSkillCooldown);
      }
    }
  });

  it('rejects over-budget and out-of-range attributes', () => {
    expect(attributesLegal(balanced)).toBe(true);
    expect(attributesLegal({ ...balanced, power: 18 })).toBe(false); // 101 points
    expect(attributesLegal({ ...balanced, power: 3 })).toBe(false);
    expect(attributesLegal({ vitality: 41, power: 4, agility: 4, perception: 4, armor: 4, haste: 4 })).toBe(false);
    expect(attributesLegal({ ...balanced, power: Number.NaN })).toBe(false);
  });

  it('heavier weapons turn slower than daggers at the same build', () => {
    expect(turnRate(balanced, 'WARHAMMER')).toBeLessThan(turnRate(balanced, 'TWIN_DAGGERS'));
    expect(visionFov(balanced, 'TWIN_DAGGERS')).toBeGreaterThan(visionFov(balanced, 'LONGBOW'));
  });
});

describe('rule tables are complete (the rulebook and sim iterate them blindly)', () => {
  it('every weapon is consistent with its family', () => {
    for (const id of WEAPON_IDS) {
      const w = WEAPONS[id];
      expect(w.id).toBe(id);
      expect(w.doc.length).toBeGreaterThan(10);
      if (w.family === 'melee') {
        expect(w.arc, id).toBeGreaterThan(0);
        expect(w.projectileSpeed, id).toBe(0);
      } else {
        expect(w.arc, id).toBe(0);
        expect(w.projectileSpeed, id).toBeGreaterThan(0);
        expect(w.ammo, id).toBeGreaterThan(0);
        // A shot aimed at max range must be able to arrive before it drops.
        expect(projectileTtl(id) * projectileSpeed(id), id).toBeGreaterThanOrEqual(w.range);
        // Ammo must come back somehow, or the fighter is unarmed forever.
        expect(w.ammoPickup || w.ammoRegenTicks > 0, id).toBe(true);
      }
    }
  });

  it('only shield weapons block projectiles, as the spec promises', () => {
    expect(WEAPON_IDS.filter((id) => WEAPONS[id].shield).sort()).toEqual(['GREATSWORD', 'WARHAMMER']);
  });

  it('every skill, hazard, pickup and prop documents itself', () => {
    for (const id of SKILL_IDS) {
      expect(SKILLS[id].id).toBe(id);
      expect(SKILLS[id].doc.length).toBeGreaterThan(10);
    }
    for (const table of [HAZARD_RULES, PICKUP_RULES, PROP_RULES]) {
      for (const entry of Object.values(table)) expect(entry.doc.length).toBeGreaterThan(10);
    }
    for (const key of Object.keys(COMBAT)) expect(COMBAT_DOCS[key as keyof typeof COMBAT]).toBeTruthy();
    for (const key of Object.keys(PERCEPTION)) expect(PERCEPTION_DOCS[key as keyof typeof PERCEPTION]).toBeTruthy();
    for (const key of Object.keys(STAT_DOCS)) expect(key in deriveStats(balanced, 'LONGBOW')).toBe(true);
  });

  // The rulebook prints MATCH_RULES as a number table; a non-number would print as garbage.
  it('keeps match rules numeric and documented', () => {
    for (const [key, value] of Object.entries(MATCH_RULES)) {
      expect(typeof value, key).toBe('number');
      expect(MATCH_RULES_DOCS[key as keyof typeof MATCH_RULES], key).toBeTruthy();
    }
  });
});

describe('ranged vs melee (spec: kiting is easy and closing in is hard, so the rules must make melee worth it)', () => {
  const melee = WEAPON_IDS.filter((id) => WEAPONS[id].family === 'melee');
  const ranged = WEAPON_IDS.filter((id) => WEAPONS[id].family === 'ranged');
  const avg = (ids: readonly string[]) => ids.reduce((s, id) => s + WEAPONS[id as keyof typeof WEAPONS].moveMul, 0) / ids.length;

  it('melee builds move about 10% faster, and no ranged weapon outruns any melee weapon', () => {
    const ratio = avg(melee) / avg(ranged);
    expect(ratio).toBeGreaterThanOrEqual(1.07);
    expect(ratio).toBeLessThanOrEqual(1.15);
    expect(Math.min(...melee.map((id) => WEAPONS[id].moveMul))).toBeGreaterThanOrEqual(Math.max(...ranged.map((id) => WEAPONS[id].moveMul)));
  });

  it('backpedalling is slow: full speed forwards, the backpedal penalty straight back, in between sideways', () => {
    expect(facingMoveMul(0, 0)).toBeCloseTo(1, 12);
    expect(facingMoveMul(Math.PI, 0)).toBeCloseTo(COMBAT.backpedalMoveMul, 12);
    const sideways = facingMoveMul(Math.PI / 2, 0);
    expect(sideways).toBeGreaterThan(COMBAT.backpedalMoveMul);
    expect(sideways).toBeLessThan(1);
    // Turning left or right costs the same, and the angle wraps.
    expect(facingMoveMul(-Math.PI / 2, 0)).toBeCloseTo(sideways, 12);
    expect(facingMoveMul(0.3 + Math.PI * 2, 0.3)).toBeCloseTo(1, 12);
    // A kiter walking away loses at least a third of its speed against a melee chaser.
    expect(COMBAT.backpedalMoveMul).toBeLessThanOrEqual(0.67);
  });

  it('ranged attackers plant to shoot and need to face the target', () => {
    expect(COMBAT.rangedPlantMoveMul).toBeLessThan(0.5);
    expect(COMBAT.releaseFacingTolerance).toBeGreaterThan(0);
    expect(COMBAT.releaseFacingTolerance).toBeLessThan(0.35);
  });

  it('shots get less accurate when the shooter moves and the farther the target is, within a cap', () => {
    const still = shotSpread(0, 100);
    expect(shotSpread(1.5, 100)).toBeGreaterThan(still);
    expect(shotSpread(0, 400)).toBeGreaterThan(still);
    expect(shotSpread(50, 5000)).toBe(COMBAT.spreadMax);
    expect(shotSpread(-3, -10)).toBe(COMBAT.spreadBase);
    // A standing archer at full longbow range still misses a body-width target some of the time.
    const lateral = Math.tan(shotSpread(0, WEAPONS.LONGBOW.range)) * WEAPONS.LONGBOW.range;
    expect(lateral).toBeGreaterThan(fighterRadius(balanced));
  });

  it('point-blank shots are weak, every melee swing lunges 20-40 px, and a melee hit interrupts a windup', () => {
    expect(COMBAT.pointBlankMul).toBeLessThan(1);
    expect(COMBAT.pointBlankRange).toBeGreaterThan(Math.max(...melee.map((id) => WEAPONS[id].range)) - 10);
    for (const id of melee) {
      expect(WEAPONS[id].lunge, id).toBeGreaterThanOrEqual(20);
      expect(WEAPONS[id].lunge, id).toBeLessThanOrEqual(40);
    }
    for (const id of ranged) expect(WEAPONS[id].lunge, id).toBe(0);
    expect(COMBAT.interruptStaggerTicks).toBeGreaterThan(0);
  });
});

describe('fog of war numbers (spec: hearing is fuzzy, never exact)', () => {
  it('hearing error is never zero and grows with distance; walls muffle', () => {
    expect(PERCEPTION.hearingErrorBase).toBeGreaterThan(0);
    expect(PERCEPTION.hearingErrorPerPx).toBeGreaterThan(0);
    expect(PERCEPTION.hearingWallMul).toBeLessThan(1);
    // Refreshed about twice a second: a stale guess, not a live tracker.
    expect(PERCEPTION.hearingRefreshTicks).toBeGreaterThanOrEqual(20);
    expect(PERCEPTION.hearingRefreshTicks).toBeLessThanOrEqual(40);
  });
});

describe('power-ups and barks', () => {
  it('a power-up first appears no later than its respawn time, so one ring formula shows progress', () => {
    for (const [kind, r] of Object.entries(PICKUP_RULES)) {
      expect(r.firstSpawnTicks, kind).toBeGreaterThanOrEqual(0);
      expect(r.firstSpawnTicks, kind).toBeLessThanOrEqual(r.cooldownTicks);
    }
    // Strong and short: the buff runs out well before the next one is up.
    expect(PICKUP_RULES.haste.durationTicks).toBeLessThan(PICKUP_RULES.haste.cooldownTicks);
    expect(PICKUP_RULES.berserk.durationTicks).toBeLessThan(PICKUP_RULES.berserk.cooldownTicks);
  });

  it('barks are rare (one per fighter every 8 s) and key moments exclude chatter', () => {
    expect(BARK_RULES.cooldownTicks).toBe(8 * TICK_HZ);
    expect(BARK_RULES.maxVisible).toBe(2);
    expect([...BARK_RULES.keyKinds].sort()).toEqual(['death', 'kill', 'low_hp', 'skill', 'spawn']);
  });
});

describe('sudden death zone (spec: every match ends, and strategies can see the wall coming)', () => {
  const PIT = { width: 1360, height: 860 };
  const rect = (): Rect => ({ x: 0, y: 0, w: 0, h: 0 });
  /** A zone that started at `inset` and is still closing. */
  function closing(inset: number): SuddenDeathState {
    const z = initialSuddenDeathState(PIT);
    z.active = true;
    z.reason = 'time';
    z.startedAtTick = 0;
    z.inset = inset;
    const ix = Math.min(inset, z.final.x);
    const iy = Math.min(inset, z.final.y);
    z.bounds = { x: ix, y: iy, w: PIT.width - 2 * ix, h: PIT.height - 2 * iy };
    return z;
  }

  it('starts as the whole map with a centred final rectangle of the minimum size', () => {
    const z = initialSuddenDeathState(PIT);
    expect(z.active).toBe(false);
    expect(z.bounds).toEqual({ x: 0, y: 0, w: 1360, h: 860 });
    expect(z.warning).toEqual(z.bounds);
    expect(z.warning).not.toBe(z.bounds);
    expect(z.final).toEqual({ x: 680 - MATCH_RULES.suddenDeathMinHalfSize, y: 430 - MATCH_RULES.suddenDeathMinHalfSize, w: 180, h: 180 });
  });

  it('predicts the wall: inward at the inset speed on every side, stopping at the final rectangle', () => {
    const z = closing(100);
    const d = 60 * MATCH_RULES.suddenDeathInsetPerTick;
    expect(zoneBoundsAfter(z, 60, rect())).toEqual({ x: 100 + d, y: 100 + d, w: 1160 - 2 * d, h: 660 - 2 * d });
    // Far enough ahead it is exactly the final rectangle, never smaller.
    expect(zoneBoundsAfter(z, 1e6, rect())).toEqual(z.final);
    // Writing into the live bounds object is safe.
    zoneBoundsAfter(z, 60, z.bounds);
    expect(z.bounds.x).toBeCloseTo(100 + d, 12);
    // Before sudden death and once closed, nothing moves.
    const idle = initialSuddenDeathState(PIT);
    expect(zoneBoundsAfter(idle, 600, rect())).toEqual(idle.bounds);
    const closed = closing(1000);
    closed.closedAtTick = 50;
    expect(zoneBoundsAfter(closed, 600, rect())).toEqual(closed.bounds);
  });

  it('tells a fighter how long until the wall reaches it, and how far the edge is', () => {
    const z = closing(100);
    const v = MATCH_RULES.suddenDeathInsetPerTick;
    expect(zoneTicksToReach(z, { x: 140, y: 430 })).toBeCloseTo(40 / v, 9);
    expect(zoneTicksToReach(z, { x: 680, y: 300 })).toBeCloseTo(200 / v, 9);
    expect(zoneTicksToReach(z, { x: 50, y: 430 })).toBe(0);
    expect(zoneTicksToReach(z, { x: 680, y: 430 })).toBe(Infinity);
    expect(zoneTicksToReach(initialSuddenDeathState(PIT), { x: 5, y: 5 })).toBe(Infinity);
    expect(zoneEdgeDistance(z, { x: 140, y: 430 })).toBe(40);
    expect(zoneEdgeDistance(z, { x: 97, y: 96 })).toBeCloseTo(-5, 9);
  });

  // Worst case: sudden death starts at the time limit, and the tankiest legal build stands in the
  // final zone on a shrine. The ramp must still kill it before the hard cap, so the judges stay a
  // last resort. (Wall damage ignores armor; the wall starts from the map edge here, which is slower
  // than the real start at the outer wall.)
  it('escalation kills a max-HP fighter camping a shrine before the hard cap', () => {
    const tank = maxHp({ vitality: 40, power: 4, agility: 4, perception: 4, armor: 40, haste: 8 });
    const closeAt = Math.ceil((Math.max(PIT.width, PIT.height) / 2 - MATCH_RULES.suddenDeathMinHalfSize) / MATCH_RULES.suddenDeathInsetPerTick);
    const shrine = PICKUP_RULES.shrine;
    let hp = tank;
    let shrineCd = 0;
    let t = 0;
    for (; t < MATCH_RULES.hardCapExtraTicks && hp > 0; t++) {
      if (t >= closeAt && t - closeAt >= MATCH_RULES.escalationEverywhereTicks && t % MATCH_RULES.suddenDeathIntervalTicks === 0) {
        hp -= MATCH_RULES.escalationDamage * (1 + Math.floor((t - closeAt) / MATCH_RULES.escalationStepTicks));
      }
      if (shrineCd > 0) shrineCd--;
      else if (hp > 0 && hp < tank) {
        hp = Math.min(tank, hp + Math.round(tank * shrine.amount));
        shrineCd = shrine.cooldownTicks;
      }
    }
    expect(hp).toBeLessThanOrEqual(0);
    expect(t).toBeLessThan(MATCH_RULES.hardCapExtraTicks - 5 * TICK_HZ);
    expect(matchHardCapTicks(5400)).toBe(5400 + MATCH_RULES.hardCapExtraTicks);
  });

  it('a stalemate starts sudden death after 15 s without damage, and the warning looks 3 s ahead', () => {
    expect(MATCH_RULES.stalemateTicks).toBe(15 * TICK_HZ);
    expect(MATCH_RULES.warningTicks).toBe(3 * TICK_HZ);
    expect(MATCH_RULES.hardCapExtraTicks).toBe(60 * TICK_HZ);
  });
});
