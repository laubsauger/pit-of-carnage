/**
 * Balance search tools (the workbench behind docs/TUNING.md; `npm run balance` writes the official
 * docs/BALANCE.md). Every command plays real matches on the real sim, with rule numbers overridden
 * at runtime by dotted paths into `src/core` (e.g. `WEAPONS.LONGBOW.ammo`). Nothing here writes
 * src/core/rules.ts: copy the numbers you settle on by hand.
 *
 *   npx tsx scripts/balance-search.ts probe [--seeds 60] [--ffas 40] [--seed 1] [--ovr '{"WEAPONS.LONGBOW.ammo":14}'] [--pit]
 *       Duel matrix (balance stacks, seats swapped), FFA family/weapon shares and per-house-stack lines.
 *   npx tsx scripts/balance-search.ts tune PARAMS.json [--seeds 60] [--seed-sets 1,2,3] [--passes 2] [--dps 1] [--ovr '{...}']
 *       Coordinate search over the PARAMS ([{ path, value, min, max, step }]) against the duel matrix:
 *       score = sum over pairings of 100 x max(0, |rate - 0.5| - 0.12)^2, plus a penalty when melee
 *       nominal DPS falls below 1.5x ranged (weight --dps). Tries +-1 and +-2 steps per parameter,
 *       keeps the best that improves and walks on. Writes PARAMS.best.json after each pass.
 *   npx tsx scripts/balance-search.ts skills SKILL [--seeds 20] [--vs DASH] [--ovr '{...}']
 *       Is a skill dominant? Every weapon pairing, the skill against --vs, same plans, seats swapped.
 *   npx tsx scripts/balance-search.ts trace WEAPON_A WEAPON_B [--seed 1] [--every 30] [--map pit] [--ovr '{...}']
 *       Play one duel and print hits, sticks, pickups, skills and a state line every N ticks.
 *   npx tsx scripts/balance-search.ts acid [--ffas 40] [--ovr '{...}']
 *       How much spilled acid matters in house FFAs.
 *
 * Threads: --threads N (default 6, the cap agreed for this shared machine).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import * as core from '../src/core';
import type { Behaviour, MatchConfig, MatchReport, SkillId, Strategy, WeaponId } from '../src/core';
import { analyseBalance, balancePlan, balanceStack, duelConfig, nominalDps, weaponShares, type BalanceOptions } from '../src/gym/balance';
import { createSimRunner } from '../src/gym/runner';
import { MAPS, MAP_IDS, createMatch } from '../src/sim';
import { HOUSE_STACKS, headlessBrainFactory } from '../src/strategy';
import { STARTER_LIBRARY } from '../src/strategy/library';

type Overrides = Record<string, unknown>;

/** Set a rule number by dotted path into src/core (mutates the live tables of this thread). */
function setPath(path: string, value: unknown): void {
  const parts = path.split('.');
  let o = core as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    o = o[parts[i]!] as Record<string, unknown>;
    if (o === undefined || o === null) throw new Error(`No rule at ${path}`);
  }
  const last = parts[parts.length - 1]!;
  if (!(last in o)) throw new Error(`No rule at ${path}`);
  o[last] = value;
}

function apply(ovr: Overrides): void {
  for (const [k, v] of Object.entries(ovr)) setPath(k, v);
}

const SHORT: Record<WeaponId, string> = { GREATSWORD: 'GS', WARHAMMER: 'WH', TWIN_DAGGERS: 'TD', THROWING_AXES: 'TA', LONGBOW: 'LB', ARCANE_STAFF: 'AS' };

// ---------------------------------------------------------------------------------------------
// Worker: plays one match per message with the overrides it is given
// ---------------------------------------------------------------------------------------------

type Job = { index: number; config: MatchConfig; ovr: Overrides };

if (!isMainThread) {
  apply((workerData as { base: Overrides }).base);
  const run = createSimRunner({ createMatch, brainFactory: headlessBrainFactory, mapName: (id) => MAPS[id]?.name ?? id });
  let applied = '';
  parentPort!.on('message', (job: Job) => {
    const key = JSON.stringify(job.ovr);
    if (key !== applied) {
      apply(job.ovr);
      applied = key;
    }
    parentPort!.postMessage({ index: job.index, report: run(job.config) });
  });
}

