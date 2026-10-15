// Owned by: ui
// A lenient JSON scanner for the strategy editor. It never throws: half-typed text still yields
// every token with the JSON path it sits at (`behaviours.kite.move[1].keep_range[0]`), which is
// what highlighting, hover cards, completion and the visual builder's text edits need. The strict
// reader in src/strategy/json.ts stays the gate; this one only describes text.

export type PathSeg = string | number;

export type JsonTokenKind = 'key' | 'string' | 'number' | 'literal' | 'open' | 'close' | 'colon' | 'comma' | 'bad';

export type JsonToken = {
  kind: JsonTokenKind;
  from: number;
  /** Exclusive. An unclosed string ends at the end of its line. */
  to: number;
  /** Path of the value this token is (or, for a key, the member it names). */
  path: readonly PathSeg[];
  /** Strings only: false when the closing quote is missing. */
  closed?: boolean;
};

/** Where every value sits: `[from, to)` of the value and, for object members, where the key starts. */
export type ValueSpan = { from: number; to: number; keyFrom?: number };

export type JsonScan = {
  tokens: JsonToken[];
  /** By `pathKey`, for values that were complete. */
  values: Map<string, ValueSpan>;
};

/** `behaviours.kite.move[1]`: the validator's path notation. */
export function pathKey(path: readonly PathSeg[]): string {
  let out = '';
  for (const seg of path) out += typeof seg === 'number' ? `[${seg}]` : out ? `.${seg}` : seg;
  return out;
}

