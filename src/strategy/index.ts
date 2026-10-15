/**
 * Strategy tooling: the gate (`loadStrategy`), validation and static analysis, strategy codes,
 * the JSON Schema, the rulebook and LLM prompt, the starter library and the house stacks.
 */
export { analyzeStrategy, expressionRange } from './analyze';
export type { Analysis, AnalysisIssue } from './analyze';
export { CODE_PREFIX, MAX_CODE_JSON_BYTES, MAX_CODE_LENGTH, decodeStrategyCode, encodeStrategyCode } from './code';
export { HOUSE_NOTES, HOUSE_STACKS } from './house';
export { STARTER_DOCS, STARTER_LIBRARY, STARTER_NAMES, mergeBehaviours } from './library';
export { InvalidStrategyError, MAX_STRATEGY_TEXT, gatedBrainFactory, headlessBrainFactory, loadStrategy, requireValidStrategy } from './load';
export { buildLlmPrompt } from './prompt';
export type { PromptMode } from './prompt';
export { generateRulebook } from './rulebook';
export { SCHEMA_PATH, generateJsonSchema } from './schema';
export { BARK_KINDS, LIMITS, priceBuild, validateStrategy } from './validate';
export type { BuildPrice } from './validate';
