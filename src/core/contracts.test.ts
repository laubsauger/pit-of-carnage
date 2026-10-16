// Pass 3 contracts: the shared tables and helpers several modules now read instead of keeping their
// own copies (muzzles, hazard reach), the rating display, lineups, and the rules that ship off.
import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_LIMIT_TICKS } from './constants';
import { lineupFromConfig, rulesFromConfig } from './controller';
import { DEFAULT_VIEW_SETTINGS } from './render-api';
import { RATING_PROVISIONAL_SIGMA, displayRating, makeRating, ratingDisplay } from './report-types';
import {
  BLEED_RULES,
  BLEED_RULES_DOCS,
  HAZARD_RULES,
  MUZZLES,
  RIG_NOMINAL_RADIUS,
  STUCK_AMMO,
  STUCK_AMMO_DOCS,
  WEAPONS,
  WEAPON_IDS,
  hazardReach,
  muzzlePoint,
  muzzleSide,
} from './rules';
import type { FighterState, MatchConfig, Strategy } from './types';

type Shooter = Parameters<typeof muzzlePoint>[0];

function shooter(over: Partial<Shooter> = {}): Shooter {
  const limbs: FighterState['limbs'] = { armL: true, armR: true, legL: true, legR: true };
  return { pos: { x: 100, y: 200 }, facing: 0, radius: RIG_NOMINAL_RADIUS, weapon: 'ARCANE_STAFF', ammo: 4, limbs, ...over };
}

describe('muzzles (one table for the sim and the rig)', () => {
  // Spec: every projectile leaves its weapon's muzzle. Melee weapons never fire, but `muzzlePoint`
  // must still be safe to call for them (a punching archer's weapon id can be anything).
  it('has an entry for every weapon, and only ranged weapons sit off the body centre', () => {
    for (const id of WEAPON_IDS) {
      const m = MUZZLES[id];
      expect(m, id).toBeDefined();
      expect(m.u !== 0 || m.v !== 0, id).toBe(WEAPONS[id].family === 'ranged');
    }
  });

  // The staff tip reaches about 70 px ahead (SPEC "Projectiles"): an enemy inside that reach is hit
  // by the orb. If the rig and this table drift apart, orbs appear in mid-air or inside the body.
  it('puts the staff tip far ahead in the right hand and turns with the body', () => {
    const east = muzzlePoint(shooter(), { x: 0, y: 0 });
    expect(east.x - 100).toBeCloseTo(MUZZLES.ARCANE_STAFF.u);
    // Right hand of a fighter facing east (+x) is toward +y (south): angles turn clockwise on screen.
    expect(east.y - 200).toBeCloseTo(MUZZLES.ARCANE_STAFF.v);
    const south = muzzlePoint(shooter({ facing: Math.PI / 2 }), { x: 0, y: 0 });
    expect(south.y - 200).toBeCloseTo(MUZZLES.ARCANE_STAFF.u);
    expect(south.x - 100).toBeCloseTo(-MUZZLES.ARCANE_STAFF.v);
  });

  // The rig scales by radius / RIG_NOMINAL_RADIUS, so the muzzle must too, or a big fighter would
  // shoot from inside its own body.
  it('scales with the body like the drawn rig', () => {
    const big = muzzlePoint(shooter({ radius: RIG_NOMINAL_RADIUS * 1.5 }), { x: 0, y: 0 });
    expect(big.x - 100).toBeCloseTo(MUZZLES.ARCANE_STAFF.u * 1.5);
  });

  // The renderer draws the throw from the hand the sim throws from; both ask `muzzleSide`.
  it('alternates axe throws between hands while both arms are there, right hand otherwise', () => {
    expect(muzzleSide('THROWING_AXES', 3, true)).toBe(1);
    expect(muzzleSide('THROWING_AXES', 4, true)).toBe(-1);
    expect(muzzleSide('THROWING_AXES', 4, false)).toBe(1);
    expect(muzzleSide('LONGBOW', 4, true)).toBe(1);
    const left = muzzlePoint(shooter({ weapon: 'THROWING_AXES', ammo: 4 }), { x: 0, y: 0 });
    expect(left.y - 200).toBeCloseTo(-MUZZLES.THROWING_AXES.v);
  });
});

describe('hazard reach (one value for the sim and the renderer)', () => {
  // The renderer's "standing in acid" look must match where the sim's acid hurts and slows.
  it('reaches a share of the body radius past the pool edge, the map radius first', () => {
    expect(hazardReach({ kind: 'acid', radius: 0 }, 20)).toBeCloseTo(HAZARD_RULES.acid.radius + 20 * HAZARD_RULES.acid.bodyShare);
    expect(hazardReach({ kind: 'acid', radius: 50 }, 20)).toBeCloseTo(50 + 20 * HAZARD_RULES.acid.bodyShare);
  });

  // A pool needs you standing in it; a saw only has to graze you.
  it('needs more of the body inside a pool than a saw', () => {
    expect(HAZARD_RULES.saw.bodyShare).toBeGreaterThan(HAZARD_RULES.acid.bodyShare);
    for (const h of Object.values(HAZARD_RULES)) expect(h.bodyShare).toBeGreaterThanOrEqual(0);
  });
});

