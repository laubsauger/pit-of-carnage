/**
 * Gym: headless batch runs, battle reports, ratings and evolution.
 *
 * `createGymApi()` runs every job in a module Web Worker (one job at a time) and keeps the
 * persistent rating book on the main thread, so `leaderboard()` answers synchronously. Batches send
 * the book to the worker and get the updated book back with their result; evolution and
 * comparisons never touch it (throwaway mutants would bury the leaderboard, and a comparison is a
 * measurement). Cancelling terminates the worker outright, which stops a running match
 * immediately; the next job starts a fresh worker. The running job is published for the top-bar
 * chip (`jobs()`, `GymOptions.onJobsChange`).
 */

import type { BackgroundJob, BatchResult, CompareResult, EvolveResult, GymApi } from '../core';
import type { WorkerRequest, WorkerResponse } from './jobs';
import { RatingBook } from './ratings';

export { compareToText, deathPhrase, reportForLlm, reportToText } from './text';
export { compareBatches, compareReports, compareRows, runCompare, type CompareMatch, type CompareRequest, type CompareResult, type CompareRow } from './compare';
export { fighterMoments, pickMatches, type FighterMoment, type MatchPick, type MatchPickKind, type MatchPicks } from './picks';
export { HEAT_REGIONS, heatmapLegend, heatmapPhrase, regionAreas, summarizeHeatmap, trimHeatmap, type HeatRegion, type HeatmapSummary, type TrimmedHeatmap } from './heatmap';
export { MatchRecorder, placementsByStanding } from './recorder';
export { RatingBook, DEFAULT_RATING, type RatingBookJson, type RatingRecord } from './ratings';
export { aggregateReports } from './aggregate';
export { buildBatch, runBatch, type MatchRunner } from './batch';
export { createSimRunner } from './runner';
export {
  evolve,
  evolutionMatch,
  type ArchiveCell,
  type EvolutionMatch,
  type GenerationMatches,
  type GenerationReport,
  type RecordedSlot,
  type RecordedTrial,
} from './evolve';
export { nicheOf, nicheKey, NICHE_COUNT, type Niche } from './mutate';

