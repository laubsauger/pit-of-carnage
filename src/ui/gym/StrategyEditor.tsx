// Owned by: ui
import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  ATTRIBUTE_BUDGET,
  ATTRIBUTE_DOCS,
  ATTRIBUTE_MAX,
  ATTRIBUTE_MIN,
  DEFAULT_FIGHTERS,
  DEFAULT_MAP_ID,
  SKILLS,
  SKILL_IDS,
  STAT_DOCS,
  WEAPONS,
  deriveStats,
  strategyKey,
} from '../../core';
import type { CompareRequest, DerivedStats, GameController, LoadReport, MatchConfig, SavedOrigin, SavedStrategy, SkillId, Strategy, ValidationIssue } from '../../core';
import { reportToText } from '../../gym';
import { buildLlmPrompt, encodeStrategyCode } from '../../strategy';
import { budget, completeAttributes, inlineJson, issueAtCaret, lineCol, parseJson, placeIssues, prettyJson, readAttributes, readWeapon } from '../editor';
import type { IssueSpan, JsonParse } from '../editor';
import { Builder } from '../editor/Builder';
import type { BuilderApi } from '../editor/Builder';
import { HistoryPanel } from '../editor/History';
import type { CompareSide } from '../editor/History';
import { SEVERITY_SVG, fixText, suggestionLine } from '../editor/issues';
import { setAt, stampVersion } from '../editor/edit';
import type { PathSeg } from '../editor/jsontext';
import { SaveDialog } from '../editor/SaveDialog';
import { EDITOR_SIDE, EDITOR_SIDE_KEY, dragSideWidth, sanitizeSideWidth } from '../editor/sidepane';
import { baseLine, draftIdentity, draftBase, nextVersionOf, savePlan, savedMessage, withoutVersion } from '../editor/versions';
import type { SaveChoice, SavePlan } from '../editor/versions';
import type { CardBuild } from '../editor/WordCard';
import { buildLine, formatStat, strategyLabel } from '../format';
import { useStoredState } from '../hooks';
import { CloseIcon, ImportIcon } from '../icons';
import { issueSpot } from '../importer';
import { RANDOM_SLOT, buildMatchConfig, buildPool, defaultSetup, randomSeed } from '../setup';
import { copyAndToast, copyText, toast } from '../toast';
import { ATTRIBUTE_LABEL } from '../widgets';
import type { CodeAreaApi } from './CodeArea';
import { CompareView } from './CompareView';
import type { CompareOutcome } from './CompareView';
import type { BatchOutcome } from './GymScreen';
import { ImportDialog } from './ImportDialog';
import type { LlmPaste } from './ImportDialog';
import '../editor/editor.css';

// CodeMirror and the Codex are big: each gets its own chunk, loaded when first shown.
const CodeArea = lazy(() => import('./CodeArea').then((m) => ({ default: m.CodeArea })));
const CodexDialog = lazy(() => import('../codex/Codex').then((m) => ({ default: m.CodexDialog })));

type Props = {
  controller: GameController;
  draft: string;
  setDraft: (text: string) => void;
  /** Record `text` as the saved state of the draft (clears "Unsaved"). */
  markSaved: (text: string) => void;
  /** Replace the draft (asks first when there are unsaved edits). */
  onLoad: (s: Strategy) => void;
  /** JSON parse of `checked`. */
  parsed: JsonParse;
  /** The text `parsed` and `report` describe: the draft, deferred while typing. */
  checked: string;
  /** The gate's report on `checked` (null while it does not parse). */
  report: LoadReport | null;
  strategy: Strategy | null;
  houseStacks: readonly Strategy[];
  saved: SavedStrategy[];
  refreshSaved: () => void;
  lastBatch: BatchOutcome | null;
  onTest: () => void;
  onWatch: (config: MatchConfig) => void;
};

