import { describe, expect, it } from 'vitest';
import type { StrategySource } from '../core';
import { runJob, type JobDeps, type WorkerResponse } from './jobs';
import { collectTerms } from './mutate';
import { TEST_LIBRARY, fakeRunner, makeStrategy, strictValidate } from './testkit';

const house = [makeStrategy('Gary', { weapon: 'GREATSWORD' }), makeStrategy('Brenda', { weapon: 'LONGBOW' }), makeStrategy('Doug')];
const mine = makeStrategy('Lurking Daggers', { weapon: 'TWIN_DAGGERS', version: 3 });

/** Deps whose gate records the source label of every strategy it checks, by name. */
function recordingDeps(): { deps: JobDeps; sources: Map<string, Set<StrategySource>> } {
  const sources = new Map<string, Set<StrategySource>>();
  const deps: JobDeps = {
    runMatch: fakeRunner(() => 0),
    validate: (input, source) => {
      const name = (input as { name?: string }).name ?? '?';
      if (!sources.has(name)) sources.set(name, new Set());
      sources.get(name)!.add(source ?? 'test');
      return strictValidate(input);
    },
    library: TEST_LIBRARY,
    termPool: collectTerms(Object.values(TEST_LIBRARY), house),
    houseStacks: house,
  };
  return { deps, sources };
}

function finalMessage(messages: WorkerResponse[]): WorkerResponse {
  const last = messages.at(-1);
  if (!last) throw new Error('runJob posted nothing.');
  if (last.type === 'error') throw new Error(`runJob failed: ${last.message}`);
  return last;
}

describe('runJob gate sources', () => {
  // The source only shapes messages and logs, but a wrong label sends a player looking in the wrong
  // place ("evolution child" for their own strategy). House stacks say house, the player's say config.
  it('labels house stacks as house and candidates as config in a batch', () => {
    const { deps, sources } = recordingDeps();
    const out: WorkerResponse[] = [];
    runJob({ type: 'batch', jobId: 1, req: { candidates: [mine], field: house, mapIds: ['pit'], matches: 2, fighters: 3, seed: 7 }, ratings: null, playedAt: 0 }, deps, (m) => out.push(m));
    expect(finalMessage(out).type).toBe('batch_done');
    expect([...sources.get('Lurking Daggers')!]).toEqual(['config']);
    for (const h of house) expect([...sources.get(h.name)!]).toEqual(['house']);
  });

  it('labels the evolution parent as config and only bred children as evolution', () => {
    const { deps, sources } = recordingDeps();
    const out: WorkerResponse[] = [];
    runJob(
      { type: 'evolve', jobId: 2, req: { parent: mine, field: house, mapIds: ['pit'], generations: 2, population: 3, matchesPerCandidate: 2, fighters: 3, seed: 7 } },
      deps,
      (m) => out.push(m),
    );
    expect(finalMessage(out).type).toBe('evolve_done');
    // Children keep the parent's name, so its set holds both labels: config first (the parent), then evolution.
    expect([...sources.get('Lurking Daggers')!]).toEqual(['config', 'evolution']);
    for (const h of house) expect([...sources.get(h.name)!]).toEqual(['house']);
  });
});