/** What the gym needs from a worker; a real `Worker` fits, tests pass an in-process fake. */
export type WorkerLike = {
  postMessage(message: WorkerRequest): void;
  terminate(): void;
  onmessage: ((event: { data: WorkerResponse }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
};

type KeyValueStore = { getItem(key: string): string | null; setItem(key: string, value: string): void };

export type GymOptions = {
  createWorker?: () => WorkerLike;
  /** Called whenever `jobs()` changes: a job started, made progress, finished, failed or was cancelled. */
  onJobsChange?: () => void;
  /** Where the rating book persists. Defaults to localStorage when available; null keeps it in memory. */
  storage?: KeyValueStore | null;
  /** Clock for "last played" on the leaderboard. */
  now?: () => number;
};

export const RATINGS_STORAGE_KEY = 'pit-of-carnage/gym-ratings';

function defaultWorker(): WorkerLike {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}

function defaultStorage(): KeyValueStore | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function loadBook(storage: KeyValueStore | null): RatingBook {
  try {
    const raw = storage?.getItem(RATINGS_STORAGE_KEY);
    return raw ? RatingBook.fromJSON(JSON.parse(raw)) : new RatingBook();
  } catch {
    return new RatingBook();
  }
}

function abortError(): Error {
  const err = new Error('Gym job cancelled.');
  err.name = 'AbortError';
  return err;
}

/** The gym as the app uses it: the `GymApi` contract (comparisons included) plus the running job for the top-bar chip. */
export type GymService = GymApi & {
  /**
   * The job running in the background, for the top-bar chip: empty when idle, else one entry (the
   * gym runs one job at a time). The same array until it changes.
   */
  jobs(): BackgroundJob[];
};

type JobKind = 'batch' | 'evolve' | 'compare';

/** Chip text: "Testing: 37 of 100 matches", "Evolving: gen 4 of 20" (the generation running), "Comparing: 12 of 40 matches". */
export function jobLabel(kind: JobKind, done: number, total: number): string {
  if (kind === 'evolve') return `Evolving: gen ${Math.min(done + 1, total)} of ${total}`;
  return `${kind === 'batch' ? 'Testing' : 'Comparing'}: ${done} of ${total} matches`;
}

type Job = { id: number; kind: JobKind; reject: (err: Error) => void; onMessage: (m: WorkerResponse) => void };

export function createGymApi(options: GymOptions = {}): GymService {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const now = options.now ?? (() => Date.now());
  let book = loadBook(storage);
  let worker: WorkerLike | null = null;
  let job: Job | null = null;
  let nextId = 1;
  let running: BackgroundJob[] = [];

  /** Publish the chip state: the current job with its progress, or nothing. */
  function showJob(progress: { kind: JobKind; id: number; done: number; total: number } | null): void {
    running = progress
      ? [{ id: progress.id, kind: progress.kind === 'evolve' ? 'evolve' : 'batch', label: jobLabel(progress.kind, progress.done, progress.total), done: progress.done, total: progress.total }]
      : [];
    options.onJobsChange?.();
  }

  /** Clear the current job (it finished, failed or was cancelled) and tell the chip. */
  function endJob(): void {
    job = null;
    showJob(null);
  }

  function saveBook(): void {
    try {
      storage?.setItem(RATINGS_STORAGE_KEY, JSON.stringify(book.toJSON()));
    } catch (err) {
      console.warn('Gym: could not store ratings.', err);
    }
  }

  function dropWorker(): void {
    worker?.terminate();
    worker = null;
  }

  function ensureWorker(): WorkerLike {
    if (worker) return worker;
    const w = (options.createWorker ?? defaultWorker)();
    w.onmessage = (event) => {
      if (job && event.data.jobId === job.id) job.onMessage(event.data);
    };
    w.onerror = (event) => {
      const failed = job;
      if (failed) endJob();
      if (worker === w) dropWorker();
      failed?.reject(new Error(`The gym worker crashed: ${event.message ?? 'unknown error'}`));
    };
    worker = w;
    return w;
  }

  function startJob<T>(
    kind: JobKind,
    total: number,
    request: (id: number) => WorkerRequest,
    handle: (m: WorkerResponse, resolve: (v: T) => void) => void,
  ): Promise<T> {
    if (job) return Promise.reject(new Error('The gym is already running a job; cancel it first.'));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const finish = (v: T) => {
        endJob();
        resolve(v);
      };
      job = {
        id,
        kind,
        reject,
        onMessage(m) {
          if (m.type === 'error') {
            endJob();
            reject(new Error(m.message));
            return;
          }
          if (m.type === 'progress' || m.type === 'generation') showJob({ kind, id, done: m.done, total: m.total });
          handle(m, finish);
        },
      };
      showJob({ kind, id, done: 0, total });
      try {
        ensureWorker().postMessage(request(id));
      } catch (err) {
        endJob();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  return {
    runBatch(req, onProgress) {
      return startJob<BatchResult>(
        'batch',
        req.matches,
        (jobId) => ({ type: 'batch', jobId, req, ratings: book.toJSON(), playedAt: now() }),
        (m, resolve) => {
          if (m.type === 'progress') onProgress?.(m.done, m.total);
          else if (m.type === 'batch_done') {
            book = RatingBook.fromJSON(m.ratings);
            saveBook();
            resolve(m.result);
          }
        },
      );
    },

    evolve(req, onGeneration) {
      return startJob<EvolveResult>(
        'evolve',
        req.generations,
        (jobId) => ({ type: 'evolve', jobId, req }),
        (m, resolve) => {
          if (m.type === 'generation') onGeneration?.(m.generation, m.done, m.total);
          else if (m.type === 'evolve_done') resolve(m.result);
        },
      );
    },

    compare(req, onProgress) {
      return startJob<CompareResult>(
        'compare',
        2 * req.matches,
        (jobId) => ({ type: 'compare', jobId, req }),
        (m, resolve) => {
          if (m.type === 'progress') onProgress?.(m.done, m.total);
          else if (m.type === 'compare_done') resolve(m.result);
        },
      );
    },

    leaderboard: () => book.leaderboard(),

    jobs: () => running,

    cancel() {
      const cancelled = job;
      if (!cancelled) return;
      endJob();
      dropWorker();
      cancelled.reject(abortError());
    },
  };
}
