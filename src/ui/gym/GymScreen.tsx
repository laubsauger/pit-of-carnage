// Owned by: ui
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { strategyKey } from '../../core';
import type {
  BatchRequest,
  BatchResult,
  EvolveGeneration,
  EvolveRequest,
  EvolveResult,
  GameController,
  GymApi,
  SavedStrategy,
  Strategy,
} from '../../core';
import type { CompareRequest, GymService } from '../../gym';
import { loadStrategy } from '../../strategy';
import type { WatchRequest } from '../App';
import { newStrategyText, parseJson, prettyJson } from '../editor';
import { strategyLabel } from '../format';
import { usePane, useStoredState } from '../hooks';
import { WeaponIcon } from '../icons';
import { paneExtent } from '../panes';
import { toast } from '../toast';
import { PaneHandle, PaneToggle } from '../widgets';
import { BatchPane } from './BatchPane';
import type { CompareOutcome } from './CompareView';
import { EvolvePane } from './EvolvePane';
import { StrategyEditor } from './StrategyEditor';

export type GymTab = 'editor' | 'test' | 'evolve';
type Tab = GymTab;
const TABS: { id: Tab; label: string }[] = [
  { id: 'editor', label: 'Editor' },
  { id: 'test', label: 'Test' },
  { id: 'evolve', label: 'Evolve' },
];

/** The gym runs one job at a time (see GymApi). */
export type GymJob = { kind: 'idle' } | { kind: 'batch' | 'evolve' | 'compare'; done: number; total: number };

/**
 * The gym service behind `GameController.gym` also runs paired comparisons (src/gym `GymService`),
 * though the shared `GymApi` contract does not promise it yet; the Compare mode shows only when it is there.
 */
type GymWithCompare = GymApi & Pick<GymService, 'compare'>;
function canCompare(g: GymApi): g is GymWithCompare {
  return typeof (g as Partial<GymWithCompare>).compare === 'function';
}

export type BatchOutcome = {
  result: BatchResult;
  /** `strategyKey`s of the strategies under test. */
  candidateKeys: string[];
  /** Every strategy that played, for replaying a match in the arena. */
  strategies: Strategy[];
};

export type EvolveOutcome = {
  parentKey: string;
  /** The run's request: its field, maps and fighters, for watching an entry fight. */
  request: EvolveRequest;
  generations: EvolveGeneration[];
  /** Null while the run is going. */
  result: EvolveResult | null;
};

type Props = {
  controller: GameController;
  /** The Gym is the screen showing (a job finishing elsewhere gets a toast). */
  active: boolean;
  houseStacks: readonly Strategy[];
  saved: SavedStrategy[];
  refreshSaved: () => void;
  tab: Tab;
  setTab: (t: Tab) => void;
  /** "Back to the report" from the Watch screen: bring that match row of the batch report into view. */
  reportFocus: { matchIndex: number | null; n: number } | null;
  /** "Open in gym" from a strategy sheet: load this strategy into the editor. */
  openRequest: { strategy: Strategy; n: number } | null;
  onWatch: (req: WatchRequest) => void;
};

const asText = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);