class Pool {
  private workers: Worker[] = [];
  constructor(threads: number, base: Overrides) {
    for (let t = 0; t < threads; t++) this.workers.push(new Worker(new URL(import.meta.url), { workerData: { base } }));
  }
  /** Play every config with `ovr` applied on top of the base; reports in config order. */
  play(configs: readonly MatchConfig[], ovr: Overrides = {}): Promise<MatchReport[]> {
    const out = new Array<MatchReport>(configs.length);
    let next = 0;
    let done = 0;
    return new Promise((resolve, reject) => {
      if (configs.length === 0) return resolve(out);
      for (const w of this.workers) {
        const feed = () => {
          if (next < configs.length) {
            const index = next++;
            w.postMessage({ index, config: configs[index]!, ovr } satisfies Job);
          }
        };
        w.removeAllListeners('message');
        w.removeAllListeners('error');
        w.on('message', (d: { index: number; report: MatchReport }) => {
          out[d.index] = d.report;
          if (++done === configs.length) resolve(out);
          else feed();
        });
        w.on('error', reject);
        feed();
      }
    });
  }
  close(): void {
    for (const w of this.workers) void w.terminate();
  }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

type Flags = Record<string, string>;

function parse(argv: readonly string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) pos.push(a);
    else if (a === '--pit') flags.pit = '1';
    else flags[a.slice(2)] = argv[++i] ?? '';
  }
  return { pos, flags };
}

const num = (f: Flags, k: string, d: number) => (f[k] !== undefined ? Number(f[k]) : d);

function winnerOf(r: MatchReport) {
  return r.roster.find((e) => e.fighterId === r.placements[0]) ?? null;
}

function matrix(rate: (a: WeaponId, b: WeaponId) => number): void {
  const ids = core.WEAPON_IDS;
  console.log('      ' + ids.map((i) => SHORT[i].padStart(5)).join('') + '   avg');
  for (const a of ids) {
    let sum = 0;
    const cells = ids.map((b) => {
      if (a === b) return '    -';
      const v = rate(a, b);
      sum += v;
      const s = `${Math.round(v * 100)}`;
      return (v < 0.35 || v > 0.65 ? `*${s}` : s).padStart(5);
    });
    console.log(SHORT[a].padEnd(6) + cells.join('') + `  ${Math.round((sum / (ids.length - 1)) * 100)}`);
  }
}

function dpsRatio(): number {
  const ids = core.WEAPON_IDS;
  const mean = (fam: core.WeaponFamily) => {
    const xs = ids.filter((w) => core.WEAPONS[w].family === fam).map((w) => nominalDps(w).dps);
    return xs.reduce((s, x) => s + x, 0) / xs.length;
  };
  return mean('melee') / mean('ranged');
}

