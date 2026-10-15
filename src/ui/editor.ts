// Owned by: ui
// Pure helpers for the strategy editor: JSON errors with a line and column, issue underlines, and
// the budget meter.
import { ATTRIBUTE_BUDGET, ATTRIBUTE_KEYS, ATTRIBUTE_MAX, ATTRIBUTE_MIN, STRATEGY_SCHEMA, WEAPON_IDS } from '../core';
import type { AttributeKey, Attributes, Strategy, ValidationIssue, WeaponId } from '../core';

export const NEW_STRATEGY_NAME = 'My Gladiator';

/**
 * Text for "New strategy": the first house stack under a fresh name (house stacks are known to
 * validate, so a new player starts from something that fights), or a bare brawler when there are
 * none. Never a house stack's own name: reports and ratings key on `name@vN`, and a copy saved
 * under the original name would pour its results into the house stack's row.
 */
export function newStrategyText(house: readonly Strategy[]): string {
  const base = house[0];
  const s: Strategy = base
    ? { ...base, name: NEW_STRATEGY_NAME, author: undefined, version: 1 }
    : {
        schema: STRATEGY_SCHEMA,
        name: NEW_STRATEGY_NAME,
        version: 1,
        build: { weapon: 'GREATSWORD', skill: 'DASH', attributes: { vitality: 18, power: 18, agility: 18, perception: 16, armor: 16, haste: 14 } },
        target: '0 - it.distance',
        behaviours: { brawl: { score: '1', move: [{ seek: 'target', weight: 1 }], attack: 'in_range' } },
        commit: 30,
      };
  return prettyJson(s);
}

export type JsonParse =
  | { ok: true; value: unknown }
  | { ok: false; message: string; line: number; col: number };

/**
 * JSON for the editor: like `JSON.stringify(v, null, 2)`, but any object or array that fits in
 * `width` columns stays on one line. A move term then reads as one line instead of five, so a
 * whole behaviour fits on screen and diffs between versions stay readable.
 */
export function prettyJson(value: unknown, width = 96): string {
  // The top level always breaks: a strategy is a document, not a value.
  return prettyJsonAt(value, '', 0, width);
}

const jsonEntries = (v: object) => Object.entries(v).filter(([, x]) => x !== undefined);

