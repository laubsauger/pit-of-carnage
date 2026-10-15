/**
 * The starter library: behaviours written in the strategy language itself, importable by name
 * (`"imports": ["lurk", "heal"]`). They double as the rulebook's worked examples, so each one is
 * small, generic across weapons where it can be, and documented.
 *
 * Score scale used throughout: about 0..1, with COMMIT_BONUS (0.25) as the margin a challenger
 * needs to interrupt a committed behaviour.
 */

import type { Behaviour, Strategy } from '../core';

export const STARTER_LIBRARY: Record<string, Behaviour> = {
  prowl: {
    score: '0.7 * (enemies_known == 0)',
    move: [
      { keep_range: ['centre', 140, 260], weight: 1 },
      { orbit: ['centre', 'cw'], weight: 0.6 },
      { avoid: 'hazards', weight: 0.8 },
    ],
    attack: 'if_blocked',
  },
  brawl: {
    score: '(enemies_known > 0) * (0.45 + 0.2 * target.in_reach)',
    move: [
      { seek: 'target', weight: 1 },
      { avoid: 'hazards', weight: 0.8 },
    ],
    attack: 'in_range',
    skill: 'target.distance < 90 or enemies_near >= 2',
  },
  kite: {
    score: 'self.ranged * (self.ammo > 0) * (enemies_known > 0) * 0.65',
    move: [
      { keep_range: ['target', 180, 250], weight: 1.2 },
      { orbit: ['target', 'ccw'], weight: 0.45 },
      { avoid: 'walls', weight: 0.35 },
      { avoid: 'hazards', weight: 0.8 },
    ],
    attack: 'in_range',
    skill: 'target.distance < 110',
  },
  restock: {
    score: 'self.ranged * (ammo.distance < 9999) * (0.85 * (self.ammo == 0) + 0.3 * (self.ammo <= 1) * (ammo.distance < 160))',
    move: [
      { seek: 'ammo', weight: 1.2 },
      { flee: 'nearest_enemy', weight: 0.35 },
      { avoid: 'hazards', weight: 0.8 },
    ],
    attack: 'if_blocked',
  },
  heal: {
    score: 'shrine.ready * (self.hp < 0.55) * (shrine.distance < 700) * (1.2 - self.hp)',
    move: [
      { seek: 'shrine', weight: 1.2 },
      { avoid: 'seen_by(enemies)', weight: 0.3 },
      { avoid: 'hazards', weight: 0.8 },
    ],
    attack: 'if_blocked',
  },
  retreat: {
    score: '(self.hp < 0.3) * (since_hit < 180) * 0.8',
    move: [
      { seek: 'cover_from(enemies)', weight: 1 },
      { flee: 'nearest_enemy', weight: 0.7 },
      { avoid: 'seen_by(enemies)', weight: 0.5 },
      { avoid: 'hazards', weight: 0.8 },
    ],
    attack: 'if_blocked',
    skill: 'enemies_near >= 1',
  },
  lurk: {
    score: '(enemies_known > 0) * (0.35 + 0.25 * (not self.seen) - 0.3 * target.facing_away * (target.distance < 200))',
    move: [
      { prefer: 'shadow', weight: 1 },
      { seek: 'dark_spot', weight: 0.5 },
      { seek: 'target', weight: 0.35 },
      { avoid: 'seen_by(enemies)', weight: 0.9 },
      { avoid: 'hazards', weight: 0.8 },
    ],
    attack: 'in_range',
    stance: 'creep',
  },
  backstab: {
    score: '(enemies_known > 0) * (0.3 + 0.35 * target.facing_away + 0.2 * target.fighting + 0.15 * (target.distance < 150))',
    move: [
      { seek: 'behind(target, 36)', weight: 1.2 },
      { avoid: 'seen_by(target)', weight: 0.4 },
      { avoid: 'hazards', weight: 0.8 },
    ],
    attack: 'in_range',
    skill: 'target.distance < 200 and not target.facing_away',
  },
  bait: {
    score: '(target.hazard_distance < 220) * (target.distance < 320) * target.sees_me * (not target.ranged) * 0.7',
    move: [
      { seek: 'beyond(hazard_near(target), target, 85)', weight: 1.2 },
      { avoid: 'hazards', weight: 1 },
    ],
    attack: 'in_range',
  },
  guard_corner: {
    score: '(enemies_known > 0) * (0.3 + 0.25 * (enemies_near >= 2)) * (1 - sudden_death)',
    move: [
      { seek: 'corner', weight: 1.2 },
      { avoid: 'hazards', weight: 0.8 },
    ],
    attack: 'in_range',
    skill: 'enemies_near >= 2 or target.in_reach',
    stance: 'guard',
  },
  third_party: {
    score: '(fights_nearby >= 1) * (0.55 - 0.4 * (target.hp < 0.35))',
    move: [
      { keep_range: ['nearest_fight', 150, 230], weight: 1 },
      { orbit: ['nearest_fight', 'cw'], weight: 0.2 },
      { avoid: 'seen_by(enemies)', weight: 0.6 },
      { avoid: 'hazards', weight: 0.8 },
    ],
    attack: 'if_blocked',
  },
  search: {
    score: '(enemies_known > 0) * (not target.visible) * 0.5',
    move: [
      { seek: 'search_point', weight: 1.1 },
      { avoid: 'hazards', weight: 0.8 },
    ],
    attack: 'in_range',
  },
  grab_powerup: {
    score: 'pickup.any.ready * (pickup.any.distance < 500) * (0.75 - 0.0008 * min(500, pickup.any.distance))',
    move: [
      { seek: 'nearest_pickup', weight: 1.2 },
      { avoid: 'hazards', weight: 0.8 },
    ],
    attack: 'if_blocked',
  },
  deny_powerup: {
    score: '(pickup.respawn_in > 0) * (pickup.respawn_in < 4) * (pickup.any.distance < 450) * 0.55',
    move: [
      { seek: 'nearest_pickup', weight: 1 },
      { avoid: 'hazards', weight: 0.8 },
    ],
    attack: 'in_range',
  },
  escape_zone: {
    score: '0.95 * (zone.time_to_reach < 3) + 0.3 * (zone.time_to_reach < 8)',
    move: [
      { seek: 'zone_centre', weight: 1.2 },
      { avoid: 'outside_zone', weight: 1 },
      { avoid: 'hazards', weight: 0.6 },
    ],
    attack: 'in_range',
  },
};

