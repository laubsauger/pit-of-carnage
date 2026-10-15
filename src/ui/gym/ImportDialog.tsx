// Owned by: ui
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { Strategy } from '../../core';
import { offsetOf } from '../editor';
import { SEVERITY_SVG, suggestionLine } from '../editor/issues';
import { buildLine, strategyLabel } from '../format';
import { CloseIcon, ImportIcon } from '../icons';
import { checkImport, importVerdict, isJsonFile, issueSpot, rejectedFile } from '../importer';
import type { ImportEntry } from '../importer';

type Props = {
  /** Files dropped on the editor before the dialog opened. */
  initialFiles: File[];
  houseNames: readonly string[];
  onOpen: (s: Strategy) => void;
  /** Saves as the next version; returns the label it was saved under. */
  onSave: (s: Strategy) => string;
  onClose: () => void;
};

const SOURCE_LABEL: Record<string, string> = { file: 'File', paste: 'Pasted JSON', code: 'Strategy code' };

/**
 * Import strategies from .json files (dropped or picked), pasted JSON or a strategy code. Each one
 * is checked by the same gate as everything else and its report is shown before anything is saved:
 * errors block, warnings can be accepted.
 */
export function ImportDialog({ initialFiles, houseNames, onOpen, onSave, onClose }: Props) {
  const [files, setFiles] = useState<ImportEntry[]>([]);
  const [paste, setPaste] = useState('');
  const [dragging, setDragging] = useState(false);
  const [saved, setSaved] = useState<Record<number, string>>({});
  const nextId = useRef(1);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const deferred = useDeferredValue(paste);
  const pasted = useMemo(() => (deferred.trim() ? checkImport('Pasted text', deferred, false, 0) : null), [deferred]);

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
      <div className="dialog import-dialog" role="dialog" aria-modal="true" aria-label="Import strategies">
        <div className="dialog-head">
          <h2>Import strategies</h2>
          <button type="button" className="btn btn-sm btn-icon btn-quiet" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="dialog-body">
          <div
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
            <span>Or paste JSON or a strategy code</span>
            <textarea
              ref={pasteRef}
              className="input paste-box"
              value={paste}
              spellCheck={false}
              placeholder={'{ "schema": "pit-strategy/2", ... }   or   PIT2.…'}
              onChange={(e) => setPaste(e.target.value)}
            />
          </label>

          {entries.length ? (
            <div className="imp-list">
              {entries.map((e) => (
                <EntryCard
                  key={e.id}
                  entry={e}
                  houseNames={houseNames}
                  savedAs={saved[e.id] ?? null}
                  onOpen={(s) => {
                    onOpen(s);
                    onClose();
                  }}
                  onSave={(s) => {
                    // Outside the updater: StrictMode runs updaters twice, which would save twice.
                    const label = onSave(s);
                    setSaved((prev) => ({ ...prev, [e.id]: label }));
                  }}
                  onIssue={e.id === 0 ? jumpInPaste : undefined}
                />
              ))}
            </div>
          ) : (
            <p className="faint">Nothing is saved until you choose to. Each strategy is checked first.</p>
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
  onOpen: (s: Strategy) => void;
  onSave: (s: Strategy) => void;
  /** Clicking an issue (pasted text only: jumps to the spot in the paste box). */
  onIssue?: (line?: number, column?: number) => void;
}) {
  const { entry, houseNames, savedAs, onOpen, onSave, onIssue } = props;
  const s = entry.report.strategy ?? null;
  const verdict = importVerdict(entry.report);
  const errors = entry.issues.filter((i) => i.severity === 'error');
  const warnings = entry.issues.filter((i) => i.severity === 'warning');
  const clash = s !== null && houseNames.includes(s.name);
  return (
    <section className={`imp-entry${verdict.ok ? '' : ' blocked'}`} aria-label={entry.label}>
      <div className="imp-head">
        <div className="imp-title">
          <b>{s ? strategyLabel(s.name, s.version) : entry.label}</b>
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
      <div className="imp-actions">
        <button type="button" className="btn btn-sm" disabled={!verdict.ok || !s || savedAs !== null} onClick={() => s && onSave(s)} title={verdict.ok ? 'Save as the next version in your library' : 'Fix the errors first'}>
          {savedAs ? `Saved as ${savedAs}` : 'Save to library'}
        </button>
        <button type="button" className={`btn btn-sm${verdict.ok ? ' btn-primary' : ''}`} disabled={!verdict.ok || !s} onClick={() => s && onOpen(s)} title={verdict.ok ? 'Replace the editor with this strategy' : 'Errors block loading'}>
          {verdict.label}
        </button>
      </div>
    </section>
  );
}
