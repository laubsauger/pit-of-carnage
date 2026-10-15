// Owned by: ui
import { MAX_FIGHTERS, MIN_FIGHTERS, strategyKey } from '../../core';
import type { BatchRequest, SavedStrategy, Strategy } from '../../core';
import type { CompareRequest } from '../../gym';
import type { WatchRequest } from '../App';
import { batchLineup, batchProblem, compareProblem, sanitizeForm } from '../batch';
import type { BatchForm } from '../batch';
import { useStoredState } from '../hooks';
import { DiceIcon } from '../icons';
import { randomSeed } from '../setup';
import { NumberField } from '../widgets';
import { CompareView } from './CompareView';
import type { CompareOutcome } from './CompareView';
import type { BatchOutcome, GymJob } from './GymScreen';
import { Picklist } from './Picklist';
import type { PickItem } from './Picklist';
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
  onWatch: (req: WatchRequest) => void;
  /** Back from the arena: the match row to bring into view. */
  focus: { matchIndex: number | null; n: number } | null;
  comparison: CompareOutcome | null;
  /** Run a paired comparison; null when the gym cannot (the Compare mode is then hidden). */
  onCompare: ((req: CompareRequest) => void) | null;
};

type Mode = 'batch' | 'compare';
const asMode = (v: unknown, fallback: Mode): Mode => (v === 'batch' || v === 'compare' ? v : fallback);
/** The two sides of a comparison, as strategy refs (see options.ts). */
type Sides = { a: string; b: string };
const asSides = (v: unknown, fallback: Sides): Sides =>
  typeof v === 'object' && v !== null && typeof (v as Sides).a === 'string' && typeof (v as Sides).b === 'string' ? (v as Sides) : fallback;