describe('ratings for display', () => {
  // SPEC "Showing a rating": "1240 ±85" with a "new" marker, never a bare "?". The flag must come
  // with the rating so every screen marks the same ratings.
  it('marks a fresh rating provisional and shows its uncertainty in display points', () => {
    const fresh = makeRating(25, 25 / 3);
    expect(fresh.ordinal).toBeCloseTo(0);
    expect(fresh.provisional).toBe(true);
    expect(ratingDisplay(fresh)).toEqual({ value: 1000, plusMinus: Math.round((25 / 3) * 40), provisional: true });
  });

  it('settles once sigma drops to the provisional threshold, and the ± shrinks with it', () => {
    const settled = makeRating(30, RATING_PROVISIONAL_SIGMA);
    expect(settled.provisional).toBe(false);
    const d = ratingDisplay(settled);
    expect(d.value).toBe(displayRating(settled));
    expect(d.plusMinus).toBeLessThan(ratingDisplay(makeRating(30, 8)).plusMinus);
  });
});

describe('lineups', () => {
  const strat = (name: string): Strategy => ({ name } as Strategy);
  const config = (format: MatchConfig['format'], squads: number[]): MatchConfig => ({
    seed: 7, mapId: 'pit', format, friendlyFire: false, timeLimitTicks: DEFAULT_TIME_LIMIT_TICKS, suddenDeath: true,
    entrants: squads.map((squad, i) => ({ id: `e${i}`, strategy: strat(`S${i}`), squad, name: `S${i}`, color: '#fff' })),
  });

  // SPEC "Next match keeps the lineup": the lineup is whatever the last match used, so a fighter
  // brought in from the gym or the editor must not drop out when nothing better is known.
  it('keeps every entrant of a match, in slot order, pinned', () => {
    const l = lineupFromConfig(config('ffa', [0, 1, 2]));
    expect(l.size).toBe(3);
    expect(l.fighters.map((f) => f.strategy.name)).toEqual(['S0', 'S1', 'S2']);
    expect(l.fighters.every((f) => f.pinned && f.source === 'match')).toBe(true);
  });

  it('reads the squad size and rules back off a config', () => {
    const r = rulesFromConfig(config('squads', [0, 0, 0, 1, 1, 1]));
    expect(r).toMatchObject({ mapId: 'pit', format: 'squads', squadSize: 3, friendlyFire: false, suddenDeath: true, rotateMaps: false });
    expect(rulesFromConfig(config('ffa', [0, 1])).squadSize).toBe(1);
  });
});

describe('rules that ship as placeholders', () => {
  // Bleed is a candidate (SPEC "Core balance and expressiveness pass"): until the harness says it
  // adds variety, it must do nothing at all, so a sim that reads these numbers cannot bleed anyone.
  it('keeps bleed disabled with zero damage and duration', () => {
    expect(BLEED_RULES.enabled).toBe(false);
    expect(BLEED_RULES.limbLossDamage + BLEED_RULES.backstabDamage).toBe(0);
    expect(BLEED_RULES.limbLossTicks + BLEED_RULES.backstabTicks + BLEED_RULES.maxTicks).toBe(0);
  });

  // The rulebook and the Codex print these docs; every number needs one.
  it('documents every stuck-ammo and bleed rule', () => {
    expect(Object.keys(STUCK_AMMO_DOCS).sort()).toEqual(Object.keys(STUCK_AMMO).sort());
    expect(Object.keys(BLEED_RULES_DOCS).sort()).toEqual(Object.keys(BLEED_RULES).sort());
    for (const doc of [...Object.values(STUCK_AMMO_DOCS), ...Object.values(BLEED_RULES_DOCS)]) expect(doc.length).toBeGreaterThan(10);
  });

  it('gives stuck ammo sane bounds (chances are probabilities, caps are positive)', () => {
    for (const k of ['wallStickChance', 'propStickChance', 'bodyStickChance', 'floorStickChance'] as const) {
      expect(STUCK_AMMO[k]).toBeGreaterThanOrEqual(0);
      expect(STUCK_AMMO[k]).toBeLessThanOrEqual(1);
    }
    expect(STUCK_AMMO.maxPerBody).toBeGreaterThan(0);
    expect(STUCK_AMMO.maxStuck).toBeGreaterThanOrEqual(STUCK_AMMO.maxPerBody);
  });
});

describe('view settings', () => {
  // The cinematic view hides the HUD; a fresh viewer must see the HUD.
  it('starts with the HUD showing', () => {
    expect(DEFAULT_VIEW_SETTINGS.cinematic).toBe(false);
  });
});
