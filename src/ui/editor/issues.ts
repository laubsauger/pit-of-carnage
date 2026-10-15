// Owned by: ui
// How an issue from the gate is shown: its icon (errors a red circle, warnings an amber triangle,
// so they differ in shape as well as colour), its "did you mean" line, and the one-click fix.

export type Severity = 'error' | 'warning';

/** Static, trusted SVG markup for each severity. */
export const SEVERITY_SVG: Readonly<Record<Severity, string>> = {
  error:
    '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="#c4302b"/><path d="M4.6 4.6l4.8 4.8M9.4 4.6l-4.8 4.8" stroke="#fff6f0" stroke-width="1.6" stroke-linecap="round"/></svg>',
  warning:
    '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.3 13 12.2H1z" fill="#c9a55a"/><path d="M7 5.2v3.3" stroke="#1f1c19" stroke-width="1.6" stroke-linecap="round"/><circle cx="7" cy="10.3" r="0.9" fill="#1f1c19"/></svg>',
};

/** "Did you mean …?" for a suggestion, which may already be phrased as one. */
export function suggestionLine(s: string): string {
  return /^did you mean/i.test(s) ? s : `Did you mean "${s}"?`;
}

/**
 * Replacement text for a "did you mean" fix at `span`, or null when the suggestion is advice
 * rather than a word. On a quoted spot (an unknown key or enum value) the fix keeps the quotes.
 */
export function fixText(text: string, span: { start: number; end: number }, suggestion: string | undefined): string | null {
  if (!suggestion || !/^[\w.$/-]+$/.test(suggestion)) return null;
  return text[span.start] === '"' ? JSON.stringify(suggestion) : suggestion;
}