export function GymScreen({ controller, active, houseStacks, saved, refreshSaved, tab, setTab, reportFocus, openRequest, onWatch }: Props) {
  const [library, setLibrary] = usePane('gym.library');
  const [draft, setDraft] = useStoredState<string>('poc.draft.v1', () => newStrategyText(houseStacks), asText);
  // Text of the draft as last loaded or saved; differs from `draft` when there are unsaved edits.
  const [baseline, setBaseline] = useStoredState<string>('poc.draft.base.v1', () => draft, asText);
  const [job, setJob] = useState<GymJob>({ kind: 'idle' });
  const [batch, setBatch] = useState<BatchOutcome | null>(null);
  const [evolution, setEvolution] = useState<EvolveOutcome | null>(null);
  const [comparison, setComparison] = useState<CompareOutcome | null>(null);

  // Validation runs on a deferred copy so typing stays smooth on long strategies. The editor's text
  // goes through the same gate as any pasted strategy, so its issues carry lines and columns.
  const deferred = useDeferredValue(draft);
  const parsed = useMemo(() => parseJson(deferred), [deferred]);
  const report = useMemo(() => (parsed.ok ? loadStrategy(deferred, 'editor') : null), [parsed, deferred]);
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

  // "Open in gym" from a strategy sheet. Handled once per request number.
  const handledOpen = useRef(0);
  useEffect(() => {
    if (!openRequest || openRequest.n === handledOpen.current) return;
    handledOpen.current = openRequest.n;
    load(openRequest.strategy);
  }, [openRequest, load]);

  // Jobs run on while the player watches matches; say so when one finishes off screen.
  const activeRef = useRef(active);
  activeRef.current = active;

  const runBatch = useCallback(
    async (req: BatchRequest) => {
      if (job.kind !== 'idle') return;
      setJob({ kind: 'batch', done: 0, total: req.matches });
      try {
        const result = await controller.gym.runBatch(req, (done, total) => setJob({ kind: 'batch', done, total }));
        setBatch({ result, candidateKeys: req.candidates.map(strategyKey), strategies: [...req.candidates, ...req.field] });
        if (!activeRef.current) toast(`Batch done: ${result.reports.length} matches. The report is in the Gym.`);
      } catch (err) {
        toast(isAbort(err) ? 'Batch stopped.' : `Batch failed: ${errorText(err)}`);
      } finally {
        setJob({ kind: 'idle' });
      }
    },
    [controller, job.kind],
  );

  const runCompare = useCallback(
    async (req: CompareRequest) => {
      const gym = controller.gym;
      if (job.kind !== 'idle' || !canCompare(gym)) return;
      setJob({ kind: 'compare', done: 0, total: req.matches * 2 });
      try {
        const result = await gym.compare(req, (done, total) => setJob({ kind: 'compare', done, total }));
        setComparison({ request: req, result });
        if (!activeRef.current) toast(`Comparison done: ${result.findings[0] ?? 'the numbers are in the Gym.'}`);
      } catch (err) {
        toast(isAbort(err) ? 'Comparison stopped.' : `Comparison failed: ${errorText(err)}`);
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
      setEvolution({ parentKey: strategyKey(req.parent), request: req, generations: [], result: null });
      try {
        const result = await controller.gym.evolve(req, (gen, done, total) => {
          setJob({ kind: 'evolve', done, total });
          setEvolution((prev) => (prev ? { ...prev, generations: [...prev.generations, gen] } : prev));
        });
        setEvolution((prev) => (prev ? { ...prev, generations: result.generations, result } : prev));
        if (!activeRef.current) toast(`Evolution done: ${result.summary}`);
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
    <div className="gym" style={{ '--lib-w': `${paneExtent(library)}px` } as CSSProperties}>
      <nav className={`library${library.collapsed ? ' collapsed' : ''}`} aria-label="Strategy library">
        <PaneToggle side="left" collapsed={library.collapsed} label="Library" onToggle={() => setLibrary((p) => ({ ...p, collapsed: !p.collapsed }))} />
        {library.collapsed ? null : <PaneHandle id="gym.library" setPane={setLibrary} label="Library" />}
        {library.collapsed ? null : (
          <>
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
          </>
        )}
      </nav>

      <div className="workspace">
        <div className="ws-head">
          <h1 title={title}>{title}</h1>
          {draft !== baseline ? <span className="chip">Unsaved</span> : null}
          <span className="spacer" />
          {job.kind !== 'idle' ? (
            <span className="dim num job-pill">
              {job.kind === 'batch' ? 'Batch' : job.kind === 'compare' ? 'Comparison' : 'Evolution'} {job.done}/{job.total}
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
              onWatch={(config) => onWatch({ config })}
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
              focus={reportFocus}
              comparison={comparison}
              onCompare={canCompare(controller.gym) ? runCompare : null}
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
              onWatch={onWatch}
              onSave={(s, generation) => {
                const entry = controller.strategies.save(s, { origin: { kind: 'evolution', generation } });
                refreshSaved();
                toast(`Saved ${strategyLabel(entry.name, entry.version)}, evolved in generation ${generation}.`);
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
