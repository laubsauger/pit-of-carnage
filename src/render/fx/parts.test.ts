import { describe, expect, it } from 'vitest';
import { WEAPON_IDS } from '../../core';
import { ATLAS, GIB_KINDS, PARTS, PART_IDS, deathGibs, partCell } from './parts';
import type { GibKind } from './parts';

describe('part catalogue', () => {
  it('has 10 distinct gib types plus limbs, a helmet and a weapon for every class', () => {
    expect(new Set(GIB_KINDS).size).toBe(10);
    for (const g of GIB_KINDS) expect(PARTS[g]).toBeDefined();
    expect(PARTS.limbArm.tinted).toBe(true);
    expect(PARTS.limbLeg.tinted).toBe(true);
    for (const w of WEAPON_IDS) {
      expect(PARTS[`helmet_${w}`].rolls).toBe(true);
      expect(PARTS[`weapon_${w}`].wet).toBe(0);
    }
  });

  // The shader finds a part by its cell index: two parts sharing a cell would draw the wrong art.
  it('gives every part its own atlas cell inside the atlas', () => {
    const cells = PART_IDS.map(partCell);
    expect(new Set(cells).size).toBe(PART_IDS.length);
    expect(Math.max(...cells)).toBeLessThan(ATLAS.cols * ATLAS.rows);
  });

  it('only lets body parts bleed', () => {
    for (const id of PART_IDS) {
      if (id.startsWith('helmet_') || id.startsWith('weapon_')) expect(PARTS[id].wet).toBe(0);
      else expect(PARTS[id].wet).toBeGreaterThan(0);
    }
  });

  // Gibs bleed where they land, above all intestines; gear never oozes.
  it('lets wet body parts ooze a pool when they land, guts the most', () => {
    let biggest = PART_IDS[0];
    for (const id of PART_IDS) {
      if (PARTS[id].ooze > PARTS[biggest].ooze) biggest = id;
      if (PARTS[id].wet === 0) expect(PARTS[id].ooze).toBe(0);
    }
    expect(biggest).toBe('intestine');
    for (const g of ['heart', 'brain', 'limbArm', 'limbLeg'] as const) expect(PARTS[g].ooze).toBeGreaterThan(0);
  });
});

describe('death throw', () => {
  const out: GibKind[] = [];
  const counts = (xs: GibKind[]) => xs.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});

  it('throws 8-10 gibs including the crowd-pleasers', () => {
    for (const n of [8, 9, 10]) {
      deathGibs(out, n, true, Math.random);
      expect(out.length).toBe(n);
      for (const must of ['skull', 'ribcage', 'heart', 'intestine', 'eyeball'] as const) expect(out).toContain(must);
    }
  });

  it('never throws more than two eyeballs or a duplicate of anything else', () => {
    for (let i = 0; i < 50; i++) {
      const c = counts(deathGibs(out, 10, true, Math.random));
      for (const [k, v] of Object.entries(c)) expect(v).toBeLessThanOrEqual(k === 'eyeball' ? 2 : 1);
    }
  });

  // A fighter who already lost the weapon arm cannot lose it again.
  it('only includes the weapon arm when the fighter still had it', () => {
    for (let i = 0; i < 30; i++) expect(deathGibs(out, 10, false, Math.random)).not.toContain('weaponArm');
    expect(deathGibs(out, 10, true, () => 0)).toHaveLength(10);
  });
});
