// Owned by: ui-shell (lineup and Quick matchup)
/**
 * The lineup behind "Next match", "Shuffle field" and Quick matchup, as pure functions: the
 * controller (and the UI's mock of it) fill a lineup's open slots from the house stacks, redraw the
 * unpinned field, and turn a lineup plus rules into the `MatchConfig` that plays.
 *
 * Slot i of a filled lineup is entrant `e<i>` of its config, so the UI can find a fighter's strategy
 * by position. Draws use the match seed, so the same lineup, rules and seed give the same fight.
 */

import { DEFAULT_FIGHTERS, DEFAULT_MAP_ID, DEFAULT_TIME_LIMIT_TICKS, FIGHTER_COLORS, MAX_FIGHTERS, MIN_FIGHTERS, Rng, clamp, strategyKey } from '../core';
import type { Entrant, Lineup, LineupFighter, MatchConfig, MatchRules, Strategy } from '../core';
import { MAPS } from '../sim';

/** The rules a fresh install plays: free-for-all on the default map, sudden death on, no rotation. */
export const DEFAULT_MATCH_RULES: Readonly<MatchRules> = {
  mapId: DEFAULT_MAP_ID,
  format: 'ffa',
  squadSize: 2,
  friendlyFire: true,
  timeLimitTicks: DEFAULT_TIME_LIMIT_TICKS,
  suddenDeath: true,
  rotateMaps: false,
};

/** An empty lineup of the default size: every slot is drawn from the house stacks. */
export function emptyLineup(size = DEFAULT_FIGHTERS): Lineup {
  return { fighters: [], size };
}

/** Fighters that actually play: a duel is always two, everything else 2..MAX_FIGHTERS. */
export function playedSize(lineup: Pick<Lineup, 'size'>, rules: Pick<MatchRules, 'format'>): number {
  if (rules.format === 'duel') return 2;
  return clamp(Math.round(lineup.size), MIN_FIGHTERS, MAX_FIGHTERS);
}

/** Squad size actually used: the requested size, shrunk until there are at least two squads. */
export function squadSizeFor(n: number, rules: Pick<MatchRules, 'format' | 'squadSize'>): number {
  if (rules.format !== 'squads') return 1;
  return clamp(Math.round(rules.squadSize), 1, Math.max(1, Math.floor(n / 2)));
}

/** The map after `mapId` in `MAPS` order (wrapping), for "Next match" with map rotation on. */
export function nextMapId(mapId: string): string {
  const ids = Object.keys(MAPS);
  const at = ids.indexOf(mapId);
  return ids[(at + 1) % ids.length] ?? DEFAULT_MAP_ID;
}

/**
 * A bag of house stacks drawn without replacement (refilled when empty), preferring strategies the
 * lineup does not hold yet, so a default match shows different house stacks next to the player's.
 */
function houseBag(house: readonly Strategy[], taken: readonly LineupFighter[], seed: number, label: string): () => Strategy {
  if (house.length === 0) throw new Error('No house stacks to fill the field with.');
  const used = new Set(taken.map((f) => strategyKey(f.strategy)));
  const fresh = house.filter((s) => !used.has(strategyKey(s)));
  const rng = new Rng(seed >>> 0).fork(label);
  let bag = rng.shuffle([...(fresh.length > 0 ? fresh : house)]);
  return () => {
    if (bag.length === 0) bag = rng.shuffle([...house]);
    return bag.pop() as Strategy;
  };
}

function fieldSlot(strategy: Strategy, seed: number, slot: number): LineupFighter {
  return { key: `field-${(seed >>> 0).toString(36)}-${slot}`, strategy, source: 'house', savedId: null, pinned: false };
}

/**
 * The lineup that plays: the fighters it has (trimmed to the played size), then house stacks in the
 * open slots, drawn with `seed`. Pinned picks and the field already drawn keep their slots.
 */