async function probe(pool: Pool, f: Flags): Promise<void> {
  const options: BalanceOptions = { seed: num(f, 'seed', 1), duelSeeds: num(f, 'seeds', 60), duelMapId: 'pit', field: HOUSE_STACKS, mapIds: MAP_IDS, ffasPerMap: num(f, 'ffas', 40) };
  const plan = balancePlan(options);
  const reports = await pool.play([...plan.duels, ...plan.ffas]);
  const duels = reports.slice(0, plan.duels.length);
  const ffas = reports.slice(plan.duels.length);
  const r = analyseBalance(options, duels, ffas);
  matrix((a, b) => {
    const p = r.pairings.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a))!;
    return p.a === a ? p.winRate : 1 - p.winRate;
  });
  console.log(`duels inside ${r.pairings.filter((p) => p.pass).length}/15; DPS ratio ${dpsRatio().toFixed(2)}`);
  for (const m of r.ffaByMap) console.log(`${m.mapId.padEnd(13)} ` + m.families.map((x) => `${x.key} ${x.ratio}x`).join('  ') + `  length ${Math.round(m.endings.avgTicks / 60)} s`);
  console.log('weapons, all maps: ' + r.weapons.map((w) => `${SHORT[w.key]} ${w.ratio}`).join('  '));
  console.log('weapons, pit:      ' + weaponShares(ffas.filter((x) => x.mapId === 'pit')).map((w) => `${SHORT[w.key]} ${w.ratio}`).join('  '));
  const rows = new Map<string, { n: number; wins: number; kills: number; dealt: number; alive: number }>();
  for (const rep of ffas) {
    if (f.pit && rep.mapId !== 'pit') continue;
    for (const e of rep.roster) {
      const fr = rep.fighters.find((x) => x.fighterId === e.fighterId)!;
      const row = rows.get(e.strategyName) ?? { n: 0, wins: 0, kills: 0, dealt: 0, alive: 0 };
      row.n++;
      if (rep.placements[0] === e.fighterId) row.wins++;
      row.kills += fr.kills;
      row.dealt += fr.damageDealt;
      row.alive += fr.exposure.ticksAlive;
      rows.set(e.strategyName, row);
    }
  }
  for (const [name, x] of [...rows].sort((a, b) => b[1].wins / b[1].n - a[1].wins / a[1].n)) {
    console.log(`  ${name.slice(0, 26).padEnd(26)} win ${Math.round((x.wins / x.n) * 100)}%  kills ${(x.kills / x.n).toFixed(2)}  dealt ${Math.round(x.dealt / x.n)}  alive ${Math.round(x.alive / x.n / 60)} s`);
  }
}

type Param = { path: string; value: number; min: number; max: number; step: number };

async function tune(pool: Pool, file: string, f: Flags): Promise<void> {
  const params = JSON.parse(readFileSync(file, 'utf8')) as Param[];
  const seedSets = (f['seed-sets'] ?? '1').split(',').map(Number);
  const configs = seedSets.flatMap((seed) => balancePlan({ seed, duelSeeds: num(f, 'seeds', 60), duelMapId: 'pit', field: HOUSE_STACKS, mapIds: MAP_IDS, ffasPerMap: 0 }).duels);
  const dpsW = num(f, 'dps', 1);
  const W = core.WEAPON_IDS;
  const evaluate = async (values: Record<string, number>) => {
    const reports = await pool.play(configs, values);
    const rates = new Map<string, number>();
    let score = 0;
    for (let i = 0; i < W.length; i++) {
      for (let j = i + 1; j < W.length; j++) {
        const games = reports.filter((r) => r.roster.some((e) => e.weapon === W[i]) && r.roster.some((e) => e.weapon === W[j]));
        const wr = games.filter((g) => winnerOf(g)?.weapon === W[i]).length / games.length;
        rates.set(`${SHORT[W[i]!]}-${SHORT[W[j]!]}`, wr);
        score += 100 * Math.max(0, Math.abs(wr - 0.5) - 0.12) ** 2;
      }
    }
    apply(values);
    const ratio = dpsRatio();
    score += dpsW * 10 * Math.max(0, 1.5 - ratio) ** 2;
    return { score, ratio, rates };
  };
  const show = (r: Awaited<ReturnType<typeof evaluate>>) => `score ${r.score.toFixed(3)} ratio ${r.ratio.toFixed(2)} | ` + [...r.rates].map(([k, v]) => `${k} ${Math.round(v * 100)}`).join(' ');
  const values: Record<string, number> = Object.fromEntries(params.map((p) => [p.path, p.value]));
  const step = (path: string, k: number, p: Param) => Math.round((values[path]! + k * p.step) * 1000) / 1000;
  let best = await evaluate(values);
  console.log('start', show(best));
  for (let pass = 0; pass < num(f, 'passes', 2); pass++) {
    let improved = false;
    for (const p of params) {
      let bestK = 0;
      let bestR = best;
      for (const k of [1, -1, 2, -2]) {
        const v = step(p.path, k, p);
        if (v < p.min || v > p.max) continue;
        const r = await evaluate({ ...values, [p.path]: v });
        if (r.score < bestR.score - 0.02) {
          bestR = r;
          bestK = k;
        }
      }
      if (bestK === 0) continue;
      values[p.path] = step(p.path, bestK, p);
      best = bestR;
      improved = true;
      console.log(`  ${p.path} = ${values[p.path]}  ${show(best)}`);
      for (;;) {
        const v = step(p.path, Math.sign(bestK), p);
        if (v < p.min || v > p.max) break;
        const r = await evaluate({ ...values, [p.path]: v });
        if (!(r.score < best.score - 0.02)) break;
        values[p.path] = v;
        best = r;
        console.log(`  ${p.path} = ${v}  ${show(r)}`);
      }
    }
    console.log(`pass ${pass + 1} done: ${show(best)}`);
    writeFileSync(file.replace(/\.json$/, '.best.json'), JSON.stringify(values, null, 1));
    if (!improved) break;
  }
  console.log(JSON.stringify(values));
}

