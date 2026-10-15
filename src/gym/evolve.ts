/**
 * Evolution: quality-diversity search (MAP-Elites) seeded with one strategy.
 *
 * The archive keeps one elite per niche (weapon family x preferred range x aggression, see
 * `nicheOf`), so the search keeps several different builds alive instead of collapsing onto one.
 * A strategy's niche is read from its move terms, weighted by the time it spent in each behaviour
 * during its first trial, and stays fixed after that. Each generation:
 *
 * 1. Fix the generation's matches: `matchesPerCandidate` seeds on a rotating map pool, each with a
 *    lineup of `fighters - 1` opponents drawn evenly from the field, every archive elite and the
 *    champion, plus a test seat. Everyone evaluated this generation plays exactly these matches
 *    in the test seat (paired comparison).
 * 2. Breed `population` children from uniformly chosen elites: crossover (whole behaviours from
 *    another elite or a field strategy) and/or one mutation. Every child must pass the validator
 *    before it is played; duplicates of anything already tried are skipped.
 * 3. Play the champion, every child, and the elite of each niche a child lands in.
 * 4. Fitness is the FFA placement score (n - place) / (n - 1), averaged over the matches: 1 = won
 *    every match, 0 = last every time. A child takes an empty niche outright, or an occupied one
 *    only if it beats the occupant on the shared seeds by a real margin (`beats`).
 * 5. The champion is a separate title, harder to take than a niche. The best elite that beat it on
 *    the shared seeds races it on 2 x `matchesPerCandidate` fresh seeds and must win again, by a
 *    stricter test, to be promoted. With several challengers per generation the best of them beats
 *    an equal champion on the shared seeds by luck most generations; the fresh race keeps those
 *    false promotions rare, while the archive keeps improving underneath.
 *
 * Nothing here touches the persistent leaderboard: hundreds of throwaway mutants would bury it.
 * Ratings inside a run come from a run-local book.
 */

import { MAX_FIGHTERS, Rng, strategyKey } from '../core';
import type {
  Behaviour,
  EvolveCandidate,
  EvolveGeneration,
  EvolveRequest,
  EvolveResult,
  MatchReport,
  MoveTerm,
  Strategy,
  StrategyAggregate,
  ValidationResult,
} from '../core';
import { keyNames, strategyAggregate } from './aggregate';
import { ShuffleBag, gymConfig, uniqueByKey, type MatchRunner } from './batch';
import type { Appearance, FindingContext, StrategyFindingContext } from './findings';
import { plural, round, versionedName } from './format';
import { NICHE_COUNT, collectTerms, crossover, materializeImports, mutate, nicheKey, nicheOf, type Niche, type Usage } from './mutate';
import { RatingBook } from './ratings';

export type EvolveDeps = {
  runMatch: MatchRunner;
  validate: (input: unknown) => ValidationResult;
  /** Starter behaviours: imported behaviours are copied in so they can evolve too. */
  library?: Readonly<Record<string, Behaviour>>;
  /** Extra move terms the term swap may draw from (starter library, house stacks). */
  termPool?: readonly MoveTerm[];
  mapName?: FindingContext['mapName'];
  mapPickups?: FindingContext['mapPickups'];
};

/** One archive slot as reported each generation. */
export type ArchiveCell = {
  niche: Niche;
  nicheKey: string;
  key: string;
  /** "Lurking Daggers v7". */
  name: string;
  strategy: Strategy;
  /** Mean placement score over every match this elite played in the run (1 = always won). */
  fitness: number;
  avgPlace: number;
  matches: number;
  /** Generation it was bred in (0 = the strategy the run started from). */
  bornGeneration: number;
  /** Versioned name of the elite it was bred from, null for the starting strategy. */
  parent: string | null;
  /** What changed versus its parent. */
  mutations: string[];
  /** Holds the title. The champion can lose its niche to a child and still hold the title. */
  champion: boolean;
};

/** `EvolveGeneration` plus the archive after the generation and the count of children the validator rejected. */
export type GenerationReport = EvolveGeneration & { archive: ArchiveCell[]; rejected: number };