type ViewMode = 'visual' | 'split' | 'code';
const VIEW_MODES: { id: ViewMode; label: string; title: string }[] = [
  { id: 'visual', label: 'Visual', title: 'Edit with cards, sliders and pickers' },
  { id: 'split', label: 'Split', title: 'Visual and code side by side; a change in either shows in both' },
  { id: 'code', label: 'Code', title: 'The strategy JSON' },
];
const asMode = (v: unknown, fallback: ViewMode): ViewMode => (v === 'visual' || v === 'split' || v === 'code' ? v : fallback);

const DRAFT_REF = 'draft';
const STAT_KEYS = Object.keys(STAT_DOCS) as (keyof DerivedStats)[];

/**
 * Where an opened import or LLM answer came from, until it is saved: Save then records that origin
 * (and, for "Improve this with an LLM", the version it improves as parent). It applies only while
 * the draft still has that name and no saved version as its base.
 */
type Pending = { name: string; origin: SavedOrigin; parentId: string | null };
const asPending = (v: unknown, fallback: Pending | null): Pending | null => {
  const p = v as Partial<Pending> | null;
  if (!p || typeof p.name !== 'string' || typeof p.origin !== 'object' || p.origin === null) return fallback;
  const kind = (p.origin as { kind?: unknown }).kind;
  if (kind !== 'import' && kind !== 'llm-paste') return fallback;
  return { name: p.name, origin: { kind }, parentId: typeof p.parentId === 'string' ? p.parentId : null };
};

/** An LLM round trip in progress: the prompt and the version it was asked to improve. */
type LlmRound = LlmPaste & { parentId: string | null };

/** "Compare" in the history panel: shared seeds against the house stacks on the default map. */
const HISTORY_COMPARE_MATCHES = 16;

