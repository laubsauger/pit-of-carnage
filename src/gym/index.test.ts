import { describe, expect, it } from 'vitest';
import type { BatchRequest } from '../core';
import { createGymApi, RATINGS_STORAGE_KEY, type WorkerLike } from './index';
import { runJob, type JobDeps, type WorkerRequest, type WorkerResponse } from './jobs';
import { TEST_LIBRARY, fakeRunner, makeStrategy, strictValidate } from './testkit';

const house = [makeStrategy('Gary'), makeStrategy('Brenda', { weapon: 'LONGBOW' }), makeStrategy('Doug'), makeStrategy('Mabel')];
const candidate = makeStrategy('Lurking Daggers', { weapon: 'TWIN_DAGGERS', version: 3 });
const deps: JobDeps = {
  runMatch: fakeRunner((s) => (s.name === 'Lurking Daggers' ? 2 : 0), 0.5),
  validate: strictValidate,
  library: TEST_LIBRARY,
  houseStacks: house,
};
const batch: BatchRequest = { candidates: [candidate], field: house, mapIds: ['pit'], matches: 6, fighters: 4, seed: 1 };

/** Runs jobs in-process, asynchronously like a worker, with structured-cloned messages. */
function inProcess(): { create: () => WorkerLike; created: number; terminated: number } {
  const stats = {
    created: 0,
    terminated: 0,
    create(): WorkerLike {
      stats.created++;
      let alive = true;
      const w: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage(msg) {
          setTimeout(() => runJob(structuredClone(msg), deps, (m) => alive && w.onmessage?.({ data: structuredClone(m) })), 0);
        },
        terminate() {
          alive = false;
          stats.terminated++;
        },
      };
      return w;
    },
  };
  return stats;
}

/** A worker that holds messages until the test answers them. */
function manual(): { create: () => WorkerLike; workers: { w: WorkerLike; sent: WorkerRequest[]; reply: (m: WorkerResponse) => void }[] } {
  const workers: { w: WorkerLike; sent: WorkerRequest[]; reply: (m: WorkerResponse) => void }[] = [];
  return {
    workers,
    create() {
      const sent: WorkerRequest[] = [];
      const w: WorkerLike = { onmessage: null, onerror: null, postMessage: (m) => sent.push(m), terminate() {} };
      workers.push({ w, sent, reply: (m) => w.onmessage?.({ data: m }) });
      return w;
    },
  };
}

function memoryStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