/** The inverse of `pathKey` for the paths the validator writes (keys are identifiers or words). */
export function parsePath(key: string): PathSeg[] {
  const out: PathSeg[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  for (let m = re.exec(key); m; m = re.exec(key)) out.push(m[2] !== undefined ? Number(m[2]) : m[1]!);
  return out;
}

type Frame =
  /** `hasValue`: the current key already has its value, so another string is a key (a missing comma). */
  | { t: 'obj'; from: number; key: string | null; keyFrom: number; expectKey: boolean; hasValue: boolean; path: PathSeg[] }
  | { t: 'arr'; from: number; index: number; path: PathSeg[] };

function valuePath(top: Frame | undefined): PathSeg[] {
  if (!top) return [];
  if (top.t === 'arr') return [...top.path, top.index];
  return top.key === null ? [...top.path] : [...top.path, top.key];
}

const LITERAL = /^(?:true|false|null)/;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
/**
 * Nesting the scanner follows: the gate's MAX_JSON_DEPTH (src/strategy/json.ts), which refuses
 * anything deeper. Every token carries its path, so without a cap a paste of 20 000 `[` would hold
 * 200 million path segments and take the tab down.
 */
const MAX_DEPTH = 64;

/** Scan the whole text. Linear; about a millisecond for the 64 KiB limit. */
export function scanJson(text: string): JsonScan {
  const tokens: JsonToken[] = [];
  const values = new Map<string, ValueSpan>();
  const stack: Frame[] = [];
  const n = text.length;
  let i = 0;

  const recordValue = (path: PathSeg[], from: number, to: number) => {
    const top = stack[stack.length - 1];
    if (top?.t === 'obj') top.hasValue = true;
    const span: ValueSpan = { from, to };
    if (top?.t === 'obj' && top.key !== null) span.keyFrom = top.keyFrom;
    values.set(pathKey(path), span);
  };

  while (i < n) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
      i++;
      continue;
    }
    const top = stack[stack.length - 1];
    if (ch === '"') {
      const from = i;
      i++;
      let closed = false;
      while (i < n) {
        const c = text[i]!;
        if (c === '\\') i += 2;
        else if (c === '"') {
          i++;
          closed = true;
          break;
        } else if (c === '\n') break;
        else i++;
      }
      const to = Math.min(i, n);
      if (top?.t === 'obj' && (top.expectKey || top.hasValue)) {
        const key = closed ? unquote(text.slice(from, to)) : text.slice(from + 1, to);
        top.key = key;
        top.keyFrom = from;
        top.expectKey = false;
        top.hasValue = false;
        tokens.push({ kind: 'key', from, to, path: [...top.path, key], closed });
      } else {
        const path = valuePath(top);
        tokens.push({ kind: 'string', from, to, path, closed });
        if (closed) recordValue(path, from, to);
        else if (top?.t === 'obj') top.hasValue = true;
      }
      continue;
    }
    if (ch === '{' || ch === '[') {
      if (stack.length > MAX_DEPTH) {
        // Deeper than any strategy may nest (the gate says so): the rest is one bad token.
        tokens.push({ kind: 'bad', from: i, to: n, path: valuePath(top) });
        break;
      }
      const path = valuePath(top);
      tokens.push({ kind: 'open', from: i, to: i + 1, path });
      stack.push(ch === '{' ? { t: 'obj', from: i, key: null, keyFrom: i, expectKey: true, hasValue: false, path } : { t: 'arr', from: i, index: 0, path });
      i++;
      continue;
    }
    if (ch === '}' || ch === ']') {
      const want = ch === '}' ? 'obj' : 'arr';
      tokens.push({ kind: 'close', from: i, to: i + 1, path: top ? [...top.path] : [] });
      if (top && top.t === want) {
        stack.pop();
        const parent = stack[stack.length - 1];
        // The container's own span, keyed by its path in the parent.
        const span: ValueSpan = { from: top.from, to: i + 1 };
        if (parent?.t === 'obj' && parent.key !== null) span.keyFrom = parent.keyFrom;
        if (parent?.t === 'obj') parent.hasValue = true;
        values.set(pathKey(top.path), span);
      }
      i++;
      continue;
    }
    if (ch === ':') {
      tokens.push({ kind: 'colon', from: i, to: i + 1, path: valuePath(top) });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma', from: i, to: i + 1, path: top ? [...top.path] : [] });
      if (top?.t === 'obj') {
        top.key = null;
        top.expectKey = true;
        top.hasValue = false;
      } else if (top?.t === 'arr') top.index++;
      i++;
      continue;
    }
    const rest = text.slice(i, i + 32);
    const lit = LITERAL.exec(rest) ?? NUMBER.exec(rest);
    if (lit) {
      const path = valuePath(top);
      const kind = /^[tfn]/.test(lit[0]) ? 'literal' : 'number';
      tokens.push({ kind, from: i, to: i + lit[0].length, path });
      recordValue(path, i, i + lit[0].length);
      i += lit[0].length;
      continue;
    }
    // Anything else: a bare word or stray character. One token per run, so the scan always advances.
    const from = i;
    while (i < n && !/[\s"{}[\]:,]/.test(text[i]!)) i++;
    if (i === from) i++;
    tokens.push({ kind: 'bad', from, to: i, path: valuePath(top) });
  }
  return { tokens, values };
}

function unquote(lit: string): string {
  try {
    const v: unknown = JSON.parse(lit);
    return typeof v === 'string' ? v : lit.slice(1, -1);
  } catch {
    return lit.slice(1, -1);
  }
}

/** Does the caret at `offset` count as inside `t`? Right after a word or an unclosed string does (that is where typing goes on). */
function touches(t: JsonToken, offset: number): boolean {
  if (offset < t.to) return offset >= t.from;
  if (offset > t.to) return false;
  if (t.kind === 'string' || t.kind === 'key') return t.closed === false;
  return t.kind === 'number' || t.kind === 'literal' || t.kind === 'bad';
}

/** The token containing `offset`, or null between tokens. */
export function tokenAt(tokens: readonly JsonToken[], offset: number): JsonToken | null {
  let lo = 0;
  let hi = tokens.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = tokens[mid]!;
    if (touches(t, offset)) return t;
    if (offset < t.from) hi = mid - 1;
    else lo = mid + 1;
  }
  return null;
}

/** A string token's content offset range (inside the quotes). */
export function stringContent(t: JsonToken): { from: number; to: number } {
  return { from: t.from + 1, to: t.closed ? t.to - 1 : t.to };
}

/**
 * Where a new key or value would go at `offset` when it is not inside a token: the object whose
 * key is expected there (`key`), or the path of the value that is expected (`value`).
 */
export function slotAt(text: string, offset: number): { at: 'key'; object: PathSeg[] } | { at: 'value'; path: PathSeg[] } | null {
  // The frame state at the end of the prefix is the context of `offset`.
  const stack: { obj: boolean; path: PathSeg[]; key: string | null; index: number }[] = [];
  for (const t of scanJson(text.slice(0, offset)).tokens) {
    const top = stack[stack.length - 1];
    if (t.kind === 'open') stack.push({ obj: text[t.from] === '{', path: [...t.path], key: null, index: 0 });
    else if (t.kind === 'close') stack.pop();
    else if (t.kind === 'key' && top) top.key = String(t.path[t.path.length - 1]);
    else if (t.kind === 'comma' && top) {
      top.key = null;
      top.index++;
    }
  }
  const top = stack[stack.length - 1];
  if (!top) return null;
  if (!top.obj) return { at: 'value', path: [...top.path, top.index] };
  return top.key === null ? { at: 'key', object: top.path } : { at: 'value', path: [...top.path, top.key] };
}
