/**
 * Strategy tuner (SPEC 11, "Evolution"):
 *
 *   npm run tune -- "Unpaid Intern"
 *   npm run tune -- my-strategy.json --seeds 8 --budget 4000 --out tuned.json
 *   npm run tune -- "Unpaid Intern" --seed 3 --threads 6
 *
 * Takes a strategy file (JSON or a PIT2 code) or a house stack's name, and tunes only that strategy's
 * JSON (numbers and policies; never its weapon, skill or behaviours, never a rule) against the house
 * stacks in 8-fighter FFAs on every map plus duels, on paired seeds with a re-test before any change
 * is kept (src/gym/tune.ts). Prints each round, a before/after table and a plain-English note, and
 * writes the best strategy (checked through `loadStrategy`) to --out.
 *
 * Deterministic: the same arguments give the same result whatever --threads is. --budget is a match
 * count, never exceeded. Exit code 1 when the run fails, 2 on bad arguments.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname } from 'node:path';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import type { MatchConfig, MatchReport, Strategy, StrategySource, ValidationResult } from '../src/core';
import { createSimRunner } from '../src/gym/runner';
import { TUNE_DEFAULTS, minimumBudget, tune, type TuneRequest } from '../src/gym/tune';
import { MAPS, MAP_IDS, createMatch } from '../src/sim';
import { HOUSE_STACKS, STARTER_LIBRARY, headlessBrainFactory, loadStrategy } from '../src/strategy';

type Job = { index: number; config: MatchConfig };
type Done = { index: number; report: MatchReport } | { index: number; error: string };

function workerMain(): void {
  const run = createSimRunner({ createMatch, brainFactory: headlessBrainFactory, mapName: (id) => MAPS[id]?.name ?? id });
  parentPort!.on('message', (job: Job) => {
    let done: Done;
    try {
      done = { index: job.index, report: run(job.config) };
    } catch (e) {
      done = { index: job.index, error: e instanceof Error ? e.message : String(e) };
    }
    parentPort!.postMessage(done);
  });
}

/** A fixed pool of worker threads that lives for the whole run (the tuner plays many small batches). */
class Pool {
  private readonly workers: Worker[] = [];

  constructor(threads: number) {
    for (let t = 0; t < threads; t++) this.workers.push(new Worker(new URL(import.meta.url)));
  }

  /** Plays every config; reports come back in config order. */
  play(configs: readonly MatchConfig[]): Promise<MatchReport[]> {
    const reports = new Array<MatchReport>(configs.length);
    let next = 0;
    let finished = 0;
    return new Promise((resolve, reject) => {
      if (configs.length === 0) return resolve(reports);
      let failed = false;
      const listeners = new Map<Worker, { message: (d: Done) => void; error: (e: Error) => void }>();
      const detach = () => {
        for (const [w, l] of listeners) {
          w.off('message', l.message);
          w.off('error', l.error);
        }
      };
      const feed = (w: Worker) => {
        if (next < configs.length) {
          const index = next++;
          w.postMessage({ index, config: configs[index]! } satisfies Job);
        }
      };
      for (const w of this.workers) {
        const l = {
          message: (done: Done) => {
            if (failed) return;
            if ('error' in done) {
              failed = true;
              detach();
              const c = configs[done.index]!;
              return reject(new Error(`Match ${done.index} (seed ${c.seed}, ${c.mapId}) failed: ${done.error}`));
            }
            reports[done.index] = done.report;
            if (++finished === configs.length) {
              detach();
              resolve(reports);
            } else feed(w);
          },
          error: (e: Error) => {
            failed = true;
            detach();
            reject(e);
          },
        };
        listeners.set(w, l);
        w.on('message', l.message);
        w.on('error', l.error);
        feed(w);
      }
    });
  }

  close(): Promise<number[]> {
    return Promise.all(this.workers.map((w) => w.terminate()));
  }
}

type Args = { target: string; seeds: number; budget: number; seed: number; threads: number; out: string | null };