/** The skill policy each skill gets in the skill test (a fair, simple use of it). */
const SKILL_POLICY: Record<SkillId, string> = {
  HOOK: 'target.distance > 100 and target.distance < 250',
  SECOND_WIND: 'self.hp < 0.55',
  DASH: 'target.distance < 90 or enemies_near >= 2',
  WHIRLWIND: 'enemies_near >= 1 and target.distance < 90',
  SHADOWSTEP: 'target.distance < 300',
  SHOCKWAVE: 'target.distance < 90',
  BLOODRAGE: 'target.distance < 150',
};

function withSkill(weapon: WeaponId, skill: SkillId): Strategy {
  const s = balanceStack(weapon);
  const fight: Behaviour = { ...(STARTER_LIBRARY as Record<string, Behaviour>).brawl!, skill: SKILL_POLICY[skill] };
  const behaviours: Record<string, Behaviour> = { ...s.behaviours, fight };
  if (behaviours.kite) behaviours.kite = { ...behaviours.kite, skill: SKILL_POLICY[skill] };
  return { ...s, name: `${s.name} ${skill}`, build: { ...s.build, skill }, behaviours, imports: (s.imports ?? []).filter((i) => i !== 'brawl') };
}

async function skills(pool: Pool, skill: SkillId, f: Flags): Promise<void> {
  const base = (f.vs ?? 'DASH') as SkillId;
  const rng = new core.Rng(7);
  const seeds = Array.from({ length: num(f, 'seeds', 20) }, (_, i) => rng.fork(`s${i}`).nextU32());
  const jobs: { config: MatchConfig; a: string; wa: WeaponId; wb: WeaponId }[] = [];
  for (const wa of core.WEAPON_IDS) {
    for (const wb of core.WEAPON_IDS) {
      const A = withSkill(wa, skill);
      const B = { ...withSkill(wb, base) };
      B.name += ' (b)';
      for (const seed of seeds) jobs.push({ config: duelConfig(seed, 'pit', A, B), a: A.name, wa, wb }, { config: duelConfig(seed, 'pit', B, A), a: A.name, wa, wb });
    }
  }
  const reports = await pool.play(jobs.map((j) => j.config));
  const won = reports.map((r, i) => winnerOf(r)?.strategyName === jobs[i]!.a);
  const mirror = jobs.map((j, i) => [j, won[i]] as const).filter(([j]) => j.wa === j.wb);
  console.log(`${skill} vs ${base}: overall ${Math.round((won.filter(Boolean).length / won.length) * 100)}%, mirror ${Math.round((mirror.filter(([, w]) => w).length / mirror.length) * 100)}%`);
  console.log('  by weapon with the skill: ' + core.WEAPON_IDS.map((w) => {
    const xs = jobs.map((j, i) => [j, won[i]] as const).filter(([j]) => j.wa === w);
    return `${SHORT[w]} ${Math.round((xs.filter(([, x]) => x).length / xs.length) * 100)}%`;
  }).join('  '));
}

