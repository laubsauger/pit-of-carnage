// Owned by: ui
// Pure helpers for the strategy editor: JSON errors with a line and column, and the budget meter.
import { ATTRIBUTE_BUDGET, ATTRIBUTE_KEYS, ATTRIBUTE_MAX, ATTRIBUTE_MIN, WEAPON_IDS } from '../core';
import type { AttributeKey, Attributes, WeaponId } from '../core';

export type JsonParse =
  | { ok: true; value: unknown }
  | { ok: false; message: string; line: number; col: number };

/** Line and column (both 1-based) of a character offset. */
export function lineCol(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = before.split('\n');
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
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

/** Full attributes when every value is present (for derived stats), else null. */
export function completeAttributes(attrs: Record<AttributeKey, number | null> | null): Attributes | null {
  if (!attrs) return null;
  for (const k of ATTRIBUTE_KEYS) if (attrs[k] === null) return null;
  return attrs as Attributes;
}
