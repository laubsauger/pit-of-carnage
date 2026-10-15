// Owned by: ui (dev harness only; never imported by the app)
// Believable strategies for ui-dev.html, written in pit-strategy/2 with sensors from the spec.
import { STRATEGY_SCHEMA } from '../../core';
import type { Behaviour, SkillId, Strategy, WeaponId } from '../../core';

const B: Record<string, Behaviour> = {
  brawl: {
    score: '0.6 + enemies_seen * 0.1',
    move: [
      { seek: 'target', weight: 1 },
      { avoid: 'hazards', weight: 0.8 },
    ],
    attack: 'in_range',
    skill: 'enemies_near >= 2',
  },
  heal: {
    score: '(1 - self.hp) * 1.4 * shrine.ready',
    move: [
      { seek: 'shrine', weight: 1 },
      { flee: 'nearest_enemy', weight: 0.6 },
    ],
    attack: 'never',
  },
  kite: {
    score: '(target.distance < 260) * (1 - target.family_ranged)',
    move: [
      { keep_range: ['target', 220, 320], weight: 1 },
      { avoid: 'walls', weight: 0.5 },
    ],
    attack: 'in_range',
    skill: 'target.distance < 120',
  },
  lurk: {
    score: '0.5 + self.in_shadow * 0.3 - enemies_seen * 0.2',
    move: [
      { prefer: 'shadow', weight: 1 },
      { avoid: 'seen_by(enemies)', weight: 0.8 },
    ],
    attack: 'target.facing_away',
    stance: 'creep',
  },
  backstab: {
    score: 'target.facing_away * 1.2',
    move: [
      { seek: 'behind(target, 40)', weight: 1 },
      { avoid: 'seen_by(target)', weight: 0.6 },
    ],
    attack: 'in_range',
    skill: 'target.distance < 300',
  },
  third_party: {
    score: 'fights_nearby * 0.4',
    move: [
      { seek: 'target', weight: 0.7 },
      { orbit: ['target', 'cw'], weight: 0.4 },
    ],
    attack: 'in_range',
  },
  guard: {
    score: 'target.family_ranged * 0.9',
    move: [
      { seek: 'target', weight: 0.8 },
      { prefer: 'lit', weight: 0.3 },
    ],
    attack: 'in_range',
    stance: 'guard',
  },
};

function strat(
  name: string,
  weapon: WeaponId,
  skill: SkillId,
  [vitality, power, agility, perception, armor, haste]: number[],
  behaviours: string[],
  barks: Strategy['barks'],
  version = 1,
): Strategy {
  return {
    schema: STRATEGY_SCHEMA,
    name,
    version,
    build: { weapon, skill, attributes: { vitality, power, agility, perception, armor, haste } },
    target: '1000 - it.distance + it.fighting * 150 - it.hp * 200',
    behaviours: Object.fromEntries(behaviours.map((b) => [b, B[b]])),
    commit: 30,
    barks,
  };
}

export const FIXTURE_HOUSE: Strategy[] = [
  strat('Apologetic Gary', 'GREATSWORD', 'WHIRLWIND', [20, 20, 16, 14, 16, 14], ['brawl', 'heal', 'third_party'], {
    spawn: 'Excuse me.',
    kill: ['Sorry!', 'So sorry.', 'That was rude of me.'],
  }),
  strat('Brenda From Accounts', 'WARHAMMER', 'SHOCKWAVE', [22, 22, 12, 12, 20, 12], ['brawl', 'guard', 'heal'], {
    spawn: 'Per my last email.',
    kill: 'Filed.',
  }),
  strat('Sister Splinter', 'TWIN_DAGGERS', 'SHADOWSTEP', [12, 18, 24, 20, 8, 18], ['lurk', 'backstab', 'heal'], {
    kill: 'Shh.',
    low_hp: 'This is fine.',
  }),
  strat('Two Axes Tom', 'THROWING_AXES', 'DASH', [16, 18, 20, 18, 12, 16], ['kite', 'brawl', 'heal'], {
    spawn: 'I brought two.',
    kill: 'Fetch.',
  }),
  strat('Nan With A Bow', 'LONGBOW', 'DASH', [14, 16, 18, 26, 8, 18], ['kite', 'lurk', 'heal'], {
    spawn: 'Mind the cat.',
    kill: ['Lovely.', 'Back in my day.'],
  }),
  strat('The Accountant', 'ARCANE_STAFF', 'SHOCKWAVE', [16, 22, 14, 22, 12, 14], ['kite', 'third_party', 'heal'], {
    kill: 'Reconciled.',
  }),
  strat('Wet Kevin', 'TWIN_DAGGERS', 'BLOODRAGE', [18, 20, 22, 12, 10, 18], ['brawl', 'backstab'], {
    spawn: 'Is it raining?',
    death: 'Typical.',
  }),
  strat('Doug', 'WARHAMMER', 'BLOODRAGE', [24, 24, 12, 8, 20, 12], ['brawl', 'third_party'], {
    spawn: 'DOUG.',
    kill: 'DOUG!',
  }),
  strat('Mild Steve', 'GREATSWORD', 'SHOCKWAVE', [22, 16, 14, 16, 20, 12], ['guard', 'brawl', 'heal'], {
    spawn: 'Morning.',
  }),
];

/** Strategies the mock store starts with, oldest first, so versions and "saved ... ago" show up. */
export const FIXTURE_SAVED: { strategy: Strategy; ageMs: number }[] = [
  { strategy: strat('Lurking Daggers', 'TWIN_DAGGERS', 'SHADOWSTEP', [12, 18, 24, 22, 8, 16], ['lurk', 'backstab'], { kill: 'Boo.' }, 1), ageMs: 3 * 86_400_000 },
  { strategy: strat('Lurking Daggers', 'TWIN_DAGGERS', 'SHADOWSTEP', [12, 20, 24, 22, 6, 16], ['lurk', 'backstab', 'heal'], { kill: 'Boo.' }, 2), ageMs: 26 * 3_600_000 },
  { strategy: strat('Lurking Daggers', 'TWIN_DAGGERS', 'SHADOWSTEP', [14, 20, 24, 20, 6, 16], ['lurk', 'backstab', 'heal'], { kill: 'Boo.' }, 3), ageMs: 40 * 60_000 },
  { strategy: strat('Polite Archer', 'LONGBOW', 'DASH', [14, 16, 20, 26, 8, 16], ['kite', 'heal'], { kill: 'Pardon.' }, 1), ageMs: 5 * 3_600_000 },
  { strategy: strat('Keg Enthusiast', 'THROWING_AXES', 'BLOODRAGE', [18, 20, 18, 16, 12, 16], ['third_party', 'kite'], { kill: 'Cheers!' }, 1), ageMs: 12 * 60_000 },
];
