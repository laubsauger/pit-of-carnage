// Owned by: ui
// The import dialog's model: every file, paste or code goes through the one gate (`loadStrategy`)
// and comes back as an entry with a report the dialog shows before anything is saved.
import type { LoadReport, StrategySource, ValidationIssue } from '../core';
import { CODE_PREFIX, loadStrategy } from '../strategy';
import { issueOffset, lineCol } from './editor';

export type ImportEntry = {
  id: number;
  /** File name, or "Pasted text". */
  label: string;
  source: StrategySource;
  text: string;
  report: LoadReport;
  /** Errors, then warnings, each with a line and column whenever the text can supply one. */
  issues: ValidationIssue[];
};

/** A strategy code is recognised by its prefix wherever it came from; anything else is JSON text. */
export function sourceOf(text: string, fromFile: boolean): StrategySource {
  return text.trim().startsWith(CODE_PREFIX) ? 'code' : fromFile ? 'file' : 'paste';
}

/**
 * The issue with a line and column. The gate supplies them for text input; until it does for every
 * issue, the spot its path names stands in. A code is opaque, so its issues stay without a spot.
 */
export function locateIssue(text: string, issue: ValidationIssue, source: StrategySource): ValidationIssue {
  if (source === 'code' || (issue.line !== undefined && issue.column !== undefined)) return issue;
  const at = issueOffset(text, issue);
  if (at < 0) return issue;
  const { line, col } = lineCol(text, Math.min(at, text.length));
  return { ...issue, line, column: col };
}

export function checkImport(label: string, text: string, fromFile: boolean, id = 0): ImportEntry {
  const source = sourceOf(text, fromFile);
  const report = loadStrategy(text, source);
  const issues = [...report.errors, ...report.warnings].map((i) => locateIssue(text, i, source));
  return { id, label, source, text, report, issues };
}

/** A dropped file that is not JSON: reported like any other problem, never read. */
export function rejectedFile(label: string, id = 0): ImportEntry {
  const message = 'Not a .json file. Export a strategy as JSON, or paste its code into the box.';
  return { id, label, source: 'file', text: '', report: { errors: [{ path: '', message, severity: 'error' }], warnings: [] }, issues: [{ path: '', message, severity: 'error' }] };
}

export function isJsonFile(file: { name: string; type: string }): boolean {
  return /\.json$/i.test(file.name) || file.type === 'application/json';
}

/** Errors block; warnings are the player's call, so the button names them. */
export function importVerdict(report: LoadReport): { ok: boolean; label: string } {
  const e = report.errors.length;
  const w = report.warnings.length;
  if (e > 0 || !report.strategy) return { ok: false, label: `Fix ${e || 1} ${e === 1 ? 'error' : 'errors'} first` };
  if (w > 0) return { ok: true, label: `Open with ${w} ${w === 1 ? 'warning' : 'warnings'}` };
  return { ok: true, label: 'Open in editor' };
}

/** "line 4, column 12" when known. */
export function issueSpot(issue: Pick<ValidationIssue, 'line' | 'column'>): string | null {
  return issue.line !== undefined ? `line ${issue.line}${issue.column !== undefined ? `, column ${issue.column}` : ''}` : null;
}
