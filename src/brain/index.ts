/**
 * Strategy runtime. `createBrain` is what the sim calls; the rest is the vocabulary and compiler
 * the strategy module (validator, schema, rulebook) and the editor build on.
 */
export { createBrain } from './brain';
export type { BrainOptions } from './brain';
export {
  StrategyCompileError,
  compileExpression,
  compilePlace,
  compileStrategy,
  compileZone,
  expressionVocabulary,
  placeVocabulary,
  termKind,
  worstThinkCost,
  zoneVocabulary,
} from './compile';
export type { CompileIssue, CompiledBehaviour, CompiledStrategy, ExprScope } from './compile';
export { ExprError, FUNCTIONS, KEYWORDS, MAX_EXPR_DEPTH, MAX_EXPR_LENGTH, exprNodes, exprText, parseExpr } from './expr';
export type { BinOp, Expr } from './expr';
export {
  ATTACK_POLICIES,
  ATTACK_POLICY_NAMES,
  ENEMIES_WORD,
  FIGHTER_REFS,
  FIGHTER_SENSORS,
  MOVE_TERMS,
  PICKUP_ARG_WORDS,
  PLACES,
  SENSORS,
  SENSOR_INDEX,
  ZONES,
  parseRange,
  sensorRange,
} from './registry';
export type { ArgSpec, BuildFacts, FighterSensorDef, PlaceDef, SensorDef, SensorScope, TermKind, ValueRange, ZoneDef } from './registry';
export { didYouMean } from './suggest';
export { AMMO_KINDS, GUARDS, GUARDS_DOCS, STEERING, STEERING_DOCS, UNLIMITED_AMMO, weaponReach } from './tuning';
