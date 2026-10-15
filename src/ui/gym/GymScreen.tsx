// Owned by: ui
import { useCallback, useDeferredValue, useMemo, useState } from 'react';
import { strategyKey } from '../../core';
import type {
  BatchRequest,
  BatchResult,
  EvolveGeneration,
  EvolveRequest,
  EvolveResult,
  GameController,
  MatchConfig,
  SavedStrategy,
  Strategy,
} from '../../core';
import { loadStrategy } from '../../strategy';
import { newStrategyText, parseJson, prettyJson } from '../editor';
import { strategyLabel } from '../format';
import { useStoredState } from '../hooks';
import { WeaponIcon } from '../icons';
import { toast } from '../toast';
import { BatchPane } from './BatchPane';
import { EvolvePane } from './EvolvePane';
import { StrategyEditor } from './StrategyEditor';

type Tab = 'editor' | 'test' | 'evolve';
const TABS: { id: Tab; label: string }[] = [
  { id: 'editor', label: 'Editor' },
  { id: 'test', label: 'Test' },
  { id: 'evolve', label: 'Evolve' },
];

/** The gym runs one job at a time (see GymApi). */
export type GymJob = { kind: 'idle' } | { kind: 'batch' | 'evolve'; done: number; total: number };

export type BatchOutcome = {
  result: BatchResult;
  /** `strategyKey`s of the strategies under test. */
  candidateKeys: string[];
  /** Every strategy that played, for replaying a match in the arena. */
  strategies: Strategy[];
};

export type EvolveOutcome = {
  parentKey: string;
  generations: EvolveGeneration[];
  /** Null while the run is going. */
  result: EvolveResult | null;
};

type Props = {
  controller: GameController;
  houseStacks: readonly Strategy[];
  saved: SavedStrategy[];
  refreshSaved: () => void;
  onWatch: (config: MatchConfig) => void;
};

const asTab = (v: unknown, fallback: Tab): Tab => (v === 'editor' || v === 'test' || v === 'evolve' ? v : fallback);
const asText = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);

