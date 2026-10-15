// Owned by: ui
// Edits the visual builder makes to the strategy text. The text stays the source of truth (the
// code view, undo and validation all read it), so each edit replaces only the value it changes and
// keeps the player's own formatting everywhere else. Adding or removing a member rewrites just the
// object or list that holds it, in the editor's usual layout.
import { prettyJson, prettyJsonAt } from '../editor';
import { pathKey, scanJson, stringContent } from './jsontext';
import type { JsonScan, PathSeg } from './jsontext';
import { lexExpr, slotOf } from './language';

/** Line width the editor formats to (as `prettyJson`). */
const WIDTH = 96;

type Json = unknown;

function getIn(root: Json, path: readonly PathSeg[]): Json {
  let v = root;
  for (const seg of path) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string | number, Json>)[seg];
  }
  return v;
}

/** `container` with `seg` set to `value` (or removed when `value` is undefined), as a new value. */
function withMember(container: Json, seg: PathSeg, value: Json): Json {
  if (typeof seg === 'number') {
    const arr = Array.isArray(container) ? [...container] : [];
    if (value === undefined) arr.splice(seg, 1);
    else arr[seg] = value;
    return arr;
  }
  const obj: Record<string, Json> = container !== null && typeof container === 'object' && !Array.isArray(container) ? { ...(container as Record<string, Json>) } : {};
  if (value === undefined) delete obj[seg];
  else obj[seg] = value;
  return obj;
}

function replaceSpan(text: string, from: number, to: number, value: Json): string {
  const lineStart = text.lastIndexOf('\n', from - 1) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart, from))![0];
  // Room left on the line, keeping a column for the comma that may follow.
  const room = WIDTH - (from - lineStart) - 1;
  return text.slice(0, from) + prettyJsonAt(value, indent, room, WIDTH) + text.slice(to);
}

function setIn(text: string, scan: JsonScan, root: Json, path: readonly PathSeg[], value: Json): string {
  const span = scan.values.get(pathKey(path));
  if (span && value !== undefined) return replaceSpan(text, span.from, span.to, value);
  if (path.length === 0) return value === undefined ? '' : prettyJson(value);
  const parentPath = path.slice(0, -1);
  const parent = withMember(getIn(root, parentPath), path[path.length - 1]!, value);
  return setIn(text, scan, root, parentPath, parent);
}

/**
 * The text with the value at `path` set to `value`, or removed when `value` is undefined. Missing
 * parents are created. The text must be valid JSON (the builder only edits a draft that parses).
 */
export function setAt(text: string, path: readonly PathSeg[], value: Json): string {
  const root: Json = JSON.parse(text);
  const current = getIn(root, path);
  if (value !== undefined && current !== undefined && JSON.stringify(current) === JSON.stringify(value)) return text;
  if (value === undefined && current === undefined) return text;
  return setIn(text, scanJson(text), root, path, value);
}

/** The text with the object key at `path` renamed to `name` (its value and position unchanged). */
export function renameKey(text: string, path: readonly PathSeg[], name: string): string {
  const key = pathKey(path);
  const tok = scanJson(text).tokens.find((t) => t.kind === 'key' && pathKey(t.path) === key);
  if (!tok) return text;
  return text.slice(0, tok.from) + JSON.stringify(name) + text.slice(tok.to);
}

/** The value at `path` in the parsed draft (undefined when missing). */
export function valueAt(root: unknown, path: readonly PathSeg[]): unknown {
  return getIn(root, path);
}

/**
 * Rename memory slot `from` to `to` everywhere it appears: its declaration, every `set` that
 * writes it and every expression that reads it. Other words that merely contain the name stay.
 */
export function renameMemory(text: string, from: string, to: string): string {
  const edits: { at: number; end: number; insert: string }[] = [];
  for (const t of scanJson(text).tokens) {
    const p = t.path;
    if (t.kind === 'key') {
      const isSlot = (p.length === 2 && p[0] === 'memory') || (p.length === 4 && p[0] === 'behaviours' && p[2] === 'set');
      if (isSlot && p[p.length - 1] === from) edits.push({ at: t.from, end: t.to, insert: JSON.stringify(to) });
      continue;
    }
    if (t.kind !== 'string') continue;
    const slot = slotOf(p);
    if (slot.kind !== 'expr' && slot.kind !== 'attack') continue;
    const c = stringContent(t);
    const src = text.slice(c.from, c.to);
    if (src.includes('\\')) continue;
    for (const x of lexExpr(src)) if (x.kind === 'name' && x.text === from) edits.push({ at: c.from + x.from, end: c.from + x.to, insert: to });
  }
  let out = text;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.insert + out.slice(e.end);
  return out;
}
