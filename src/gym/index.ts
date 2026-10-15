/**
 * Gym: headless batch runs, battle reports, ratings and evolution.
 *
 * `createGymApi()` runs every job in a module Web Worker (one job at a time) and keeps the
 * persistent rating book on the main thread, so `leaderboard()` answers synchronously. Batches send
 * the book to the worker and get the updated book back with their result; evolution never touches
 * it (throwaway mutants would bury the leaderboard). Cancelling terminates the worker outright,
 * which stops a running match immediately; the next job starts a fresh worker.
 */

import type { BatchResult, EvolveResult, GymApi } from '../core';
import type { WorkerRequest, WorkerResponse } from './jobs';
import { RatingBook } from './ratings';

export { reportToText } from './text';
export { MatchRecorder, placementsByStanding } from './recorder';
export { RatingBook, DEFAULT_RATING, type RatingBookJson, type RatingRecord } from './ratings';
export { aggregateReports } from './aggregate';
export { buildBatch, runBatch, type MatchRunner } from './batch';
export { createSimRunner } from './runner';
export { evolve, type ArchiveCell, type GenerationReport } from './evolve';
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

type Job = { id: number; reject: (err: Error) => void; onMessage: (m: WorkerResponse) => void };

export function createGymApi(options: GymOptions = {}): GymApi {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const now = options.now ?? (() => Date.now());
  let book = loadBook(storage);
  let worker: WorkerLike | null = null;
  let job: Job | null = null;
  let nextId = 1;

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
      job = null;
      if (worker === w) dropWorker();
      failed?.reject(new Error(`The gym worker crashed: ${event.message ?? 'unknown error'}`));
    };
    worker = w;
    return w;
  }

  function startJob<T>(request: (id: number) => WorkerRequest, handle: (m: WorkerResponse, resolve: (v: T) => void) => void): Promise<T> {
    if (job) return Promise.reject(new Error('The gym is already running a job; cancel it first.'));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const finish = (v: T) => {
        job = null;
        resolve(v);
      };
      job = {
        id,
        reject,
        onMessage(m) {
          if (m.type === 'error') {
            job = null;
            reject(new Error(m.message));
          } else {
            handle(m, finish);
          }
        },
      };
      try {
        ensureWorker().postMessage(request(id));
      } catch (err) {
        job = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  return {
    runBatch(req, onProgress) {
      return startJob<BatchResult>(
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
        (jobId) => ({ type: 'evolve', jobId, req }),
        (m, resolve) => {
          if (m.type === 'generation') onGeneration?.(m.generation, m.done, m.total);
          else if (m.type === 'evolve_done') resolve(m.result);
        },
      );
    },

    leaderboard: () => book.leaderboard(),

    cancel() {
      const running = job;
      if (!running) return;
      job = null;
      dropWorker();
      running.reject(abortError());
    },
  };
}
