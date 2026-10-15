import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_BUDGET, ATTRIBUTE_MAX, ATTRIBUTE_MIN, TICK_HZ } from './constants';
import {
  ATTRIBUTE_KEYS,
  COMBAT,
  COMBAT_DOCS,
  HAZARD_RULES,
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
  hearingRadius,
  maxHp,
  moveSpeed,
  noiseMultiplier,
  parryChance,
  projectileSpeed,
  projectileTtl,
  resolveDamage,
  skillCooldown,
  skillDamage,
  turnRate,
  visionFov,
  visionRange,
} from './rules';
import type { Attributes } from './types';

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
    for (const key of Object.keys(STAT_DOCS)) expect(key in deriveStats(balanced, 'LONGBOW')).toBe(true);
  });
});