/** Batch runs: pick who is tested, who they fight and where, then read the report. Or compare two. */
export function BatchPane({ houseStacks, saved, draft, job, outcome, onRun, onCancel, onWatch, focus, comparison, onCompare }: Props) {
  const [form, setForm] = useStoredState<BatchForm>('poc.gym.batch.v1', () => defaultBatchForm(houseStacks), sanitizeForm);
  const [storedMode, setMode] = useStoredState<Mode>('poc.gym.testMode', () => 'batch', asMode);
  const [sides, setSides] = useStoredState<Sides>('poc.gym.compare.v1', () => ({ a: DRAFT_REF, b: '' }), asSides);
  const mode: Mode = onCompare ? storedMode : 'batch';
  const opts = strategyOptions(houseStacks, saved, draft);
  const patch = (p: Partial<BatchForm>) => setForm((prev) => ({ ...prev, ...p }));

  const lineup = batchLineup(resolveRefs(form.candidates, opts.byRef), resolveRefs(form.field, opts.byRef));
  const maps = form.maps.filter((id) => mapItems().some((m) => m.ref === id));
  const sideA = opts.byRef.get(sides.a) ?? null;
  const sideB = opts.byRef.get(sides.b) ?? null;
  const sameSide = !!sideA && !!sideB && strategyKey(sideA) === strategyKey(sideB);
  const compareField = resolveRefs(form.field, opts.byRef).filter((s) => (!sideA || strategyKey(s) !== strategyKey(sideA)) && (!sideB || strategyKey(s) !== strategyKey(sideB)));
  const problem =
    mode === 'batch'
      ? batchProblem({ candidates: lineup.candidates.length, field: lineup.field.length, maps: maps.length, matches: form.matches, fighters: form.fighters })
      : compareProblem({ a: !!sideA, b: !!sideB, same: sameSide, field: compareField.length, maps: maps.length, matches: form.matches, fighters: form.fighters });
  const draftLeftOut = mode === 'batch' && form.candidates.includes(DRAFT_REF) && !draft;
  const running = job.kind === mode;
  const busy = job.kind !== 'idle';
  const allSides: PickItem[] = [...(opts.draft ? [opts.draft] : []), ...opts.mine, ...opts.house];

  const run = () => {
    if (problem || busy) return;
    if (mode === 'batch') {
      onRun({ candidates: lineup.candidates, field: lineup.field, mapIds: maps, matches: form.matches, fighters: form.fighters, seed: form.seed >>> 0 });
    } else if (onCompare && sideA && sideB) {
      onCompare({ a: sideA, b: sideB, field: compareField, mapIds: maps, matches: form.matches, fighters: form.fighters, seed: form.seed >>> 0 });
    }
  };

  return (
    <div className="pane">
      {onCompare ? (
        <div className="seg pane-mode" role="group" aria-label="Test mode">
          <button type="button" aria-pressed={mode === 'batch'} onClick={() => setMode('batch')}>
            Batch
          </button>
          <button type="button" aria-pressed={mode === 'compare'} onClick={() => setMode('compare')}>
            Compare two
          </button>
        </div>
      ) : null}
      <p className="pane-intro">
        {mode === 'batch'
          ? 'Every match gives each tested strategy one slot and fills the rest from the opponents. Same seed, same matches: change one thing, run again, compare.'
          : 'Both strategies play the same seeds, maps, opponents and seat, and never meet, so a gap comes from the strategies and not from who drew the easier fights. Not rated.'}
      </p>
      <div className="pick-cols">
        {mode === 'batch' ? (
          <Picklist
            title="Test"
            items={[...(opts.draft ? [opts.draft] : []), ...opts.mine]}
            selected={form.candidates}
            onChange={(candidates) => patch({ candidates })}
            empty="Save a strategy or fix the one in the editor to test it."
          />
        ) : (
          <div className="picklist compare-sides">
            <div className="picklist-head">
              <span>Compare</span>
            </div>
            <div className="compare-pick">
              <SideSelect label="A" value={sides.a} items={allSides} onChange={(a) => setSides({ ...sides, a })} />
              <SideSelect label="B" value={sides.b} items={allSides} onChange={(b) => setSides({ ...sides, b })} />
              <p className="faint">Two strategies, or two versions of one. They are left out of the opponents.</p>
            </div>
          </div>
        )}
        <Picklist title="Against" items={[...opts.house, ...opts.mine]} selected={form.field} onChange={(field) => patch({ field })} />
        <Picklist title="Maps" items={mapItems()} selected={form.maps} onChange={(m) => patch({ maps: m })} />
      </div>

      <div className="form-grid">
        <NumberField label={mode === 'batch' ? 'Matches' : 'Shared seeds'} value={form.matches} min={1} max={500} onChange={(matches) => patch({ matches })} />
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
              {mode === 'batch' ? 'Run batch' : 'Compare'}
            </button>
            {busy ? (
              <span className="dim">Another gym job is running. One at a time.</span>
            ) : problem ? (
              <span className="error-line">{problem}</span>
            ) : (
              <span className="dim">
                {mode === 'batch'
                  ? `${form.matches} ${form.matches === 1 ? 'match' : 'matches'} of ${form.fighters} on ${mapNames(maps)}.`
                  : `${form.matches} shared ${form.matches === 1 ? 'seed' : 'seeds'} for each side (${form.matches * 2} matches) on ${mapNames(maps)}.`}
              </span>
            )}
          </>
        )}
      </div>
      {draftLeftOut ? <p className="error-line">The strategy in the editor has errors, so it sits this one out.</p> : null}

      {mode === 'batch' && outcome ? <ReportView outcome={outcome} onWatch={onWatch} focus={focus} /> : null}
      {mode === 'compare' && comparison ? <CompareView outcome={comparison} onWatch={onWatch} /> : null}
    </div>
  );
}

function SideSelect({ label, value, items, onChange }: { label: string; value: string; items: PickItem[]; onChange: (ref: string) => void }) {
  return (
    <label className="side-select">
      <span className="side-tag">{label}</span>
      <select className="select" value={items.some((i) => i.ref === value) ? value : ''} onChange={(e) => onChange(e.target.value)}>
        <option value="" disabled>
          Pick a strategy
        </option>
        {items.map((i) => (
          <option key={i.ref} value={i.ref}>
            {i.label}
            {i.note ? ` (${i.note})` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
