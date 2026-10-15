/**
 * Balance harness (spec "Balance: ranged vs melee": measured, not guessed). Two experiments:
 *
 * (a) Duels on the Pit between comparable stacks, one per weapon (`balanceStack`): the same build,
 *     skill and target rule, and the starter plan of the weapon's family. Only the weapon differs,
 *     so the matrix measures weapons rather than plans (house stacks differ in build and plan, so
 *     their duels would measure strategies). Each pairing plays every seed twice with the seats
 *     swapped, which cancels any spawn-side advantage.
 * (b) FFAs (8 fighters) on the map pool with the house stacks: the field the game actually plays.
 *     A weapon family's wins are compared with its fair share, the share of seats it held in each
 *     match summed over the matches, so a lineup with more melee seats expects more melee wins.
 *
 * Targets: every duel pairing between 35% and 65%; on the Pit each family wins 0.67-1.5x its fair
 * share. `scripts/balance.ts` (npm run balance) plays the plan, then writes `balanceMarkdown` to
 * docs/BALANCE.md. Everything here is pure: same reports in, same document out.
 */

import {
  COMBAT,
  COMBAT_DOCS,
  DEFAULT_FIGHTERS,
  Rng,
  STRATEGY_SCHEMA,
  TICK_HZ,
  WEAPONS,
  WEAPON_IDS,
  attackCooldown,
  damageMultiplier,
  strategyKey,
} from '../core';
import type { Attributes, Behaviour, MatchConfig, MatchEnding, MatchReport, Strategy, SuddenDeathReason, WeaponFamily, WeaponId } from '../core';
import { buildBatch, gymConfig } from './batch';
import { clock, plural, round } from './format';

export const BALANCE_TARGETS = {
  /** Every duel pairing's win rate must lie in [duelMin, duelMax]. */
  duelMin: 0.35,
  duelMax: 0.65,
  /** On the duel map each family's FFA wins / fair share must lie in [shareMin, shareMax]. */
  shareMin: 0.67,
  shareMax: 1.5,
} as const;

/** Spec guideline, not a harness target: melee damage per second about 1.5-1.8x ranged. */
export const DPS_RATIO_GUIDE = { min: 1.5, max: 1.8 } as const;

/** The build every comparable stack uses (100 points, nothing extreme). */
export const STACK_ATTRIBUTES: Readonly<Attributes> = { vitality: 18, power: 18, agility: 18, perception: 16, armor: 14, haste: 16 };

/** Ranged stacks hold their target at this fraction of their weapon's range, so no bow is played as an axe. */
const KITE_BAND = [0.55, 0.85] as const;

const FAMILIES: readonly WeaponFamily[] = ['melee', 'ranged'];

/** Two-letter column labels for the duel matrix. */
const SHORT: Record<WeaponId, string> = {
  GREATSWORD: 'GS',
  WARHAMMER: 'WH',
  TWIN_DAGGERS: 'TD',
  THROWING_AXES: 'TA',
  LONGBOW: 'LB',
  ARCANE_STAFF: 'AS',
};

/**
 * The comparable stack for one weapon: same build, skill (DASH) and target rule for everyone.
 * Melee: brawl. Ranged: kite (the starter `kite` with its band scaled to the weapon's range), then
 * restock spent ammo, brawl with fists when there is none. Both: heal at the shrine, prowl when
 * nobody is known.
 */
export function balanceStack(weapon: WeaponId): Strategy {
  const w = WEAPONS[weapon];
  const behaviours: Record<string, Behaviour> = {};
  if (w.family === 'ranged') {
    behaviours.kite = {
      score: '(self.ammo > 0) * (enemies_known > 0) * 0.65',
      move: [
        { keep_range: ['target', Math.round(w.range * KITE_BAND[0]), Math.round(w.range * KITE_BAND[1])], weight: 1.2 },
        { orbit: ['target', 'ccw'], weight: 0.45 },
        { avoid: 'walls', weight: 0.35 },
        { avoid: 'hazards', weight: 0.8 },
      ],
      attack: 'in_range',
      skill: 'target.distance < 110',
    };
  }
  return {
    schema: STRATEGY_SCHEMA,
    name: `Standard ${w.name}`,
    author: 'Balance harness',
    version: 1,
    build: { weapon, skill: 'DASH', attributes: { ...STACK_ATTRIBUTES } },
    target: '1000 - it.distance + 200 * (1 - it.hp)',
    behaviours,
    imports: w.family === 'ranged' ? ['restock', 'brawl', 'heal', 'prowl'] : ['brawl', 'heal', 'prowl'],
    commit: 30,
  };
}

