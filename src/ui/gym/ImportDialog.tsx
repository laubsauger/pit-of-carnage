// Owned by: ui
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { Strategy } from '../../core';
import { offsetOf } from '../editor';
import { SEVERITY_SVG, suggestionLine } from '../editor/issues';
import { buildLine } from '../format';
import { CloseIcon, ImportIcon } from '../icons';
import { checkImport, importVerdict, isJsonFile, issueSpot, llmReplyHint, rejectedFile } from '../importer';
import type { ImportEntry } from '../importer';
import type { SaveChoice, SavePlan } from '../editor/versions';
import { copyText } from '../toast';

/**
 * Pasting an LLM's answer back ("New fighter with an LLM", "Improve this with an LLM"): the prompt
 * that was copied, whether the clipboard took it, and what the model was asked to improve.
 */
export type LlmPaste = { prompt: string; copied: boolean; improving: string | null };

type Props = {
  /** Files dropped on the editor before the dialog opened. */
  initialFiles: File[];
  houseNames: readonly string[];
  /** Set when the dialog takes an LLM's reply instead of files. */
  llm?: LlmPaste | null;
  /** What saving this strategy would do (next version, v1 of a new name, or a name collision). */
  planFor: (s: Strategy) => SavePlan;
  onOpen: (s: Strategy) => void;
  /** Saves it as the player chose; returns the label it was saved under. */
  onSave: (s: Strategy, choice: SaveChoice) => string;
  onClose: () => void;
};

const SOURCE_LABEL: Record<string, string> = { file: 'File', paste: 'Pasted JSON', code: 'Strategy code' };

/**
 * Import strategies from .json files (dropped or picked), pasted JSON or a strategy code. Each one
 * is checked by the same gate as everything else and its report is shown before anything is saved:
 * errors block, warnings can be accepted.
 */
