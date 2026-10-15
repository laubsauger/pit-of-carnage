/**
 * "Copy for LLM": one block of text a player pastes into any chat model. Rulebook first, then the
 * task, the current strategy and the last battle report, then exact answer instructions, so the
 * reply can be pasted straight back into the editor.
 */

import { STRATEGY_SCHEMA } from '../core';
import type { Strategy } from '../core';
import { formatJson, generateRulebook } from './rulebook';

export function buildLlmPrompt(opts: { strategy?: Strategy; reportText?: string; goal?: string }): string {
  const { strategy, reportText, goal } = opts;
  const task = goal?.trim()
    ? goal.trim()
    : strategy
      ? 'Improve this strategy so it places higher. Keep what works, fix what the battle report shows is failing, and change as little as needed.'
      : 'Write a new strategy with a clear plan for its weapon. Give it a funny name and a few dry barks.';

  const parts = [
    'You are writing a fighter strategy for Pit of Carnage. The full rules follow; they are exact, so rely on them over assumptions from other games.',
    '<rulebook>',
    generateRulebook().trim(),
    '</rulebook>',
    '## Your task',
    task,
  ];
  if (strategy) {
    parts.push('## Current strategy', ['```json', formatJson(strategy), '```'].join('\n'));
  }
  if (reportText?.trim()) {
    parts.push('## Last battle report', reportText.trim());
  }
  const keepName = strategy
    ? `Keep "name": ${JSON.stringify(strategy.name)} and set "version" to ${(strategy.version ?? 1) + 1}.`
    : 'Pick a name of at most 40 characters and set "version" to 1.';
  parts.push(
    '## How to answer',
    [
      `- Reply with one complete JSON object with "schema": "${STRATEGY_SCHEMA}", inside a single \`\`\`json block. No comments inside the JSON.`,
      `- ${keepName}`,
      '- Use only the sensors, places, zones, move terms and policies listed in the rulebook, and stay within every limit (attribute budget, behaviour and move-term counts).',
      '- The game checks the strategy strictly before it can fight (see "Validation and safety"): never divide by something that can be 0, keep scores within the score limit, and stay under the evaluation budget.',
      '- After the JSON, at most three short lines on what you changed and why.',
    ].join('\n'),
  );
  return parts.join('\n\n') + '\n';
}
