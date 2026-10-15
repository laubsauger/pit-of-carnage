import { describe, expect, it } from 'vitest';
import { WEAPONS as RULES } from '../../core';
import { IMPACT, KEG_FX, PROJECTILE_FX, impactSize, isProjectileWeapon, projectileColor, spellColor } from './impacts';
import type { ProjectileWeapon } from './impacts';
import type { Rgb } from './palette';

const WEAPONS: readonly ProjectileWeapon[] = ['LONGBOW', 'THROWING_AXES', 'ARCANE_STAFF'];

/** sRGB 0..1 channels of a hex colour. */
function srgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Chroma of a linear colour, measured in gamma space (what the eye sees). */
function chroma(c: Rgb): number {
  const g = [c.r, c.g, c.b].map((v) => Math.pow(v, 1 / 2.2));
  return Math.max(...g) - Math.min(...g);
}

describe('projectile colour code', () => {
  // The user's complaint: every impact was the same grey puff. Each projectile type (and the keg)
  // needs its own impact effect so a hit reads at a glance.
  it('gives every projectile type and the keg its own impact effect', () => {
    const styles = [...WEAPONS.map((w) => PROJECTILE_FX[w].impact), KEG_FX.impact];
    expect(new Set(styles).size).toBe(styles.length);
  });

  it('gives every type its own colour, and none of them is grey', () => {
    const hexes = [...WEAPONS.map((w) => PROJECTILE_FX[w].color), KEG_FX.color];
    expect(new Set(hexes).size).toBe(hexes.length);
    for (const h of hexes) {
      const [r, g, b] = srgb(h);
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(0.25);
    }
  });

  it('knows which weapons fire projectiles', () => {
    for (const w of WEAPONS) expect(isProjectileWeapon(w)).toBe(true);
    for (const w of ['GREATSWORD', 'WARHAMMER', 'TWIN_DAGGERS', null, undefined] as const) expect(isProjectileWeapon(w)).toBe(false);
  });
});

describe('spell colours', () => {
  const out: Rgb = { r: 0, g: 0, b: 0 };

  // Staff orbs all shared one colour; each caster's spells must be their own.
  it('gives casters with different colours different spell colours', () => {
    const fighters = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#46f0f0'];
    const spells = fighters.map((h) => {
      const c = spellColor(out, h);
      return `${c.r.toFixed(3)},${c.g.toFixed(3)},${c.b.toFixed(3)}`;
    });
    expect(new Set(spells).size).toBe(fighters.length);
  });

  it('keeps the fighter hue and makes it a saturated, glowing colour (never grey)', () => {
    for (const [hex, channel] of [['#c03030', 'r'], ['#2a8a2a', 'g'], ['#3048b0', 'b']] as const) {
      const c = spellColor(out, hex);
      const max = Math.max(c.r, c.g, c.b);
      expect(c[channel]).toBe(max);
      expect(chroma(c)).toBeGreaterThan(0.4);
      expect(max).toBeGreaterThan(0.9);
    }
  });

  it('falls back to the default arcane colour for a colourless or invalid fighter colour', () => {
    const fallback = { ...projectileColor(out, 'ARCANE_STAFF', null) };
    expect({ ...spellColor(out, '#808080') }).toEqual(fallback);
    expect({ ...spellColor(out, 'nope') }).toEqual(fallback);
  });

  it('uses the caster colour only for staff orbs', () => {
    const arrow = { ...projectileColor(out, 'LONGBOW', null) };
    expect({ ...projectileColor(out, 'LONGBOW', '#3048b0') }).toEqual(arrow);
    expect({ ...projectileColor(out, 'ARCANE_STAFF', '#3048b0') }).toEqual({ ...spellColor({ r: 0, g: 0, b: 0 }, '#3048b0') });
  });
});

describe('impact size', () => {
  // Impacts were sized by weapon type: a staff orb looked like fireworks while a sword hit for the
  // same damage looked modest. Size now follows what happened, the same for every weapon.
  it("gives every weapon's ordinary hit a similar, modest impact sized by its damage", () => {
    const sizes = Object.values(RULES).map((w) => impactSize(w.damage, false, false));
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeLessThan(2.2);
    for (const s of sizes) expect(s).toBeLessThanOrEqual(IMPACT.max);
    let last = 0;
    for (let dmg = 0; dmg <= 80; dmg += 2) {
      const s = impactSize(dmg, false, false);
      expect(s).toBeGreaterThanOrEqual(last);
      expect(s).toBeGreaterThanOrEqual(IMPACT.min);
      last = s;
    }
  });

  // The big moments are crits and backstabs: even a weak crit outsizes the hardest ordinary hit.
  it('reserves the biggest impacts for crits and backstabs', () => {
    const hardest = impactSize(999, false, false);
    expect(impactSize(8, true, false)).toBeGreaterThan(hardest);
    expect(impactSize(8, false, true)).toBeGreaterThan(hardest);
    expect(impactSize(30, true, false)).toBeGreaterThan(impactSize(30, false, false));
  });

  // "Spells keep their colour identity, not extra size."
  it("keeps a staff orb's own impact no bigger than an arrow's or an axe's", () => {
    const others = [PROJECTILE_FX.LONGBOW, PROJECTILE_FX.THROWING_AXES];
    expect(PROJECTILE_FX.ARCANE_STAFF.flash).toBeLessThanOrEqual(Math.max(...others.map((f) => f.flash)));
    expect(PROJECTILE_FX.ARCANE_STAFF.particles).toBeLessThanOrEqual(Math.max(...others.map((f) => f.particles)));
  });
});
