// Owned by: ui
// Quick matchup's model: editing a lineup (add, remove, pin, size), the lineup a gym or editor
// Watch brings in, and the matchup kept in localStorage between visits. Pure, so the dialog and the
// tests read the same rules.
import { DEFAULT_FIGHTERS, DEFAULT_MAP_ID, DEFAULT_TIME_LIMIT_TICKS, MAX_FIGHTERS, MIN_FIGHTERS, TICK_HZ, clamp, strategyKey } from '../core';
import type { Lineup, LineupFighter, LineupSource, MatchConfig, MatchFormat, MatchRules, Strategy } from '../core';
import { MAPS } from '../sim';
import { loadStrategy } from '../strategy';

export const DEFAULT_RULES: Readonly<MatchRules> = {
  mapId: DEFAULT_MAP_ID,
  format: 'ffa',
  squadSize: 2,
  friendlyFire: true,
  timeLimitTicks: DEFAULT_TIME_LIMIT_TICKS,
  suddenDeath: true,
  rotateMaps: false,
};

/** Time limits offered next to the lineup (seconds before sudden death). */
export const TIME_LIMITS_S: readonly number[] = [45, 60, 90, 120, 180];

/** The badge on a lineup row: where the fighter came from. */
export const SOURCE_LABEL: Readonly<Record<LineupSource, string>> = {
  house: 'House',
  library: 'Library',
  file: 'File',
  paste: 'Pasted',
  code: 'Code',
  editor: 'Editor',
  gym: 'Gym',
  room: 'Room',
  match: 'Last match',
};

/** Fighters the match will have: a duel is two, everything else 2..16. */
export function lineupSize(lineup: Pick<Lineup, 'size'>, format: MatchFormat): number {
  return format === 'duel' ? 2 : clamp(Math.round(lineup.size), MIN_FIGHTERS, MAX_FIGHTERS);
}

/**
 * The fighters that will play, in slot order: when the lineup holds more than the format takes (a
 * duel), the player's picks go first, as the controller fills it.
 */
export function playingFighters(lineup: Lineup, format: MatchFormat): LineupFighter[] {
  const n = lineupSize(lineup, format);
  if (lineup.fighters.length <= n) return [...lineup.fighters];
  const keep = new Set<LineupFighter>();
  for (const f of lineup.fighters) if (f.pinned && keep.size < n) keep.add(f);
  for (const f of lineup.fighters) if (!f.pinned && keep.size < n) keep.add(f);
  return lineup.fighters.filter((f) => keep.has(f));
}

export function pinnedCount(lineup: Lineup): number {
  return lineup.fighters.reduce((n, f) => n + (f.pinned ? 1 : 0), 0);
}

/** A key no other slot of `lineup` uses. */
export function freshKey(lineup: Lineup, prefix = 'pick'): string {
  const used = new Set(lineup.fighters.map((f) => f.key));
  for (let i = lineup.fighters.length; ; i++) if (!used.has(`${prefix}-${i}`)) return `${prefix}-${i}`;
}

/**
 * Add the player's pick, pinned. It takes an open slot when there is one, else the last field slot
 * (house stacks make room for the player's fighters), else the lineup grows by one. Null when all
 * sixteen slots are the player's own already.
 */
export function addFighter(lineup: Lineup, strategy: Strategy, source: LineupSource, savedId: string | null = null): Lineup | null {
  const pick: LineupFighter = { key: freshKey(lineup), strategy, source, savedId, pinned: true };
  const size = clamp(Math.round(lineup.size), MIN_FIGHTERS, MAX_FIGHTERS);
  if (lineup.fighters.length < size) return { fighters: [...lineup.fighters, pick], size };
  for (let i = lineup.fighters.length - 1; i >= 0; i--) {
    if (!lineup.fighters[i]!.pinned) {
      // The pick goes after the other picks, ahead of the remaining field.
      const rest = lineup.fighters.filter((_, j) => j !== i);
      const at = rest.findIndex((f) => !f.pinned);
      const fighters = at < 0 ? [...rest, pick] : [...rest.slice(0, at), pick, ...rest.slice(at)];
      return { fighters, size };
    }
  }
  if (size >= MAX_FIGHTERS) return null;
  return { fighters: [...lineup.fighters, pick], size: size + 1 };
}

/** Remove one slot; the size stays, so the house stacks fill the gap. */
export function removeFighter(lineup: Lineup, key: string): Lineup {
  return { ...lineup, fighters: lineup.fighters.filter((f) => f.key !== key) };
}

/** Pin a field fighter (keep it for every next match) or let a pick go back to being field. */
export function togglePin(lineup: Lineup, key: string): Lineup {
  return { ...lineup, fighters: lineup.fighters.map((f) => (f.key === key ? { ...f, pinned: !f.pinned } : f)) };
}

/** Drop the drawn field: the open slots are drawn fresh at Fight. */
export function clearField(lineup: Lineup): Lineup {
  return { ...lineup, fighters: lineup.fighters.filter((f) => f.pinned) };
}

/**
 * Change the fighter count. Shrinking drops field slots from the end first and never drops a pick
 * (the count stops at the number of picks); remove a pick to go lower.
 */