export function fillLineup(lineup: Lineup, rules: Pick<MatchRules, 'format'>, house: readonly Strategy[], seed: number): Lineup {
  const n = playedSize(lineup, rules);
  const fighters = keepFirst(lineup.fighters, n);
  if (fighters.length < n) {
    const draw = houseBag(house, fighters, seed, 'field');
    for (let i = fighters.length; i < n; i++) fighters.push(fieldSlot(draw(), seed, i));
  }
  return { fighters, size: n };
}

/**
 * "Shuffle field": every unpinned slot gets a fresh house stack drawn with `seed`; pinned fighters
 * keep their slots, and open slots are filled too.
 */
export function shuffleLineup(lineup: Lineup, rules: Pick<MatchRules, 'format'>, house: readonly Strategy[], seed: number): Lineup {
  const n = playedSize(lineup, rules);
  const kept = keepFirst(lineup.fighters, n);
  const draw = houseBag(house, kept.filter((f) => f.pinned), seed, 'shuffle');
  const fighters = kept.map((f, i) => (f.pinned ? f : fieldSlot(draw(), seed, i)));
  for (let i = fighters.length; i < n; i++) fighters.push(fieldSlot(draw(), seed, i));
  return { fighters, size: n };
}

/**
 * At most `n` fighters, pinned picks first in line: when a duel shrinks an eight-fighter lineup, the
 * player's own fighters are the ones that stay. Order among the kept ones is unchanged.
 */
function keepFirst(fighters: readonly LineupFighter[], n: number): LineupFighter[] {
  if (fighters.length <= n) return [...fighters];
  const keep = new Set<LineupFighter>();
  for (const f of fighters) if (f.pinned && keep.size < n) keep.add(f);
  for (const f of fighters) if (!f.pinned && keep.size < n) keep.add(f);
  return fighters.filter((f) => keep.has(f));
}

const ROMAN: readonly [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
function roman(n: number): string {
  let rest = n;
  let out = '';
  for (const [v, g] of ROMAN) {
    while (rest >= v) {
      out += g;
      rest -= v;
    }
  }
  return out;
}

/** Mirror matches get numerals ("Gary", "Gary II"), so the feed never names two fighters the same. */
export function uniqueNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const k = (seen.get(name) ?? 0) + 1;
    seen.set(name, k);
    return k === 1 ? name : `${name} ${roman(k)}`;
  });
}

/**
 * The match a filled lineup plays: entrant `e<i>` is slot i, squads fill consecutive slots and share
 * a colour (who is on whose side comes first in a team fight), everyone else gets their own colour.
 * Throws when the lineup has fewer than two fighters (fill it first).
 */
export function configFromLineup(lineup: Lineup, rules: MatchRules, seed: number): MatchConfig {
  const n = lineup.fighters.length;
  if (n < MIN_FIGHTERS) throw new Error(`A match needs at least ${MIN_FIGHTERS} fighters.`);
  const squadSize = squadSizeFor(n, rules);
  const names = uniqueNames(lineup.fighters.map((f) => f.strategy.name));
  const entrants: Entrant[] = lineup.fighters.map((f, i) => {
    const squad = rules.format === 'squads' ? Math.floor(i / squadSize) : i;
    return { id: `e${i}`, strategy: f.strategy, squad, name: names[i]!, color: FIGHTER_COLORS[squad % FIGHTER_COLORS.length]! };
  });
  return {
    seed: seed >>> 0,
    mapId: Object.hasOwn(MAPS, rules.mapId) ? rules.mapId : DEFAULT_MAP_ID,
    format: rules.format,
    entrants,
    friendlyFire: rules.format === 'squads' ? rules.friendlyFire : true,
    timeLimitTicks: rules.timeLimitTicks,
    suddenDeath: rules.suddenDeath,
  };
}

/** Lineup, rules and seed to the config and the filled lineup that plays it. */
export function planMatch(lineup: Lineup, rules: MatchRules, house: readonly Strategy[], seed: number): { config: MatchConfig; lineup: Lineup } {
  const filled = fillLineup(lineup, rules, house, seed);
  return { config: configFromLineup(filled, rules, seed), lineup: filled };
}