describe('createGymApi', () => {
  // The Gym screen shows a progress bar and then the reports; the Room shows the leaderboard.
  it('runs a batch off the main thread with progress, then updates and persists the leaderboard', async () => {
    const storage = memoryStorage();
    const gym = createGymApi({ createWorker: inProcess().create, storage, now: () => 123 });
    expect(gym.leaderboard()).toEqual([]);
    const progress: [number, number][] = [];
    const result = await gym.runBatch(batch, (done, total) => progress.push([done, total]));
    expect(result.reports).toHaveLength(6);
    expect(progress.at(-1)).toEqual([6, 6]);
    const board = gym.leaderboard();
    expect(board[0]!.key).toBe('Lurking Daggers@v3');
    expect(board[0]).toMatchObject({ matches: 6, lastPlayedAt: 123 });
    // A fresh session reads the stored book back.
    expect(storage.data.has(RATINGS_STORAGE_KEY)).toBe(true);
    expect(createGymApi({ createWorker: inProcess().create, storage }).leaderboard()).toEqual(board);
    // A second batch continues from the stored ratings instead of starting over.
    await gym.runBatch({ ...batch, seed: 2 });
    expect(gym.leaderboard()[0]!.matches).toBe(12);
  });

  // Evolution reports each generation (with the archive) and never touches the leaderboard.
  it('streams evolution generations and keeps mutants off the leaderboard', async () => {
    const gym = createGymApi({ createWorker: inProcess().create, storage: null });
    const seen: number[] = [];
    let archiveSize = 0;
    const result = await gym.evolve(
      { parent: candidate, field: house, mapIds: ['pit'], generations: 2, population: 3, matchesPerCandidate: 2, fighters: 4, seed: 9 },
      (gen, done, total) => {
        seen.push(done * 10 + total);
        archiveSize = (gen as { archive?: unknown[] }).archive?.length ?? 0;
      },
    );
    expect(seen).toEqual([12, 22]);
    expect(archiveSize).toBeGreaterThan(0);
    expect(result.generations).toHaveLength(2);
    expect(gym.leaderboard()).toEqual([]);
  });

  // Cancel must stop a long batch immediately and leave the gym usable.
  it('cancels by rejecting with AbortError, ignores the stopped worker, and starts fresh next time', async () => {
    const m = manual();
    const gym = createGymApi({ createWorker: m.create, storage: null });
    const running = gym.runBatch(batch);
    gym.cancel();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    // A late answer from the cancelled job changes nothing.
    m.workers[0]!.reply({ type: 'batch_done', jobId: m.workers[0]!.sent[0]!.jobId, result: { reports: [], aggregate: { matches: 0, seed: 1, mapIds: [], endings: {}, suddenDeath: { matches: 0, share: 0, byReason: {}, avgStartTick: null }, judges: { matches: 0, share: 0, decisions: [] }, strategies: [], findings: [] } }, ratings: { schema: 'pit-ratings/1', records: [{ key: 'X@v1', name: 'X', version: 1, mu: 40, sigma: 2, matches: 1, wins: 1, placeSum: 1, lastPlayedAt: 0 }] } });
    expect(gym.leaderboard()).toEqual([]);
    const next = gym.runBatch(batch);
    expect(m.workers).toHaveLength(2);
    gym.cancel();
    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('runs one job at a time and reports worker errors as errors', async () => {
    const m = manual();
    const gym = createGymApi({ createWorker: m.create, storage: null });
    const first = gym.runBatch(batch);
    await expect(gym.runBatch(batch)).rejects.toThrow(/already running/);
    m.workers[0]!.reply({ type: 'error', jobId: m.workers[0]!.sent[0]!.jobId, message: 'Candidate "X" is invalid.' });
    await expect(first).rejects.toThrow('Candidate "X" is invalid.');
    const second = gym.runBatch(batch);
    m.workers[0]!.w.onerror?.({ message: 'boom' });
    await expect(second).rejects.toThrow(/crashed: boom/);
  });

  // Strategies are checked before any match runs; a broken one is named, not silently skipped.
  it('refuses a batch with an invalid strategy', async () => {
    const gym = createGymApi({ createWorker: inProcess().create, storage: null });
    const broken = { ...candidate, name: 'Broken', build: { ...candidate.build, attributes: { ...candidate.build.attributes, power: 99 } } };
    await expect(gym.runBatch({ ...batch, candidates: [broken] })).rejects.toThrow(/Candidate "Broken" is invalid/);
  });

  // The top-bar chip shows a running batch or evolution on every screen ("Evolving: gen 4 of 20")
  // and must disappear the moment the job ends, however it ends.
  it('publishes the running job with its progress for the top-bar chip, and clears it at the end', async () => {
    let changes = 0;
    const gym = createGymApi({ createWorker: inProcess().create, storage: null, onJobsChange: () => changes++ });
    expect(gym.jobs()).toEqual([]);
    const labels: string[] = [];
    const done = gym.runBatch(batch, () => labels.push(gym.jobs()[0]!.label));
    expect(gym.jobs()).toEqual([{ id: expect.any(Number), kind: 'batch', label: 'Testing: 0 of 6 matches', done: 0, total: 6 }]);
    expect(gym.jobs()).toBe(gym.jobs());
    await done;
    expect(labels).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Testing: ${n} of 6 matches`));
    expect(gym.jobs()).toEqual([]);
    expect(changes).toBe(8); // start, six matches, end

    const gens: string[] = [];
    const evolving = gym.evolve(
      { parent: candidate, field: house, mapIds: ['pit'], generations: 2, population: 2, matchesPerCandidate: 2, fighters: 4, seed: 9 },
      () => gens.push(`${gym.jobs()[0]!.kind} ${gym.jobs()[0]!.label}`),
    );
    expect(gym.jobs()[0]).toMatchObject({ kind: 'evolve', label: 'Evolving: gen 1 of 2', done: 0, total: 2 });
    await evolving;
    expect(gens).toEqual(['evolve Evolving: gen 2 of 2', 'evolve Evolving: gen 2 of 2']);
    expect(gym.jobs()).toEqual([]);
  });

  it('clears the chip when a job is cancelled or fails', async () => {
    const m = manual();
    const gym = createGymApi({ createWorker: m.create, storage: null });
    const cancelled = gym.runBatch(batch);
    expect(gym.jobs()).toHaveLength(1);
    gym.cancel();
    expect(gym.jobs()).toEqual([]);
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    const failed = gym.runBatch(batch);
    m.workers[1]!.reply({ type: 'progress', jobId: m.workers[1]!.sent[0]!.jobId, done: 2, total: 6 });
    expect(gym.jobs()[0]).toMatchObject({ label: 'Testing: 2 of 6 matches', done: 2 });
    m.workers[1]!.w.onerror?.({ message: 'boom' });
    expect(gym.jobs()).toEqual([]);
    await expect(failed).rejects.toThrow(/crashed: boom/);
  });

  // Compare runs in the worker like any job: gated strategies, progress over both sides, no ratings.
  it('compares two versions over the same seeds off the main thread without touching the leaderboard', async () => {
    const gym = createGymApi({ createWorker: inProcess().create, storage: null });
    const v2 = makeStrategy('Lurking Daggers', { weapon: 'TWIN_DAGGERS', version: 2 });
    const progress: number[] = [];
    const running = gym.compare({ a: candidate, b: v2, field: house, mapIds: ['pit'], matches: 3, fighters: 4, seed: 2 }, (d) => progress.push(d));
    expect(gym.jobs()[0]).toMatchObject({ kind: 'batch', label: 'Comparing: 0 of 6 matches' });
    const result = await running;
    expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.matches.map((x) => x.seed)).toEqual(result.reportsB.map((r) => r.seed));
    expect([result.a.key, result.b.key]).toEqual(['Lurking Daggers@v3', 'Lurking Daggers@v2']);
    expect(gym.leaderboard()).toEqual([]);
    await expect(gym.compare({ a: candidate, b: { ...v2, name: 'Broken', build: { ...v2.build, attributes: { ...v2.build.attributes, power: 99 } } }, field: house, mapIds: ['pit'], matches: 1, fighters: 4, seed: 2 })).rejects.toThrow(
      /Strategy to compare "Broken" is invalid/,
    );
  });
});
