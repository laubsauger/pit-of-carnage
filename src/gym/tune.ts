/**
 * Tune: make one strategy better at what it already is (`npm run tune`).
 *
 * Evolution searches for new play styles; the tuner sharpens a given one. It changes only the
 * strategy's own numbers and policies (attributes within the budget, move-term weights, keep_range
 * bands, expression constants in scores, targets and policies, attack keywords, stances, commit)
 * with evolution's mutation operators (`TUNE_MUTATIONS`), and never its weapon, skill, behaviours or
 * move terms, nor any rule of the game: everything here is strategy JSON in, strategy JSON out.
 *
 * A paired hill climb against a fixed field:
 *
 * 1. Each round fixes a fresh set of seeds. Per seed: one `fighters`-way FFA on every map and
 *    `duelsPerSeed` duels (opponents and seats from shuffle bags over the field). The incumbent and
 *    `mutants` mutants of it all play exactly these matches in the test seat.
 * 2. A seed's score is the mean FFA placement score ((n - place) / (n - 1)) and the duel win rate,
 *    weighted half and half. The best mutant must beat the incumbent on the round's seeds by
 *    evolution's margin test (`beats`, `Z_SHARED`), then again on twice as many fresh seeds with the
 *    stricter `Z_CONFIRM` (the re-test). Only then does it become the incumbent.
 * 3. Rounds run while the budget (a match count) still covers a whole round with its re-test and the
 *    final check. The final check plays the original and the result on held-out seeds, each rated
 *    in its own run-local book, for the before/after table. Over many rounds a neutral change
 *    sometimes passes both tests by luck; the result is kept only if it also scores higher than the
 *    original on the held-out seeds, else the original comes back.
 *
 * Deterministic: every seed derives from `req.seed`, and `play` must return reports in config order.
 */

import { DEFAULT_MAP_ID, MAX_FIGHTERS, Rng, displayRating, ratingDisplay, strategyKey } from '../core';
import type { Behaviour, FighterReport, MatchConfig, MatchReport, MoveTerm, Rating, RatingDisplay, Strategy, StrategySource, ValidationResult } from '../core';
import { ShuffleBag, gymConfig, uniqueByKey } from './batch';
import { Z_CONFIRM, Z_SHARED, beats, fingerprint } from './evolve';
import { clock, listing, plural, round, versionedName } from './format';
import { TUNE_MUTATIONS, materializeImports, mutate, termLabel } from './mutate';
import { RatingBook } from './ratings';

export type TuneRequest = {
  strategy: Strategy;
  /** Fixed opponents for the whole run; entries with the tuned strategy's name are left out. */
  field: Strategy[];
  /** Every seed plays one FFA on each of these maps. */
  mapIds: string[];
  /** The duels rotate through these maps. */
  duelMapIds: string[];
  /** Paired seeds per round (the re-test plays twice as many, the final check too). */
  seeds: number;
  /** Most matches the whole run may play, the final check included. */
  budget: number;
  seed: number;
  /** FFA size. */
  fighters: number;
  duelsPerSeed: number;
  /** Mutants tried per round. */
  mutants: number;
};

export const TUNE_DEFAULTS = { seeds: 8, budget: 6000, seed: 1, fighters: 8, duelsPerSeed: 2, mutants: 4, duelMapIds: [DEFAULT_MAP_ID] } as const;

export type TuneDeps = {
  /** Plays configs and returns their reports in the same order (in parallel or not). */
  play: (configs: MatchConfig[]) => MatchReport[] | Promise<MatchReport[]>;
  /** The gate (`loadStrategy` in the result shape the gym uses). */
  validate: (input: unknown, source: StrategySource) => ValidationResult;
  /** Starter behaviours, so imported ones can be tuned too (folded back into `imports` when unchanged). */
  library?: Readonly<Record<string, Behaviour>>;
};

