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

/**
 * The text with the member at index `from` of the object or array at `container` moved to index
 * `to` (behaviours and move terms; order decides who wins a tied score). Each member keeps its own
 * text and the separators stay where they were, so the player's formatting survives. Unchanged when
 * an index is out of range or a member cannot be placed in the text.
 */
export function moveMember(text: string, container: readonly PathSeg[], from: number, to: number): string {
  if (from === to) return text;
  let root: Json;
  try {
    root = JSON.parse(text);
  } catch {
    return text;
  }
  const value = getIn(root, container);
  if (value === null || typeof value !== 'object') return text;
  const segs: PathSeg[] = Array.isArray(value) ? value.map((_, i) => i) : Object.keys(value);
  if (from < 0 || to < 0 || from >= segs.length || to >= segs.length) return text;
  const scan = scanJson(text);
  const spans = segs.map((seg) => {
    const sp = scan.values.get(pathKey([...container, seg]));
    return sp ? { from: sp.keyFrom ?? sp.from, to: sp.to } : null;
  });
  // A duplicate key (JSON.parse keeps the last) or a half-scanned member: do not guess.
  if (spans.some((s) => s === null)) return text;
  const placed = spans as { from: number; to: number }[];
  for (let i = 1; i < placed.length; i++) if (placed[i]!.from < placed[i - 1]!.to) return text;
  const order = segs.map((_, i) => i);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved!);
  let out = text.slice(0, placed[0]!.from);
  order.forEach((src, slot) => {
    out += text.slice(placed[src]!.from, placed[src]!.to);
    if (slot < placed.length - 1) out += text.slice(placed[slot]!.to, placed[slot + 1]!.from);
  });
  return out + text.slice(placed[placed.length - 1]!.to);
}

/**
 * The text with `"version"` set to the library's number after a save, touching nothing else: an
 * existing version is replaced in place; a draft without one (a new fighter, an import, an LLM's
 * answer) gets it on its own line right after the name. Null when the text has no name to anchor to.
 */
export function stampVersion(text: string, version: number): string | null {
  const scan = scanJson(text);
  if (scan.values.has('version')) return setAt(text, ['version'], version);
  const name = scan.values.get('name');
  if (!name || name.keyFrom === undefined) return null;
  const lineStart = text.lastIndexOf('\n', name.keyFrom - 1) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart, name.keyFrom))![0];
  const sameLine = text.slice(lineStart, name.keyFrom).trim() !== '';
  return `${text.slice(0, name.to)},${sameLine ? ' ' : `\n${indent}`}"version": ${version}${text.slice(name.to)}`;
}
