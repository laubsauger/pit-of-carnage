// Owned by: ui
import { MAX_FIGHTERS, MIN_FIGHTERS } from '../../core';
import type { BatchRequest, MatchConfig, SavedStrategy, Strategy } from '../../core';
import { batchLineup, batchProblem, sanitizeForm } from '../batch';
import type { BatchForm } from '../batch';
import { useStoredState } from '../hooks';
import { DiceIcon } from '../icons';
import { randomSeed } from '../setup';
import { NumberField } from '../widgets';
import type { BatchOutcome, GymJob } from './GymScreen';
import { Picklist } from './Picklist';
import { ReportView } from './ReportView';
import { DRAFT_REF, defaultBatchForm, mapItems, mapNames, resolveRefs, strategyOptions } from './options';

type Props = {
  houseStacks: readonly Strategy[];
  /** Latest version of each saved strategy. */
  saved: SavedStrategy[];
  /** The editor's strategy when it validates, else null. */
  draft: Strategy | null;
  job: GymJob;
  outcome: BatchOutcome | null;
  onRun: (req: BatchRequest) => void;
  onCancel: () => void;
  onWatch: (config: MatchConfig) => void;
};

/** Batch runs: pick who is tested, who they fight and where, then read the report. */
export function BatchPane({ houseStacks, saved, draft, job, outcome, onRun, onCancel, onWatch }: Props) {
  const [form, setForm] = useStoredState<BatchForm>('poc.gym.batch.v1', () => defaultBatchForm(houseStacks), sanitizeForm);
  const opts = strategyOptions(houseStacks, saved, draft);
  const patch = (p: Partial<BatchForm>) => setForm((prev) => ({ ...prev, ...p }));

  const lineup = batchLineup(resolveRefs(form.candidates, opts.byRef), resolveRefs(form.field, opts.byRef));
  const maps = form.maps.filter((id) => mapItems().some((m) => m.ref === id));
  const problem = batchProblem({
    candidates: lineup.candidates.length,
    field: lineup.field.length,
    maps: maps.length,
    matches: form.matches,
    fighters: form.fighters,
  });
  const draftLeftOut = form.candidates.includes(DRAFT_REF) && !draft;
  const running = job.kind === 'batch';
  const busy = job.kind !== 'idle';

  const run = () => {
    if (problem || busy) return;
    onRun({ candidates: lineup.candidates, field: lineup.field, mapIds: maps, matches: form.matches, fighters: form.fighters, seed: form.seed >>> 0 });
  };

  return (
    <div className="pane">
      <p className="pane-intro">
        Every match gives each tested strategy one slot and fills the rest from the opponents. Same seed, same matches: change
        one thing, run again, compare.
      </p>
      <div className="pick-cols">
        <Picklist
          title="Test"
          items={[...(opts.draft ? [opts.draft] : []), ...opts.mine]}
          selected={form.candidates}
          onChange={(candidates) => patch({ candidates })}
          empty="Save a strategy or fix the one in the editor to test it."
        />
        <Picklist title="Against" items={[...opts.house, ...opts.mine]} selected={form.field} onChange={(field) => patch({ field })} />
        <Picklist title="Maps" items={mapItems()} selected={form.maps} onChange={(m) => patch({ maps: m })} />
      </div>

      <div className="form-grid">
        <NumberField label="Matches" value={form.matches} min={1} max={500} onChange={(matches) => patch({ matches })} />
        <NumberField label="Fighters per match" value={form.fighters} min={MIN_FIGHTERS} max={MAX_FIGHTERS} onChange={(fighters) => patch({ fighters })} />
        <NumberField
          label="Seed"
          value={form.seed}
          min={0}
          max={0xffffffff}
          width={120}
          onChange={(seed) => patch({ seed })}
          after={
            <button type="button" className="btn btn-icon" onClick={() => patch({ seed: randomSeed() })} title="New seed" aria-label="New seed">
              <DiceIcon />
            </button>
          }
        />
      </div>

      <div className="run-bar">
        {running ? (
          <>
            <button type="button" className="btn" onClick={onCancel}>
              Stop
            </button>
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={job.total} aria-valuenow={job.done}>
              <div style={{ width: `${job.total > 0 ? (job.done / job.total) * 100 : 0}%` }} />
            </div>
            <span className="dim num">
              Match {Math.min(job.done + 1, job.total)} of {job.total}
            </span>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-primary" disabled={!!problem || busy} onClick={run}>
              Run batch
            </button>
            {busy ? (
              <span className="dim">Evolution is running. One gym job at a time.</span>
            ) : problem ? (
              <span className="error-line">{problem}</span>
            ) : (
              <span className="dim">
                {form.matches} {form.matches === 1 ? 'match' : 'matches'} of {form.fighters} on {mapNames(maps)}.
              </span>
            )}
          </>
        )}
      </div>
      {draftLeftOut ? <p className="error-line">The strategy in the editor has errors, so it sits this one out.</p> : null}

      {outcome ? <ReportView outcome={outcome} onWatch={onWatch} /> : null}
    </div>
  );
}
