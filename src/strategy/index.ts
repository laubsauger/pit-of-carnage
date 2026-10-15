// Owned by: ai
// Placeholder stub from the architect: minimal checks and a JSON+zlib code. Replace wholesale.
import { strFromU8, strToU8, unzlibSync, zlibSync } from 'fflate';
import { STRATEGY_SCHEMA, WEAPONS, WEAPON_IDS, attributesLegal } from '../core';
import type { Behaviour, Strategy, ValidationResult } from '../core';

const CODE_PREFIX = 'POC2:';

export function validateStrategy(input: unknown): ValidationResult {
  const s = input as Strategy;
  if (typeof input !== 'object' || input === null || s.schema !== STRATEGY_SCHEMA) {
    return { ok: false, issues: [{ path: 'schema', message: `Expected schema "${STRATEGY_SCHEMA}".`, severity: 'error' }] };
  }
  if (!s.build || !attributesLegal(s.build.attributes)) {
    return { ok: false, issues: [{ path: 'build.attributes', message: 'Attributes out of range or over budget.', severity: 'error' }] };
  }
  return { ok: true, issues: [], strategy: s };
}

export function encodeStrategyCode(s: Strategy): string {
  const bytes = zlibSync(strToU8(JSON.stringify(s)));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return CODE_PREFIX + btoa(bin);
}

export function decodeStrategyCode(code: string): ValidationResult {
  try {
    const bin = atob(code.trim().slice(CODE_PREFIX.length));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return validateStrategy(JSON.parse(strFromU8(unzlibSync(bytes))));
  } catch {
    return { ok: false, issues: [{ path: '', message: 'Not a valid strategy code.', severity: 'error' }] };
  }
}

export function generateRulebook(): string {
  return WEAPON_IDS.map((id) => `${WEAPONS[id].name}: ${WEAPONS[id].doc}`).join('\n');
}

export function generateJsonSchema(): Record<string, unknown> {
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', title: STRATEGY_SCHEMA, type: 'object' };
}

export function buildLlmPrompt(opts: { strategy?: Strategy; reportText?: string; goal?: string }): string {
  return [generateRulebook(), opts.goal ?? '', opts.strategy ? JSON.stringify(opts.strategy, null, 2) : '', opts.reportText ?? ''].join('\n\n');
}

export const STARTER_LIBRARY: Record<string, Behaviour> = {
  brawl: { score: '1', move: [{ seek: 'target', weight: 1 }], attack: 'in_range' },
};

export const HOUSE_STACKS: Strategy[] = [
  {
    schema: 'pit-strategy/2',
    name: 'Apologetic Gary',
    version: 1,
    build: { weapon: 'GREATSWORD', skill: 'WHIRLWIND', attributes: { vitality: 20, power: 20, agility: 16, perception: 14, armor: 16, haste: 14 } },
    target: '1000 - it.distance',
    behaviours: { brawl: { score: '1', move: [{ seek: 'target', weight: 1 }], attack: 'in_range', skill: 'enemies_near >= 2' } },
    commit: 30,
    barks: { spawn: 'Excuse me.', kill: ['Sorry!', 'So sorry.'] },
  },
];