/** A value on one line the way the editor writes it: `{ "seek": "target", "weight": 1 }`. */
export function inlineJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(inlineJson).join(', ')}]`;
  if (v !== null && typeof v === 'object') {
    const e = jsonEntries(v);
    return e.length ? `{ ${e.map(([k, x]) => `${JSON.stringify(k)}: ${inlineJson(x)}`).join(', ')} }` : '{}';
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * `prettyJson` for a value that starts inside a document: `indent` is the indentation of its line
 * and `room` the columns left on that line, so a replaced value lines up with its neighbours.
 */
export function prettyJsonAt(value: unknown, indent: string, room: number, width = 96): string {
  const walk = (v: unknown, indent: string, room: number): string => {
    const flat = inlineJson(v);
    if (v === null || typeof v !== 'object' || flat.length <= room || flat === '{}' || flat === '[]') return flat;
    const inner = `${indent}  `;
    if (Array.isArray(v)) {
      return `[\n${v.map((x) => inner + walk(x, inner, width - inner.length - 1)).join(',\n')}\n${indent}]`;
    }
    const lines = jsonEntries(v).map(([k, x]) => {
      const key = `${JSON.stringify(k)}: `;
      return inner + key + walk(x, inner, width - inner.length - key.length - 1);
    });
    return `{\n${lines.join(',\n')}\n${indent}}`;
  };
  return walk(value, indent, room);
}

/** Line and column (both 1-based) of a character offset. */
export function lineCol(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = before.split('\n');
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

/** Character offset of a 1-based line and column, clamped to the text. Inverse of `lineCol`. */
export function offsetOf(text: string, line: number, col: number): number {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf('\n', offset);
    if (nl < 0) return text.length;
    offset = nl + 1;
  }
  const end = text.indexOf('\n', offset);
  return Math.min(offset + Math.max(0, col - 1), end < 0 ? text.length : end);
}

/**
 * JSON.parse with a usable location. Engines word their errors differently: V8 says
 * "at position 123" or "(line 3 column 5)", Firefox says "at line 3 column 5". Without a location
 * the error points at the end of the text, which is where a truncated paste usually breaks.
 */
export function parseJson(text: string): JsonParse {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const lc = /line (\d+) column (\d+)/i.exec(raw);
    if (lc) return { ok: false, message: cleanJsonMessage(raw), line: Number(lc[1]), col: Number(lc[2]) };
    const pos = /position (\d+)/i.exec(raw);
    const at = lineCol(text, pos ? Number(pos[1]) : text.length);
    return { ok: false, message: cleanJsonMessage(raw), ...at };
  }
}

function cleanJsonMessage(raw: string): string {
  const msg = raw
    .replace(/^JSON\.parse:\s*/i, '')
    .replace(/\s*(in JSON )?at position \d+.*$/i, '')
    .replace(/\s*\(line \d+ column \d+\)/i, '')
    .replace(/\s*at line \d+ column \d+ of the JSON data/i, '')
    .trim();
  return msg ? msg.charAt(0).toUpperCase() + msg.slice(1) : 'Invalid JSON';
}

/**
 * Attributes from a draft that may be invalid elsewhere, so the budget meter keeps working while
 * the player is halfway through an edit. Non-numbers read as null.
 */
export function readAttributes(value: unknown): Record<AttributeKey, number | null> | null {
  const attrs = (value as { build?: { attributes?: unknown } } | null)?.build?.attributes;
  if (typeof attrs !== 'object' || attrs === null) return null;
  const out = {} as Record<AttributeKey, number | null>;
  for (const k of ATTRIBUTE_KEYS) {
    const v = (attrs as Record<string, unknown>)[k];
    out[k] = typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  return out;
}

export function readWeapon(value: unknown): WeaponId | null {
  const w = (value as { build?: { weapon?: unknown } } | null)?.build?.weapon;
  return typeof w === 'string' && (WEAPON_IDS as readonly string[]).includes(w) ? (w as WeaponId) : null;
}

export type BudgetRow = { key: AttributeKey; value: number | null; outOfRange: boolean };
export type Budget = { rows: BudgetRow[]; total: number; left: number; over: boolean; complete: boolean };

/** Budget meter state: total spent, points left, and which attributes are outside 4..40. */
export function budget(attrs: Record<AttributeKey, number | null>): Budget {
  let total = 0;
  let complete = true;
  const rows = ATTRIBUTE_KEYS.map((key) => {
    const value = attrs[key];
    if (value === null) complete = false;
    else total += value;
    const outOfRange = value === null || value < ATTRIBUTE_MIN || value > ATTRIBUTE_MAX;
    return { key, value, outOfRange };
  });
  const left = ATTRIBUTE_BUDGET - total;
  return { rows, total, left, over: left < 0, complete };
}

/**
 * Character offset of the key a validator path points at, e.g. `behaviours.kite.move[1].keep_range`,
 * so clicking an issue can put the cursor on it. Walks the keys in order through the text, which
 * is right for any JSON a person or an LLM writes (keys are not repeated inside their own value).
 * Array indices are skipped: the next named key after them is close enough to the error.
 * Returns the deepest key found, or -1 when not even the first key is in the text.
 */
export function locatePath(text: string, path: string): number {
  const keys = path.split(/[.[\]]+/).filter((k) => k !== '' && !/^\d+$/.test(k));
  let from = 0;
  let found = -1;
  for (const key of keys) {
    const at = text.indexOf(JSON.stringify(key), from);
    if (at < 0) break;
    found = at;
    from = at + key.length + 2;
  }
  return found;
}

/** Full attributes when every value is present (for derived stats), else null. */
export function completeAttributes(attrs: Record<AttributeKey, number | null> | null): Attributes | null {
  if (!attrs) return null;
  for (const k of ATTRIBUTE_KEYS) if (attrs[k] === null) return null;
  return attrs as Attributes;
}

/**
 * Where an issue points in the text: the gate's own line and column when it gave them, otherwise
 * the key its path names (or, for a JSON syntax error without a location, where parsing fails).
 * -1 when the text has no such spot.
 */
export function issueOffset(text: string, issue: Pick<ValidationIssue, 'path' | 'line' | 'column'>): number {
  if (issue.line !== undefined && issue.column !== undefined) return offsetOf(text, issue.line, issue.column);
  if (issue.path) return locatePath(text, issue.path);
  const parsed = parseJson(text);
  return parsed.ok ? -1 : offsetOf(text, parsed.line, parsed.col);
}

/**
 * End of the token starting at `start`, for the underline: a whole JSON string (escapes included),
 * a number, a name, or one character. Never runs past the end of the line.
 */
export function tokenEnd(text: string, start: number): number {
  const nl = text.indexOf('\n', start);
  const lineEnd = nl < 0 ? text.length : nl;
  if (start >= lineEnd) return Math.min(text.length, start + 1);
  if (text[start] === '"') {
    for (let i = start + 1; i < lineEnd; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '"') return i + 1;
    }
    return lineEnd;
  }
  let i = start;
  // A name inside an expression stops at operators (`hp+1` underlines only `hp`); a number may hold "+-" in its exponent.
  const word = /[A-Za-z_]/.test(text[start]) ? /[\w.]/ : /[\w.+-]/;
  while (i < lineEnd && word.test(text[i])) i++;
  return Math.max(i, start + 1);
}

/** One issue placed in the text: the characters to underline and the 1-based spot to report. */
export type IssueSpan = { start: number; end: number; line: number; column: number; severity: ValidationIssue['severity']; issue: ValidationIssue };

/** Every issue that can be placed in the text, errors first, then by position. */
export function placeIssues(text: string, issues: readonly ValidationIssue[]): IssueSpan[] {
  const out: IssueSpan[] = [];
  for (const issue of issues) {
    let start = issueOffset(text, issue);
    if (start < 0) continue;
    // "Unexpected end of JSON" points past the last character: underline the last one instead.
    if (start >= text.length) start = Math.max(0, text.length - 1);
    const { line, col } = lineCol(text, start);
    out.push({ start, end: tokenEnd(text, start), line, column: col, severity: issue.severity, issue });
  }
  return out.sort((a, b) => sevRank(a) - sevRank(b) || a.start - b.start);
}

/** Underlines to draw, in text order, never overlapping: on a shared spot the error wins over a warning. */
export function underlineSpans(spans: readonly IssueSpan[]): IssueSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || sevRank(a) - sevRank(b));
  const out: IssueSpan[] = [];
  for (const s of sorted) {
    const prev = out[out.length - 1];
    if (prev && s.start < prev.end) continue;
    out.push(s);
  }
  return out;
}

/** Worst severity per 1-based line, for the gutter. */
export function lineSeverity(spans: readonly IssueSpan[]): Map<number, ValidationIssue['severity']> {
  const out = new Map<number, ValidationIssue['severity']>();
  for (const s of spans) if (out.get(s.line) !== 'error') out.set(s.line, s.severity);
  return out;
}

/** The issue under the caret, or else the first one on the caret's line, for the status line. */
export function issueAtCaret(spans: readonly IssueSpan[], text: string, caret: number): IssueSpan | null {
  const inside = spans.find((s) => caret >= s.start && caret <= s.end);
  if (inside) return inside;
  const line = lineCol(text, caret).line;
  return spans.find((s) => s.line === line) ?? null;
}

function sevRank(s: { severity: ValidationIssue['severity'] }): number {
  return s.severity === 'error' ? 0 : 1;
}
