// Owned by: ui
import { Fragment, useMemo, useRef, useState } from 'react';
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
import { budget, completeAttributes, issueAtCaret, lineCol, placeIssues, prettyJson, readAttributes, readWeapon } from '../editor';
import type { IssueSpan, JsonParse } from '../editor';
import { buildLine, formatAgo, formatStat, strategyLabel } from '../format';
import { CloseIcon, ImportIcon } from '../icons';
import { issueSpot } from '../importer';
import { RANDOM_SLOT, buildMatchConfig, buildPool, defaultSetup, randomSeed } from '../setup';
import { copyAndToast, toast } from '../toast';
import { ATTRIBUTE_LABEL } from '../widgets';
import { CodeArea } from './CodeArea';
import type { BatchOutcome } from './GymScreen';
import { ImportDialog } from './ImportDialog';

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

/** Line height of `.code` in px, for scrolling an issue into view. */
const CODE_LINE_PX = 20;
const DRAFT_REF = 'draft';
const STAT_KEYS = Object.keys(STAT_DOCS) as (keyof DerivedStats)[];

export function StrategyEditor(props: Props) {
  const { controller, draft, setDraft, markSaved, onLoad, parsed, checked, report, strategy, houseStacks, saved, refreshSaved, lastBatch } = props;
  const area = useRef<HTMLTextAreaElement>(null);
  // Null: closed. Otherwise the files that opened it (none from the button).
  const [importing, setImporting] = useState<File[] | null>(null);
  const [caret, setCaret] = useState(0);

  const value = parsed.ok ? parsed.value : null;
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

  const jumpTo = (offset: number, length = 0) => {
    const el = area.current;
    if (!el || offset < 0) return;
    el.focus();
    el.setSelectionRange(offset, offset + length);
    el.scrollTop = Math.max(0, (lineCol(draft, offset).line - 4) * CODE_LINE_PX);
    setCaret(offset);
  };
  const jumpToSpan = (sp: IssueSpan) => jumpTo(sp.start, sp.end - sp.start);

  const save = () => {
    if (!strategy) return;
    const entry = controller.strategies.save(strategy);
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
    const entry = controller.strategies.save(s);
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
      className="editor"
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
          <button type="button" className="btn btn-sm" disabled={!parsed.ok} onClick={() => parsed.ok && setDraft(prettyJson(parsed.value))}>
            Format
          </button>
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
          <span className="spacer" />
          <button type="button" className="btn btn-sm" disabled={!strategy} onClick={props.onTest}>
            Test in gym
          </button>
          <button type="button" className="btn btn-sm" disabled={!strategy} onClick={watchIt} title="Start an 8-fighter match on the Pit with this strategy in it">
            Watch it fight
          </button>
        </div>

        <CodeArea
          areaRef={area}
          text={draft}
          checked={checked}
          spans={spans}
          onChange={setDraft}
          onCaret={setCaret}
          onJump={jumpToSpan}
          onKeyDown={(e) => {
            if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            } else if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              e.currentTarget.setRangeText('  ', e.currentTarget.selectionStart, e.currentTarget.selectionEnd, 'end');
              setDraft(e.currentTarget.value);
            }
          }}
        />
        <div className={`code-status${atCaret ? ` ${atCaret.severity}` : ''}`} aria-live="polite">
          <span className="num">
            Ln {caretAt.line}, Col {caretAt.col}
          </span>
          {atCaret ? (
            <span className="code-status-msg" title={atCaret.issue.message}>
              <b>{atCaret.severity === 'error' ? 'Error' : 'Warning'}</b> {atCaret.issue.message}
            </span>
          ) : (
            <span className="faint">{issues.length ? 'Click a problem, or a marked line number, to jump to it.' : ''}</span>
          )}
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
                return (
                  <li key={`${iss.path}:${i}`}>
                    <button
                      type="button"
                      className={`issue ${iss.severity}`}
                      onClick={() => placed && jumpToSpan(placed)}
                      title={placed ? 'Show in the editor' : undefined}
                    >
                      {spot || iss.path ? (
                        <code>
                          {spot}
                          {spot && iss.path ? ' · ' : ''}
                          {iss.path}
                        </code>
                      ) : null}
                      {iss.message}
                      {iss.suggestion ? <div className="hint">{suggestionText(iss.suggestion)}</div> : null}
                    </button>
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

        <BudgetSection value={value} />
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
        {b.rows.map((r, i) => (r.value ? <div key={r.key} style={{ width: `${(r.value / scale) * 100}%`, background: SEGMENT_SHADES[i] }} /> : null))}
        {b.over ? <i className="budget-cap" style={{ left: `${(ATTRIBUTE_BUDGET / scale) * 100}%` }} /> : null}
      </div>
      <div className="dim budget-left">
        {b.over ? <span className="error-line">{-b.left} over budget.</span> : b.left > 0 ? `${b.left} points unspent.` : 'Every point spent.'}
      </div>
      {b.rows.map((r) => (
        <div key={r.key} className={`budget-row${r.outOfRange ? ' bad' : ''}`} title={ATTRIBUTE_DOCS[r.key]}>
          <span>{ATTRIBUTE_LABEL[r.key]}</span>
          <span className="budget-bar">
            <div style={{ width: `${Math.min(1, Math.max(0, (r.value ?? 0) / ATTRIBUTE_MAX)) * 100}%` }} />
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

/** Greys for the stacked budget meter: colour stays reserved for fighters. */
const SEGMENT_SHADES = ['#c9c1b5', '#a39a8e', '#857c71', '#6b635a', '#564f47', '#463f38'];

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

function suggestionText(s: string): string {
  return /^did you mean/i.test(s) ? s : `Did you mean "${s}"?`;
}
