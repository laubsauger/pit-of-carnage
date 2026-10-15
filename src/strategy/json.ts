/**
 * A strict JSON reader for strategy text that remembers where everything is. `JSON.parse` gives
 * neither positions nor duplicate keys (it silently keeps the last one, so a strategy with two
 * behaviours called "lurk" loses one without a word). This reader records, for every value, the
 * offset of the value and of its key, keyed by the same paths the validator reports
 * (`behaviours.kite.move[1].keep_range[0]`), so every issue can point at a line and column.
 * Errors carry an offset and a one-line message with the likely fix.
 */

export type JsonSpot = {
  /** Offset of the value's first character (the opening quote for a string). */
  start: number;
  /** Offset of the key's opening quote, for object members. */
  keyStart?: number;
};

export type JsonDuplicate = { path: string; key: string; keyStart: number };

export type JsonRead =
  | { ok: true; value: unknown; spots: Map<string, JsonSpot>; duplicates: JsonDuplicate[] }
  | { ok: false; message: string; offset: number };

/** Deepest nesting accepted; strategies need about 6. Keeps hostile text from exhausting the stack. */
export const MAX_JSON_DEPTH = 64;

const ESCAPES: Readonly<Record<string, string>> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

class JsonSyntax extends Error {
  constructor(message: string, readonly offset: number) {
    super(message);
  }
}

function childPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

class Reader {
  private i = 0;
  readonly spots = new Map<string, JsonSpot>();
  readonly duplicates: JsonDuplicate[] = [];

  constructor(private readonly s: string) {}

  read(): unknown {
    this.ws();
    if (this.i >= this.s.length) throw new JsonSyntax('the text is empty.', 0);
    const v = this.value('', 0);
    this.ws();
    if (this.i < this.s.length) throw new JsonSyntax('unexpected text after the end of the JSON value; remove it.', this.i);
    return v;
  }

  private ws(): void {
    const s = this.s;
    for (;;) {
      const ch = s[this.i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') this.i++;
      else if (ch === '/' && (s[this.i + 1] === '/' || s[this.i + 1] === '*')) throw new JsonSyntax('JSON has no comments; remove them.', this.i);
      else return;
    }
  }

  private value(path: string, depth: number): unknown {
    if (depth > MAX_JSON_DEPTH) throw new JsonSyntax(`nested more than ${MAX_JSON_DEPTH} levels deep.`, this.i);
    const start = this.i;
    const spot = this.spots.get(path);
    if (spot) spot.start = start;
    else this.spots.set(path, { start });
    const ch = this.s[this.i];
    if (ch === '{') return this.object(path, depth);
    if (ch === '[') return this.array(path, depth);
    if (ch === '"') return this.string();
    if (ch === '-' || (ch !== undefined && ch >= '0' && ch <= '9')) return this.number();
    if (this.s.startsWith('true', this.i)) return this.word('true', true);
    if (this.s.startsWith('false', this.i)) return this.word('false', false);
    if (this.s.startsWith('null', this.i)) return this.word('null', null);
    throw this.unexpected('a value');
  }

  private word<T>(w: string, v: T): T {
    this.i += w.length;
    return v;
  }

  /** An error for the character at the cursor, with the fix for the usual suspects. */
  private unexpected(wanted: string): JsonSyntax {
    const s = this.s;
    const at = this.i;
    if (at >= s.length) return new JsonSyntax(`the text ends too early; ${wanted} is missing (an unclosed "{", "[" or string?).`, at);
    const ch = s[at]!;
    if (ch === "'") return new JsonSyntax('strings and keys need double quotes ("), not single quotes.', at);
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(at, at + 32))?.[0];
    if (word === 'True' || word === 'False' || word === 'None' || word === 'TRUE' || word === 'FALSE') return new JsonSyntax(`"${word}" is not JSON; write true, false or null in lower case.`, at);
    if (word === 'NaN' || word === 'Infinity' || word === 'undefined') return new JsonSyntax(`"${word}" is not a JSON value; write a number.`, at);
    if (word) return new JsonSyntax(`expected ${wanted}, found "${word}"; text values and keys need double quotes.`, at);
    if (ch === '+' || ch === '.') return new JsonSyntax('numbers start with a digit or "-" (write 0.5, not .5 or +0.5).', at);
    return new JsonSyntax(`expected ${wanted}, found "${ch}".`, at);
  }