/** Mean score gap (normalized place, 0..1) a challenger needs: 0.05 is about a third of a place in an 8-way FFA. */
export const MIN_MARGIN = 0.05;
/** Standard errors a challenger must lead by on the shared seeds (niche contests, first round for the title). */
export const Z_SHARED = 1;
/** Standard errors a title challenger must lead by again on fresh seeds (one-sided 95%). */
export const Z_CONFIRM = 1.645;
/** The title race plays this many times `matchesPerCandidate` fresh seeds. */
const RACE_LENGTH = 2;
/** Share of children bred by crossover (the rest are pure mutants). */
const CROSSOVER_RATE = 0.3;
/** Tries per child slot before giving up on it (invalid or duplicate children use them up). */
const MAX_ATTEMPTS = 12;

/**
 * Paired comparison on shared seeds: the challenger's mean score must lead by at least MIN_MARGIN
 * and by at least `z` standard errors of the per-seed differences, so one lucky match is not enough.
 */
export function beats(challenger: readonly number[], incumbent: readonly number[], z = Z_SHARED): boolean {
  const n = Math.min(challenger.length, incumbent.length);
  if (n === 0) return false;
  const d = Array.from({ length: n }, (_, i) => challenger[i]! - incumbent[i]!);
  const mean = d.reduce((s, x) => s + x, 0) / n;
  if (mean < MIN_MARGIN) return false;
  if (n < 2) return true;
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  return mean >= (z * sd) / Math.sqrt(n);
}

type Elite = {
  strategy: Strategy;
  key: string;
  niche: Niche;
  nicheKey: string;
  parent: string | null;
  mutations: string[];
  born: number;
  matches: number;
  scoreSum: number;
  placeSum: number;
};

type Slot = { seed: number; mapId: string; seat: number; opponents: Strategy[] };

/** One strategy's results in the test seat of every slot. */
type Trial = { key: string; reports: MatchReport[]; apps: Appearance[]; scores: number[]; places: number[] };

type Child = { strategy: Strategy; key: string; parent: Elite; mutations: string[] };

function checkRequest(req: EvolveRequest): void {
  const whole = (v: number) => Number.isInteger(v) && v >= 1;
  if (!whole(req.generations)) throw new Error(`Generations must be a whole number of at least 1, got ${req.generations}.`);
  if (!whole(req.population)) throw new Error(`Population must be a whole number of at least 1, got ${req.population}.`);
  if (!whole(req.matchesPerCandidate)) throw new Error(`Matches per candidate must be at least 1, got ${req.matchesPerCandidate}.`);
  if (!Number.isInteger(req.fighters) || req.fighters < 3 || req.fighters > MAX_FIGHTERS) {
    throw new Error(`Evolution plays free-for-alls of 3-${MAX_FIGHTERS} fighters, got ${req.fighters}.`);
  }
  if (req.mapIds.length === 0) throw new Error('Evolution needs at least one map.');
}

/** Content identity, ignoring name and version: two children with the same moves are the same child. */
function fingerprint(s: Strategy): string {
  return JSON.stringify([s.build, s.target, s.behaviours, s.imports ?? [], s.memory ?? {}, s.commit]);
}

