/**
 * The rulebook: everything a player or an outside LLM needs to write a strategy, generated from
 * the brain registry and the core rule tables so it always describes the game that actually runs.
 * Markdown, one document, no prose that a table could hold instead.
 */

import {
  ATTRIBUTE_BUDGET,
  ATTRIBUTE_DOCS,
  ATTRIBUTE_KEYS,
  ATTRIBUTE_MAX,
  ATTRIBUTE_MIN,
  BARK_RULES,
  COMBAT,
  COMBAT_DOCS,
  COMMIT_BONUS,
  HAZARD_RULES,
  JUDGES_DOC,
  MATCH_RULES,
  MATCH_RULES_DOCS,
  MAX_BEHAVIOURS,
  MAX_MEMORY_SLOTS,
  MAX_MOVE_TERMS,
  PERCEPTION,
  PERCEPTION_DOCS,
  PICKUP_RULES,
  PROP_RULES,
  SKILLS,
  SKILL_IDS,
  SPEED_SCALE,
  STANCES,
  STAT_DOCS,
  STEER_DIRS,
  STRATEGY_SCHEMA,
  THINK_EVERY_TICKS,
  TICK_HZ,
  WEAPONS,
  WEAPON_IDS,
  deriveStats,
} from '../core';
import type { Behaviour, DerivedStats, Strategy } from '../core';
import {
  ATTACK_POLICIES,
  ENEMIES_WORD,
  FIGHTER_REFS,
  FIGHTER_SENSORS,
  FUNCTIONS,
  GUARDS,
  GUARDS_DOCS,
  MAX_EXPR_DEPTH,
  MAX_EXPR_LENGTH,
  MOVE_TERMS,
  PLACES,
  SENSORS,
  STEERING,
  STEERING_DOCS,
  ZONES,
  sensorRange,
} from '../brain';
import { MAX_CODE_LENGTH } from './code';
import { HOUSE_NOTES, HOUSE_STACKS } from './house';
import { STARTER_DOCS, STARTER_LIBRARY } from './library';
import { MAX_STRATEGY_TEXT } from './load';
import { BARK_KINDS, LIMITS } from './validate';