  private object(path: string, depth: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const seen = new Set<string>();
    this.i++;
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') {
        if (this.s[this.i] === '}') throw new JsonSyntax('trailing comma before "}"; remove it.', this.i);
        throw this.unexpected('a key in double quotes');
      }
      const keyStart = this.i;
      const key = this.string();
      const p = childPath(path, key);
      if (seen.has(key)) this.duplicates.push({ path: p, key, keyStart });
      seen.add(key);
      this.spots.set(p, { start: keyStart, keyStart });
      this.ws();
      if (this.s[this.i] !== ':') throw this.unexpected(`":" after the key "${key}"`);
      this.i++;
      this.ws();
      const v = this.value(p, depth + 1);
      // Own property even for "__proto__", exactly like JSON.parse.
      Object.defineProperty(out, key, { value: v, writable: true, enumerable: true, configurable: true });
      this.ws();
      const ch = this.s[this.i];
      if (ch === ',') {
        this.i++;
        continue;
      }
      if (ch === '}') {
        this.i++;
        return out;
      }
      if (ch === '"') throw new JsonSyntax('missing "," between two properties.', this.i);
      throw this.unexpected('"," or "}" after a property');
    }
  }

  private array(path: string, depth: number): unknown[] {
    const out: unknown[] = [];
    this.i++;
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] === ']') throw new JsonSyntax('trailing comma before "]"; remove it.', this.i);
      out.push(this.value(`${path}[${out.length}]`, depth + 1));
      this.ws();
      const ch = this.s[this.i];
      if (ch === ',') {
        this.i++;
        continue;
      }
      if (ch === ']') {
        this.i++;
        return out;
      }
      if (ch === '"' || ch === '{' || ch === '[') throw new JsonSyntax('missing "," between two list items.', this.i);
      throw this.unexpected('"," or "]" in a list');
    }
  }

  private string(): string {
    const s = this.s;
    const open = this.i;
    this.i++;
    let out = '';
    let run = this.i;
    for (;;) {
      if (this.i >= s.length) throw new JsonSyntax('a string is not closed; add the closing ".', open);
      const ch = s.charCodeAt(this.i);
      if (ch === 34) {
        out += s.slice(run, this.i);
        this.i++;
        return out;
      }
      if (ch < 32) throw new JsonSyntax('a string cannot contain a line break or tab; write \\n or \\t, or close the string.', this.i);
      if (ch !== 92) {
        this.i++;
        continue;
      }
      out += s.slice(run, this.i);
      const e = s[this.i + 1];
      if (e !== undefined && Object.hasOwn(ESCAPES, e)) {
        out += ESCAPES[e];
        this.i += 2;
      } else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(this.i + 2, this.i + 6))) {
        out += String.fromCharCode(parseInt(s.slice(this.i + 2, this.i + 6), 16));
        this.i += 6;
      } else {
        throw new JsonSyntax(`"\\${e ?? ''}" is not a JSON escape; write \\\\ for a backslash.`, this.i);
      }
      run = this.i;
    }
  }

  private number(): number {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.s.slice(this.i, this.i + 400));
    if (!m) throw new JsonSyntax('this is not a valid number.', this.i);
    const next = this.s[this.i + m[0].length];
    if (next !== undefined && /[0-9.eE]/.test(next)) throw new JsonSyntax('this is not a valid number (no leading zeros; digits after a decimal point).', this.i);
    this.i += m[0].length;
    return Number(m[0]);
  }
}

/** Read JSON text. Never throws: syntax problems come back with an offset and a one-line message. */
export function readJson(text: string): JsonRead {
  const r = new Reader(text);
  try {
    const value = r.read();
    return { ok: true, value, spots: r.spots, duplicates: r.duplicates };
  } catch (e) {
    if (e instanceof JsonSyntax) return { ok: false, message: e.message, offset: e.offset };
    throw e;
  }
}

/** 1-based line and column (in UTF-16 units, as editors count) of an offset into text. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(Math.max(0, offset), text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: end - lineStart + 1 };
}

/**
 * Offset in the text of character `index` of the string literal whose opening quote is at
 * `quote` (escape sequences count as one character of the decoded string).
 */
export function stringCharOffset(text: string, quote: number, index: number): number {
  let i = quote + 1;
  for (let n = 0; n < index && i < text.length; n++) {
    if (text[i] !== '\\') i++;
    else i += text[i + 1] === 'u' ? 6 : 2;
  }
  return i;
}