// ---------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------

export type BalanceOptions = {
  seed: number;
  /** Seeds per duel pairing; each is played twice, seats swapped. */
  duelSeeds: number;
  /** Where the duels are fought and the FFA family target is read. */
  duelMapId: string;
  /** FFA lineups are drawn from these (the house stacks). */
  field: readonly Strategy[];
  /** FFA map pool. */
  mapIds: readonly string[];
  ffasPerMap: number;
  /** Fighters per FFA (default 8). */
  fighters?: number;
};

export type BalancePlan = { duels: MatchConfig[]; ffas: MatchConfig[] };

/** A duel between two strategies: seat 0 is `a`. */
export function duelConfig(seed: number, mapId: string, a: Strategy, b: Strategy): MatchConfig {
  return { ...gymConfig(seed, mapId, [a, b]), format: 'duel' };
}

/**
 * Every match the harness plays, in a fixed order. Duels: for each pairing of weapons (in
 * WEAPON_IDS order), for each seed, seat order (a, b) then (b, a); every pairing uses the same
 * seeds. FFAs: `ffasPerMap` per map, rotating through the pool, lineups drawn evenly from the field.
 */
export function balancePlan(o: BalanceOptions): BalancePlan {
  const rng = new Rng(o.seed);
  const seeds = Array.from({ length: o.duelSeeds }, (_, i) => rng.fork(`duel:${i}`).nextU32());
  const stacks = WEAPON_IDS.map(balanceStack);
  const duels: MatchConfig[] = [];
  for (let i = 0; i < stacks.length; i++) {
    for (let j = i + 1; j < stacks.length; j++) {
      for (const seed of seeds) duels.push(duelConfig(seed, o.duelMapId, stacks[i]!, stacks[j]!), duelConfig(seed, o.duelMapId, stacks[j]!, stacks[i]!));
    }
  }
  const ffas =
    o.ffasPerMap > 0
      ? buildBatch({
          candidates: [],
          field: [...o.field],
          mapIds: [...o.mapIds],
          matches: o.ffasPerMap * o.mapIds.length,
          fighters: o.fighters ?? DEFAULT_FIGHTERS,
          seed: rng.fork('ffa').nextU32(),
        })
      : [];
  return { duels, ffas };
}

// ---------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------

/** One unordered pairing of weapons; `a` comes first in WEAPON_IDS. */
export type DuelPairing = {
  a: WeaponId;
  b: WeaponId;
  matches: number;
  winsA: number;
  /** `a`'s win rate (b's is 1 - this). */
  winRate: number;
  avgTicks: number;
  suddenDeath: number;
  judges: number;
  pass: boolean;
};

/** How a set of matches ended. */
export type EndingSummary = {
  matches: number;
  avgTicks: number;
  endings: Partial<Record<MatchEnding, number>>;
  suddenDeath: Partial<Record<SuddenDeathReason, number>>;
};

/**
 * Wins against fair share. `fair` sums, over the matches, the share of seats held (so 3 melee
 * seats of 8 add 0.375); `ratio` = wins / fair, null when it never held a seat.
 */
export type ShareRow<K extends string> = { key: K; seats: number; wins: number; fair: number; ratio: number | null };

export type MapShares = { mapId: string; families: ShareRow<WeaponFamily>[]; endings: EndingSummary };

export type StrategyRow = { key: string; name: string; weapon: WeaponId; matches: number; wins: number; avgPlace: number };

export type BalanceCheck = { target: string; measured: string; pass: boolean; /** Guidelines are shown but do not fail the run. */ guideline?: boolean };

export type BalanceReport = {
  options: Omit<BalanceOptions, 'field'> & { fighters: number; fieldSize: number };
  pairings: DuelPairing[];
  duelEndings: EndingSummary;
  ffaByMap: MapShares[];
  /** Weapon win shares over every FFA. */
  weapons: ShareRow<WeaponId>[];
  strategies: StrategyRow[];
  /** Nominal damage per second of each weapon with the comparable build. */
  dps: { weapon: WeaponId; cycleTicks: number; dps: number }[];
  checks: BalanceCheck[];
  /** Every target (not guideline) holds. */
  pass: boolean;
};

/** The roster entry that placed 1st. */
function winnerOf(r: MatchReport) {
  const id = r.placements[0];
  return r.roster.find((e) => e.fighterId === id);
}

