// Owned by: ui
import { Fragment, Suspense, lazy, useCallback, useMemo, useRef, useState } from 'react';
import {
  ATTRIBUTE_BUDGET,
  ATTRIBUTE_DOCS,
  ATTRIBUTE_MAX,
  ATTRIBUTE_MIN,
  SKILLS,
  SKILL_IDS,
  STAT_DOCS,
  WEAPONS,
  deriveStats,
} from '../../core';
import type { DerivedStats, GameController, LoadReport, MatchConfig, SavedStrategy, SkillId, Strategy, ValidationIssue } from '../../core';
import { reportToText } from '../../gym';
import { buildLlmPrompt, encodeStrategyCode } from '../../strategy';
import { budget, completeAttributes, issueAtCaret, lineCol, parseJson, placeIssues, prettyJson, readAttributes, readWeapon } from '../editor';
import type { IssueSpan, JsonParse } from '../editor';
import { Builder } from '../editor/Builder';
import type { BuilderApi } from '../editor/Builder';
import { SEVERITY_SVG, fixText, suggestionLine } from '../editor/issues';
import { setAt } from '../editor/edit';
import type { PathSeg } from '../editor/jsontext';
import type { CardBuild } from '../editor/WordCard';
import { buildLine, formatAgo, formatStat, strategyLabel } from '../format';
import { useStoredState } from '../hooks';
import { CloseIcon, ImportIcon } from '../icons';
import { issueSpot } from '../importer';
import { RANDOM_SLOT, buildMatchConfig, buildPool, defaultSetup, randomSeed } from '../setup';
import { copyAndToast, toast } from '../toast';
import { ATTRIBUTE_LABEL } from '../widgets';
import type { CodeAreaApi } from './CodeArea';
import type { BatchOutcome } from './GymScreen';
import { ImportDialog } from './ImportDialog';
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
  const versions = saved.filter((s) => s.name === name).sort((a, b) => b.version - a.version);
  const shadowsHouse = name !== null && houseStacks.some((h) => h.name === name);
  const showCode = mode !== 'visual';
  const showBuilder = mode !== 'code';

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

  const save = () => {
    if (!strategy) return;
    const entry = controller.strategies.save(strategy, { origin: { kind: 'editor' } });
    refreshSaved();
    const text = prettyJson({ ...entry.strategy, version: entry.version });
    setDraft(text);
    markSaved(text);
    toast(`Saved ${strategyLabel(entry.name, entry.version)}.`);
  };

  const copyPrompt = () => {
    const report = lastBatch?.result.aggregate ?? controller.lastReport();
    let goal: string | undefined;
    if (!parsed.ok) {
      goal = `My strategy JSON does not parse (${parsed.message}, line ${parsed.line}, column ${parsed.col}). Return a corrected strategy. Here is what I have:\n\n${draft}`;
    } else if (errors.length) {
      goal = `Fix these validation errors, then improve the strategy:\n${errors.map((i) => `- ${i.path || '(root)'}: ${i.message}`).join('\n')}`;
    }
    const text = buildLlmPrompt({
      strategy: parsed.ok ? (parsed.value as Strategy) : undefined,
      reportText: report ? reportToText(report) : undefined,
      goal,
    });
    const what = lastBatch ? 'LLM prompt with the last gym report' : report ? 'LLM prompt with the last match report' : 'LLM prompt';
    void copyAndToast(text, what);
  };

  const saveImported = (s: Strategy): string => {
    const entry = controller.strategies.save(s, { origin: { kind: 'import' } });
    refreshSaved();
    const label = strategyLabel(entry.name, entry.version);
    toast(`Saved ${label}.`);
    return label;
  };

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
      className={`editor editor-${mode}`}
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
        <div className="editor-bar">
          <button type="button" className="btn btn-primary btn-sm" disabled={!strategy} onClick={save} title="Save as the next version (Cmd/Ctrl+S)">
            Save version
          </button>
          {showCode ? (
            <button type="button" className="btn btn-sm" disabled={!parsed.ok} onClick={() => parsed.ok && setDraft(prettyJson(parsed.value))} title="Lay the JSON out the editor's way">
              Format
            </button>
          ) : null}
          <span className="bar-sep" />
          <button type="button" className="btn btn-sm" onClick={copyPrompt} title="Rulebook, this strategy and the latest report, ready to paste into an LLM">
            Copy LLM prompt
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
                onSave={save}
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

        {name ? (
          <section className="side-section">
            <div className="side-title">
              <span>Versions</span>
              <span className="dim">{versions.length ? `${versions.length} saved` : 'not saved yet'}</span>
            </div>
            {versions.length ? (
              <div className="versions">
                {versions.map((v) => (
                  <div className="version" key={v.id}>
                    <span className="num">v{v.version}</span>
                    <span className="faint">{formatAgo(v.savedAt, Date.now())}</span>
                    <span className="spacer" />
                    <button type="button" className="btn btn-sm btn-quiet" onClick={() => onLoad({ ...v.strategy, version: v.version })}>
                      Load
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-icon btn-quiet"
                      aria-label={`Delete v${v.version}`}
                      title="Delete this version"
                      onClick={() => {
                        if (!window.confirm(`Delete ${strategyLabel(v.name, v.version)}? Its code still works if you copied it.`)) return;
                        controller.strategies.remove(v.id);
                        refreshSaved();
                      }}
                    >
                      <CloseIcon size={12} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="side-note">Save to keep a version you can test, share and roll back to.</p>
            )}
          </section>
        ) : null}
      </aside>

      {importing ? (
        <ImportDialog
          initialFiles={importing}
          houseNames={houseStacks.map((h) => h.name)}
          onOpen={(s) => {
            onLoad(s);
            toast(`Opened ${strategyLabel(s.name, s.version)}.`);
          }}
          onSave={saveImported}
          onClose={() => setImporting(null)}
        />
      ) : null}

      {codexAt !== null ? (
        <Suspense fallback={null}>
          <CodexDialog initial={codexAt} build={cardBuild} onClose={() => setCodexAt(null)} />
        </Suspense>
      ) : null}
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