const USAGE = 'Usage: npm run tune -- <strategy file | house stack name> [--seeds N] [--budget N] [--seed N] [--threads N] [--out FILE]';

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { target: '', seeds: TUNE_DEFAULTS.seeds, budget: TUNE_DEFAULTS.budget, seed: TUNE_DEFAULTS.seed, threads: Math.max(1, availableParallelism() - 1), out: null };
  const numeric: Record<string, 'seeds' | 'budget' | 'seed' | 'threads'> = { '--seeds': 'seeds', '--budget': 'budget', '--seed': 'seed', '--threads': 'threads' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (!flag.startsWith('--')) {
      if (args.target) throw new Error(`One strategy at a time; got "${args.target}" and "${flag}".\n${USAGE}`);
      args.target = flag;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value.\n${USAGE}`);
    if (flag === '--out') {
      args.out = value;
      continue;
    }
    const key = Object.hasOwn(numeric, flag) ? numeric[flag] : undefined;
    if (!key) throw new Error(`Unknown option ${flag}.\n${USAGE}`);
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || (key !== 'seed' && n < 1)) throw new Error(`${flag} needs a whole number, got "${value}".\n${USAGE}`);
    args[key] = n;
  }
  if (!args.target) throw new Error(`Name a strategy file or a house stack.\n${USAGE}`);
  return args;
}

/** The one gate, in the result shape the gym uses. */
function gate(input: unknown, source: StrategySource): ValidationResult {
  const r = loadStrategy(input, source);
  return { ok: r.strategy !== undefined, issues: [...r.errors, ...r.warnings], strategy: r.strategy };
}

const simple = (s: string) => s.toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** A file path (JSON or a strategy code), or a house stack by name ("Unpaid Intern" finds "The Unpaid Intern"). */
function resolveTarget(target: string): Strategy {
  if (existsSync(target)) {
    const r = loadStrategy(readFileSync(target, 'utf8'), 'file');
    if (!r.strategy) throw new Error(`${target} is not a valid strategy:\n${r.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
    return r.strategy;
  }
  const want = simple(target);
  const exact = HOUSE_STACKS.filter((s) => simple(s.name) === want);
  const found = exact.length > 0 ? exact : HOUSE_STACKS.filter((s) => simple(s.name).includes(want));
  if (found.length === 1) return found[0]!;
  const names = HOUSE_STACKS.map((s) => `  ${s.name}`).join('\n');
  if (found.length === 0) throw new Error(`No file "${target}" and no house stack by that name. House stacks:\n${names}`);
  throw new Error(`"${target}" matches ${found.length} house stacks: ${found.map((s) => s.name).join(', ')}. Be more specific.`);
}

const slug = (name: string) => simple(name).replace(/\s+/g, '-') || 'strategy';

async function main(): Promise<void> {
  let args: Args;
  let strategy: Strategy;
  try {
    args = parseArgs(process.argv.slice(2));
    strategy = resolveTarget(args.target);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
    return;
  }
  const req: TuneRequest = {
    strategy,
    field: [...HOUSE_STACKS],
    mapIds: [...MAP_IDS],
    duelMapIds: [...TUNE_DEFAULTS.duelMapIds],
    seeds: args.seeds,
    budget: args.budget,
    seed: args.seed,
    fighters: TUNE_DEFAULTS.fighters,
    duelsPerSeed: TUNE_DEFAULTS.duelsPerSeed,
    mutants: TUNE_DEFAULTS.mutants,
  };
  const out = args.out ?? `tuned/${slug(strategy.name)}.json`;
  if (args.budget < minimumBudget(req)) {
    console.error(`--budget ${args.budget} is below the ${minimumBudget(req)} matches one round and the final check need with --seeds ${args.seeds}.`);
    process.exitCode = 2;
    return;
  }

  const mapName = (id: string) => MAPS[id]?.name ?? id;
  console.log(`Tuning ${strategy.name} v${strategy.version ?? 1}: ${req.fighters}-fighter FFAs on ${req.mapIds.map(mapName).join(', ')} plus ${req.duelsPerSeed} duels per seed against the house stacks.`);
  console.log(`${args.seeds} seeds per round, budget ${args.budget} matches, seed ${args.seed}, ${args.threads} threads.\n`);
  const started = Date.now();
  const pool = new Pool(args.threads);
  try {
    const result = await tune(req, { play: (configs) => pool.play(configs), validate: gate, library: STARTER_LIBRARY }, {
      mapName,
      onRound: (round, played, budget) => console.log(`  ${round.summary}  [${played}/${budget} matches]`),
    });
    const text = `${JSON.stringify(result.best, null, 2)}\n`;
    const check = loadStrategy(text, 'file');
    if (!check.strategy) throw new Error(`The tuned strategy failed the gate: ${check.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    console.log(`\n${result.table}\n\n${result.note}\n`);
    console.log(`Wrote ${out} (${result.matchesPlayed} matches in ${Math.round((Date.now() - started) / 1000)} s).`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    await pool.close();
  }
}

if (isMainThread) void main();
else workerMain();
