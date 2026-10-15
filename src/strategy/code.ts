/**
 * Strategy codes: a strategy as one pasteable line. JSON, raw-deflated with fflate, then
 * base64url (URL- and chat-safe, no padding), behind the prefix "PIT2.". Decoding validates, so
 * a code from a stranger is checked exactly like a hand-written strategy. Codes are capped in
 * length and in what they may unpack to, so a hostile code (a "zip bomb") cannot eat the memory.
 */

import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';
import type { Strategy, ValidationResult } from '../core';
import { validateStrategy } from './validate';

export const CODE_PREFIX = 'PIT2.';

/** Longest code accepted (characters). Real codes are 1-3 thousand. */
export const MAX_CODE_LENGTH = 16 * 1024;
/** Most bytes a code may unpack to; a strategy's JSON is a few thousand. */
export const MAX_CODE_JSON_BYTES = 64 * 1024;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

function toBase64Url(bytes: Uint8Array): string {
  const out: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out.push(ALPHABET[(n >> 18) & 63]!, ALPHABET[(n >> 12) & 63]!, ALPHABET[(n >> 6) & 63]!, ALPHABET[n & 63]!);
  }
  const rest = bytes.length - i;
  if (rest > 0) {
    const n = (bytes[i]! << 16) | (rest === 2 ? bytes[i + 1]! << 8 : 0);
    out.push(ALPHABET[(n >> 18) & 63]!, ALPHABET[(n >> 12) & 63]!);
    if (rest === 2) out.push(ALPHABET[(n >> 6) & 63]!);
  }
  return out.join('');
}

/** Decoded bytes, or null when the text is not base64url. */
function fromBase64Url(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const v = c < 128 ? LOOKUP[c]! : -1;
    if (v < 0) return null;
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return out.subarray(0, o);
}

export function encodeStrategyCode(s: Strategy): string {
  return CODE_PREFIX + toBase64Url(deflateSync(strToU8(JSON.stringify(s)), { level: 9 }));
}

function fail(message: string): ValidationResult {
  return { ok: false, issues: [{ path: '', message, severity: 'error' }] };
}

/** Decode and validate a strategy code. Never throws; problems come back as issues. */
export function decodeStrategyCode(code: string): ValidationResult {
  // Codes pasted from chat often pick up line breaks or spaces.
  const text = typeof code === 'string' ? code.replace(/\s+/g, '') : '';
  if (!text.startsWith(CODE_PREFIX)) return fail(`Strategy codes start with "${CODE_PREFIX}".`);
  if (text.length > MAX_CODE_LENGTH) return fail(`This code is ${text.length} characters; strategy codes are at most ${MAX_CODE_LENGTH}.`);
  const bytes = fromBase64Url(text.slice(CODE_PREFIX.length));
  if (!bytes || bytes.length === 0) return fail('This code has characters that do not belong in a strategy code.');
  let json: string;
  try {
    // A fixed output buffer one byte past the cap: fflate writes nothing beyond it, and a full
    // buffer means the code unpacks to more than any strategy needs.
    const out = inflateSync(bytes, { out: new Uint8Array(MAX_CODE_JSON_BYTES + 1) });
    if (out.length > MAX_CODE_JSON_BYTES) return fail(`This code unpacks to more than ${MAX_CODE_JSON_BYTES} bytes; no strategy is that big.`);
    json = strFromU8(out);
  } catch {
    return fail('This code is damaged or cut short; copy it again in full.');
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return fail('This code unpacks, but not to a strategy (bad JSON inside).');
  }
  return validateStrategy(value);
}