/** One round, as the log and the result tell it. */
export type TuneRound = {
  round: number;
  /** Mutants that played (valid and new). */
  tried: number;
  rejected: number;
  /** The round's best mutant, or null when none was valid. */
  best: { mutations: string[]; avgScore: number; incumbentScore: number; retest: { avgScore: number; incumbentScore: number } | null } | null;
  accepted: boolean;
  summary: string;
};

/** One side of the before/after table, measured on the held-out seeds. */
export type TuneSide = {
  strategy: Strategy;
  key: string;
  /** Mean seed score (0..1), the quantity the tuner climbs. */
  score: number;
  ffa: { matches: number; wins: number; winShare: number; avgPlace: number; avgKills: number; byMap: Record<string, { matches: number; wins: number; avgPlace: number }> };
  duels: { matches: number; wins: number; winRate: number };
  rating: Rating;
  display: RatingDisplay;
  /** Share of time alive in each behaviour, over every held-out match. */
  behaviourShare: Record<string, number>;
  /** Share of time alive spent engaged with an enemy. */
  engaged: number;
  /** Mean ticks to first contact over the matches where it had one; null when it never engaged. */
  firstContactTicks: number | null;
};

export type TuneResult = {
  original: Strategy;
  /** What passed the re-tests (version bumped), null when nothing did. */
  candidate: Strategy | null;
  /** The candidate when the held-out seeds confirmed it, else the original. */
  best: Strategy;
  /** The candidate scored higher than the original on the held-out seeds and is the result. */
  improved: boolean;
  rounds: TuneRound[];
  /** Net changes from the original to the candidate, in plain words. */
  changes: string[];
  /** The original on the held-out seeds. */
  before: TuneSide;
  /** The candidate on the same seeds (the original again when there is no candidate). */
  after: TuneSide;
  matchesPlayed: number;
  budget: number;
  /** Markdown before/after table. */
  table: string;
  /** A short plain-English note on what changed and what it did. */
  note: string;
};

/** Tries per mutant slot before giving up on it (invalid or duplicate mutants use them up). */
const MAX_ATTEMPTS = 12;
/** Rounds in a row without a single valid mutant before the tuner stops early. */
const MAX_BARREN_ROUNDS = 3;
/** The re-test and the final check play this many times `seeds`. */
const RETEST_FACTOR = 2;

type Kind = 'ffa' | 'duel';
type Slot = { group: number; kind: Kind; seed: number; mapId: string; seat: number; opponents: Strategy[] };
type Trial = { strategy: Strategy; key: string; reports: MatchReport[]; places: number[]; scores: number[] };

function checkRequest(req: TuneRequest): void {
  const whole = (v: number, min: number) => Number.isInteger(v) && v >= min;
  if (!whole(req.seeds, 2)) throw new Error(`Tune needs at least 2 seeds per round (the margin test needs a spread), got ${req.seeds}.`);
  if (!whole(req.mutants, 1)) throw new Error(`Tune needs at least 1 mutant per round, got ${req.mutants}.`);
  if (!whole(req.duelsPerSeed, 0)) throw new Error(`Duels per seed must be a whole number, got ${req.duelsPerSeed}.`);
  if (!whole(req.budget, 1)) throw new Error(`The budget is a number of matches, got ${req.budget}.`);
  if (!Number.isInteger(req.fighters) || req.fighters < 3 || req.fighters > MAX_FIGHTERS) {
    throw new Error(`Tune plays free-for-alls of 3-${MAX_FIGHTERS} fighters, got ${req.fighters}.`);
  }
  if (req.mapIds.length === 0 && req.duelsPerSeed === 0) throw new Error('Tune needs FFA maps or duels to play.');
  if (req.duelsPerSeed > 0 && req.duelMapIds.length === 0) throw new Error('Duels need at least one map.');
}

/** Matches one strategy plays on `seeds` seeds. */
export function matchesPerTest(req: Pick<TuneRequest, 'mapIds' | 'duelsPerSeed'>, seeds: number): number {
  return seeds * (req.mapIds.length + req.duelsPerSeed);
}

