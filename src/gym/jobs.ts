/**
 * The gym worker's side of the protocol: one request in, progress messages and one final message
 * out. Kept free of worker globals so it runs the same in the worker, in tests and in-process.
 */

import { strategyKey } from '../core';
import type { BatchRequest, BatchResult, EvolveRequest, EvolveResult, Strategy } from '../core';
import { runBatch } from './batch';
import { runCompare, type CompareRequest, type CompareResult } from './compare';
import { evolve, type EvolveDeps, type GenerationReport } from './evolve';
import { RatingBook, type RatingBookJson } from './ratings';

export type WorkerRequest =
  | { type: 'batch'; jobId: number; req: BatchRequest; ratings: RatingBookJson | null; playedAt: number }
  | { type: 'evolve'; jobId: number; req: EvolveRequest }
  | { type: 'compare'; jobId: number; req: CompareRequest };

export type WorkerResponse =
  | { type: 'progress'; jobId: number; done: number; total: number }
  | { type: 'generation'; jobId: number; generation: GenerationReport; done: number; total: number }
  | { type: 'batch_done'; jobId: number; result: BatchResult; ratings: RatingBookJson }
  | { type: 'evolve_done'; jobId: number; result: EvolveResult }
  | { type: 'compare_done'; jobId: number; result: CompareResult }
  | { type: 'error'; jobId: number; message: string };

export type JobDeps = EvolveDeps & {
  /** Built-in opponents; a field made only of these is called "the house stacks" in findings. */
  houseStacks: readonly Strategy[];
};

/** Validated (normalized) copies, or an error naming the first broken strategy. House stacks are gated as `house`. */
function validated(list: readonly Strategy[], role: string, deps: JobDeps): Strategy[] {
  const house = new Set(deps.houseStacks.map(strategyKey));
  return list.map((s) => {
    const isHouse = typeof s === 'object' && s !== null && house.has(strategyKey(s));
    const r = deps.validate(s, isHouse ? 'house' : 'config');
    if (r.ok) return r.strategy ?? s;
    const first = r.issues.find((i) => i.severity === 'error');
    throw new Error(`${role} "${s?.name ?? '?'}" is invalid${first ? ` (${first.path}: ${first.message})` : ''}.`);
  });
}

function fieldLabel(field: readonly Strategy[], houseStacks: readonly Strategy[]): string {
  const house = new Set(houseStacks.map(strategyKey));
  return field.length > 0 && field.every((s) => house.has(strategyKey(s))) ? 'the house stacks' : 'the field';
}

export function runJob(msg: WorkerRequest, deps: JobDeps, post: (m: WorkerResponse) => void): void {
  const { jobId } = msg;
  try {
    if (msg.type === 'batch') {
      const req: BatchRequest = {
        ...msg.req,
        candidates: validated(msg.req.candidates, 'Candidate', deps),
        field: validated(msg.req.field, 'Field strategy', deps),
      };
      const book = RatingBook.fromJSON(msg.ratings);
      const result = runBatch(req, deps.runMatch, {
        book,
        playedAt: msg.playedAt,
        fieldLabel: fieldLabel(req.field, deps.houseStacks),
        mapName: deps.mapName,
        mapPickups: deps.mapPickups,
        onProgress: (done, total) => post({ type: 'progress', jobId, done, total }),
      });
      post({ type: 'batch_done', jobId, result, ratings: book.toJSON() });
    } else if (msg.type === 'evolve') {
      const req: EvolveRequest = { ...msg.req, field: validated(msg.req.field, 'Field strategy', deps) };
      const result = evolve(req, deps, (generation, done, total) => post({ type: 'generation', jobId, generation, done, total }));
      post({ type: 'evolve_done', jobId, result });
    } else {
      const [a, b] = validated([msg.req.a, msg.req.b], 'Strategy to compare', deps);
      const req: CompareRequest = { ...msg.req, a: a!, b: b!, field: validated(msg.req.field, 'Field strategy', deps) };
      const result = runCompare(req, deps.runMatch, {
        mapName: deps.mapName,
        mapPickups: deps.mapPickups,
        onProgress: (done, total) => post({ type: 'progress', jobId, done, total }),
      });
      post({ type: 'compare_done', jobId, result });
    }
  } catch (err) {
    post({ type: 'error', jobId, message: err instanceof Error ? err.message : String(err) });
  }
}
