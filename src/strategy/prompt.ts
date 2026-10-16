/**
 * "Copy for LLM": one block of text a player pastes into any chat model. Rulebook first, then the
 * task, the current strategy and the last battle report, then exact answer instructions, so the
 * reply can be pasted straight back into the editor.
 *
 * The prompt makes the model interview the player before it writes anything: without that, models
 * tend to hand back the starter strategy that happened to be in the editor, lightly edited.
 */

import { STRATEGY_SCHEMA } from '../core';
import type { Strategy } from '../core';
import { formatJson, generateRulebook } from './rulebook';

/**
 * `new` designs a fighter from scratch ("New fighter with an LLM"): the open strategy and its report
 * stay out, so the model cannot hand back a lightly edited copy. `improve` works on the given
 * strategy ("Improve this with an LLM"). Without a mode, a prompt with a strategy first asks the
 * player which of the two they want.
 */
export type PromptMode = 'new' | 'improve';

const INTERVIEW = [
  'Before you write any JSON, interview the player. Ask these in one short message, each with two or three concrete suggestions they can pick, plus "or describe your own", and wait for the answers:',
  '1. Name and personality: what is the fighter called, and how does it talk (its barks)?',
  '2. Plan: how should it win? For example ambush from the dark, kite and shoot, third-party other fights, control the power-ups, camp the shrine, bait enemies into hazards, berserk charge.',
  '3. Weapon and skill, or "pick for me".',
  '4. Who should it beat, and how much risk should it take?',
  '5. Optional: colour and glyph.',
  'If the player says "surprise me", choose boldly and say what you chose. Design for their answers, not for the example strategies: those exist only to show the syntax and must never be copied.',
].join('\n');

export function buildLlmPrompt(opts: { strategy?: Strategy; reportText?: string; goal?: string; mode?: PromptMode }): string {
  const goal = opts.goal?.trim();
  const mode: PromptMode = opts.mode ?? (opts.strategy ? 'improve' : 'new');
  // A new fighter starts from the player's answers, never from whatever happens to be open.
  const strategy = mode === 'new' && !goal ? undefined : opts.strategy;
  const reportText = mode === 'new' && !goal ? undefined : opts.reportText;

  let task: string;
  if (goal) {
    task = goal;
  } else if (mode === 'new' || !strategy) {
    task = ['Design a brand-new fighter strategy with the player.', INTERVIEW].join('\n\n');
  } else if (opts.mode === 'improve') {
    task = [
      'Improve the strategy below with the player. It is their fighter; they asked for changes, not a new one.',
      `First ask, in one short message, what they want changed, with two or three concrete suggestions${reportText?.trim() ? ' drawn from the battle report below (what killed it, what it never did, where it wasted time)' : ''}, plus "or describe your own". Wait for the answer before writing JSON.`,
      'Then keep its name, identity and barks, change as little as needed, and say in one line what you changed and why.',
    ].join('\n');
  } else {
    task = [
      'The strategy below is the one open in the player\'s editor. It may be their own build, or just a starter sample they have not touched yet.',
      'First ask the player, in one short message, which they want:',
      '- a brand-new fighter (then run the interview below), or',
      '- changes to this one: sharpen its current plan, fix what the battle report shows is failing, or move it toward a different style.',
      'Wait for the answer before writing JSON. When improving, keep its name and identity, change as little as needed, and say what the report told you.',
      INTERVIEW,
    ].join('\n');
  }

  const parts = [
    'You are helping a player design a fighter strategy for Pit of Carnage, an autoplaying gladiator arena. The full rules follow; they are exact, so rely on them over assumptions from other games.',
    '<rulebook>',
    generateRulebook().trim(),
    '</rulebook>',
    '## Your task',
    task,
  ];
  if (strategy) {
    parts.push('## Strategy open in the editor', ['```json', formatJson(strategy), '```'].join('\n'));
  }
  if (reportText?.trim()) {
    parts.push('## Last battle report', reportText.trim());
  }
  const naming = strategy && mode === 'improve'
    ? `When improving, keep "name": ${JSON.stringify(strategy.name)}; for a new fighter use the name the player chose (at most 40 characters).`
    : 'Use the name the player chose (at most 40 characters).';
  parts.push(
    '## How to answer once you have what you need',
    [
      '- First, at most three short lines: the plan, and why it should work against the field.',
      `- Then one complete JSON object with "schema": "${STRATEGY_SCHEMA}", inside a single \`\`\`json block. No comments inside the JSON.`,
      `- ${naming} Leave out "version": the game numbers saved versions itself.`,
      '- Use only the sensors, places, zones, move terms and policies listed in the rulebook, and stay within every limit (attribute budget, behaviour and move-term counts).',
      '- The game checks the strategy strictly before it can fight (see "Validation and safety"): never divide by something that can be 0, keep scores within the score limit, and stay under the evaluation budget.',
      '- After the JSON, suggest two things to try in the gym to test whether the plan works.',
      '- The player pastes your whole reply back into the game as it is; the game reads the ```json block, so keep exactly one.',
    ].join('\n'),
  );
  return parts.join('\n\n') + '\n';
}