function cell(v: unknown): string {
  return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function table(headers: string[], rows: unknown[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

function num(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
}

function code(v: string): string {
  return `\`${v}\``;
}

/** JSON indented by structure, but with anything that fits on one line kept on one line. */
export function formatJson(v: unknown, indent = ''): string {
  const flat = JSON.stringify(v);
  if (v === null || typeof v !== 'object' || flat.length + indent.length <= 100) return flat;
  const next = `${indent}  `;
  if (Array.isArray(v)) return `[\n${v.map((x) => next + formatJson(x, next)).join(',\n')}\n${indent}]`;
  const body = Object.entries(v as Record<string, unknown>).map(([k, x]) => `${next}${JSON.stringify(k)}: ${formatJson(x, next)}`);
  return `{\n${body.join(',\n')}\n${indent}}`;
}

function json(v: unknown): string {
  return ['```json', formatJson(v), '```'].join('\n');
}

function signature(name: string, args: readonly { name: string }[]): string {
  return args.length ? `${name}(${args.map((a) => a.name).join(', ')})` : name;
}

function section(title: string, ...parts: string[]): string {
  return [`## ${title}`, ...parts].join('\n\n');
}

/** The sensors a build narrows, worked out from the registry (a melee build vs a longbow). */
const BUILD_RANGES = SENSORS.map((s, i) => ({ s, i }))
  .filter(({ i }) => {
    const even = { vitality: 17, power: 17, agility: 17, perception: 17, armor: 16, haste: 16 };
    const all = sensorRange(i, null);
    return (['GREATSWORD', 'LONGBOW'] as const).some((weapon) => {
      const r = sensorRange(i, { weapon, attributes: even });
      return r.lo !== all.lo || r.hi !== all.hi;
    });
  })
  .map(({ s }) => code(s.name))
  .join(', ') + ' (a melee build always reads `self.ranged` 0 and `self.ammo` 99, for example)';

// ---------------------------------------------------------------------------------------------

function intro(): string {
  return [
    `# Pit of Carnage: strategy rulebook (${STRATEGY_SCHEMA})`,
    'Pit of Carnage is a free-for-all gladiator arena that plays itself. Nobody steers a fighter during a match. ' +
      'A strategy is a JSON document: a build (weapon, skill, attribute points) plus behaviours written in a small, exact language. ' +
      'Last fighter standing wins; everyone else is placed in reverse order of death. ' +
      `After ${num(MATCH_RULES.timeLimitTicks / TICK_HZ)} s (or ${num(MATCH_RULES.stalemateTicks / TICK_HZ)} s without anyone hurting anyone) sudden death starts and the walls close in; hiding cannot win a match.`,
    `Units: distances in px, time in ticks (${TICK_HZ} ticks = 1 s), angles in radians unless a name says degrees. ` +
      'The map origin is the top-left corner, +x points right (east), +y points down (south); angles grow clockwise on screen (0 = east, 90° = south).',
  ].join('\n\n');
}

function thinking(): string {
  return section(
    'How a fighter thinks',
    `A fighter thinks every ${THINK_EVERY_TICKS} ticks (${TICK_HZ / THINK_EVERY_TICKS} times per second). Each think runs these steps in order:`,
    [
      `1. **Perceive.** Enemies are *seen*, *heard* or *remembered* (see "What a fighter knows"). Squadmates are always known exactly.`,
      '2. **Choose a target.** The `target` expression is evaluated once per known enemy with `it.*` describing that enemy. The highest value wins; on a tie the first one listed wins. With no known enemies there is no target and every `target.*` sensor reads its "none" value (distances 9999, everything else 0).',
      `3. **Choose a behaviour.** Every behaviour's \`score\` is evaluated. The behaviour already running gets +${COMMIT_BONUS} until \`commit\` ticks have passed since it started. The highest score runs; on a tie your own behaviours (in the order written) come before imported ones (in import order).`,
      `4. **Steer.** The running behaviour's move terms each rate ${STEER_DIRS} directions; the weighted sum, minus wall and hazard danger, picks a heading and a throttle (see "Steering").`,
      '5. **Act.** The attack policy decides whether to attack; the skill policy whether to use the skill (only when it is ready). Parry is automatic.',
      '6. **Remember.** The running behaviour\'s `set` expressions write memory slots. All of them see the memory as it was at the start of this think.',
    ].join('\n'),
    'Between thinks the fighter keeps the last decision: it walks along the heading at the chosen throttle (turning at its turn rate) and aims attacks and skills at the decision\'s target.',
    `**Parry** is automatic. When an enemy within reach starts a windup aimed at you while you face it (within ${COMBAT.parryFacingArc} rad) and your parry is off cooldown, the game rolls your parry chance (${COMBAT.parryBaseChance} x perception / 40) once for that windup. A parry lasts ${COMBAT.parryTicks} ticks, reflects ${COMBAT.parryReflect * 100}% of the blow, stuns the attacker for ${COMBAT.parryStunTicks} ticks, then cools down for ${COMBAT.parryCooldown} ticks. ` +
      `*Parry reflex:* when your parry is ready and a melee enemy is winding up with you inside its swing and within its reach + ${STEERING.parryMargin} px, that enemy becomes the decision's target for this think (unless you are attacking someone), so you turn to face it. Your strategy's own target is kept for the next think.`,
  );
}

function knowledge(): string {
  return section(
    'What a fighter knows',
    'Fighters are not omniscient. What you know about an enemy is your own memory of it, never a window onto the real fighter:',
    [
      `- **Seen**: inside your vision cone and range with nothing in between; a target in shadow only within ${PERCEPTION.shadowVisionMul * 100}% of your range. Everything about it is exact and current: position, movement, facing, HP, ammo, windup.`,
      `- **Heard** (not seen): within your hearing radius (${PERCEPTION.hearingBase} + perception x ${PERCEPTION.hearingPerPerception} px, x${PERCEPTION.hearingFastMul} against a noisy target, x${PERCEPTION.hearingQuietMul} against a slow or creeping one, x${PERCEPTION.hearingWallMul} through a wall or pillar). You get a rough position only: off by at most ${PERCEPTION.hearingErrorBase} px + ${PERCEPTION.hearingErrorPerPx} x distance and always by at least half that, a new guess every ${PERCEPTION.hearingRefreshTicks} ticks. Hearing tells you nothing else: HP, facing and the rest stay as you last saw them.`,
      `- **Remembered**: neither seen nor heard. Nothing changes: its position stays where you last saw or heard it and does not follow the real fighter. It is forgotten after ${PERCEPTION.memoryTicks} ticks without news.`,
    ].join('\n'),
    'So `target.distance` is the distance to where you *think* it is. `target.visible`, `target.heard` and `target.last_seen_age` say how good that guess is; `last_seen(target)` is where you last saw it and `search_point` sweeps round that spot. A shot needs a target in sight this tick (an aimed shot at a guess is refused); a melee swing may go at a target you only hear when its estimated spot is in reach. The head looks at the last seen spot for a moment, then scans.',
  );
}

function documentFormat(): string {
  const fields: unknown[][] = [
    ['$schema', 'no', 'A link to the published JSON Schema (`/pit-strategy-2.schema.json`) so editors check the file as you type. The game ignores it.'],
    ['schema', 'yes', `Always ${code(STRATEGY_SCHEMA)}.`],
    ['name', 'yes', `1-${LIMITS.nameLength} characters. Also the fighter's name in the arena.`],
    ['author', 'no', `1-${LIMITS.nameLength} characters.`],
    ['version', 'no', 'Whole number from 1 (default 1). Reports name strategies as name@vN; bump it when you change something.'],
    ['build', 'yes', `{ "weapon", "skill", "attributes" }. Attributes: all six, whole numbers ${ATTRIBUTE_MIN}-${ATTRIBUTE_MAX}, total at most ${ATTRIBUTE_BUDGET}.`],
    ['target', 'yes', 'Expression rating each known enemy with it.* sensors.'],
    ['behaviours', 'yes', `Object of name -> behaviour. Names: lowercase letters, digits, _ (start with a letter, at most ${LIMITS.identLength}). At most ${MAX_BEHAVIOURS} including imports.`],
    ['imports', 'no', 'List of starter-library behaviour names to include. Your own behaviour with the same name replaces the import.'],
    ['memory', 'no', `Object of slot name -> starting number. At most ${MAX_MEMORY_SLOTS}. Read by name in any expression; write with "set".`],
    ['commit', 'yes', `Ticks (0-${LIMITS.commitMax}) a newly chosen behaviour keeps the +${COMMIT_BONUS} bonus. Default ${LIMITS.commitDefault}.`],
    ['barks', 'no', `Object of kind -> line or list of lines (${BARK_KINDS.join(', ')}). At most ${LIMITS.barkLinesPerKind} lines per kind, ${BARK_RULES.maxLength} characters per line.`],
    ['look', 'no', `{ "color": "#RRGGBB", "glyph": 1-${LIMITS.glyphLength} characters }. The match may assign another colour to keep fighters distinct.`],
  ];
  const behaviourFields: unknown[][] = [
    ['score', 'yes', 'Expression: how much this behaviour wants to run (scores of about 0..1 work well with the commit bonus).'],
    ['move', 'yes', `List of 0-${MAX_MOVE_TERMS} move terms. An empty list stands still.`],
    ['attack', 'yes', `${ATTACK_POLICIES.map((p) => code(p.name)).join(', ')}, or an expression (above 0 = attack the target). Missing means in_range.`],
    ['skill', 'no', 'Expression: use the skill when above 0 and the skill is ready. Missing means never.'],
    ['set', 'no', 'Object of memory slot -> expression, written every think while this behaviour runs. Slots must be declared in "memory".'],
    ['stance', 'no', `normal (default), creep or guard. ${(['normal', 'creep', 'guard'] as const).map((s) => `${s}: ${STANCES[s].doc} (speed x${STANCES[s].moveMul})`).join(' ')}`],
  ];
  return section(
    'The strategy document',
    table(['Field', 'Required', 'Meaning'], fields),
    '### Behaviour fields',
    table(['Field', 'Required', 'Meaning'], behaviourFields),
  );
}

function expressions(): string {
  return section(
    'Expressions',
    'Expressions are numbers built from numbers, sensors, memory slots, operators, functions and parentheses. ' +
      'Comparisons and `and` / `or` / `not` give 1 (true) or 0 (false). Anything above 0 counts as true; 0 and negatives count as false. ' +
      '`true` is 1, `false` is 0. The language has no loops, recursion or calls into the game, so every expression finishes; how long a think takes is bounded by the evaluation budget (see "Validation and safety").',
    'Precedence, loosest first:',
    table(['Level', 'Operators', 'Notes'], [
      [1, 'or', ''],
      [2, 'and', ''],
      [3, 'not', 'not a < b means not (a < b)'],
      [4, '< <= > >= == !=', 'do not chain: write a < b and b < c'],
      [5, '+ -', 'left to right'],
      [6, '* /', 'left to right'],
      [7, 'unary -', ''],
    ]),
    table(['Function', 'Meaning'], Object.values(FUNCTIONS).map((f) => [f.signature, f.doc])),
    'Not available: `&&`, `||`, `!`, `=`, `%`, `^`, `?:`. Write `and`, `or`, `not`, `==`; for "if c then a else b" write `c * a + (1 - c) * b`.',
    'Example: `(enemies_known > 0) * (0.3 + 0.5 * target.facing_away) - 0.4 * (self.hp < 0.3)`.',
    `Each expression, place and zone is at most ${MAX_EXPR_LENGTH} characters and ${MAX_EXPR_DEPTH} levels deep.`,
  );
}

function sensors(): string {
  const selfRows = SENSORS.filter((s) => s.scope === 'self').map((s) => [code(s.name), s.unit, s.range, s.doc]);
  const fighterRows = FIGHTER_SENSORS.map((d) => [code(`target.${d.key}`), code(`it.${d.key}`), d.unit, d.range, d.doc]);
  return section(
    'Sensors',
    'Everything an expression can read. Values are about you and the world as you perceive them this think. ' +
      `Every sensor reads inside its range (a rare value outside is cut to it), and the validator uses the ranges to check your expressions before the match. Your build narrows a few: ${BUILD_RANGES}.`,
    table(['Sensor', 'Unit', 'Range', 'Meaning'], selfRows),
    '### Fighter sensors',
    '`target.*` reads your target (not available in the target expression itself). `it.*` reads the enemy being rated and works only in the target expression. "It" below means that fighter.',
    table(['Target sensor', 'Target expression', 'Unit', 'Range', 'Meaning'], fighterRows),
    'Memory slots are read by their bare name (for example `struck_at`).',
  );
}

function places(): string {
  const refRows = FIGHTER_REFS.map((r) => [code(r.name), r.doc]);
  const placeRows = PLACES.map((p) => [code(signature(p.name, p.args)), p.doc]);
  return section(
    'Places',
    'A place is where a move term points: a fighter or a point. If a place does not exist right now (no target, no shrine, no ammo on the floor), terms using it rate nothing.',
    '### Fighters',
    'Usable as places (seek stops at touching distance and leads them) and as the X argument of places and zones.',
    table(['Name', 'Meaning'], refRows),
    '### Points',
    `Numbers in places must be plain numbers. Where an argument takes a fighter, ${code(ENEMIES_WORD)} is also accepted by ${code('cover_from')} and ${code('seen_by')}.`,
    table(['Place', 'Meaning'], placeRows),
  );
}

function zones(): string {
  return section(
    'Zones',
    'A zone is an area with a strength from 0 to 1 at each point. Zones are used by avoid and prefer.',
    table(['Zone', 'Meaning'], ZONES.map((z) => [code(signature(z.name, z.args)), z.doc])),
  );
}

function steering(): string {
  return section(
    'Move terms',
    table(['Term', 'Form', 'Definition'], MOVE_TERMS.map((t) => [t.key, code(t.form), t.doc])),
    `Weights are 0-${LIMITS.weightMax} (default 1). Ratings are in [-1, 1] before the weight.`,
    '### Steering',
    `For each of the ${STEER_DIRS} directions i (every ${360 / STEER_DIRS}°, 0 = east):`,
    [
      '- raw(i) = sum of weight x rating(i) over the behaviour\'s move terms',
      `- interest(i) = ${STEERING.smoothing} x previous interest(i) + ${num(1 - STEERING.smoothing)} x raw(i) (the first think uses raw(i))`,
      `- danger(i) = max(wall danger, hazard danger) walking that way, 0..1, measured ${STEERING.wallLookahead} px (walls, pillars, props) and ${STEERING.hazardLookahead} px (hazards, the sudden-death wall) past your body edge, along three rays: from the front of your body and from both sides of it, so your whole width clears corners`,
      '- penalty(i) = max(1, sum of weights) x (danger(i) - the smallest danger of any direction)',
      `- final(i) = interest(i) + ${STEERING.momentum} x cos(angle between i and your current movement) - penalty(i)`,
      '- heading = the best direction, refined between it and its neighbours',
      `- throttle(x) = clamp((x - ${STEERING.throttleDead}) / (${STEERING.throttleFull} - ${STEERING.throttleDead}), 0, 1) of your move speed (after stance, buffs and injuries); speed = throttle(best final)`,
      `- sliding: if throttle(best interest) is higher than that speed (danger took away speed you wanted), you instead walk the best-rated *open* direction (danger within ${STEERING.slideOpen} of the safest one) at throttle(best interest). This is how fighters go round pillars instead of stopping at them.`,
    ].join('\n'),
    'So: if no direction rates above the dead zone, you stand still. A behaviour with only a seek stops when it arrives.',
    '### Steering constants',
    table(['Name', 'Value', 'Meaning'], (Object.keys(STEERING) as (keyof typeof STEERING)[]).map((k) => [k, num(STEERING[k]), STEERING_DOCS[k]])),
  );
}

function policies(): string {
  return section(
    'Attack and skill policies',
    table(['Attack policy', 'Meaning'], [
      ...ATTACK_POLICIES.map((p) => [code(p.name), p.doc]),
      ['any expression', 'Attack the target when the expression is above 0. It does not check reach: combine with `target.in_reach` unless you want to swing at air.'],
    ]),
    `The skill policy is an expression; the skill fires when it is above 0, the skill is off cooldown and you are not stunned. ${SKILLS.SHADOWSTEP.name} also needs a target within ${SKILLS.SHADOWSTEP.maxRange} px. ${SKILLS.DASH.name} bursts along your current steering heading, so it works for chasing and for running away.`,
    `Reach: melee range + ${STEERING.bodyAllowance} px (the game measures melee to the victim's edge; the brain counts a typical body). Ranged: weapon range, and the line to the target must be clear. Without the weapon arm, or out of ammo, you punch (reach ${COMBAT.punchRange} + ${STEERING.bodyAllowance} px, ${COMBAT.punchDamage} damage).`,
  );
}

function statLine(stats: DerivedStats): string {
  return (Object.keys(STAT_DOCS) as (keyof DerivedStats)[]).map((k) => `${STAT_DOCS[k].label} ${num(stats[k])}`).join(', ');
}

function builds(): string {
  const weaponRows = WEAPON_IDS.map((id) => {
    const w = WEAPONS[id];
    return [
      id, w.family, w.range, w.damage, w.cooldown, `${w.windup}/${w.strike}/${w.recovery}`, w.knockback,
      w.arc ? num(w.arc) : '-', w.cleave ? 'yes' : 'no', w.backstabMult,
      w.ammo ? `${w.ammo}${w.ammoPickup ? ' (pick up)' : ''}${w.ammoRegenTicks ? ` (1 per ${w.ammoRegenTicks} ticks)` : ''}` : '-',
      w.projectileSpeed ? num(w.projectileSpeed * SPEED_SCALE) : '-', w.visionBonus, num(w.fov), w.moveMul, w.turnMul, w.doc,
    ];
  });
  const skillRows = SKILL_IDS.map((id) => [id, SKILLS[id].name, SKILLS[id].doc]);
  const even = { vitality: 17, power: 17, agility: 17, perception: 17, armor: 16, haste: 16 };
  return section(
    'Builds',
    `Six attributes, each a whole number from ${ATTRIBUTE_MIN} to ${ATTRIBUTE_MAX}, at most ${ATTRIBUTE_BUDGET} in total. Unspent points are wasted.`,
    table(['Attribute', 'Effect'], ATTRIBUTE_KEYS.map((k) => [k, ATTRIBUTE_DOCS[k]])),
    '### Derived stats',
    table(['Stat', 'Unit', 'Formula'], (Object.keys(STAT_DOCS) as (keyof DerivedStats)[]).map((k) => [STAT_DOCS[k].label, STAT_DOCS[k].unit, STAT_DOCS[k].doc])),
    `Example: an even spread (${JSON.stringify(even)}) with a greatsword gives ${statLine(deriveStats(even, 'GREATSWORD'))}.`,
    '### Weapons',
    'Damage before power, berserk, backstab, crit and armor. Cooldown counts from the strike. Phases are windup/strike/recovery ticks; the blow lands on the first strike tick. Projectile speed is px/tick. Vision bonus is px; fov is radians before perception; move and turn are multipliers.',
    table(['Weapon', 'Family', 'Range', 'Damage', 'Cooldown', 'Phases', 'Knockback', 'Arc', 'Cleave', 'Backstab x', 'Ammo', 'Proj. speed', 'Vision +', 'FOV', 'Move x', 'Turn x', 'Notes'], weaponRows),
    `Projectiles stop at the first wall, pillar, prop or fighter in their path (any fighter, so crowds take stray shots). Shields: greatsword and warhammer users in guard stance block every projectile arriving within ${COMBAT.shieldArc} rad of their facing; a blocked staff orb bursts on the shield and its splash spares the bearer. Shots spread with the shooter's speed and the distance, lead the target imperfectly, and hit for x${COMBAT.pointBlankMul} under ${COMBAT.pointBlankRange} px. Melee strikes lunge forward and interrupt a ranged windup; walking backwards is slow (x${COMBAT.backpedalMoveMul}), and a ranged attacker plants (x${COMBAT.rangedPlantMoveMul}) while shooting.`,
    '### Skills',
    table(['Skill', 'Name', 'Effect'], skillRows),
    '### Combat rules',
    table(['Rule', 'Value', 'Meaning'], (Object.keys(COMBAT) as (keyof typeof COMBAT)[]).map((k) => [k, num(COMBAT[k]), COMBAT_DOCS[k]])),
    '### Perception rules',
    table(['Rule', 'Value', 'Meaning'], (Object.keys(PERCEPTION) as (keyof typeof PERCEPTION)[]).map((k) => [k, num(PERCEPTION[k]), PERCEPTION_DOCS[k]])),
  );
}

function arena(): string {
  return section(
    'The arena',
    table(['Hazard', 'Rule'], Object.values(HAZARD_RULES).map((h) => [h.name, h.doc])),
    table(['Prop', 'Rule'], Object.values(PROP_RULES).map((p) => [p.name, p.doc])),
    'Maps mix lit open ground, pillars that block sight, dark alcoves, shrines, power-up pedestals, kegs and traps. Use sensors and places (shadow, corner, dark_spot, cover_from, shrine, nearest_pickup) rather than coordinates: they work on every map.',
    '### Shrines and power-ups',
    table(['Pickup', 'Rule'], Object.values(PICKUP_RULES).map((p) => [p.name, p.doc])),
    'Power-ups sit on glowing pedestals, usually in contested spots: strong, short, and worth a detour. A ring on the pedestal fills while it comes back, and the announcer calls it when it is up. Walk over one to take it. ' +
      'Read them with `pickup.haste.ready`, `pickup.haste.distance`, `pickup.berserk.ready`, `pickup.berserk.distance`, and for the one worth going for (`nearest_pickup`) `pickup.any.ready`, `pickup.any.distance` and `pickup.respawn_in`. Go there with `pickup(haste)`, `pickup(berserk)` or `nearest_pickup`; the starter behaviours `grab_powerup` and `deny_powerup` show both plans. Battle reports count what you took and the kills it bought.',
    '### Sudden death',
    [
      `- It starts at the time limit (${num(MATCH_RULES.timeLimitTicks / TICK_HZ)} s by default), or earlier when nobody has hurt another fighter for ${num(MATCH_RULES.stalemateTicks / TICK_HZ)} s (traps and the wall do not count).`,
      `- The wall closes in from every side at ${MATCH_RULES.suddenDeathInsetPerTick} px per tick until the square left is ${MATCH_RULES.suddenDeathMinHalfSize * 2} px across, centred on the map. The wall is solid and spiked: nobody ends up outside it. It shoves anyone it touches back in, touching it costs ${MATCH_RULES.wallContactDamage} HP every tick, and a fighter it pins against a wall, pillar or prop is crushed for ${MATCH_RULES.wallCrushDamage} more every tick. The floor shows where the wall will be in ${num(MATCH_RULES.warningTicks / TICK_HZ)} s.`,
      `- Once the wall stops, the wall damage climbs by ${MATCH_RULES.escalationDamage} every ${num(MATCH_RULES.escalationStepTicks / TICK_HZ)} s, and ${num(MATCH_RULES.escalationEverywhereTicks / TICK_HZ)} s later it hits everyone every ${MATCH_RULES.suddenDeathIntervalTicks} ticks, inside the square too.`,
      `- If anyone is still standing ${num(MATCH_RULES.hardCapExtraTicks / TICK_HZ)} s after the time limit, the judges decide. ${JUDGES_DOC}`,
      '- React with `sudden_death`, `zone.distance`, `zone.time_to_reach`, the place `zone_centre` and the zone `outside_zone`; `corner` and `dark_spot` skip spots the wall reaches within 3 s. The starter behaviour `escape_zone` does the obvious thing.',
    ].join('\n'),
    table(['Match rule', 'Value', 'Meaning'], (Object.keys(MATCH_RULES) as (keyof typeof MATCH_RULES)[]).map((k) => [k, num(MATCH_RULES[k]), MATCH_RULES_DOCS[k]])),
  );
}

function safety(): string {
  return section(
    'Validation and safety',
    `Every strategy (a file, pasted text, a strategy code, a saved version, an evolved child, a house stack) goes through the same check before it can fight. The check reports every problem at once, each on one line with the JSON path (and line and column when you gave text), ending with the fix. Errors stop the strategy from loading; warnings do not. Text is at most ${MAX_STRATEGY_TEXT} characters and codes at most ${MAX_CODE_LENGTH}; a pasted answer with the JSON inside a \`\`\`json block is read as that JSON.`,
    '**Errors**: invalid JSON, a missing or wrong `schema`, unknown fields anywhere, duplicate keys (JSON would silently drop one), wrong types, numbers out of range or not finite, attributes over budget, unknown sensors, places, zones, move terms or policies, expression syntax, limits exceeded (behaviours, move terms, memory slots, expression length and depth, names and barks), `keep_range` min above max, and anything the static analysis below says a runtime guard would have to catch.',
    '**Warnings**: a behaviour that can never win, an import your own behaviour replaces, an import that never scores above 0 for your build, memory written but never read (or read but never written), all move weights 0, no behaviour that ever attacks, comparisons that are always true or always false, and expressions that come out the same whatever the sensors read.',
    '**Static analysis.** Before the match, the check works out the range of every expression from the sensor ranges (interval arithmetic: it may say "can" when the combination is in fact impossible, but "always" and "never" are certain). It rejects a division whose divisor can be 0 (write `x / max(1, y)`), a behaviour score that can leave the score limit (it shows the range it can reach), a value that can overflow, and a strategy whose worst think costs more than the budget. So a strategy that loads never needs a runtime guard.',
    `**Runtime guards** stay as a second line of defence: a division by zero gives 0, a result that is not a finite number becomes 0, scores are cut to ±${GUARDS.scoreLimit}, and a think stops spending at ${GUARDS.costBudget} units. Every trip is counted per expression path, shown in the inspector and listed in the battle report ("behaviours.lurk.score hit division by zero 212 times"). A trip in a strategy that loaded is a bug in the check: please report it.`,
    `**Cost.** One unit per expression node evaluated and per place or zone node looked up. A think costs the target expression once per enemy you could know (${GUARDS.costKnown}), every behaviour's score, and then the winning behaviour's moves, attack, skill and memory writes. An avoid/prefer term looks its zone up ${GUARDS.zoneSamples} times, and seen_by(enemies) also counts every enemy, so \`avoid seen_by(enemies)\` costs ${GUARDS.zoneSamples * (2 + GUARDS.costKnown)} units on its own. The house stacks cost about 300-1100.`,
    table(['Limit', 'Value', 'Meaning'], (Object.keys(GUARDS) as (keyof typeof GUARDS)[]).map((k) => [k, num(GUARDS[k]), GUARDS_DOCS[k]])),
  );
}

function barks(): string {
  return section(
    'Barks',
    'The game picks the moment: spawn at the start, kill and death when they happen, hit when you land one, low_hp once when you drop low, skill when you use it, taunt now and then while you see an enemy and are not fighting. ' +
      `Kinds: ${BARK_KINDS.map(code).join(', ')}. A fighter barks at most once per ${BARK_RULES.cooldownTicks} ticks, whatever the kind. Viewers see key moments (${BARK_RULES.keyKinds.join(', ')}) by default, at most ${BARK_RULES.maxVisible} bubbles at once and ${BARK_RULES.maxWords} words per bubble, so short lines land best. ` +
      `Chance per trigger: ${BARK_KINDS.map((k) => `${k} ${BARK_RULES.chance[k] * 100}%`).join(', ')}. ` +
      `low_hp fires once, below ${BARK_RULES.lowHp * 100}% HP. Lines are at most ${BARK_RULES.maxLength} characters. Dry beats loud.`,
  );
}

function library(): string {
  const parts = Object.entries(STARTER_LIBRARY).map(([name, b]: [string, Behaviour]) => [`### ${name}`, STARTER_DOCS[name] ?? '', json(b)].join('\n\n'));
  return section(
    'Starter library',
    'Behaviours you can import by name (`"imports": ["lurk", "heal"]`), and worked examples of the language. To change one, copy it into your own behaviours under the same name and edit it.',
    ...parts,
  );
}

function example(): string {
  const brenda = HOUSE_STACKS.find((s) => s.name === 'Brenda From Accounts') as Strategy;
  const others = HOUSE_STACKS.filter((s) => s !== brenda).map((s) => `- **${s.name}** (${s.build.weapon}, ${s.build.skill}): ${HOUSE_NOTES[s.name] ?? ''}`);
  return section(
    'A complete strategy',
    `${brenda.name}: ${HOUSE_NOTES[brenda.name] ?? ''}`,
    json(brenda),
    'How it plays: `lurk` (imported) creeps through shadow toward the target while unseen. When the target turns its back or gets busy fighting, `stab` outscores it: Shadowstep lands her behind a target that is facing her, `behind(target, 36)` walks her round to its back otherwise. When she is seen and hit (and the target is not nearly dead), `vanish` (0.9) takes over and runs for the dark. While it runs, `set` writes the current time into `vanished_at`, so for 2.5 s after she stops vanishing, `vanish` keeps +0.3 and `stab` loses 0.6: she waits in the dark before the next stab instead of turning straight back. `heal` and `prowl` cover being hurt and being alone, `search` hunts a target she has lost sight of, and `escape_zone` gets her out of the wall\'s way in sudden death.',
    '### The other house stacks',
    others.join('\n'),
  );
}

function tips(): string {
  return section(
    'Tips',
    [
      `- Keep scores around 0..1. The running behaviour gets +${COMMIT_BONUS} while committed, so a challenger needs a clear lead to interrupt it.`,
      '- Multiply by a condition to gate a score: `(self.hp < 0.4) * 0.8` is 0.8 when hurt and 0 otherwise.',
      '- Always have a behaviour for "nobody known" (`enemies_known == 0`), or the fighter stands still until someone finds it. `prowl` does this.',
      '- Add `+ 80 * it.is_target` (or similar) to the target expression so you finish one enemy instead of switching every think.',
      '- Longbow and throwing axes run out: import `restock` or write your own pickup behaviour. The staff recharges by itself.',
      '- Melee needs a way in. Charging straight at a ranged build costs HP; approach from the dark (`lurk`), from behind (`backstab`), wait for others to fight (`third_party`), or make them come to you (`guard_corner`, `bait`).',
      '- `avoid hazards` (weight about 0.8) in every behaviour that walks keeps you out of saws even when steering is busy.',
      '- `self.ranged` lets one behaviour serve both families; `random` breaks ties between equally good plans.',
      '- Sudden death closes the walls toward the centre and starts early if nobody fights: corners and dark edges become traps. Import `escape_zone`, or use `zone.time_to_reach` and `zone_centre` yourself.',
      '- You lose sight of people. Import `search` (or seek `search_point`) so a lost target is hunted, not stared at; `target.visible` tells you whether your numbers are live.',
      '- Power-ups are strong and short: `grab_powerup` takes them, `deny_powerup` waits on the pedestal of one about to come back.',
      '- Divide only by something that cannot be 0 (`max(1, x)`), and keep scores small: the check rejects anything a runtime guard would have to fix.',
      '- Read the battle report: behaviours that never won are dead weight, and "killed most by" tells you what to plan against.',
    ].join('\n'),
  );
}

/** The full rulebook as Markdown. */
export function generateRulebook(): string {
  return [
    intro(),
    thinking(),
    knowledge(),
    documentFormat(),
    expressions(),
    sensors(),
    places(),
    zones(),
    steering(),
    policies(),
    builds(),
    arena(),
    safety(),
    barks(),
    library(),
    example(),
    tips(),
  ].join('\n\n') + '\n';
}