/** The smallest budget that fits one round with its re-test plus the final check. */
export function minimumBudget(req: Pick<TuneRequest, 'mapIds' | 'duelsPerSeed' | 'seeds' | 'mutants'>): number {
  return roundCost(req) + finalCost(req);
}

function roundCost(req: Pick<TuneRequest, 'mapIds' | 'duelsPerSeed' | 'seeds' | 'mutants'>): number {
  return (req.mutants + 1) * matchesPerTest(req, req.seeds) + 2 * matchesPerTest(req, RETEST_FACTOR * req.seeds);
}

function finalCost(req: Pick<TuneRequest, 'mapIds' | 'duelsPerSeed' | 'seeds'>): number {
  return 2 * matchesPerTest(req, RETEST_FACTOR * req.seeds);
}

function mean(xs: readonly number[]): number {
  return xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

/** Placement score of one finish: 1 = won, 0 = last. A duel is 1 or 0. */
function placeScore(place: number, n: number): number {
  return (n - place) / (n - 1);
}

/**
 * The seed set `label`: per seed, one FFA per map, then the duels. Lineups come from shuffle bags
 * over the field, so every field strategy meets the tested seat about equally often.
 */
function makeSlots(req: TuneRequest, field: readonly Strategy[], rng: Rng, label: string, seeds: number): Slot[] {
  const srng = rng.fork(label);
  const ffaBag = new ShuffleBag(field, srng.fork('ffa'));
  const duelBag = new ShuffleBag(field, srng.fork('duel'));
  const slots: Slot[] = [];
  for (let g = 0; g < seeds; g++) {
    const grng = srng.fork(`seed:${g}`);
    for (const mapId of req.mapIds) {
      slots.push({ group: g, kind: 'ffa', seed: grng.nextU32(), mapId, seat: grng.int(0, req.fighters - 1), opponents: ffaBag.draw(req.fighters - 1) });
    }
    for (let d = 0; d < req.duelsPerSeed; d++) {
      const mapId = req.duelMapIds[(g * req.duelsPerSeed + d) % req.duelMapIds.length]!;
      slots.push({ group: g, kind: 'duel', seed: grng.nextU32(), mapId, seat: grng.int(0, 1), opponents: duelBag.draw(1) });
    }
  }
  return slots;
}

/** The tested seat's result (seat i is entrant `e{i}`, see `gymConfig`). */
function seatResult(report: MatchReport, seat: number): FighterReport {
  const entry = report.roster.find((r) => r.entrantId === `e${seat}`);
  const f = entry && report.fighters.find((x) => x.fighterId === entry.fighterId);
  if (!f) throw new Error(`Tune: the match on seed ${report.seed} reported no result for the tested seat.`);
  return f;
}

function configFor(s: Strategy, slot: Slot): MatchConfig {
  const lineup = [...slot.opponents];
  lineup.splice(slot.seat, 0, s);
  return gymConfig(slot.seed, slot.mapId, lineup);
}

/** Plays every strategy on the same slots in one `play` call (so a pool can run them all in parallel). */
async function playAll(strategies: readonly Strategy[], slots: readonly Slot[], deps: TuneDeps): Promise<Trial[]> {
  const configs = strategies.flatMap((s) => slots.map((slot) => configFor(s, slot)));
  const reports = await deps.play(configs);
  if (reports.length !== configs.length) throw new Error(`Tune: asked for ${configs.length} matches, got ${reports.length} reports.`);
  const groups = Math.max(0, ...slots.map((s) => s.group + 1));
  return strategies.map((strategy, i) => {
    const mine = reports.slice(i * slots.length, (i + 1) * slots.length);
    const places = mine.map((r, j) => seatResult(r, slots[j]!.seat).place);
    const scores = Array.from({ length: groups }, (_, g) => {
      const part = (kind: Kind) => mine.flatMap((r, j) => (slots[j]!.group === g && slots[j]!.kind === kind ? [placeScore(places[j]!, r.roster.length)] : []));
      const ffa = part('ffa');
      const duel = part('duel');
      if (ffa.length === 0) return mean(duel);
      if (duel.length === 0) return mean(ffa);
      return (mean(ffa) + mean(duel)) / 2;
    });
    return { strategy, key: strategyKey(strategy), reports: mine, places, scores };
  });
}

/** Everything one side did on the held-out seeds. */
function sideOf(t: Trial, slots: readonly Slot[]): TuneSide {
  const book = new RatingBook();
  for (const r of t.reports) book.rate(r);
  const rating = book.get(t.key);
  const ffa = { matches: 0, wins: 0, winShare: 0, avgPlace: 0, avgKills: 0, byMap: {} as TuneSide['ffa']['byMap'] };
  const duels = { matches: 0, wins: 0, winRate: 0 };
  const ticks: Record<string, number> = {};
  let alive = 0;
  let engaged = 0;
  const contacts: number[] = [];
  let kills = 0;
  t.reports.forEach((r, j) => {
    const slot = slots[j]!;
    const f = seatResult(r, slot.seat);
    if (slot.kind === 'ffa') {
      ffa.matches++;
      ffa.avgPlace += f.place;
      kills += f.kills;
      if (f.place === 1) ffa.wins++;
      const m = (ffa.byMap[slot.mapId] ??= { matches: 0, wins: 0, avgPlace: 0 });
      m.matches++;
      m.avgPlace += f.place;
      if (f.place === 1) m.wins++;
    } else {
      duels.matches++;
      if (f.place === 1) duels.wins++;
    }
    for (const [b, n] of Object.entries(f.behaviourTicks)) ticks[b] = (ticks[b] ?? 0) + n;
    alive += f.exposure.ticksAlive;
    engaged += f.stats.ticksEngaged;
    if (f.stats.ticksToFirstContact !== null) contacts.push(f.stats.ticksToFirstContact);
  });
  if (ffa.matches > 0) {
    ffa.winShare = round(ffa.wins / ffa.matches, 3);
    ffa.avgKills = round(kills / ffa.matches, 2);
    ffa.avgPlace = round(ffa.avgPlace / ffa.matches, 2);
  }
  for (const m of Object.values(ffa.byMap)) m.avgPlace = round(m.avgPlace / m.matches, 2);
  if (duels.matches > 0) duels.winRate = round(duels.wins / duels.matches, 3);
  const totalTicks = Object.values(ticks).reduce((s, n) => s + n, 0);
  const behaviourShare = Object.fromEntries(
    Object.entries(ticks)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([b, n]) => [b, totalTicks > 0 ? round(n / totalTicks, 3) : 0]),
  );
  return {
    strategy: t.strategy,
    key: t.key,
    score: round(mean(t.scores), 3),
    ffa,
    duels,
    rating,
    display: ratingDisplay(rating),
    behaviourShare,
    engaged: alive > 0 ? round(engaged / alive, 3) : 0,
    firstContactTicks: contacts.length > 0 ? Math.round(mean(contacts)) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// What changed
// ---------------------------------------------------------------------------------------------

/** Imported starter behaviours that came through tuning unchanged go back to being imports. */
function foldImports(original: Strategy, tuned: Strategy, library: Readonly<Record<string, Behaviour>>): Strategy {
  if (!original.imports?.length) return tuned;
  const out = structuredClone(tuned);
  const imports: string[] = [];
  for (const name of original.imports) {
    const lib = library[name];
    if (name in original.behaviours || !lib) {
      imports.push(name);
    } else if (out.behaviours[name] && JSON.stringify(out.behaviours[name]) === JSON.stringify(lib)) {
      delete out.behaviours[name];
      imports.push(name);
    }
  }
  if (imports.length > 0) out.imports = imports;
  else delete out.imports;
  return out;
}

function termChange(behaviour: string, a: MoveTerm, b: MoveTerm): string | null {
  const la = termLabel(a);
  const lb = termLabel(b);
  if (la !== lb) return `${behaviour}: ${la} -> ${lb}${a.weight !== b.weight ? ` (weight ${a.weight} -> ${b.weight})` : ''}`;
  if (a.weight !== b.weight) return `${behaviour}: ${la} weight ${a.weight} -> ${b.weight}`;
  return null;
}

/**
 * Net differences between two versions of a strategy, in plain words ("hide: keep_range [nearest_enemy,
 * 350, 2000] -> [nearest_enemy, 350, 900]", "attributes: agility 36 -> 30, vitality 4 -> 10").
 * Compares imported starter behaviours by their content.
 */
export function describeChanges(before: Strategy, after: Strategy, library: Readonly<Record<string, Behaviour>> = {}): string[] {
  const a = materializeImports(before, library);
  const b = materializeImports(after, library);
  const out: string[] = [];
  const attrs = (Object.keys(a.build.attributes) as (keyof Strategy['build']['attributes'])[])
    .filter((k) => a.build.attributes[k] !== b.build.attributes[k])
    .map((k) => `${k} ${a.build.attributes[k]} -> ${b.build.attributes[k]}`);
  if (attrs.length > 0) out.push(`attributes: ${attrs.join(', ')}`);
  if (a.build.weapon !== b.build.weapon) out.push(`build: weapon ${a.build.weapon} -> ${b.build.weapon}`);
  if (a.build.skill !== b.build.skill) out.push(`build: skill ${a.build.skill} -> ${b.build.skill}`);
  if (a.target !== b.target) out.push(`target: "${a.target}" -> "${b.target}"`);
  if (a.commit !== b.commit) out.push(`commit ${a.commit} -> ${b.commit} ticks`);
  for (const [name, x] of Object.entries(a.behaviours)) {
    const y = b.behaviours[name];
    if (!y) {
      out.push(`${name}: removed`);
      continue;
    }
    if (x.score !== y.score) out.push(`${name}: score "${x.score}" -> "${y.score}"`);
    if (x.attack !== y.attack) out.push(`${name}: attack "${x.attack}" -> "${y.attack}"`);
    if (x.skill !== y.skill) out.push(`${name}: skill "${x.skill ?? 'never'}" -> "${y.skill ?? 'never'}"`);
    if ((x.stance ?? 'normal') !== (y.stance ?? 'normal')) out.push(`${name}: stance ${x.stance ?? 'normal'} -> ${y.stance ?? 'normal'}`);
    for (const slot of new Set([...Object.keys(x.set ?? {}), ...Object.keys(y.set ?? {})])) {
      const ex = x.set?.[slot];
      const ey = y.set?.[slot];
      if (ex !== ey) out.push(`${name}: set ${slot} "${ex ?? ''}" -> "${ey ?? ''}"`);
    }
    if (x.move.length !== y.move.length) {
      out.push(`${name}: move terms [${x.move.map(termLabel).join('; ')}] -> [${y.move.map(termLabel).join('; ')}]`);
      continue;
    }
    x.move.forEach((t, i) => {
      const c = termChange(name, t, y.move[i]!);
      if (c) out.push(c);
    });
  }
  for (const name of Object.keys(b.behaviours)) if (!(name in a.behaviours)) out.push(`${name}: added`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const pctText = (v: number) => `${Math.round(v * 100)}%`;
const signed = (v: number, digits = 2) => `${v > 0 ? '+' : v < 0 ? '-' : '±'}${Math.abs(round(v, digits))}`;

/** The before/after table, Markdown. `kept` false marks the after column as a result the held-out seeds rejected. */
export function tuneTable(before: TuneSide, after: TuneSide, fighters: number, mapName: (id: string) => string = (id) => id, kept = true): string {
  const rows: [string, string, string, string][] = [];
  const ratingText = (s: TuneSide) => `${s.display.value} ±${s.display.plusMinus}${s.display.provisional ? ' (new)' : ''}`;
  if (before.ffa.matches > 0) {
    rows.push([`FFA win share (fair ${pctText(1 / fighters)})`, pctText(before.ffa.winShare), pctText(after.ffa.winShare), `${signed((after.ffa.winShare - before.ffa.winShare) * 100, 0)} pts`]);
    rows.push(['FFA average place', String(before.ffa.avgPlace), String(after.ffa.avgPlace), signed(after.ffa.avgPlace - before.ffa.avgPlace)]);
    rows.push(['FFA kills per match', String(before.ffa.avgKills), String(after.ffa.avgKills), signed(after.ffa.avgKills - before.ffa.avgKills)]);
    for (const id of Object.keys(before.ffa.byMap)) {
      const b = before.ffa.byMap[id]!;
      const a = after.ffa.byMap[id];
      if (a) rows.push([`  average place, ${mapName(id)}`, String(b.avgPlace), String(a.avgPlace), signed(a.avgPlace - b.avgPlace)]);
    }
  }
  if (before.duels.matches > 0) {
    rows.push([`Duels won (of ${before.duels.matches})`, pctText(before.duels.winRate), pctText(after.duels.winRate), `${signed((after.duels.winRate - before.duels.winRate) * 100, 0)} pts`]);
  }
  rows.push(['Rating (held-out matches)', ratingText(before), ratingText(after), signed(displayRating(after.rating) - displayRating(before.rating), 0)]);
  rows.push(['Tuning score (0-1)', String(before.score), String(after.score), signed(after.score - before.score, 3)]);
  rows.push(['Time engaged', pctText(before.engaged), pctText(after.engaged), `${signed((after.engaged - before.engaged) * 100, 0)} pts`]);
  const contact = (t: number | null) => (t === null ? 'never' : clock(t));
  rows.push(['First contact', contact(before.firstContactTicks), contact(after.firstContactTicks), '']);
  const head = `| | Before (${versionedName(before.strategy.name, before.strategy.version ?? 1)}) | After (${versionedName(after.strategy.name, after.strategy.version ?? 1)}${kept ? '' : ', not kept'}) | Change |`;
  return [head, '| --- | ---: | ---: | ---: |', ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

/** The behaviour whose share of the fighter's time moved the most, when it moved by 5 points or more. */
function biggestShift(before: TuneSide, after: TuneSide): string | null {
  let best: { name: string; from: number; to: number } | null = null;
  for (const name of new Set([...Object.keys(before.behaviourShare), ...Object.keys(after.behaviourShare)])) {
    const from = before.behaviourShare[name] ?? 0;
    const to = after.behaviourShare[name] ?? 0;
    if (!best || Math.abs(to - from) > Math.abs(best.to - best.from)) best = { name, from, to };
  }
  if (!best || Math.abs(best.to - best.from) < 0.05) return null;
  return `it spends ${pctText(best.to)} of its time in "${best.name}" (was ${pctText(best.from)})`;
}

function tuneNote(r: Omit<TuneResult, 'note' | 'table'>, fighters: number, heldOut: number): string {
  const name = r.original.name;
  const accepted = r.rounds.filter((x) => x.accepted).length;
  const head = `${r.rounds.length} ${plural(r.rounds.length, 'round')}, ${r.matchesPlayed} of ${r.budget} matches`;
  if (!r.candidate) {
    const close = r.rounds.filter((x) => x.best?.retest).length;
    return (
      `${name} is unchanged after ${head}: no mutant beat it by a real margin on a round's seeds and again on the re-test` +
      `${close > 0 ? ` (${close} got as far as the re-test)` : ''}. On ${heldOut} held-out seeds it places ${r.before.ffa.avgPlace} on average in ${fighters}-fighter FFAs.`
    );
  }
  if (!r.improved) {
    return (
      `${name} is unchanged after ${head}: ${accepted} ${plural(accepted, 'change')} passed the re-test (${r.changes.join('; ')}), ` +
      `but on ${heldOut} held-out seeds the result scored ${r.after.score} against the original's ${r.before.score}, so it was luck and the original stays.`
    );
  }
  const b = r.before;
  const a = r.after;
  const facts: string[] = [];
  if (b.ffa.matches > 0) {
    facts.push(`places ${a.ffa.avgPlace} on average in ${fighters}-fighter FFAs (was ${b.ffa.avgPlace})`);
    facts.push(`wins ${pctText(a.ffa.winShare)} of those FFAs (was ${pctText(b.ffa.winShare)})`);
  }
  if (b.duels.matches > 0) facts.push(`takes ${pctText(a.duels.winRate)} of its duels (was ${pctText(b.duels.winRate)})`);
  const shift = biggestShift(b, a);
  if (shift) facts.push(shift);
  if (a.firstContactTicks !== null && b.firstContactTicks !== null && Math.abs(a.firstContactTicks - b.firstContactTicks) >= 60) {
    facts.push(`gets into fights ${a.firstContactTicks < b.firstContactTicks ? 'sooner' : 'later'} (first contact ${clock(a.firstContactTicks)}, was ${clock(b.firstContactTicks)})`);
  }
  return (
    `Tuned ${name} over ${head}; ${accepted} ${plural(accepted, 'change')} passed the re-test. ` +
    `On ${heldOut} held-out seeds it now ${listing(facts)}. What changed: ${r.changes.join('; ')}.`
  );
}

// ---------------------------------------------------------------------------------------------
// The tuner
// ---------------------------------------------------------------------------------------------

export type TuneOptions = {
  /** After each round, with the matches played so far. */
  onRound?: (round: TuneRound, played: number, budget: number) => void;
  mapName?: (id: string) => string;
};

export async function tune(req: TuneRequest, deps: TuneDeps, opts: TuneOptions = {}): Promise<TuneResult> {
  checkRequest(req);
  const library = deps.library ?? {};
  const checked = deps.validate(req.strategy, 'cli');
  if (!checked.ok) {
    const first = checked.issues.find((i) => i.severity === 'error');
    throw new Error(`The strategy to tune is invalid${first ? ` (${first.path}: ${first.message})` : ''}.`);
  }
  const original = checked.strategy ?? req.strategy;
  const field = uniqueByKey(req.field).filter((s) => s.name !== original.name);
  if (field.length === 0) throw new Error(`Tune needs a field of opponents besides ${original.name}.`);
  const minimum = minimumBudget(req);
  if (req.budget < minimum) {
    throw new Error(
      `A budget of ${req.budget} matches is too small: one round (${req.mutants} mutants and the incumbent on ${req.seeds} seeds, then a re-test) ` +
        `plus the final check takes ${minimum}. Raise --budget or lower --seeds.`,
    );
  }

  const rng = new Rng(req.seed);
  const version = (original.version ?? 1) + 1;
  // Every mutant gets its own version while it plays, so reports and ratings never mix two of them.
  let nextVersion = version;
  const reserve = finalCost(req);
  const perRound = roundCost(req);
  let played = 0;
  const playCounted = async (strategies: readonly Strategy[], slots: readonly Slot[]) => {
    played += strategies.length * slots.length;
    if (played > req.budget) throw new Error(`Tune: would play ${played} matches, over the budget of ${req.budget}.`);
    return playAll(strategies, slots, deps);
  };

  let incumbent = materializeImports(original, library);
  const tried = new Set([fingerprint(incumbent)]);
  const rounds: TuneRound[] = [];
  let barren = 0;

  for (let r = 1; played + perRound + reserve <= req.budget; r++) {
    const brng = rng.fork(`breed:${r}`);
    const mutants: { strategy: Strategy; mutations: string[] }[] = [];
    let rejected = 0;
    for (let c = 0; c < req.mutants; c++) {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const m = mutate(incumbent, brng, { operators: TUNE_MUTATIONS });
        if (m.mutations.length === 0) continue;
        const fp = fingerprint(m.strategy);
        if (tried.has(fp)) continue;
        tried.add(fp);
        const named = { ...m.strategy, name: original.name, version: nextVersion++ };
        const v = deps.validate(named, 'evolution');
        if (!v.ok) {
          rejected++;
          continue;
        }
        mutants.push({ strategy: v.strategy ?? named, mutations: m.mutations });
        break;
      }
    }
    if (mutants.length === 0) {
      const entry: TuneRound = { round: r, tried: 0, rejected, best: null, accepted: false, summary: `Round ${r}: no valid new mutant.` };
      rounds.push(entry);
      opts.onRound?.(entry, played, req.budget);
      if (++barren >= MAX_BARREN_ROUNDS) break;
      continue;
    }
    barren = 0;

    const slots = makeSlots(req, field, rng, `round:${r}`, req.seeds);
    const [inc, ...kids] = await playCounted([incumbent, ...mutants.map((m) => m.strategy)], slots);
    let bi = 0;
    for (let i = 1; i < kids.length; i++) if (mean(kids[i]!.scores) > mean(kids[bi]!.scores)) bi = i;
    const kid = kids[bi]!;
    const best: NonNullable<TuneRound['best']> = { mutations: mutants[bi]!.mutations, avgScore: round(mean(kid.scores), 3), incumbentScore: round(mean(inc!.scores), 3), retest: null };
    let accepted = false;
    let summary: string;
    if (beats(kid.scores, inc!.scores, Z_SHARED)) {
      const fresh = makeSlots(req, field, rng, `retest:${r}`, RETEST_FACTOR * req.seeds);
      const [incAgain, kidAgain] = await playCounted([incumbent, kid.strategy], fresh);
      best.retest = { avgScore: round(mean(kidAgain!.scores), 3), incumbentScore: round(mean(incAgain!.scores), 3) };
      accepted = beats(kidAgain!.scores, incAgain!.scores, Z_CONFIRM);
      summary = accepted
        ? `Round ${r}: accepted ${best.mutations.join('; ')} (score ${best.avgScore} vs ${best.incumbentScore}, re-test ${best.retest.avgScore} vs ${best.retest.incumbentScore}).`
        : `Round ${r}: ${best.mutations.join('; ')} led ${best.avgScore} vs ${best.incumbentScore}, then failed the re-test (${best.retest.avgScore} vs ${best.retest.incumbentScore}).`;
      if (accepted) incumbent = kid.strategy;
    } else {
      summary = `Round ${r}: best of ${mutants.length}, ${best.mutations.join('; ')}, scored ${best.avgScore} vs ${best.incumbentScore}; not a real margin.`;
    }
    const entry: TuneRound = { round: r, tried: mutants.length, rejected, best, accepted, summary };
    rounds.push(entry);
    opts.onRound?.(entry, played, req.budget);
  }

  let candidate: Strategy | null = null;
  if (rounds.some((x) => x.accepted)) {
    candidate = foldImports(original, { ...incumbent, name: original.name, version }, library);
    const v = deps.validate(candidate, 'cli');
    if (!v.ok) throw new Error('Tune: the folded result failed validation; this is a bug in the tuner.');
    candidate = v.strategy ?? candidate;
  }

  const heldOutSlots = makeSlots(req, field, rng, 'final', RETEST_FACTOR * req.seeds);
  const finals = await playCounted(candidate ? [original, candidate] : [original], heldOutSlots);
  const before = sideOf(finals[0]!, heldOutSlots);
  const after = candidate ? sideOf(finals[1]!, heldOutSlots) : before;
  const improved = candidate !== null && mean(finals[1]!.scores) > mean(finals[0]!.scores);
  const changes = candidate ? describeChanges(original, candidate, library) : [];
  const core = { original, candidate, best: improved ? candidate! : original, improved, rounds, changes, before, after, matchesPlayed: played, budget: req.budget };
  return {
    ...core,
    table: tuneTable(before, after, req.fighters, opts.mapName, improved || !candidate),
    note: tuneNote(core, req.fighters, RETEST_FACTOR * req.seeds),
  };
}