/** One line per starter behaviour: what it is for (rulebook, editor). */
export const STARTER_DOCS: Readonly<Record<string, string>> = {
  prowl: 'Nobody known: patrol a ring 140-260 px around the centre until someone shows up.',
  brawl: 'Walk straight at the target and hit it. Uses the skill up close or when crowded.',
  kite: 'Ranged with ammo: hold the target at 180-250 px and circle it while shooting. Melee builds score 0.',
  restock: 'Ranged and out of arrows or axes: go pick them up while keeping away from the nearest enemy.',
  heal: 'Below 55% HP with a ready shrine within 700 px: go and use it. Stronger the more hurt you are.',
  retreat: 'Below 30% HP and hit in the last 3 s: break line of sight behind cover and get away.',
  lurk: 'Ambush: get into the dark and creep toward the target unseen. Gives way when the target turns its back up close.',
  backstab: 'Circle round to the target\'s back (behind() swings you around it) and stab. Strongest once you are behind it.',
  bait: 'A melee target is looking at you near a trap: stand across the trap from it, so it walks through the trap to reach you.',
  guard_corner: 'Back into the nearest corner in guard stance and hold it: only the open side can reach you. Off in sudden death.',
  third_party: 'Hover 150-230 px from someone else\'s fight, unseen if possible. Gives way when the target drops below 35% HP.',
  search: 'Lost sight of the target: go to where it was last seen, then sweep outward around it (search_point). Melee still swings at one it can hear in reach.',
  grab_powerup: 'A power-up is on its pedestal within 500 px: go and take it. Stronger the closer it is (0.75 next to it, 0.35 at 500 px).',
  deny_powerup: 'A power-up comes back within 4 s and its pedestal is within 450 px: stand on the pedestal so you take it the moment it appears, and hit whoever else turns up.',
  escape_zone: 'Sudden death: the wall reaches you within 8 s (stronger within 3 s, or when you are already outside): head for the centre of the last safe square, fighting on the way.',
};

export const STARTER_NAMES: readonly string[] = Object.keys(STARTER_LIBRARY);

/**
 * The behaviours a strategy runs, in priority order for ties: its own (in the order written),
 * then imported starter behaviours it did not override (in import order). Unknown imports are
 * skipped here; the validator reports them.
 */
export function mergeBehaviours(s: Pick<Strategy, 'behaviours' | 'imports'>): [string, Behaviour][] {
  const out: [string, Behaviour][] = Object.entries(s.behaviours ?? {});
  const own = s.behaviours ?? {};
  for (const name of s.imports ?? []) {
    if (Object.hasOwn(own, name) || !Object.hasOwn(STARTER_LIBRARY, name)) continue;
    if (out.some(([n]) => n === name)) continue;
    out.push([name, STARTER_LIBRARY[name]!]);
  }
  return out;
}