export function ImportDialog({ initialFiles, houseNames, llm = null, planFor, onOpen, onSave, onClose }: Props) {
  const [files, setFiles] = useState<ImportEntry[]>([]);
  const [paste, setPaste] = useState('');
  const [dragging, setDragging] = useState(false);
  const [saved, setSaved] = useState<Record<number, string>>({});
  const [copied, setCopied] = useState(llm?.copied ?? false);
  const nextId = useRef(1);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const deferred = useDeferredValue(paste);
  const pasteLabel = llm ? 'LLM reply' : 'Pasted text';
  const pasted = useMemo(() => (deferred.trim() ? checkImport(pasteLabel, deferred, false, 0) : null), [deferred, pasteLabel]);
  const hint = llm && pasted && !pasted.report.strategy ? llmReplyHint(deferred) : null;

  const addFiles = async (list: readonly File[]) => {
    const entries = await Promise.all(
      list.map(async (f) => {
        const id = nextId.current++;
        if (!isJsonFile(f)) return rejectedFile(f.name, id);
        return checkImport(f.name, await f.text(), true, id);
      }),
    );
    setFiles((prev) => [...entries, ...prev]);
  };

  // Taken once: StrictMode mounts effects twice in development, which would list every file twice.
  const first = useRef<File[] | null>(initialFiles);
  useEffect(() => {
    const dropped = first.current;
    first.current = null;
    if (dropped?.length) void addFiles(dropped);
    pasteRef.current?.focus();
    // Only the files that opened the dialog; later ones arrive through the drop zone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const jumpInPaste = (line?: number, column?: number) => {
    const el = pasteRef.current;
    if (!el || line === undefined) return;
    const at = offsetOf(paste, line, column ?? 1);
    el.focus();
    el.setSelectionRange(at, Math.min(paste.length, at + 1));
  };

  const entries = pasted ? [pasted, ...files] : files;

  return (
    <div
      className="dialog-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`dialog import-dialog${llm ? ' llm-dialog' : ''}`} role="dialog" aria-modal="true" aria-label={llm ? 'Paste the LLM reply' : 'Import strategies'}>
        <div className="dialog-head">
          <h2>{llm ? (llm.improving ? `Improve ${llm.improving} with an LLM` : 'New fighter with an LLM') : 'Import strategies'}</h2>
          <button type="button" className="btn btn-sm btn-icon btn-quiet" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="dialog-body">
          {llm ? (
            <ol className="llm-steps">
              <li className={copied ? 'done' : 'todo'}>
                {copied ? 'The prompt is on your clipboard.' : 'The browser blocked the clipboard.'}{' '}
                <button
                  type="button"
                  className="linkish"
                  onClick={() =>
                    void copyText(llm.prompt).then((ok) => {
                      setCopied(ok);
                      pasteRef.current?.focus();
                    })
                  }
                >
                  {copied ? 'Copy again' : 'Copy the prompt'}
                </button>
                <span className="faint num"> ({llm.prompt.length.toLocaleString('en-US')} characters)</span>
              </li>
              <li>Paste it into any chat model (Claude, ChatGPT, Gemini…) and answer its questions.</li>
              <li>Paste its whole reply below. The game reads the ```json block and checks it like any import.</li>
            </ol>
          ) : null}
          <div
            hidden={llm !== null}
            className={`dropzone${dragging ? ' over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void addFiles([...e.dataTransfer.files]);
            }}
          >
            <ImportIcon size={18} />
            <span>
              Drop <b>.json</b> files here, or{' '}
              <button type="button" className="linkish" onClick={() => pickRef.current?.click()}>
                pick files
              </button>
              .
            </span>
            <input
              ref={pickRef}
              type="file"
              accept=".json,application/json"
              multiple
              hidden
              onChange={(e) => {
                const list = e.target.files ? [...e.target.files] : [];
                e.target.value = '';
                void addFiles(list);
              }}
            />
          </div>

          <label className="field">
            <span>{llm ? 'The model’s reply' : 'Or paste JSON or a strategy code'}</span>
            <textarea
              ref={pasteRef}
              className="input paste-box"
              value={paste}
              spellCheck={false}
              placeholder={llm ? 'Here is your fighter…\n```json\n{ "schema": "pit-strategy/2", ... }\n```' : '{ "schema": "pit-strategy/2", ... }   or   PIT2.…'}
              onChange={(e) => setPaste(e.target.value)}
            />
          </label>
          {hint ? <p className="side-note llm-hint">{hint}</p> : null}

          {entries.length ? (
            <div className="imp-list">
              {entries.map((e) => (
                <EntryCard
                  key={e.id}
                  entry={e}
                  houseNames={houseNames}
                  savedAs={saved[e.id] ?? null}
                  planFor={planFor}
                  onOpen={(s) => {
                    onOpen(s);
                    onClose();
                  }}
                  onSave={(s, choice) => {
                    // Outside the updater: StrictMode runs updaters twice, which would save twice.
                    const label = onSave(s, choice);
                    setSaved((prev) => ({ ...prev, [e.id]: label }));
                  }}
                  onIssue={e.id === 0 ? jumpInPaste : undefined}
                />
              ))}
            </div>
          ) : (
            <p className="faint">{llm ? 'Nothing is saved until you choose to. The reply is checked first.' : 'Nothing is saved until you choose to. Each strategy is checked first.'}</p>
          )}
        </div>
        <div className="dialog-foot">
          <span className="faint">Errors block a strategy. Warnings are advice: you can accept them.</span>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function EntryCard(props: {
  entry: ImportEntry;
  houseNames: readonly string[];
  savedAs: string | null;
  planFor: (s: Strategy) => SavePlan;
  onOpen: (s: Strategy) => void;
  onSave: (s: Strategy, choice: SaveChoice) => void;
  /** Clicking an issue (pasted text only: jumps to the spot in the paste box). */
  onIssue?: (line?: number, column?: number) => void;
}) {
  const { entry, houseNames, savedAs, planFor, onOpen, onSave, onIssue } = props;
  const s = entry.report.strategy ?? null;
  const plan = s ? planFor(s) : null;
  const verdict = importVerdict(entry.report);
  const errors = entry.issues.filter((i) => i.severity === 'error');
  const warnings = entry.issues.filter((i) => i.severity === 'warning');
  const clash = s !== null && houseNames.includes(s.name);
  return (
    <section className={`imp-entry${verdict.ok ? '' : ' blocked'}`} aria-label={entry.label}>
      <div className="imp-head">
        <div className="imp-title">
          {/* An imported "version" is never trusted: the library numbers it when it is saved. */}
          <b>{s ? s.name : entry.label}</b>
          <span className="faint">
            {s ? `${buildLine(s.build.weapon, s.build.skill)} · ${entry.source === 'file' ? entry.label : SOURCE_LABEL[entry.source] ?? entry.source}` : SOURCE_LABEL[entry.source] ?? entry.source}
          </span>
        </div>
        <span className="imp-count">
          {errors.length ? <span className="chip chip-hot">{errors.length} {errors.length === 1 ? 'error' : 'errors'}</span> : null}
          {warnings.length ? <span className="chip">{warnings.length} {warnings.length === 1 ? 'warning' : 'warnings'}</span> : null}
          {!errors.length && !warnings.length ? <span className="chip">valid</span> : null}
        </span>
      </div>
      {entry.issues.length ? (
        <ul className="issues">
          {entry.issues.map((iss, i) => {
            const spot = issueSpot(iss);
            const body = (
              <>
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
              </>
            );
            return (
              <li key={i}>
                {onIssue && spot ? (
                  <button type="button" className={`issue ${iss.severity}`} onClick={() => onIssue(iss.line, iss.column)} title="Show in the pasted text">
                    {body}
                  </button>
                ) : (
                  <div className={`issue static ${iss.severity}`}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {clash ? <p className="side-note">Same name as a house stack. Rename it after opening so reports and ratings can tell yours apart.</p> : null}
      {plan?.kind === 'collision' && !savedAs ? (
        <p className="side-note">“{plan.name}” is already in your library. Add this as its next version, or save it as a new strategy.</p>
      ) : null}
      <div className="imp-actions">
        {savedAs ? (
          <button type="button" className="btn btn-sm" disabled>
            Saved as {savedAs}
          </button>
        ) : plan?.kind === 'collision' && s ? (
          <>
            <button type="button" className="btn btn-sm" disabled={!verdict.ok} onClick={() => onSave(s, { kind: 'plan' })} title={`Add to the history of your ${plan.name}`}>
              Add as v{plan.version} of {plan.name}
            </button>
            <button type="button" className="btn btn-sm" disabled={!verdict.ok} onClick={() => onSave(s, { kind: 'rename', name: plan.suggestedName })} title="Keep it apart, with its own history">
              Save as {plan.suggestedName}
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-sm" disabled={!verdict.ok || !s} onClick={() => s && onSave(s, { kind: 'plan' })} title={verdict.ok ? 'Save it in your library' : 'Fix the errors first'}>
            {plan ? (plan.kind === 'version' ? `Save as v${plan.version} (from v${plan.parentVersion})` : `Save as ${plan.name} v${plan.version}`) : 'Save to library'}
          </button>
        )}
        <button type="button" className={`btn btn-sm${verdict.ok ? ' btn-primary' : ''}`} disabled={!verdict.ok || !s} onClick={() => s && onOpen(s)} title={verdict.ok ? 'Replace the editor with this strategy' : 'Errors block loading'}>
          {verdict.label}
        </button>
      </div>
    </section>
  );
}