function inBand(x: number, min: number, max: number): boolean {
  return x >= min && x <= max;
}

export function endingSummary(reports: readonly MatchReport[]): EndingSummary {
  const endings: Partial<Record<MatchEnding, number>> = {};
  const suddenDeath: Partial<Record<SuddenDeathReason, number>> = {};
  let ticks = 0;
  for (const r of reports) {
    endings[r.ending] = (endings[r.ending] ?? 0) + 1;
    if (r.suddenDeathStart) suddenDeath[r.suddenDeathStart.reason] = (suddenDeath[r.suddenDeathStart.reason] ?? 0) + 1;
    ticks += r.ticks;
  }
  return { matches: reports.length, avgTicks: reports.length > 0 ? Math.round(ticks / reports.length) : 0, endings, suddenDeath };
}

/** Win rate of each weapon pairing, from duel reports (two fighters, different weapons). */
export function duelPairings(reports: readonly MatchReport[]): DuelPairing[] {
  const out: DuelPairing[] = [];
  for (let i = 0; i < WEAPON_IDS.length; i++) {
    for (let j = i + 1; j < WEAPON_IDS.length; j++) {
      const a = WEAPON_IDS[i]!;
      const b = WEAPON_IDS[j]!;
      const games = reports.filter((r) => r.roster.length === 2 && r.roster.some((e) => e.weapon === a) && r.roster.some((e) => e.weapon === b));
      if (games.length === 0) continue;
      const winsA = games.filter((r) => winnerOf(r)?.weapon === a).length;
      const ends = endingSummary(games);
      const winRate = winsA / games.length;
      out.push({
        a, b, matches: games.length, winsA, winRate: round(winRate, 3), avgTicks: ends.avgTicks,
        suddenDeath: (ends.suddenDeath.time ?? 0) + (ends.suddenDeath.stalemate ?? 0), judges: ends.endings.judges ?? 0,
        pass: inBand(winRate, BALANCE_TARGETS.duelMin, BALANCE_TARGETS.duelMax),
      });
    }
  }
  return out;
}

function shares<K extends string>(reports: readonly MatchReport[], keys: readonly K[], keyOf: (weapon: WeaponId) => K): ShareRow<K>[] {
  const rows = new Map<K, ShareRow<K>>(keys.map((k) => [k, { key: k, seats: 0, wins: 0, fair: 0, ratio: null }]));
  for (const r of reports) {
    const n = r.roster.length;
    for (const e of r.roster) {
      const row = rows.get(keyOf(e.weapon))!;
      row.seats++;
      row.fair += 1 / n;
    }
    const w = winnerOf(r);
    if (w) rows.get(keyOf(w.weapon))!.wins++;
  }
  return [...rows.values()].map((row) => ({ ...row, fair: round(row.fair, 2), ratio: row.fair > 0 ? round(row.wins / row.fair, 2) : null }));
}

export function familyShares(reports: readonly MatchReport[]): ShareRow<WeaponFamily>[] {
  return shares(reports, FAMILIES, (w) => WEAPONS[w].family);
}

export function weaponShares(reports: readonly MatchReport[]): ShareRow<WeaponId>[] {
  return shares(reports, WEAPON_IDS, (w) => w);
}

function strategyRows(reports: readonly MatchReport[]): StrategyRow[] {
  const rows = new Map<string, StrategyRow & { placeSum: number }>();
  for (const r of reports) {
    const place = new Map(r.fighters.map((f) => [f.fighterId, f.place]));
    for (const e of r.roster) {
      const row = rows.get(e.strategyKey) ?? { key: e.strategyKey, name: e.strategyName, weapon: e.weapon, matches: 0, wins: 0, avgPlace: 0, placeSum: 0 };
      row.matches++;
      row.placeSum += place.get(e.fighterId) ?? r.roster.length;
      if (r.placements[0] === e.fighterId) row.wins++;
      rows.set(e.strategyKey, row);
    }
  }
  return [...rows.values()]
    .map(({ placeSum, ...row }) => ({ ...row, avgPlace: round(placeSum / row.matches, 2) }))
    .sort((a, b) => a.avgPlace - b.avgPlace || (a.key < b.key ? -1 : 1));
}

/**
 * Nominal damage per second with the comparable build: one target, no crits, backstabs, splash,
 * point-blank penalty or armor, over the full attack cycle (windup + max(cooldown, strike + recovery)).
 */
