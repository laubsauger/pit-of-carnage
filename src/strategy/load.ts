/**
 * The one gate. Every strategy (files, pastes, strategy codes, saved versions, house stacks,
 * evolution children, match configs, later network peers) goes through `loadStrategy` and gets the
 * same report; only a clean report yields a `ValidStrategy`, the only thing `createBrain` accepts.
 *
 * Text input is read with positions, so every issue (JSON syntax, duplicate keys, schema,
 * expressions, static analysis) carries a line and column. A ```json fence (how LLMs answer) is
 * read in place, with positions still counted in the whole pasted text.
 */

import type { BrainFactory, LoadReport, LoadStrategy, Strategy, StrategySource, ValidStrategy, ValidationIssue, ValidationResult } from '../core';
import { createBrain } from '../brain';
import { CODE_PREFIX, decodeStrategyCode } from './code';
import { lineColumn, readJson } from './json';
import { validateStrategy } from './validate';

/** Longest strategy text read (characters). A real strategy is a few kB. */
export const MAX_STRATEGY_TEXT = 64 * 1024;

function toReport(r: ValidationResult): LoadReport {
  const errors = r.issues.filter((i) => i.severity === 'error');
  const warnings = r.issues.filter((i) => i.severity === 'warning');
  // The only place a Strategy becomes a ValidStrategy: after a report with no errors.
  return r.ok && r.strategy && errors.length === 0 ? { strategy: r.strategy as ValidStrategy, errors, warnings } : { errors, warnings };
}

function fail(issue: ValidationIssue): LoadReport {
  return { errors: [issue], warnings: [] };
}

/**
 * The JSON part of a pasted LLM answer: the first ```json (or bare ```) block whose content starts
 * with "{", with everything outside it blanked so offsets (and so lines and columns) still match
 * the full text. Null when there is no such block.
 */
function fencedJson(text: string): string | null {
  const open = /```(?:json|JSON)?[ \t]*\r?\n/g;
  for (let m = open.exec(text); m; m = open.exec(text)) {
    const start = m.index + m[0].length;
    const end = text.indexOf('```', start);
    if (end < 0) return null;
    if (!text.slice(start, end).trim().startsWith('{')) continue;
    let out = '';
    for (let i = 0; i < text.length; i++) out += (i >= start && i < end) || text[i] === '\n' ? text[i] : ' ';
    return out;
  }
  return null;
}

function loadText(input: string, source: StrategySource): LoadReport {
  if (input.length > MAX_STRATEGY_TEXT) {
    return fail({ path: '', message: `This text is ${input.length} characters; a strategy is at most ${MAX_STRATEGY_TEXT}.`, severity: 'error' });
  }
  // A byte-order mark is invisible in editors; blank it so columns still match.
  const text = input.charCodeAt(0) === 0xfeff ? ` ${input.slice(1)}` : input;
  const trimmed = text.trim();
  if (source === 'code' || trimmed.startsWith(CODE_PREFIX)) return toReport(decodeStrategyCode(trimmed));
  const json = !trimmed.startsWith('{') && trimmed.includes('```') ? fencedJson(text) ?? text : text;
  const read = readJson(json);
  if (!read.ok) {
    const { line, column } = lineColumn(json, read.offset);
    return fail({ path: '', message: `Invalid JSON at line ${line}, column ${column}: ${read.message}`, severity: 'error', line, column });
  }
  const src = { text: json, spots: read.spots };
  const report = toReport(validateStrategy(read.value, src));
  if (read.duplicates.length === 0) return report;
  // JSON.parse would silently keep only the last of two same-named keys: never accept that.
  const dupes: ValidationIssue[] = read.duplicates.map((d) => ({
    path: d.path,
    message: `Duplicate key "${d.key}": only the last one would count, so the first is lost. Rename or remove one.`,
    severity: 'error',
    ...lineColumn(json, d.keyStart),
  }));
  return { errors: [...dupes, ...report.errors], warnings: report.warnings };
}

/**
 * The gate. `input` is JSON text, a strategy code (`PIT2.…`) or an already parsed value. Never
 * throws: anything wrong, including a bug in here, comes back as an error.
 */
export const loadStrategy: LoadStrategy = (input, source) => {
  try {
    return typeof input === 'string' ? loadText(input, source) : toReport(validateStrategy(input));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return fail({ path: '', message: `Internal error while checking this strategy (${detail}); please report it.`, severity: 'error' });
  }
};

/** Thrown by `requireValidStrategy`; `report` has every problem found. */
export class InvalidStrategyError extends Error {
  constructor(readonly strategyName: string, readonly report: LoadReport) {
    const first = report.errors[0];
    super(`${strategyName} failed validation: ${first ? `${first.path || '(top level)'}: ${first.message}` : 'invalid strategy'}`);
    this.name = 'InvalidStrategyError';
  }
}

/**
 * Run a strategy through the gate and return the ValidStrategy, or throw an InvalidStrategyError
 * naming the strategy and its first error. For code paths that must not continue with a broken
 * strategy.
 */
export function requireValidStrategy(strategy: Strategy, source: StrategySource = 'config'): ValidStrategy {
  const r = loadStrategy(strategy, source);
  if (r.strategy) return r.strategy;
  const name = typeof strategy?.name === 'string' && strategy.name ? strategy.name : 'A strategy';
  throw new InvalidStrategyError(name, r);
}

/**
 * The BrainFactory to hand the sim: gates every entrant's strategy before compiling it, so no
 * unvalidated strategy can reach a brain even if a config skipped validation upstream.
 */
export const gatedBrainFactory: BrainFactory = (strategy) => createBrain(requireValidStrategy(strategy));

/**
 * The same gate for headless runs (gym batches, evolution): brains skip the inspector's data
 * (sensor tables, per-term ratings), which nobody reads there. Choices are identical.
 */
export const headlessBrainFactory: BrainFactory = (strategy) => createBrain(requireValidStrategy(strategy), { inspect: false });