export function GymScreen({ controller, houseStacks, saved, refreshSaved, onWatch }: Props) {
  const [tab, setTab] = useStoredState<Tab>('poc.gym.tab', () => 'editor', asTab);
  const [draft, setDraft] = useStoredState<string>('poc.draft.v1', () => newStrategyText(houseStacks), asText);
  // Text of the draft as last loaded or saved; differs from `draft` when there are unsaved edits.
  const [baseline, setBaseline] = useStoredState<string>('poc.draft.base.v1', () => draft, asText);
  const [job, setJob] = useState<GymJob>({ kind: 'idle' });
  const [batch, setBatch] = useState<BatchOutcome | null>(null);
  const [evolution, setEvolution] = useState<EvolveOutcome | null>(null);

  // Validation runs on a deferred copy so typing stays smooth on long strategies. The editor's text
  // goes through the same gate as any pasted strategy, so its issues carry lines and columns.
  const deferred = useDeferredValue(draft);
  const parsed = useMemo(() => parseJson(deferred), [deferred]);
  const report = useMemo(() => (parsed.ok ? loadStrategy(deferred, 'paste') : null), [parsed, deferred]);
  const strategy = report?.strategy ?? null;

  const latestSaved = useMemo(() => {
    const byName = new Map<string, SavedStrategy>();
    for (const s of saved) {
      const prev = byName.get(s.name);
      if (!prev || s.version > prev.version) byName.set(s.name, s);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [saved]);

  const load = useCallback(
    (s: Strategy) => {
      if (draft !== baseline && !window.confirm('Replace the strategy in the editor? Unsaved changes will be lost.')) return;
      const text = prettyJson(s);
      setDraft(text);
      setBaseline(text);
      setTab('editor');
    },
    [draft, baseline, setDraft, setBaseline, setTab],
  );

  const runBatch = useCallback(
    async (req: BatchRequest) => {
      if (job.kind !== 'idle') return;
      setJob({ kind: 'batch', done: 0, total: req.matches });
      try {
        const result = await controller.gym.runBatch(req, (done, total) => setJob({ kind: 'batch', done, total }));
        setBatch({ result, candidateKeys: req.candidates.map(strategyKey), strategies: [...req.candidates, ...req.field] });
      } catch (err) {
        toast(isAbort(err) ? 'Batch stopped.' : `Batch failed: ${errorText(err)}`);
      } finally {
        setJob({ kind: 'idle' });
      }
    },
    [controller, job.kind],
  );

  const runEvolve = useCallback(
    async (req: EvolveRequest) => {
      if (job.kind !== 'idle') return;
      setJob({ kind: 'evolve', done: 0, total: req.generations });
      setEvolution({ parentKey: strategyKey(req.parent), generations: [], result: null });
      try {
        const result = await controller.gym.evolve(req, (gen, done, total) => {
          setJob({ kind: 'evolve', done, total });
          setEvolution((prev) => (prev ? { ...prev, generations: [...prev.generations, gen] } : prev));
        });
        setEvolution((prev) => (prev ? { ...prev, generations: result.generations, result } : prev));
      } catch (err) {
        toast(isAbort(err) ? 'Evolution stopped.' : `Evolution failed: ${errorText(err)}`);
      } finally {
        setJob({ kind: 'idle' });
      }
    },
    [controller, job.kind],
  );

  const title = strategy ? strategyLabel(strategy.name, strategy.version) : parsed.ok ? draftName(parsed.value) : 'Strategy with errors';
  const currentName = strategy?.name ?? null;

  return (
    <div className="gym">
      <nav className="library" aria-label="Strategy library">
        <div className="lib-new">
          <button type="button" className="btn btn-sm" onClick={() => load(JSON.parse(newStrategyText(houseStacks)) as Strategy)}>
            New strategy
          </button>
        </div>
        <div className="lib-group">
          <span>Your strategies</span>
          <span className="faint num">{latestSaved.length || ''}</span>
        </div>
        {latestSaved.length === 0 ? <div className="lib-empty">Nothing saved yet. Edit a house stack and save it to start your own.</div> : null}
        {latestSaved.map((s) => (
          <button
            key={s.id}
            type="button"
            className="lib-item"
            aria-current={currentName === s.name}
            onClick={() => load({ ...s.strategy, version: s.version })}
            title={`Load ${strategyLabel(s.name, s.version)}`}
          >
            <span className="sb-weapon">
              <WeaponIcon weapon={s.strategy.build.weapon} />
            </span>
            <span className="lib-name">{s.name}</span>
            <span className="faint num">v{s.version}</span>
          </button>
        ))}
        <div className="lib-group">
          <span>House stacks</span>
          <span className="faint num">{houseStacks.length || ''}</span>
        </div>
        {houseStacks.map((s) => (
          <button
            key={strategyKey(s)}
            type="button"
            className="lib-item"
            aria-current={currentName === s.name}
            onClick={() => load(s)}
            title={`Load ${s.name} as a starting point`}
          >
            <span className="sb-weapon">
              <WeaponIcon weapon={s.build.weapon} />
            </span>
            <span className="lib-name">{s.name}</span>
          </button>
        ))}
      </nav>

      <div className="workspace">
        <div className="ws-head">
          <h1 title={title}>{title}</h1>
          {draft !== baseline ? <span className="chip">Unsaved</span> : null}
          <span className="spacer" />
          {job.kind !== 'idle' ? (
            <span className="dim num job-pill">
              {job.kind === 'batch' ? 'Batch' : 'Evolution'} {job.done}/{job.total}
            </span>
          ) : null}
          <div className="subtabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="ws-body">
          {tab === 'editor' ? (
            <StrategyEditor
              controller={controller}
              draft={draft}
              setDraft={setDraft}
              markSaved={setBaseline}
              onLoad={load}
              parsed={parsed}
              checked={deferred}
              report={report}
              strategy={strategy}
              houseStacks={houseStacks}
              saved={saved}
              refreshSaved={refreshSaved}
              lastBatch={batch}
              onTest={() => setTab('test')}
              onWatch={onWatch}
            />
          ) : tab === 'test' ? (
            <BatchPane
              houseStacks={houseStacks}
              saved={latestSaved}
              draft={strategy}
              job={job}
              outcome={batch}
              onRun={runBatch}
              onCancel={() => controller.gym.cancel()}
              onWatch={onWatch}
            />
          ) : (
            <EvolvePane
              houseStacks={houseStacks}
              saved={latestSaved}
              parent={strategy}
              job={job}
              outcome={evolution}
              onRun={runEvolve}
              onCancel={() => controller.gym.cancel()}
              onLoad={load}
              onSave={(s) => {
                const entry = controller.strategies.save(s);
                refreshSaved();
                toast(`Saved ${strategyLabel(entry.name, entry.version)}.`);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function draftName(value: unknown): string {
  const name = (value as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name.trim() ? name : 'Untitled strategy';
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
