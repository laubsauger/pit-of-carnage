/**
 * Gym Web Worker (module worker). Runs batches and evolution headless with the real sim, brain and
 * validator, so the arena keeps rendering at full speed while hundreds of matches play.
 * Cancelling terminates this worker; the main thread starts a fresh one for the next job.
 */

import type { PickupKind, ValidationResult } from '../core';
import { MAPS, createMatch } from '../sim';
import { HOUSE_STACKS, STARTER_LIBRARY, loadStrategy } from '../strategy';
import { runJob, type JobDeps, type WorkerRequest, type WorkerResponse } from './jobs';
import { collectTerms } from './mutate';
import { createSimRunner, headlessBrainFactory } from './runner';

type WorkerScope = {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};
const scope = self as unknown as WorkerScope;

const mapName = (id: string) => MAPS[id]?.name ?? id;
const mapPickups = (id: string): PickupKind[] => [...new Set((MAPS[id]?.pickups ?? []).map((p) => p.kind))];

/**
 * The one gate (`loadStrategy`) in the result shape the gym works with. Every match also gates its
 * entrants (`headlessBrainFactory`), so a strategy this accepted can never fail at match creation;
 * evolution children are its main customers, hence the source.
 */
function gate(input: unknown): ValidationResult {
  const r = loadStrategy(input, 'evolution');
  return { ok: r.strategy !== undefined, issues: [...r.errors, ...r.warnings], strategy: r.strategy };
}

const deps: JobDeps = {
  runMatch: createSimRunner({ createMatch, brainFactory: headlessBrainFactory, mapName }),
  validate: gate,
  library: STARTER_LIBRARY,
  termPool: collectTerms(Object.values(STARTER_LIBRARY), HOUSE_STACKS),
  houseStacks: HOUSE_STACKS,
  mapName,
  mapPickups,
};

scope.onmessage = (event) => runJob(event.data, deps, (m) => scope.postMessage(m));