function trace(a: WeaponId, b: WeaponId, f: Flags): void {
  const every = num(f, 'every', 30);
  const m = createMatch(duelConfig(num(f, 'seed', 1), f.map ?? 'pit', balanceStack(a), balanceStack(b)), headlessBrainFactory);
  const [f0, f1] = m.state.fighters as [core.FighterState, core.FighterState];
  const cap = core.matchHardCapTicks(m.config.timeLimitTicks) + 600;
  const desc = (x: core.FighterState) => `${x.weapon.slice(0, 5)} hp${x.hp} ammo${x.ammo} ${x.behaviour}/${x.anim.phase} v${Math.hypot(x.vel.x, x.vel.y).toFixed(2)}`;
  while (!m.isOver && m.state.tick < cap) {
    for (const e of m.step()) {
      if (e.type === 'hit') console.log(`  t${e.tick} hit ${e.attackerId}->${e.victimId} ${e.amount} ${e.source}${e.backstab ? ' BS' : ''}${e.crit ? ' CRIT' : ''}`);
      else if (e.type === 'kill') console.log(`  t${e.tick} KILL ${e.killerId}->${e.victimId}`);
      else if (e.type === 'ammo_stick') console.log(`  t${e.tick} stick ${e.kind} in ${e.in.kind}`);
      else if (e.type === 'pickup') console.log(`  t${e.tick} pickup ${e.fighterId} ${e.kind}`);
      else if (e.type === 'skill') console.log(`  t${e.tick} skill ${e.fighterId} ${e.skill}`);
      else if (e.type === 'sudden_death') console.log(`  t${e.tick} SUDDEN DEATH ${e.reason}`);
    }
    if (m.state.tick % every === 0) console.log(`t${m.state.tick} d${Math.round(Math.hypot(f0.pos.x - f1.pos.x, f0.pos.y - f1.pos.y))} | ${desc(f0)} | ${desc(f1)}`);
  }
  console.log('placements', m.state.placements, m.state.ending);
}

function acid(f: Flags): void {
  const plan = balancePlan({ seed: 1, duelSeeds: 0, duelMapId: 'pit', field: HOUSE_STACKS, mapIds: MAP_IDS, ffasPerMap: num(f, 'ffas', 40) });
  let spills = 0;
  let acidDamage = 0;
  let allDamage = 0;
  let acidKills = 0;
  let kills = 0;
  for (const config of plan.ffas) {
    const m = createMatch(config, headlessBrainFactory);
    const cap = core.matchHardCapTicks(config.timeLimitTicks) + 600;
    while (!m.isOver && m.state.tick < cap) {
      let victim: string | null = null;
      for (const e of m.step()) {
        if (e.type === 'prop_break' && e.kind === 'amphora') spills++;
        if (e.type === 'hazard' && e.hazardId.includes('_spill') && e.victimId) victim = e.victimId;
        if (e.type === 'hit') {
          allDamage += e.amount;
          if (e.source === 'hazard' && e.victimId === victim) acidDamage += e.amount;
        }
        if (e.type === 'kill') {
          kills++;
          if (e.hazard === 'acid') acidKills++;
        }
      }
    }
  }
  const n = plan.ffas.length;
  console.log(`${n} FFAs: amphoras broken ${(spills / n).toFixed(2)}/match, acid ${((acidDamage / allDamage) * 100).toFixed(2)}% of all damage, acid kills ${acidKills}/${kills}`);
}

async function main(): Promise<void> {
  const { pos, flags } = parse(process.argv.slice(2));
  const ovr = flags.ovr ? (JSON.parse(flags.ovr) as Overrides) : {};
  apply(ovr);
  const cmd = pos[0];
  if (cmd === 'trace') return trace(pos[1] as WeaponId, pos[2] as WeaponId, flags);
  if (cmd === 'acid') return acid(flags);
  const pool = new Pool(Math.min(6, Math.max(1, num(flags, 'threads', 6))), ovr);
  try {
    if (cmd === 'probe') await probe(pool, flags);
    else if (cmd === 'tune') await tune(pool, pos[1]!, flags);
    else if (cmd === 'skills') await skills(pool, pos[1] as SkillId, flags);
    else throw new Error('Usage: npx tsx scripts/balance-search.ts probe | tune PARAMS.json | skills SKILL | trace A B | acid (see the header)');
  } finally {
    pool.close();
  }
}

if (isMainThread) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
