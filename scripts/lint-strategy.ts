/**
 * Validate strategy files from the command line, through the same gate the game uses:
 *
 *   npm run lint:strategy -- my-strategy.json other.json
 *
 * Prints every error and warning as `file:line:column  severity  path  message`, one per line
 * (handy in an LLM loop), then one summary line per clean file. Exit code 1 when any file has an
 * error, 2 on bad usage. A file may hold JSON, a strategy code (PIT2.…) or an LLM answer with the
 * JSON in a ```json block.
 *
 *   npx tsx scripts/lint-strategy.ts --write-schema
 *
 * regenerates the published JSON Schema (public/pit-strategy-2.schema.json) from the registry.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ValidationIssue } from '../src/core';
import { SCHEMA_PATH, generateJsonSchema, loadStrategy } from '../src/strategy';

function format(file: string, i: ValidationIssue): string {
  const where = i.line !== undefined ? `${file}:${i.line}:${i.column ?? 1}` : file;
  const hint = i.suggestion ? ` (did you mean "${i.suggestion}"?)` : '';
  return `${where}  ${i.severity}  ${i.path || '(top level)'}  ${i.message}${hint}`;
}

const args = process.argv.slice(2);

if (args.includes('--write-schema')) {
  const out = fileURLToPath(new URL(`../public/${SCHEMA_PATH}`, import.meta.url));
  writeFileSync(out, `${JSON.stringify(generateJsonSchema(), null, 2)}\n`);
  console.log(`wrote ${out}`);
  process.exit(0);
}

if (args.length === 0) {
  console.error('Usage: npm run lint:strategy -- <strategy.json> [more.json ...]');
  console.error('       npx tsx scripts/lint-strategy.ts --write-schema');
  process.exit(2);
}

let failed = false;
for (const file of args) {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`${file}  error  cannot read file: ${e instanceof Error ? e.message : String(e)}`);
    failed = true;
    continue;
  }
  const report = loadStrategy(text, 'cli');
  const issues = [...report.errors, ...report.warnings].sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0));
  for (const issue of issues) console.log(format(file, issue));
  if (report.errors.length > 0) failed = true;
  else console.log(`${file}  ok  ${report.warnings.length} warning${report.warnings.length === 1 ? '' : 's'}`);
}
process.exitCode = failed ? 1 : 0;
