/**
 * Balance harness (spec: "Measured, not guessed"):
 *
 *   npm run balance
 *   npm run balance -- --seeds 100 --ffas 100 --seed 1 --threads 8 --out docs/BALANCE.md
 *   npm run balance -- --quick        (10 seeds, 10 FFAs per map: a smoke run, too noisy to tune by)
 *
 * Runs (a) weapon-vs-weapon duels on the pit between comparable stacks over many seeds and
 * (b) 8-fighter FFAs with the house stacks on the map pool, on the real sim with every entrant
 * through the strategy gate, checks the targets (every duel pairing 35-65%, each weapon family
 * 0.67-1.5x its fair share of FFA wins on the pit) and writes the results and the current numbers
 * to docs/BALANCE.md. The plan, analysis and document live in src/gym/balance.ts; this file only
 * plays matches (in parallel worker threads, one match per message) and writes the file.
 *
 * Deterministic: the same options give the same document. Exit code 1 when a target fails (the
 * document is still written), 2 on bad arguments.
 */

import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { DEFAULT_MAP_ID } from '../src/core';
import type { MatchConfig, MatchReport } from '../src/core';
import { analyseBalance, balanceMarkdown, balancePlan, type BalanceOptions } from '../src/gym/balance';
import { createSimRunner } from '../src/gym/runner';
import { MAPS, MAP_IDS, createMatch } from '../src/sim';
import { HOUSE_STACKS, headlessBrainFactory } from '../src/strategy';

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

type Args = { seeds: number; ffas: number; seed: number; threads: number; out: string };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { seeds: 100, ffas: 100, seed: 1, threads: Math.max(1, availableParallelism() - 1), out: 'docs/BALANCE.md' };
  const usage = 'Usage: npm run balance -- [--seeds N] [--ffas N] [--seed N] [--threads N] [--out FILE] [--quick]';
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--quick') {
      args.seeds = 10;
      args.ffas = 10;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value.\n${usage}`);
    if (flag === '--out') {
      args.out = value;
      continue;
    }
    const n = Number(value);
    const flags: Record<string, 'seeds' | 'ffas' | 'seed' | 'threads'> = { '--seeds': 'seeds', '--ffas': 'ffas', '--seed': 'seed', '--threads': 'threads' };
    const key = Object.hasOwn(flags, flag) ? flags[flag] : undefined;
    if (!key) throw new Error(`Unknown option ${flag}.\n${usage}`);
    if (!Number.isInteger(n) || n < 0 || (key === 'threads' && n < 1)) throw new Error(`${flag} needs a whole number, got "${value}".\n${usage}`);
    args[key] = n;
  }
  return args;
}

/** Play every config on a pool of worker threads; reports come back in config order. */
function playAll(configs: readonly MatchConfig[], threads: number): Promise<MatchReport[]> {
  const reports = new Array<MatchReport>(configs.length);
  let next = 0;
  let finished = 0;
  let lastShown = -1;
  return new Promise((resolve, reject) => {
    if (configs.length === 0) return resolve(reports);
    const pool: Worker[] = [];
    const stop = (err?: Error) => {
      for (const w of pool) void w.terminate();
      if (err) reject(err);
      else resolve(reports);
    };
    const feed = (w: Worker) => {
      if (next < configs.length) {
        const index = next++;
        w.postMessage({ index, config: configs[index]! } satisfies Job);
      }
    };
    for (let t = 0; t < Math.min(threads, configs.length); t++) {
      const w = new Worker(new URL(import.meta.url));
      w.on('message', (done: Done) => {
        if ('error' in done) return stop(new Error(`Match ${done.index} (seed ${configs[done.index]!.seed}, ${configs[done.index]!.mapId}) failed: ${done.error}`));
        reports[done.index] = done.report;
        finished++;
        const shown = Math.floor((finished / configs.length) * 10);
        if (shown !== lastShown) {
          lastShown = shown;
          process.stderr.write(`  ${finished}/${configs.length} matches\n`);
        }
        if (finished === configs.length) stop();
        else feed(w);
      });
      w.on('error', (e) => stop(e instanceof Error ? e : new Error(String(e))));
      pool.push(w);
      feed(w);
    }
  });
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
    return;
  }
  const options: BalanceOptions = {
    seed: args.seed,
    duelSeeds: args.seeds,
    duelMapId: DEFAULT_MAP_ID,
    field: HOUSE_STACKS,
    mapIds: MAP_IDS,
    ffasPerMap: args.ffas,
  };
  const plan = balancePlan(options);
  const configs = [...plan.duels, ...plan.ffas];
  console.log(`Balance: ${plan.duels.length} duels on ${options.duelMapId} and ${plan.ffas.length} FFAs on ${options.mapIds.join(', ')}, ${args.threads} threads.`);
  const started = performance.now();
  const reports = await playAll(configs, args.threads);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);

  const report = analyseBalance(options, reports.slice(0, plan.duels.length), reports.slice(plan.duels.length));
  writeFileSync(args.out, balanceMarkdown(report));
  console.log(`Played ${configs.length} matches in ${seconds} s.`);
  for (const c of report.checks) console.log(`${c.guideline ? (c.pass ? 'inside ' : 'outside') : c.pass ? 'PASS   ' : 'FAIL   '}  ${c.target}: ${c.measured}`);
  console.log(`Wrote ${args.out}. ${report.pass ? 'All targets hold.' : 'Some targets fail.'}`);
  process.exitCode = report.pass ? 0 : 1;
}

if (isMainThread) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
} else {
  workerMain();
}