export function StrategyEditor(props: Props) {
  const { controller, draft, setDraft, markSaved, onLoad, parsed, checked, report, strategy, houseStacks, saved, refreshSaved, lastBatch } = props;
  const code = useRef<CodeAreaApi | null>(null);
  const builderApi = useRef<BuilderApi | null>(null);
  // Null: closed. Otherwise the files that opened it (none from the button).
  const [importing, setImporting] = useState<File[] | null>(null);
  const [caret, setCaret] = useState(0);
  const [mode, setMode] = useStoredState<ViewMode>('poc.editor.view', () => 'split', asMode);
  // Null: closed. '' opens the Codex on its contents, an entry id on that entry.
  const [codexAt, setCodexAt] = useState<string | null>(null);

  // The builder edits the live draft, not the deferred copy, so a slider never lags its own value.
  // While the JSON is broken it shows the last draft that parsed, read-only.
  const live = useMemo(() => parseJson(draft), [draft]);
  const lastGood = useRef<unknown>(null);
  if (live.ok) lastGood.current = live.value;
  const value = live.ok ? live.value : lastGood.current;

  const name = strategy?.name ?? readName(value);
  const issues = useMemo<ValidationIssue[]>(
    () =>
      !parsed.ok
        ? [{ path: '', message: parsed.message, severity: 'error', line: parsed.line, column: parsed.col }]
        : report
          ? [...report.errors, ...report.warnings]
          : [],
    [parsed, report],
  );
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.length - errors.length;
  const spans = useMemo(() => placeIssues(checked, issues), [checked, issues]);
  const unplaced = issues.filter((i) => !spans.some((sp) => sp.issue === i));
  const atCaret = checked === draft ? issueAtCaret(spans, draft, caret) : null;
  const caretAt = lineCol(draft, caret);
  const shadowsHouse = name !== null && houseStacks.some((h) => h.name === name);
  const showCode = mode !== 'visual';
  const showBuilder = mode !== 'code';

  // ---- Versions: what the draft is based on and what Save will do.
  const store = controller.strategies;
  const [pending, setPending] = useStoredState<Pending | null>('poc.editor.pending.v1', () => null, asPending);
  const base = useMemo(() => draftBase(value, saved), [value, saved]);
  // The version the draft was last based on, to remember where a renamed copy came from.
  const lastBase = useRef<SavedStrategy | null>(null);
  if (base) lastBase.current = base;
  const identity = draftIdentity(value);
  const copiedFrom = !base && lastBase.current && identity.version === lastBase.current.version && name !== lastBase.current.name ? lastBase.current : null;
  const pendingNow = pending && !base && pending.name === name ? pending : null;
  const pendingParent = pendingNow?.parentId ? (saved.find((s) => s.id === pendingNow.parentId) ?? null) : null;
  const nextVersion = useCallback((n: string) => nextVersionOf(store, saved, n), [store, saved]);
  const plan: SavePlan | null = name ? savePlan(name, base ?? (pendingParent?.name === name ? pendingParent : null), saved, nextVersion, copiedFrom ?? pendingParent) : null;
  // Saving an untouched version would only add a copy under a new number.
  const unchanged = base !== null && strategy !== null && inlineJson({ ...strategy, version: base.version }) === inlineJson(base.strategy);
  const [ask, setAsk] = useState<SavePlan | null>(null);
  const [llm, setLlm] = useState<LlmRound | null>(null);
  const [sideWidth, setSideWidth] = useStoredState<number>(EDITOR_SIDE_KEY, () => EDITOR_SIDE.initial, sanitizeSideWidth);
  const [comparing, setComparing] = useState<{ done: number; total: number } | null>(null);
  const [comparison, setComparison] = useState<CompareOutcome | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const historyName = name ?? base?.name ?? null;
  const history = useMemo(() => (historyName ? store.history(historyName) : null), [store, historyName, saved]); // eslint-disable-line react-hooks/exhaustive-deps

  const cardBuild = useMemo<CardBuild>(() => {
    const attributes = completeAttributes(readAttributes(value));
    const weapon = readWeapon(value);
    return attributes && weapon ? { attributes, weapon } : null;
  }, [value]);

  const openCodex = useCallback((id: string) => setCodexAt(id), []);

  /** Show an issue: in the code (selected, centred, flashed) and on the builder card it belongs to. */
  const reveal = (sp: IssueSpan | null, issue: ValidationIssue) => {
    if (showCode && sp) {
      // Validation trails typing by a keystroke at most: place the issue in the text as it is now.
      const now = code.current?.text() ?? draft;
      const at = now === checked ? sp : (placeIssues(now, [issue])[0] ?? null);
      if (at) code.current?.reveal(at.start, at.end);
    }
    if (showBuilder) builderApi.current?.reveal(issue.path);
  };

  const applyFix = (sp: IssueSpan) => {
    const fix = fixText(checked, sp, sp.issue.suggestion);
    if (!fix || checked !== draft) return;
    setDraft(draft.slice(0, sp.start) + fix + draft.slice(sp.end));
  };

  const edit = useCallback(
    (path: readonly PathSeg[], v: unknown) => {
      if (!live.ok) return;
      setDraft(setAt(draft, path, v));
    },
    [draft, live.ok, setDraft],
  );

  /** Store `s` as `plan` and `choice` say; null (with a toast) when the library refuses it. */
  const commitSave = (s: Strategy, p: SavePlan, choice: SaveChoice, origin: SavedOrigin): SavedStrategy | null => {
    const renamed = choice.kind === 'rename';
    // A version added to another lineage, or a copy kept apart, records no parent in that lineage.
    const parentId = p.kind === 'collision' ? null : p.parentId;
    try {
      const entry = store.save(renamed ? { ...s, name: choice.name } : s, { parentId, origin });
      refreshSaved();
      return entry;
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.');
      return null;
    }
  };

  const save = (choice?: SaveChoice) => {
    if (!strategy || !plan) return;
    if (!choice && plan.kind === 'collision') {
      setAsk(plan);
      return;
    }
    if (!choice && unchanged && base) {
      toast(`No changes since v${base.version}: nothing to save.`);
      return;
    }
    const entry = commitSave(strategy, plan, choice ?? { kind: 'plan' }, pendingNow?.origin ?? { kind: 'editor' });
    if (!entry) return;
    // Stamp the library's number (and a new name) into the text that was saved, keeping its layout.
    let text: string | null = checked;
    if (choice?.kind === 'rename') text = parseJson(text).ok ? setAt(text, ['name'], entry.name) : null;
    text = text === null ? null : stampVersion(text, entry.version);
    if (text === null || !parseJson(text).ok) text = prettyJson(entry.strategy);
    setDraft(text);
    markSaved(text);
    setPending(null);
    setAsk(null);
    toast(savedMessage(entry));
  };

  /** "New fighter with an LLM" / "Improve this with an LLM": copy the prompt and wait for the reply. */
  const startLlm = async (llmMode: 'new' | 'improve') => {
    let text: string;
    if (llmMode === 'new') {
      text = buildLlmPrompt({ mode: 'new' });
    } else {
      const report = lastBatch?.result.aggregate ?? controller.lastReport();
      let goal: string | undefined;
      if (!parsed.ok) {
        goal = `My strategy JSON does not parse (${parsed.message}, line ${parsed.line}, column ${parsed.col}). Return a corrected strategy. Here is what I have:\n\n${draft}`;
      } else if (errors.length) {
        goal = `Fix these validation errors, then improve the strategy:\n${errors.map((i) => `- ${i.path || '(root)'}: ${i.message}`).join('\n')}`;
      }
      text = buildLlmPrompt({ strategy: parsed.ok ? (parsed.value as Strategy) : undefined, reportText: report ? reportToText(report) : undefined, goal, mode: 'improve' });
    }
    const copied = await copyText(text);
    toast(copied ? 'Prompt copied. Paste it into any chat model, then paste its reply here.' : 'The browser blocked the clipboard: use “Copy the prompt” in the dialog.');
    const parent = llmMode === 'improve' ? (base ?? pendingParent) : null;
    setLlm({ prompt: text, copied, improving: llmMode === 'improve' ? (name ?? 'this strategy') : null, parentId: parent?.id ?? null });
  };

  const llmParent = llm?.parentId ? (saved.find((s) => s.id === llm.parentId) ?? null) : null;
  /** What saving an imported or pasted strategy would do; an improved version keeps its parent. */
  const planForIncoming = (s: Strategy) => savePlan(s.name, llmParent && llmParent.name === s.name ? llmParent : null, saved, nextVersion, llmParent);
  const saveIncoming = (origin: SavedOrigin) => (s: Strategy, choice: SaveChoice): string => {
    const entry = commitSave(s, planForIncoming(s), choice, origin);
    if (!entry) return 'not saved';
    toast(savedMessage(entry));
    return strategyLabel(entry.name, entry.version);
  };
  const openIncoming = (origin: SavedOrigin) => (s: Strategy) => {
    // Its own "version" is never trusted: the library numbers it on Save.
    onLoad(withoutVersion(s));
    setPending({ name: s.name, origin, parentId: origin.kind === 'llm-paste' ? (llmParent?.id ?? null) : null });
    toast(`Opened ${s.name}. Save it to give it a version.`);
  };

  const runCompare = async (a: CompareSide, b: CompareSide) => {
    const keys = new Set([strategyKey(a.strategy), strategyKey(b.strategy)]);
    const req: CompareRequest = {
      a: a.strategy,
      b: b.strategy,
      field: houseStacks.filter((h) => !keys.has(strategyKey(h))),
      mapIds: [DEFAULT_MAP_ID],
      matches: HISTORY_COMPARE_MATCHES,
      fighters: DEFAULT_FIGHTERS,
      seed: randomSeed(),
    };
    setComparing({ done: 0, total: req.matches * 2 });
    try {
      const result = await controller.gym.compare(req, (done, total) => mounted.current && setComparing({ done, total }));
      if (mounted.current) setComparison({ request: req, result });
      else toast(`Comparison done: ${result.findings[0] ?? 'open the history to run it again.'}`);
    } catch (err) {
      toast(err instanceof Error && err.name === 'AbortError' ? 'Comparison stopped.' : `Comparison failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (mounted.current) setComparing(null);
    }
  };

  // The draft as a side to compare: only when it is valid, of this strategy, and not a saved version.
  const draftSide: CompareSide | null =
    strategy && plan && !unchanged && historyName === strategy.name ? { label: 'the editor', strategy: { ...strategy, version: plan.version } } : null;

  const saveLabel = !plan ? 'Save' : plan.kind === 'collision' ? 'Save…' : `Save as v${plan.version}`;
  const saveTitle = !strategy
    ? 'Fix the errors first'
    : unchanged && base
      ? `No changes since v${base.version}`
      : plan?.kind === 'collision'
        ? `“${plan.name}” is already in your library: choose how to save (Cmd/Ctrl+S)`
        : plan?.kind === 'version'
          ? `Save as ${plan.name} v${plan.version}, from v${plan.parentVersion} (Cmd/Ctrl+S)`
          : `Save as ${plan?.name} v${plan?.version}, a new strategy (Cmd/Ctrl+S)`;

  const watchIt = () => {
    if (!strategy) return;
    const pool = [...buildPool(houseStacks, saved), { ref: DRAFT_REF, label: strategy.name, source: 'saved' as const, strategy }];
    const setup = defaultSetup(randomSeed());
    try {
      props.onWatch(buildMatchConfig({ ...setup, slots: [DRAFT_REF, ...setup.slots.slice(1).map(() => RANDOM_SLOT)] }, pool));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start the match.');
    }
  };

  return (
    <div
      className={`editor editor-${mode} editor-sized`}
      style={{ '--side-w': `${sideWidth}px` } as CSSProperties}
      onKeyDown={(e) => {
        // Save from anywhere in the editor; the code view handles its own (and marks it handled).
        if (e.key === 's' && (e.metaKey || e.ctrlKey) && !e.defaultPrevented) {
          e.preventDefault();
          save();
        }
      }}
      onDragOver={(e) => {
        // A file dropped anywhere on the editor goes to the import dialog, not into the browser tab.
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setImporting([...e.dataTransfer.files]);
      }}
    >
      <div className="editor-main">
        <div className="editor-head" aria-live="polite">
          <span className={`ed-dot${unchanged ? '' : ' on'}`} title={unchanged ? 'Saved' : 'Unsaved changes'} aria-label={unchanged ? 'Saved' : 'Unsaved changes'} />
          <span className="ed-base">{baseLine(name, base, pendingNow?.origin ?? null, Date.now())}</span>
        </div>
        <div className="editor-bar">
          <button type="button" className="btn btn-primary btn-sm" disabled={!strategy || (unchanged && base !== null)} onClick={() => save()} title={saveTitle}>
            {saveLabel}
          </button>
          {showCode ? (
            <button type="button" className="btn btn-sm" disabled={!parsed.ok} onClick={() => parsed.ok && setDraft(prettyJson(parsed.value))} title="Lay the JSON out the editor's way">
              Format
            </button>
          ) : null}
          <span className="bar-sep" />
          <button type="button" className="btn btn-sm" onClick={() => void startLlm('new')} title="Copy a prompt that has a chat model interview you and design a brand-new fighter; paste its reply back here">
            New fighter with an LLM
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void startLlm('improve')}
            title={lastBatch || controller.lastReport() ? 'Copy a prompt with this strategy and its last battle report; paste the reply back as a new version' : 'Copy a prompt with this strategy; paste the reply back as a new version'}
          >
            Improve this with an LLM
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!strategy}
            onClick={() => strategy && copyAndToast(encodeStrategyCode(strategy), 'Strategy code')}
            title="A short code anyone can paste into Import"
          >
            Copy code
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setImporting([])} title="Open .json files, pasted JSON or a strategy code (you can also drop files on the editor)">
            <ImportIcon /> Import
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setCodexAt('')} title="Everything a strategy can say: sensors, places, zones, builds, rules and worked examples">
            Codex
          </button>
          <span className="spacer" />
          <div className="seg editor-mode" role="group" aria-label="Editor view">
            {VIEW_MODES.map((m) => (
              <button key={m.id} type="button" aria-pressed={mode === m.id} title={m.title} onClick={() => setMode(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
          <span className="bar-sep" />
          <button type="button" className="btn btn-sm" disabled={!strategy} onClick={props.onTest}>
            Test in gym
          </button>
          <button type="button" className="btn btn-sm" disabled={!strategy} onClick={watchIt} title="Start an 8-fighter match on the Pit with this strategy in it">
            Watch it fight
          </button>
        </div>

        <div className="editor-panes">
          {showBuilder ? (
            <Builder
              apiRef={builderApi}
              value={value}
              editable={live.ok}
              issues={issues}
              build={cardBuild}
              onEdit={edit}
              onText={setDraft}
              text={draft}
              onOpenCodex={openCodex}
            />
          ) : null}
          {/* Kept mounted while hidden, so undo history, caret and scroll survive switching views. */}
          <div className="editor-code" hidden={!showCode}>
            <Suspense fallback={<div className="code-cm" />}>
              <CodeArea
                apiRef={code}
                text={draft}
                onChange={setDraft}
                checked={checked}
                spans={spans}
                onCaret={setCaret}
                onSave={() => save()}
                build={cardBuild}
                onOpenCodex={openCodex}
              />
            </Suspense>
            <div className={`code-status${atCaret ? ` ${atCaret.severity}` : ''}`} aria-live="polite">
              <span className="num">
                Ln {caretAt.line}, Col {caretAt.col}
              </span>
              {atCaret ? (
                <span className="code-status-msg" title={atCaret.issue.message}>
                  <span className="dx-icon" dangerouslySetInnerHTML={{ __html: SEVERITY_SVG[atCaret.severity] }} />
                  <b>{atCaret.severity === 'error' ? 'Error' : 'Warning'}</b> {atCaret.issue.message}
                </span>
              ) : (
                <span className="faint">{issues.length ? 'Hover a marked word for the fix, or click a problem to jump to it.' : 'Hover any word for what it means. Ctrl+Space completes.'}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="editor-side-wrap">
      <SideHandle width={sideWidth} setWidth={setSideWidth} />
      <aside className="editor-side" aria-label="Strategy checks">
        <section className="side-section">
          <div className="side-title">
            <span>Checks</span>
            <span className="dim">
              {!parsed.ok
                ? 'JSON broken'
                : errors.length
                  ? `${errors.length} ${errors.length === 1 ? 'error' : 'errors'}${warnings ? `, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : ''}`
                  : warnings
                    ? `valid, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`
                    : 'valid'}
            </span>
          </div>
          {issues.length ? (
            <ul className="issues">
              {[...spans.map((sp) => ({ iss: sp.issue, placed: sp as IssueSpan | null })), ...unplaced.map((iss) => ({ iss, placed: null }))].map(({ iss, placed }, i) => {
                const spot = placed ? issueSpot({ line: placed.line, column: placed.column }) : null;
                const fix = placed && checked === draft ? fixText(checked, placed, iss.suggestion) : null;
                return (
                  <li key={`${iss.path}:${i}`}>
                    <div
                      role="button"
                      tabIndex={0}
                      className={`issue ${iss.severity}`}
                      onClick={() => reveal(placed, iss)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          reveal(placed, iss);
                        }
                      }}
                      title="Show it"
                    >
                      <span className="issue-icon" aria-label={iss.severity} dangerouslySetInnerHTML={{ __html: SEVERITY_SVG[iss.severity] }} />
                      {spot || iss.path ? (
                        <code>
                          {spot}
                          {spot && iss.path ? ' · ' : ''}
                          {iss.path}
                        </code>
                      ) : null}
                      {iss.message}
                      {iss.suggestion ? <div className="hint">{suggestionLine(iss.suggestion)}</div> : null}
                      {fix && placed ? (
                        <div className="issue-fix">
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              applyFix(placed);
                            }}
                          >
                            Use {iss.suggestion}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="ok-line">
              <span className="ok-dot" />
              Ready to fight.
            </div>
          )}
          {shadowsHouse ? (
            <p className="side-note">Same name as a house stack. Rename it so reports and ratings can tell yours apart.</p>
          ) : null}
        </section>

        {showBuilder ? null : <BudgetSection value={value} />}
        <StatsSection value={value} />

        {history ? (
          <section className="side-section">
            <div className="side-title">
              <span>History</span>
              <span className="dim">{history.entries.length ? `${history.entries.length} saved` : 'not saved yet'}</span>
            </div>
            {history.entries.length ? (
              <HistoryPanel
                history={history}
                base={base}
                draft={draftSide}
                nowMs={Date.now()}
                onOpen={(v) => onLoad({ ...v.strategy, version: v.version })}
                onDelete={(v) => {
                  if (!window.confirm(`Delete ${strategyLabel(v.name, v.version)}? Its code still works if you copied it, and its number is never given out again.`)) return;
                  store.remove(v.id);
                  refreshSaved();
                }}
                onCompare={(a, b) => void runCompare(a, b)}
                running={comparing}
                onStop={() => controller.gym.cancel()}
              />
            ) : (
              <p className="side-note">Save to keep a version you can test, share, compare and roll back to.</p>
            )}
          </section>
        ) : null}
      </aside>
      </div>

      {importing ? (
        <ImportDialog
          initialFiles={importing}
          houseNames={houseStacks.map((h) => h.name)}
          planFor={(s) => savePlan(s.name, null, saved, nextVersion)}
          onOpen={openIncoming({ kind: 'import' })}
          onSave={saveIncoming({ kind: 'import' })}
          onClose={() => setImporting(null)}
        />
      ) : null}

      {llm ? (
        <ImportDialog
          initialFiles={[]}
          houseNames={houseStacks.map((h) => h.name)}
          llm={llm}
          planFor={planForIncoming}
          onOpen={openIncoming({ kind: 'llm-paste' })}
          onSave={saveIncoming({ kind: 'llm-paste' })}
          onClose={() => setLlm(null)}
        />
      ) : null}

      {ask ? (
        <SaveDialog
          plan={ask}
          taken={[...new Set(saved.map((v) => v.name))]}
          what={pendingNow?.origin.kind === 'llm-paste' ? 'an LLM’s answer' : pendingNow?.origin.kind === 'import' ? 'an import' : copiedFrom ? `a copy of ${copiedFrom.name}` : 'a new fighter'}
          onChoose={(choice) => save(choice)}
          onClose={() => setAsk(null)}
        />
      ) : null}

      {comparison ? (
        <div
          className="dialog-scrim"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setComparison(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setComparison(null);
          }}
        >
          <div className="dialog compare-dialog" role="dialog" aria-modal="true" aria-label="Comparison">
            <div className="dialog-head">
              <h2>Compare</h2>
              <button type="button" className="btn btn-sm btn-icon btn-quiet" onClick={() => setComparison(null)} aria-label="Close" autoFocus>
                <CloseIcon />
              </button>
            </div>
            <div className="dialog-body">
              <CompareView outcome={comparison} onWatch={(req) => props.onWatch(req.config)} />
            </div>
          </div>
        </div>
      ) : null}

      {codexAt !== null ? (
        <Suspense fallback={null}>
          <CodexDialog initial={codexAt} build={cardBuild} onClose={() => setCodexAt(null)} />
        </Suspense>
      ) : null}
    </div>
  );
}

/** The side panel's drag handle (SPEC "Resizable panes"): drag, double-click to reset, arrow keys to nudge. */
function SideHandle({ width, setWidth }: { width: number; setWidth: (w: number) => void }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  return (
    <div
      className={`pane-handle right${shown !== null ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side panel"
      aria-valuenow={width}
      aria-valuemin={EDITOR_SIDE.min}
      aria-valuemax={EDITOR_SIDE.max}
      tabIndex={0}
      title="Drag to resize the side panel, double-click to reset"
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: width };
        setShown(width);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const next = dragSideWidth(d.w, d.x, e.clientX);
        setShown(next);
        if (next !== width) setWidth(next);
      }}
      onPointerUp={() => {
        drag.current = null;
        setShown(null);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setShown(null);
      }}
      onDoubleClick={() => setWidth(EDITOR_SIDE.initial)}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowLeft' ? 16 : e.key === 'ArrowRight' ? -16 : 0;
        if (!step) return;
        e.preventDefault();
        e.stopPropagation();
        // The handle moves with the arrow: left widens this right-hand panel.
        setWidth(dragSideWidth(width, 0, -step));
      }}
    >
      {shown !== null ? <span className="pane-width num">{shown}</span> : null}
    </div>
  );
}

function BudgetSection({ value }: { value: unknown }) {
  const attrs = readAttributes(value);
  if (!attrs) return null;
  const b = budget(attrs);
  const scale = Math.max(b.total, ATTRIBUTE_BUDGET);
  return (
    <section className="side-section">
      <div className="side-title">
        <span>Attribute budget</span>
        <span className={`budget-total${b.over ? ' over' : ''}`}>
          <b>{b.total}</b>
          <span className="dim">/ {ATTRIBUTE_BUDGET}</span>
        </span>
      </div>
      <div className="budget-meter" aria-hidden>
        {b.rows.map((r) => (r.value ? <div key={r.key} data-attr={r.key} className="budget-seg" style={{ width: `${(r.value / scale) * 100}%` }} /> : null))}
        {b.over ? <i className="budget-cap" style={{ left: `${(ATTRIBUTE_BUDGET / scale) * 100}%` }} /> : null}
      </div>
      <div className="dim budget-left">
        {b.over ? <span className="error-line">{-b.left} over budget.</span> : b.left > 0 ? `${b.left} points unspent.` : 'Every point spent.'}
      </div>
      {b.rows.map((r) => (
        <div key={r.key} className={`budget-row${r.outOfRange ? ' bad' : ''}`} title={ATTRIBUTE_DOCS[r.key]} data-attr={r.key}>
          <span>{ATTRIBUTE_LABEL[r.key]}</span>
          <span className="budget-bar">
            <div className="budget-fill" style={{ width: `${Math.min(1, Math.max(0, (r.value ?? 0) / ATTRIBUTE_MAX)) * 100}%` }} />
            <i style={{ left: `${(ATTRIBUTE_MIN / ATTRIBUTE_MAX) * 100}%` }} />
          </span>
          <span className="num">{r.value ?? '?'}</span>
        </div>
      ))}
      <p className="side-note">
        Each attribute {ATTRIBUTE_MIN} to {ATTRIBUTE_MAX}, {ATTRIBUTE_BUDGET} points in total.
      </p>
    </section>
  );
}

function StatsSection({ value }: { value: unknown }) {
  const attrs = completeAttributes(readAttributes(value));
  const weapon = readWeapon(value);
  if (!attrs || !weapon) return null;
  const skill = readSkill(value);
  const stats = deriveStats(attrs, weapon);
  return (
    <section className="side-section">
      <div className="side-title">
        <span>What the build gives you</span>
      </div>
      <div className="build-line">{skill ? buildLine(weapon, skill) : WEAPONS[weapon].name}</div>
      <p className="side-note">{WEAPONS[weapon].doc}</p>
      {skill ? <p className="side-note">{SKILLS[skill].doc}</p> : null}
      <dl className="kv">
        {STAT_KEYS.map((k) => (
          <Fragment key={k}>
            <dt title={STAT_DOCS[k].doc}>{STAT_DOCS[k].label}</dt>
            <dd>{formatStat(k, stats[k])}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}

function readName(value: unknown): string | null {
  const name = (value as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name.trim() ? name : null;
}

function readSkill(value: unknown): SkillId | null {
  const s = (value as { build?: { skill?: unknown } } | null)?.build?.skill;
  return typeof s === 'string' && (SKILL_IDS as readonly string[]).includes(s) ? (s as SkillId) : null;
}