export function nominalDps(weapon: WeaponId, attrs: Attributes = STACK_ATTRIBUTES): { cycleTicks: number; dps: number } {
  const w = WEAPONS[weapon];
  const cycleTicks = w.windup + Math.max(attackCooldown(attrs, weapon), w.strike + w.recovery);
  return { cycleTicks, dps: round((w.damage * damageMultiplier(attrs, false) * TICK_HZ) / cycleTicks, 1) };
}

function familyLabel(f: WeaponFamily): string {
  return f === 'melee' ? 'Melee' : 'Ranged';
}

function pctOf(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function analyseBalance(options: BalanceOptions, duelReports: readonly MatchReport[], ffaReports: readonly MatchReport[]): BalanceReport {
  const { field, ...rest } = options;
  const fighters = options.fighters ?? DEFAULT_FIGHTERS;
  const pairings = duelPairings(duelReports);
  const mapIds = [...new Set([...options.mapIds, ...ffaReports.map((r) => r.mapId)])];
  const ffaByMap = mapIds
    .map((mapId) => {
      const on = ffaReports.filter((r) => r.mapId === mapId);
      return { mapId, families: familyShares(on), endings: endingSummary(on) };
    })
    .filter((m) => m.endings.matches > 0);
  const dps = WEAPON_IDS.map((weapon) => ({ weapon, ...nominalDps(weapon) }));

  const checks: BalanceCheck[] = [];
  const { duelMin, duelMax, shareMin, shareMax } = BALANCE_TARGETS;
  const outside = pairings.filter((p) => !p.pass).sort((x, y) => Math.abs(y.winRate - 0.5) - Math.abs(x.winRate - 0.5));
  const expected = (WEAPON_IDS.length * (WEAPON_IDS.length - 1)) / 2;
  checks.push({
    target: `Every duel pairing wins between ${pctOf(duelMin)} and ${pctOf(duelMax)} on ${options.duelMapId}`,
    measured:
      pairings.length < expected
        ? `only ${pairings.length} of ${expected} pairings were played`
        : `${pairings.length - outside.length} of ${pairings.length} inside` +
          (outside.length > 0
            ? `; outside: ${outside.map((p) => (p.winRate >= 0.5 ? `${p.a} ${pctOf(p.winRate)} vs ${p.b}` : `${p.b} ${pctOf(1 - p.winRate)} vs ${p.a}`)).join(', ')}`
            : ''),
    pass: pairings.length === expected && outside.length === 0,
  });
  const onDuelMap = ffaByMap.find((m) => m.mapId === options.duelMapId);
  for (const family of FAMILIES) {
    const row = onDuelMap?.families.find((f) => f.key === family);
    const target = `${familyLabel(family)} family wins ${shareMin}-${shareMax}x its fair share of FFAs on ${options.duelMapId}`;
    if (!row || row.ratio === null) {
      checks.push({ target, measured: `no FFAs with ${family} seats on ${options.duelMapId}`, pass: false });
      continue;
    }
    checks.push({ target, measured: `${row.ratio}x (${row.wins} ${plural(row.wins, 'win')}, fair share ${row.fair} of ${onDuelMap!.endings.matches})`, pass: inBand(row.ratio, shareMin, shareMax) });
  }
  const mean = (f: WeaponFamily) => {
    const xs = dps.filter((d) => WEAPONS[d.weapon].family === f).map((d) => d.dps);
    return xs.reduce((s, x) => s + x, 0) / xs.length;
  };
  const ratio = round(mean('melee') / mean('ranged'), 2);
  checks.push({
    target: `Guideline: melee nominal DPS ${DPS_RATIO_GUIDE.min}-${DPS_RATIO_GUIDE.max}x ranged`,
    measured: `${ratio}x (melee ${round(mean('melee'), 1)}, ranged ${round(mean('ranged'), 1)} per second)`,
    pass: inBand(ratio, DPS_RATIO_GUIDE.min, DPS_RATIO_GUIDE.max),
    guideline: true,
  });

  return {
    options: { ...rest, fighters, fieldSize: new Set(field.map(strategyKey)).size },
    pairings,
    duelEndings: endingSummary(duelReports),
    ffaByMap,
    weapons: weaponShares(ffaReports),
    strategies: strategyRows(ffaReports),
    dps,
    checks,
    pass: checks.every((c) => c.guideline || c.pass),
  };
}

// ---------------------------------------------------------------------------------------------
// docs/BALANCE.md
// ---------------------------------------------------------------------------------------------

function table(header: readonly string[], rows: readonly (readonly string[])[], align?: readonly ('l' | 'r')[]): string[] {
  const rule = header.map((_, i) => ((align?.[i] ?? (i === 0 ? 'l' : 'r')) === 'r' ? '---:' : '---'));
  return [`| ${header.join(' | ')} |`, `| ${rule.join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)];
}

function endingsText(e: EndingSummary): string {
  if (e.matches === 0) return 'none played';
  const parts = (['elimination', 'judges', 'time', 'capped'] as const).filter((k) => e.endings[k]).map((k) => `${k} ${pctOf(e.endings[k]! / e.matches)}`);
  return parts.join(', ');
}

function suddenDeathText(e: EndingSummary): string {
  const time = e.suddenDeath.time ?? 0;
  const stalemate = e.suddenDeath.stalemate ?? 0;
  if (e.matches === 0) return '-';
  return `${pctOf((time + stalemate) / e.matches)} (time ${time}, stalemate ${stalemate})`;
}

/** Balance-relevant combat knobs, documented in rules.ts. */
const COMBAT_KEYS = [
  'backpedalMoveMul',
  'rangedPlantMoveMul',
  'releaseFacingTolerance',
  'spreadBase',
  'spreadPerSpeed',
  'spreadPerPx',
  'spreadMax',
  'aimLead',
  'pointBlankRange',
  'pointBlankMul',
  'interruptStaggerTicks',
  'shieldArc',
] as const satisfies readonly (keyof typeof COMBAT)[];

export function balanceMarkdown(report: BalanceReport): string {
  const o = report.options;
  const duelCount = report.duelEndings.matches;
  const ffaCount = report.ffaByMap.reduce((s, m) => s + m.endings.matches, 0);
  const targets = report.checks.filter((c) => !c.guideline);
  const holding = targets.filter((c) => c.pass).length;
  const lines: string[] = [
    '# Balance: ranged vs melee',
    '',
    'Generated by `npm run balance` (`scripts/balance.ts`, harness in `src/gym/balance.ts`). Do not edit by hand;',
    're-run after any change to `src/core/rules.ts`. Targets come from `docs/SPEC.md`, section 6, "Balance: ranged vs melee".',
    '',
    `Run: seed ${o.seed}. ${o.duelSeeds} seeds per duel pairing, each played twice with the seats swapped ` +
      `(${duelCount} duels on ${o.duelMapId}); ${o.ffasPerMap} ${o.fighters}-fighter FFAs per map on ${o.mapIds.join(', ')} ` +
      `(${ffaCount} FFAs, lineups drawn evenly from the ${o.fieldSize} house stacks).`,
    '',
    `**${holding === targets.length ? 'All' : `${holding} of`} ${targets.length} targets hold.**`,
    '',
    '## Targets',
    '',
    ...table(
      ['Target', 'Measured', 'Result'],
      report.checks.map((c) => [c.target, c.measured, c.guideline ? (c.pass ? 'inside' : 'outside') : c.pass ? 'PASS' : 'FAIL']),
      ['l', 'l', 'l'],
    ),
    '',
    `## Duels on ${o.duelMapId}`,
    '',
    'Each weapon plays a comparable stack: the same build (' +
      Object.entries(STACK_ATTRIBUTES)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') +
      '), skill DASH and target rule, with the starter plan of its family. Melee: `brawl`. Ranged: `kite` holding ' +
      `${Math.round(KITE_BAND[0] * 100)}-${Math.round(KITE_BAND[1] * 100)}% of the weapon's range, \`restock\` for spent ammo, \`brawl\` when out. ` +
      'Both import `heal` and `prowl`. Only the weapon differs, so this measures weapons, not plans.',
    '',
    `Win rate of the row weapon against the column weapon. **Bold**: outside ${pctOf(BALANCE_TARGETS.duelMin)}-${pctOf(BALANCE_TARGETS.duelMax)}. ` +
      `Columns: ${WEAPON_IDS.map((w) => `${SHORT[w]} ${w}`).join(', ')}.`,
    '',
  ];

  const rate = (row: WeaponId, col: WeaponId): DuelPairing | undefined => report.pairings.find((p) => (p.a === row && p.b === col) || (p.a === col && p.b === row));
  const matrix = WEAPON_IDS.map((row) => {
    const rates: number[] = [];
    const cells = WEAPON_IDS.map((col) => {
      if (row === col) return '-';
      const p = rate(row, col);
      if (!p) return '?';
      const x = p.a === row ? p.winRate : 1 - p.winRate;
      rates.push(x);
      return p.pass ? pctOf(x) : `**${pctOf(x)}**`;
    });
    const avg = rates.length > 0 ? pctOf(rates.reduce((s, x) => s + x, 0) / rates.length) : '-';
    return [row, ...cells, avg];
  });
  lines.push(...table(['', ...WEAPON_IDS.map((w) => SHORT[w]), 'Average'], matrix), '');

  lines.push(
    '### Pairings',
    '',
    ...table(
      ['Pairing', 'Duels', 'First wins', 'Average length', 'Sudden death', 'Judges', 'Target'],
      report.pairings.map((p) => [`${p.a} vs ${p.b}`, String(p.matches), pctOf(p.winRate), clock(p.avgTicks), pctOf(p.suddenDeath / p.matches), String(p.judges), p.pass ? 'ok' : 'outside']),
      ['l', 'r', 'r', 'r', 'r', 'r', 'l'],
    ),
    '',
    `All duels: average ${clock(report.duelEndings.avgTicks)}; ${endingsText(report.duelEndings)}; sudden death ${suddenDeathText(report.duelEndings)}.`,
    '',
    '## Free-for-alls',
    '',
    'Fair share = the share of seats a family held in each match, summed over the matches. Ratio = wins / fair share; ' +
      `the target band is ${BALANCE_TARGETS.shareMin}-${BALANCE_TARGETS.shareMax}x on ${o.duelMapId}, other maps are shown for reference.`,
    '',
  );

  const familyCells = (m: MapShares, f: WeaponFamily): string[] => {
    const row = m.families.find((x) => x.key === f)!;
    return [`${row.wins} / ${row.fair}`, row.ratio === null ? '-' : `${row.ratio}x`];
  };
  lines.push(
    ...table(
      ['Map', 'FFAs', 'Melee wins / fair', 'Melee ratio', 'Ranged wins / fair', 'Ranged ratio', 'Average length', 'Sudden death', 'Endings'],
      report.ffaByMap.map((m) => [
        m.mapId,
        String(m.endings.matches),
        ...familyCells(m, 'melee'),
        ...familyCells(m, 'ranged'),
        clock(m.endings.avgTicks),
        suddenDeathText(m.endings),
        endingsText(m.endings),
      ]),
      ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'l', 'l'],
    ),
    '',
    '### Weapons, all maps',
    '',
    ...table(
      ['Weapon', 'Family', 'Seats', 'Wins', 'Fair share', 'Ratio'],
      report.weapons.map((w) => [w.key, WEAPONS[w.key].family, String(w.seats), String(w.wins), String(w.fair), w.ratio === null ? '-' : `${w.ratio}x`]),
      ['l', 'l', 'r', 'r', 'r', 'r'],
    ),
    '',
    '### House stacks, all maps',
    '',
    ...table(
      ['Strategy', 'Weapon', 'FFAs', 'Wins', 'Win rate', 'Average place'],
      report.strategies.map((s) => [s.name, s.weapon, String(s.matches), String(s.wins), pctOf(s.wins / s.matches), String(s.avgPlace)]),
      ['l', 'l', 'r', 'r', 'r', 'r'],
    ),
    '',
    '## Current numbers (src/core/rules.ts)',
    '',
    `Nominal DPS: base damage x power (${STACK_ATTRIBUTES.power}) over the full attack cycle with haste ${STACK_ATTRIBUTES.haste}; ` +
      'one target, no crits, backstabs, splash, point-blank penalty or armor. Ranged ammo limits are not included.',
    '',
    ...table(
      ['Weapon', 'Family', 'Range', 'Damage', 'Windup', 'Cycle (ticks)', 'Nominal DPS', 'Move x', 'Lunge', 'Ammo'],
      report.dps.map((d) => {
        const w = WEAPONS[d.weapon];
        return [d.weapon, w.family, String(w.range), String(w.damage), String(w.windup), String(d.cycleTicks), String(d.dps), String(w.moveMul), String(w.lunge), w.ammo > 0 ? String(w.ammo) : '-'];
      }),
      ['l', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r'],
    ),
    '',
    ...table(
      ['Combat rule', 'Value', 'What it does'],
      COMBAT_KEYS.map((k) => [`COMBAT.${k}`, String(COMBAT[k]), COMBAT_DOCS[k]]),
      ['l', 'r', 'l'],
    ),
    '',
  );
  return lines.join('\n');
}