function mean(xs: readonly number[]): number {
  return xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

/** Ticks per behaviour over a trial's matches: weights the niche descriptor by what the fighter actually did. */
function usageOf(t: Trial): Usage {
  const usage: Record<string, number> = {};
  for (const a of t.apps) for (const [b, ticks] of Object.entries(a.fighter.behaviourTicks)) usage[b] = (usage[b] ?? 0) + ticks;
  return usage;
}

function play(s: Strategy, slots: readonly Slot[], runMatch: MatchRunner): Trial {
  const trial: Trial = { key: strategyKey(s), reports: [], apps: [], scores: [], places: [] };
  for (const slot of slots) {
    const lineup = [...slot.opponents];
    lineup.splice(slot.seat, 0, s);
    const report = runMatch(gymConfig(slot.seed, slot.mapId, lineup));
    const entry = report.roster.find((r) => r.entrantId === `e${slot.seat}`);
    const fighter = entry && report.fighters.find((f) => f.fighterId === entry.fighterId);
    if (!entry || !fighter) throw new Error(`Evolution: the match on seed ${slot.seed} reported no result for the tested seat.`);
    const n = report.roster.length;
    trial.reports.push(report);
    trial.apps.push({ report, entry, fighter });
    trial.places.push(fighter.place);
    trial.scores.push((n - fighter.place) / (n - 1));
  }
  return trial;
}

export function evolve(
  req: EvolveRequest,
  deps: EvolveDeps,
  onGeneration?: (gen: GenerationReport, done: number, total: number) => void,
): EvolveResult {
  checkRequest(req);
  const library = deps.library ?? {};
  const checked = deps.validate(req.parent);
  if (!checked.ok) {
    const first = checked.issues.find((i) => i.severity === 'error');
    throw new Error(`The strategy to evolve is invalid${first ? ` (${first.path}: ${first.message})` : ''}.`);
  }
  const root = checked.strategy ?? req.parent;
  const rootKey = strategyKey(root);
  const field = uniqueByKey(req.field).filter((s) => strategyKey(s) !== rootKey);
  // Children are versions of the root, numbered above every version of that name in play.
  let nextVersion = 1 + Math.max(root.version ?? 1, ...field.filter((s) => s.name === root.name).map((s) => s.version ?? 1));
  const termPool = [...(deps.termPool ?? []), ...collectTerms([], [materializeImports(root, library), ...field])];
  const nameOf = (s: Strategy) => versionedName(s.name, s.version ?? 1);
  const rng = new Rng(req.seed);
  const book = new RatingBook();
  const M = req.matchesPerCandidate;

  /** An elite's niche is read once, from its first trial, and kept for the rest of the run. */
  const makeElite = (strategy: Strategy, parent: string | null, mutations: string[], born: number, trial: Trial): Elite => {
    const niche = nicheOf(strategy, library, usageOf(trial));
    return { strategy, key: strategyKey(strategy), niche, nicheKey: nicheKey(niche), parent, mutations, born, matches: 0, scoreSum: 0, placeSum: 0 };
  };
  const credit = (e: Elite, t: Trial) => {
    e.matches += t.scores.length;
    e.scoreSum += t.scores.reduce((s, x) => s + x, 0);
    e.placeSum += t.places.reduce((s, x) => s + x, 0);
  };

  const archive = new Map<string, Elite>();
  /** Breeding stand-in for generation 1, before the root has a measured niche. */
  const rootSeed: Elite = { strategy: root, key: rootKey, niche: nicheOf(root, library), nicheKey: '', parent: null, mutations: [], born: 0, matches: 0, scoreSum: 0, placeSum: 0 };
  let rootElite: Elite | null = null;
  let champion: Elite | null = null;
  let promotions = 0;
  const tried = new Set([fingerprint(root)]);
  const generations: GenerationReport[] = [];

  const snapshot = (): ArchiveCell[] =>
    [...archive.values()]
      .sort((a, b) => (a.nicheKey < b.nicheKey ? -1 : 1))
      .map((e) => ({
        niche: { ...e.niche },
        nicheKey: e.nicheKey,
        key: e.key,
        name: nameOf(e.strategy),
        strategy: structuredClone(e.strategy),
        fitness: e.matches > 0 ? round(e.scoreSum / e.matches, 3) : 0,
        avgPlace: e.matches > 0 ? round(e.placeSum / e.matches, 2) : 0,
        matches: e.matches,
        bornGeneration: e.born,
        parent: e.parent,
        mutations: [...e.mutations],
        champion: e === champion,
      }));

  for (let g = 1; g <= req.generations; g++) {
    const grng = rng.fork(`gen:${g}`);
    const elites = archive.size > 0 ? [...archive.values()] : [rootSeed];

    // 1. This generation's shared matches (and, if a title race happens, fresh ones).
    const pool = [...field, ...elites.map((e) => e.strategy)];
    if (champion && !elites.includes(champion)) pool.push(champion.strategy);
    const bag = new ShuffleBag(pool, grng.fork('lineups'));
    const makeSlots = (label: string, count: number, mapStart: number): Slot[] =>
      Array.from({ length: count }, (_, m) => {
        const mrng = grng.fork(`${label}:${m}`);
        return {
          seed: mrng.nextU32(),
          mapId: req.mapIds[(mapStart + m) % req.mapIds.length]!,
          seat: mrng.int(0, req.fighters - 1),
          opponents: bag.draw(req.fighters - 1),
        };
      });
    const slots = makeSlots('match', M, (g - 1) * M);

    // 2. Breed.
    const brng = grng.fork('breed');
    const children: Child[] = [];
    let rejected = 0;
    for (let c = 0; c < req.population; c++) {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const parent = brng.pick(elites);
        let s = materializeImports(parent.strategy, library);
        const mutations: string[] = [];
        const partners = [...elites.filter((e) => e !== parent).map((e) => e.strategy), ...field];
        let crossed = false;
        if (partners.length > 0 && brng.chance(CROSSOVER_RATE)) {
          const partner = brng.pick(partners);
          const x = crossover(s, materializeImports(partner, library), brng, nameOf(partner));
          s = x.strategy;
          mutations.push(...x.mutations);
          crossed = x.mutations.length > 0;
        }
        if (!crossed || brng.chance(0.5)) {
          const m = mutate(s, brng, { termPool });
          s = m.strategy;
          mutations.push(...m.mutations);
        }
        if (mutations.length === 0) continue;
        const fp = fingerprint(s);
        if (tried.has(fp)) continue;
        tried.add(fp);
        const named = { ...s, name: root.name, version: nextVersion };
        const result = deps.validate(named);
        if (!result.ok) {
          rejected++;
          continue;
        }
        nextVersion++;
        const strategy = result.strategy ?? named;
        children.push({ strategy, key: strategyKey(strategy), parent, mutations });
        break;
      }
    }

    // 3. Play: champion, every child, and the incumbent of each niche a child lands in.
    const champTrial = play((champion ?? rootSeed).strategy, slots, deps.runMatch);
    if (!champion) {
      rootElite = makeElite(root, null, [], 0, champTrial);
      archive.set(rootElite.nicheKey, rootElite);
      champion = rootElite;
    }
    const titleHolder: Elite = champion;
    const occupantTrial = new Map<string, Trial>();
    if (archive.get(titleHolder.nicheKey) === titleHolder) occupantTrial.set(titleHolder.nicheKey, champTrial);
    else credit(titleHolder, champTrial);
    const childTrials = children.map((c) => play(c.strategy, slots, deps.runMatch));
    const childNiches = children.map((c, i) => nicheKey(nicheOf(c.strategy, library, usageOf(childTrials[i]!))));
    for (const nk of childNiches) {
      const incumbent = archive.get(nk);
      if (incumbent && !occupantTrial.has(nk)) occupantTrial.set(nk, play(incumbent.strategy, slots, deps.runMatch));
    }
    for (const t of new Set([champTrial, ...occupantTrial.values(), ...childTrials])) for (const r of t.reports) book.rate(r);
    for (const [nk, t] of occupantTrial) credit(archive.get(nk)!, t);

    // 4. Insert children, best first, each against its niche's current occupant.
    let newNiches = 0;
    const order = children.map((_, i) => i).sort((a, b) => mean(childTrials[b]!.scores) - mean(childTrials[a]!.scores) || a - b);
    const childElites = new Map<Elite, number>();
    for (const i of order) {
      const c = children[i]!;
      const t = childTrials[i]!;
      const nk = childNiches[i]!;
      if (archive.has(nk)) {
        const occ = occupantTrial.get(nk);
        if (!occ || !beats(t.scores, occ.scores)) continue;
      } else {
        newNiches++;
      }
      const elite = makeElite(c.strategy, nameOf(c.parent.strategy), c.mutations, g, t);
      credit(elite, t);
      archive.set(nk, elite);
      occupantTrial.set(nk, t);
      childElites.set(elite, i);
    }

    // 5. Title: the best elite that beat the champion on the shared seeds races it on fresh seeds.
    let challenger: { elite: Elite; trial: Trial } | null = null;
    for (const e of archive.values()) {
      const t = occupantTrial.get(e.nicheKey);
      if (e === titleHolder || !t || t.key !== e.key || !beats(t.scores, champTrial.scores)) continue;
      if (!challenger || mean(t.scores) > mean(challenger.trial.scores)) challenger = { elite: e, trial: t };
    }
    let race: { mine: Trial; theirs: Trial } | null = null;
    let promoted = false;
    if (challenger) {
      const fresh = makeSlots('race', RACE_LENGTH * M, g * M);
      race = { mine: play(challenger.elite.strategy, fresh, deps.runMatch), theirs: play(titleHolder.strategy, fresh, deps.runMatch) };
      for (const r of [...race.mine.reports, ...race.theirs.reports]) book.rate(r);
      credit(titleHolder, race.theirs);
      credit(challenger.elite, race.mine);
      if (beats(race.mine.scores, race.theirs.scores, Z_CONFIRM)) {
        champion = challenger.elite;
        promoted = true;
        promotions++;
      }
    }

    // Report.
    const names = keyNames([champTrial, ...occupantTrial.values(), ...childTrials].flatMap((t) => t.reports));
    const ctx: StrategyFindingContext = { mapName: deps.mapName, mapPickups: deps.mapPickups, nameOfKey: (k) => names.get(k) ?? k };
    const aggregateOf = (t: Trial): StrategyAggregate => strategyAggregate(t.key, t.apps, book.get(t.key), ctx);
    const candidates: EvolveCandidate[] = children.map((c, i) => ({
      strategy: c.strategy,
      mutations: [...c.mutations],
      aggregate: aggregateOf(childTrials[i]!),
    }));
    let promotedCandidate: EvolveCandidate | null = null;
    if (promoted && challenger) {
      const i = childElites.get(challenger.elite);
      // An older elite can take the title too: it played the shared seeds as its niche's incumbent.
      promotedCandidate =
        i !== undefined
          ? candidates[i]!
          : { strategy: challenger.elite.strategy, mutations: [...challenger.elite.mutations], aggregate: aggregateOf(challenger.trial) };
    }

    const champName = nameOf(titleHolder.strategy);
    const ahead = (mine: Trial, theirs: Trial) => mine.places.filter((p, i) => p < theirs.places[i]!).length;
    const raced = RACE_LENGTH * M;
    let summary: string;
    if (challenger && race && promoted) {
      summary =
        `New contender: ${nameOf(challenger.elite.strategy)} beats ${champName} on ${ahead(challenger.trial, champTrial)} of ${M} shared ` +
        `${plural(M, 'seed')} and ${ahead(race.mine, race.theirs)} of ${raced} fresh ${plural(raced, 'one')} ` +
        `(average place ${round(mean(race.mine.places), 1)} vs ${round(mean(race.theirs.places), 1)} on the fresh seeds).`;
    } else if (challenger && race) {
      summary =
        `${champName} holds: ${nameOf(challenger.elite.strategy)} beat it on the shared seeds, then finished ahead on only ` +
        `${ahead(race.mine, race.theirs)} of ${raced} fresh ${plural(raced, 'one')}.`;
    } else if (children.length === 0) {
      summary = `${champName} holds: no valid mutant this generation.`;
    } else {
      const best = order[0]!;
      summary =
        `${champName} holds: the best mutant, ${nameOf(children[best]!.strategy)}, averaged place ` +
        `${round(mean(childTrials[best]!.places), 1)} vs ${round(mean(champTrial.places), 1)} on the same seeds.`;
    }
    summary += ` Archive: ${archive.size} of ${NICHE_COUNT} niches${newNiches > 0 ? ` (${newNiches} new)` : ''}.`;
    if (rejected > 0) summary += ` ${rejected} ${plural(rejected, 'mutant')} failed validation.`;

    const report: GenerationReport = {
      generation: g,
      champion: aggregateOf(champTrial),
      candidates,
      promoted: promotedCandidate,
      summary,
      archive: snapshot(),
      rejected,
    };
    generations.push(report);
    onGeneration?.(report, g, req.generations);
  }

  if (!champion) throw new Error('Evolution ended without a champion.');
  const improved = champion !== rootElite;
  const filled = `${archive.size} of ${NICHE_COUNT} niches filled`;
  const summary = improved
    ? `New champion: ${nameOf(champion.strategy)} (from ${nameOf(root)}) after ${req.generations} ${plural(req.generations, 'generation')}, ${promotions} ${plural(promotions, 'promotion')}; ${filled}.`
    : `${nameOf(root)} held on through ${req.generations} ${plural(req.generations, 'generation')}: no mutant beat it by a real margin; ${filled}.`;
  return { champion: structuredClone(champion.strategy), improved, generations, summary };
}