export function resizeLineup(lineup: Lineup, size: number): Lineup {
  const pins = pinnedCount(lineup);
  const n = clamp(Math.round(size), Math.max(MIN_FIGHTERS, pins), MAX_FIGHTERS);
  const fighters = [...lineup.fighters];
  for (let i = fighters.length - 1; fighters.length > n && i >= 0; i--) if (!fighters[i]!.pinned) fighters.splice(i, 1);
  return { fighters, size: n };
}

/** "2 of yours, 6 from the house" for the end card and the setup panel. */
export function lineupSummary(lineup: Lineup, format: MatchFormat): string {
  const n = lineupSize(lineup, format);
  const yours = Math.min(n, pinnedCount(lineup));
  const field = n - yours;
  if (yours === 0) return `${n} house stacks`;
  const y = `${yours} of yours`;
  return field === 0 ? `${y}, no house stacks` : `${y}, ${field} from the house`;
}

/**
 * The lineup a match opened from the Gym or the editor brings in, in entrant order (slot i is
 * entrant i): the strategies under test (`pinKeys`, by `strategyKey`) pinned with `source`, everyone
 * else as field. Field fighters that are house stacks say so; the rest came with the gym's field.
 */
export function lineupForWatch(config: MatchConfig, pinKeys: ReadonlySet<string>, source: LineupSource, house: readonly Strategy[]): Lineup {
  const houseKeys = new Set(house.map(strategyKey));
  return {
    fighters: config.entrants.map((e) => {
      const key = strategyKey(e.strategy);
      const pinned = pinKeys.has(key);
      return { key: e.id, strategy: e.strategy, source: pinned ? source : houseKeys.has(key) ? 'house' : 'gym', savedId: null, pinned };
    }),
    size: config.entrants.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Kept between visits
// ---------------------------------------------------------------------------------------------

/** What Quick matchup keeps in localStorage: the rules, the size and the player's own picks. */
export type StoredMatchup = { rules: MatchRules; size: number; picks: { strategy: Strategy; source: LineupSource; savedId: string | null }[] };

export const MATCHUP_STORAGE_KEY = 'poc.matchup.v1';

export function defaultMatchup(): StoredMatchup {
  return { rules: { ...DEFAULT_RULES }, size: DEFAULT_FIGHTERS, picks: [] };
}

/** The part worth keeping: only pinned picks (the field is drawn again anyway). */
export function storeMatchup(lineup: Lineup, rules: MatchRules): StoredMatchup {
  return {
    rules: { ...rules },
    size: lineup.size,
    picks: lineup.fighters.filter((f) => f.pinned).map((f) => ({ strategy: f.strategy, source: f.source, savedId: f.savedId })),
  };
}

export function lineupOfStored(m: StoredMatchup): Lineup {
  return { fighters: m.picks.map((p, i) => ({ key: `pick-${i}`, strategy: p.strategy, source: p.source, savedId: p.savedId, pinned: true })), size: m.size };
}

const SOURCES = new Set<string>(Object.keys(SOURCE_LABEL));

export function sanitizeRules(value: unknown, fallback: MatchRules): MatchRules {
  if (typeof value !== 'object' || value === null) return fallback;
  const v = value as Partial<MatchRules>;
  const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  const bool = (x: unknown, d: boolean) => (typeof x === 'boolean' ? x : d);
  return {
    // A map from an older build would make every Fight fail; fall back instead.
    mapId: typeof v.mapId === 'string' && Object.hasOwn(MAPS, v.mapId) ? v.mapId : fallback.mapId,
    format: v.format === 'ffa' || v.format === 'squads' || v.format === 'duel' ? v.format : fallback.format,
    squadSize: clamp(Math.round(num(v.squadSize, fallback.squadSize)), 2, MAX_FIGHTERS / 2),
    friendlyFire: bool(v.friendlyFire, fallback.friendlyFire),
    timeLimitTicks: clamp(Math.round(num(v.timeLimitTicks, fallback.timeLimitTicks)), 15 * TICK_HZ, 600 * TICK_HZ),
    suddenDeath: bool(v.suddenDeath, fallback.suddenDeath),
    rotateMaps: bool(v.rotateMaps, fallback.rotateMaps),
  };
}

/**
 * Read the stored matchup back. Every pick goes through the gate again (a stored strategy is never
 * trusted), and anything malformed falls back field by field, so an old value cannot break setup.
 */
export function sanitizeMatchup(value: unknown, fallback: StoredMatchup): StoredMatchup {
  if (typeof value !== 'object' || value === null) return fallback;
  const v = value as Partial<StoredMatchup>;
  const picks: StoredMatchup['picks'] = [];
  for (const p of Array.isArray(v.picks) ? v.picks : []) {
    if (typeof p !== 'object' || p === null || picks.length >= MAX_FIGHTERS) continue;
    const r = loadStrategy((p as { strategy?: unknown }).strategy, 'config');
    if (!r.strategy) continue;
    const source = (p as { source?: unknown }).source;
    const savedId = (p as { savedId?: unknown }).savedId;
    picks.push({ strategy: r.strategy, source: typeof source === 'string' && SOURCES.has(source) ? (source as LineupSource) : 'match', savedId: typeof savedId === 'string' ? savedId : null });
  }
  const size = typeof v.size === 'number' && Number.isFinite(v.size) ? v.size : fallback.size;
  return { rules: sanitizeRules(v.rules, fallback.rules), size: clamp(Math.round(size), Math.max(MIN_FIGHTERS, picks.length), MAX_FIGHTERS), picks };
}
