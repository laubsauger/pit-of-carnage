// Owned by: ui
// Full-screen overview of one fighter (key I, or Expand on the inspector), and the strategy sheet
// opened from the end card: everything the inspector shows in a roomier layout, plus score history,
// every sensor with unit and range, target scoring, memory, damage by source, the fighter's own
// story and, after the match, its numbers, heatmap and the strategy itself. A window in the layout
// stays open onto the arena, framed on the fighter, so the match stays visible.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { STAT_DOCS, TICK_HZ, deriveStats } from '../../core';
import type { DamageSource, DerivedStats, GameController, MatchReport, Strategy, UiFighter, UiSnapshot } from '../../core';
import { encodeStrategyCode } from '../../strategy';
import { prettyJson } from '../editor';
import { formatClock, formatPercent, formatPlace, formatStat, formatValue, skillName } from '../format';
import { Heatmap } from '../Heatmap';
import { usePolled } from '../hooks';
import { KILL_LEAD_IN_TICKS, scoreBars } from '../hud';
import { CloseIcon, CopyIcon } from '../icons';
import { howOut, leadInTick, statLines } from '../reports';
import { copyAndToast } from '../toast';
import { codexHash, sensorCodexId } from '../codexLink';
import { AttrChart, BuildLinks, HpBar } from '../widgets';
import { SteeringRing } from './SteeringRing';
import { guardTripSummary, knowledgeRows, powerupLines, readLive, statusChips, zoneLines } from './fighterData';
import { InfoList, Kv, knowsSummary } from './Inspector';
import {
  REVEAL_RIVAL_STRATEGIES,
  SENSOR_GROUPS,
  commitLeft,
  fighterLog,
  pushHistory,
  scoreRange,
  sensorRows,
  sensorValueText,
  sparkPoints,
  termLabel,
} from './overview';
import type { ScorePoint } from './overview';

export type OverviewTab = 'overview' | 'strategy';

type Props = {
  controller: GameController;
  snap: UiSnapshot;
  fighter: UiFighter;
  /** This fighter's strategy, when the UI started the match (null otherwise). */
  strategy: Strategy | null;
  tab: OverviewTab;
  setTab: (t: OverviewTab) => void;
  onClose: () => void;
  /** The picture-in-picture window's client rect whenever it moves or resizes; null once gone. */
  onPip: (rect: DOMRect | null) => void;
  onOpenInGym: (s: Strategy) => void;
};

const SOURCE_LABEL: Record<DamageSource, string> = {
  weapon: 'Weapon',
  punch: 'Punches',
  skill: 'Skill',
  reflect: 'Reflected',
  hazard: 'Hazards',
  keg: 'Kegs',
  sudden_death: 'The wall',
  bleed: 'Bleeding',
};

const PERCEPTION_STATS: readonly (keyof DerivedStats)[] = ['visionRange', 'visionFov', 'hearingRadius', 'parryChance'];
const BUILD_STATS: readonly (keyof DerivedStats)[] = ['maxHp', 'moveSpeed', 'turnRate', 'armorMitigation', 'damageMultiplier', 'attackCooldown', 'skillCooldown', 'radius'];

export function FighterOverview({ controller, snap, fighter, strategy, tab, setTab, onClose, onPip, onOpenInGym }: Props) {
  const id = fighter.id;
  const report = usePolled<MatchReport | null>(controller, () => controller.lastReport(), []);
  const showStrategy = REVEAL_RIVAL_STRATEGIES && strategy !== null;
  const place = fighter.place ?? (snap.finished ? snap.placements.indexOf(id) + 1 || null : null);

  return (
    <div className="overview" role="dialog" aria-label={`${fighter.name}: full view`}>
      <header className="ov-head">
        <span className="ov-band" style={{ background: fighter.color }} />
        <div className="ov-id">
          <h2 style={{ color: fighter.color }}>{fighter.name}</h2>
          <div className="dim">
            <BuildLinks weapon={fighter.weapon} skill={fighter.skill} />
            {strategy ? <span className="faint"> · {strategy.name} v{strategy.version ?? 1}</span> : null}
          </div>
        </div>
        <div className="ov-vitals">
          {fighter.alive ? (
            <>
              <HpBar hp={fighter.hp} maxHp={fighter.maxHp} color={fighter.color} />
              <span className="num">
                {Math.ceil(fighter.hp)}
                <span className="faint">/{fighter.maxHp}</span>
              </span>
            </>
          ) : (
            <span className="dim">{place ? `Out in ${formatPlace(place)} place` : 'Out'}</span>
          )}
          {fighter.alive && snap.finished && place === 1 ? <span className="chip chip-hot">Winner</span> : null}
          <span className="chip">
            {fighter.kills} {fighter.kills === 1 ? 'kill' : 'kills'}
          </span>
        </div>
        <span className="spacer" />
        {showStrategy ? (
          <div className="subtabs ov-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'overview'} aria-pressed={tab === 'overview'} onClick={() => setTab('overview')}>
              {snap.finished ? 'This match' : 'Overview'}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'strategy'} aria-pressed={tab === 'strategy'} onClick={() => setTab('strategy')}>
              Strategy
            </button>
          </div>
        ) : null}
        {showStrategy && strategy ? (
          <>
            <button type="button" className="btn btn-sm" onClick={() => void copyAndToast(encodeStrategyCode(strategy), 'Strategy code')} title="A PIT2 code anyone can import">
              <CopyIcon size={13} /> Copy strategy code
            </button>
            <button type="button" className="btn btn-sm" onClick={() => onOpenInGym(strategy)} title="Load it into the Gym's editor">
              Open in gym
            </button>
          </>
        ) : null}
        <button type="button" className="btn btn-sm btn-icon btn-quiet" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <CloseIcon />
        </button>
      </header>
      {tab === 'strategy' && showStrategy && strategy ? (
        <div className="ov-body opaque">
          <StrategyView strategy={strategy} color={fighter.color} />
        </div>
      ) : (
        <OverviewBody controller={controller} snap={snap} fighter={fighter} strategy={strategy} report={report} onPip={onPip} />
      )}
    </div>
  );
}

function OverviewBody({ controller, snap, fighter, strategy, report, onPip }: { controller: GameController; snap: UiSnapshot; fighter: UiFighter; strategy: Strategy | null; report: MatchReport | null; onPip: (rect: DOMRect | null) => void }) {
  const id = fighter.id;
  const live = usePolled(controller, () => readLive(controller, id), [id]);
  const { f, known } = live;
  const d = live.d;
  const targetScores = d?.targetScores ?? null;
  const body = useRef<HTMLDivElement>(null);
  const pip = useRef<HTMLDivElement>(null);
  const [termFocus, setTermFocus] = useState<number | null>(null);
  const [filter, setFilter] = useState('');

  // Score history for the sparklines, in match time; starts over when the fighter changes.
  const [hist, setHist] = useState<ScorePoint[]>([]);
  useEffect(() => setHist([]), [id]);
  useEffect(() => {
    if (!d) return;
    setHist((h) => pushHistory(h, { tick: snap.tick, behaviour: d.behaviour, scores: d.scores }));
  }, [d, snap.tick]);

  // Tell the Watch screen where the arena window is, so the camera frames the fighter inside it.
  useLayoutEffect(() => {
    const el = pip.current;
    const scroller = body.current;
    if (!el || !scroller) return;
    let raf = 0;
    const send = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => onPip(el.getBoundingClientRect()));
    };
    onPip(el.getBoundingClientRect());
    const ro = new ResizeObserver(send);
    ro.observe(el);
    scroller.addEventListener('scroll', send, { passive: true });
    window.addEventListener('resize', send);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      scroller.removeEventListener('scroll', send);
      window.removeEventListener('resize', send);
      onPip(null);
    };
  }, [onPip]);

  const stats = f ? deriveStats(f.attributes, f.weapon) : null;
  const knows = fighter.alive ? knowledgeRows(known, f?.pos ?? null, snap.tick, snap.fighters) : [];
  const around = fighter.alive ? [...powerupLines(f, d?.sensors ?? {}), ...zoneLines(snap.suddenDeath, d?.sensors ?? {})] : [];
  const trips = guardTripSummary(d?.guardTrips ?? report?.fighters.find((x) => x.fighterId === id)?.guardTrips ?? []);
  const sensors = useMemo(() => sensorRows(d?.sensors ?? {}), [d]);
  const shownSensors = filter ? sensors.sensors.filter((s) => s.name.includes(filter.trim().toLowerCase())) : sensors.sensors;
  const range = scoreRange(hist);
  const commit = strategy && d ? commitLeft(hist, strategy.commit, snap.tick) : null;
  const log = fighterLog(id, snap.feed, snap.marks).filter((l) => l.tick <= snap.tick);
  const mine = report?.fighters.find((x) => x.fighterId === id) ?? null;
  const target = d?.targetId ? snap.fighters.find((x) => x.id === d.targetId) ?? null : null;

  return (
    <div className="ov-body" ref={body}>
      {/* After the match the strategy sheet leads with how the match went. */}
      {mine && report ? <MatchSection report={report} fighterId={id} color={fighter.color} controller={controller} /> : null}
      <div className="ov-cols">
        <div className="ov-col">
          <section className="ov-card">
            <h3>
              <span>Behaviours</span>
              <span className="dim">{d ? `${snap.finished ? 'last think' : 'running'} ${d.behaviour}` : fighter.alive ? 'waiting for the first think' : 'no more thinking'}</span>
            </h3>
            {d ? (
              <>
                <div className="ov-beh-head faint">
                  <span />
                  <span>last {Math.round(hist.length ? (snap.tick - hist[0]!.tick) / TICK_HZ : 0)} s</span>
                  <span>now</span>
                </div>
                {scoreBars(d.scores, d.behaviour).map((b) => (
                  <div key={b.name} className={`ov-beh${b.active ? ' active' : ''}`}>
                    <span className="bh-name" title={strategy?.behaviours[b.name]?.score ?? b.name}>
                      {b.active ? <i className="ov-run" aria-label="running" /> : null}
                      {b.name}
                    </span>
                    <svg className="spark" viewBox="0 0 120 24" width={120} height={24} aria-hidden>
                      <line x1={0} x2={120} y1={24 - ((0 - range.lo) / (range.hi - range.lo)) * 24} y2={24 - ((0 - range.lo) / (range.hi - range.lo)) * 24} className="spark-zero" />
                      <polyline points={sparkPoints(hist, b.name, snap.tick, 120, 24, range)} fill="none" className={b.active ? 'spark-on' : 'spark-off'} style={b.active ? { stroke: fighter.color } : undefined} />
                    </svg>
                    <span className="bh-bar">
                      <div style={{ width: `${b.fraction * 100}%`, background: b.active ? fighter.color : undefined }} />
                    </span>
                    <span className="bh-val num">{formatValue(b.score)}</span>
                  </div>
                ))}
                <div className="status-row">
                  {commit && !snap.finished ? (
                    <span className={`chip${commit.left > 0 ? ' chip-hot' : ''}`} title={`A new behaviour keeps a +0.25 bonus for ${strategy?.commit} ticks (commit), so it does not flicker.`}>
                      {commit.left > 0 ? `Committed, ${commit.exact ? '' : 'up to '}${(commit.left / TICK_HZ).toFixed(1)} s left` : 'Commit over: any behaviour can take over'}
                    </span>
                  ) : null}
                  {d.attack && !snap.finished ? <span className="chip chip-hot">Attacking</span> : null}
                  {d.useSkill && !snap.finished ? <span className="chip chip-hot">Using {skillName(fighter.skill)}</span> : null}
                  <span className="chip">Throttle {formatPercent(d.speed)}</span>
                  <span className="chip">Stance {d.stance}</span>
                </div>
              </>
            ) : mine ? (
              <p className="faint">No more thinking. How it split its time is in the match numbers above.</p>
            ) : (
              <p className="faint">Nothing to show yet.</p>
            )}
          </section>

          {fighter.alive ? (
            <section className="ov-card">
              <h3>
                <span>Target scoring</span>
                <span className="dim">{target ? <>after <b style={{ color: target.color }}>{target.name}</b></> : 'no target'}</span>
              </h3>
              {knows.length ? (
                <table className="ov-table">
                  <thead>
                    <tr>
                      <th>Enemy</th>
                      <th>Known by</th>
                      <th className="r">Distance</th>
                      {targetScores ? <th className="r">Score</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {knows.map((k) => (
                      <tr key={k.id} className={`${k.state}${d?.targetId === k.id ? ' is-target' : ''}`}>
                        <td>
                          <b style={{ color: k.color }}>{k.name}</b>
                          {d?.targetId === k.id ? <span className="chip">target</span> : null}
                        </td>
                        <td className={k.state === 'seen' ? '' : 'fogged'}>{k.text}</td>
                        <td className="num r">{k.distance}</td>
                        {targetScores ? <td className="num r">{targetScores[k.id] !== undefined ? formatValue(targetScores[k.id]!) : '-'}</td> : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="faint">Nobody in sight or earshot.</p>
              )}
              {strategy ? (
                <p className="ov-expr">
                  <span className="faint">Target expression, highest wins: </span>
                  <code>{strategy.target}</code>
                </p>
              ) : null}
            </section>
          ) : null}

          {sensors.memory.length || trips.total > 0 ? (
            <section className="ov-card">
              <h3>
                <span>Memory and guards</span>
              </h3>
              {sensors.memory.length ? (
                <dl className="kv">
                  {sensors.memory.map((m) => (
                    <Kv key={m.name} k={m.name} v={`${formatValue(m.value)}${strategy?.memory?.[m.name] !== undefined ? `  (starts ${strategy.memory[m.name]})` : ''}`} />
                  ))}
                </dl>
              ) : null}
              {trips.total > 0 ? (
                <ul className="trip-list">
                  {trips.lines.map((t) => (
                    <li key={`${t.path}:${t.what}`}>
                      <code>{t.path}</code>
                      <span>
                        {t.what}, <span className="num">{t.count.toLocaleString('en-US')}</span> {t.count === 1 ? 'time' : 'times'}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="faint">No guard trips: every expression stayed in bounds.</p>
              )}
            </section>
          ) : null}

          {d ? (
            <section className="ov-card">
              <h3>
                <span>Sensors</span>
                <input className="input ov-filter" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter sensors" />
              </h3>
              <div className="ov-scroll">
              <table className="ov-table sensors">
                <tbody>
                  {SENSOR_GROUPS.map((g) => {
                    const rows = shownSensors.filter((s) => s.group === g);
                    if (rows.length === 0) return null;
                    return (
                      <Fragment key={g}>
                        <tr className="grp">
                          <td colSpan={3}>{g}</td>
                        </tr>
                        {rows.map((s) => (
                          <tr key={s.name} title={s.doc}>
                            <td>
                              <SensorName name={s.name} />
                            </td>
                            <td className="num r">{sensorValueText(s.value, s.unit)}</td>
                            <td className="faint r">
                              {s.unit}, {s.range}
                            </td>
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </section>
          ) : null}
        </div>

        <div className="ov-col">
          {d && d.ring.length > 0 ? (
            <section className="ov-card">
              <h3>
                <span>Steering</span>
                <span className="dim">{termFocus !== null && d.terms[termFocus] ? d.terms[termFocus]!.label : 'combined, arrow = heading'}</span>
              </h3>
              <div className="ov-ring">
                <SteeringRing
                  ratings={d.ring}
                  size={232}
                  heading={d.speed > 0.01 ? d.heading : null}
                  facing={f?.facing ?? null}
                  color={fighter.color}
                  overlay={termFocus !== null ? d.terms[termFocus]?.ratings ?? null : null}
                />
              </div>
              <div className="ov-terms">
                {d.terms.map((t, i) => (
                  <button
                    key={`${t.label}:${i}`}
                    type="button"
                    className="ring-term"
                    aria-pressed={termFocus === i}
                    onPointerEnter={() => setTermFocus(i)}
                    onPointerLeave={() => setTermFocus(null)}
                    onFocus={() => setTermFocus(i)}
                    onBlur={() => setTermFocus(null)}
                    title={t.label}
                  >
                    <SteeringRing ratings={t.ratings} size={86} color={fighter.color} label={t.label} />
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {stats ? (
            <section className="ov-card">
              <h3>
                <span>Perception</span>
                <span className="dim">{fighter.alive ? knowsSummary(knows) : ''}</span>
              </h3>
              <dl className="kv">
                {PERCEPTION_STATS.map((k) => (
                  <Kv key={k} k={STAT_DOCS[k].label} v={formatStat(k, stats[k])} codex={`stat:${k}`} />
                ))}
              </dl>
              {f ? (
                <div className="status-row">
                  {statusChips(f).map((c) => (
                    <span key={c.text} className={`chip${c.hot ? ' chip-hot' : ''}`}>
                      {c.text}
                    </span>
                  ))}
                </div>
              ) : null}
              {knows.length ? (
                <div className="know-list" style={{ marginTop: 10 }}>
                  {knows.map((k) => (
                    <div key={k.id} className={`know-row ${k.state}`}>
                      <i className="know-dot" style={{ borderColor: k.color, background: k.state === 'seen' ? k.color : 'transparent' }} />
                      <b style={{ color: k.color }}>{k.name}</b>
                      <span className="know-text">{k.text}</span>
                      <span className="num faint">{k.distance}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {around.length ? (
                <div style={{ marginTop: 10 }}>
                  <InfoList lines={around} />
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="ov-card">
            <h3>
              <span>Its story</span>
              <span className="dim">click to replay</span>
            </h3>
            {log.length === 0 ? <p className="faint">Nothing notable yet. Give it a minute.</p> : null}
            <ol className="ov-log">
              {log.map((l, i) => (
                <li key={`${l.tick}:${i}`} className={l.role}>
                  <button type="button" onClick={() => controller.seek(Math.max(0, l.tick - (l.kind === 'kill' ? KILL_LEAD_IN_TICKS : TICK_HZ / 2)))}>
                    <span className="num faint">{formatClock(l.tick)}</span>
                    <span>{l.text}</span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <div className="ov-col ov-side">
          <div className="ov-pip" ref={pip}>
            <span className="ov-pip-label">
              {fighter.alive ? (
                <>
                  Following <b style={{ color: fighter.color }}>{fighter.name}</b>
                </>
              ) : (
                'The arena'
              )}
            </span>
          </div>

          {f && stats ? (
            <section className="ov-card">
              <h3>
                <span>Build</span>
                <span className="dim">
                  <BuildLinks weapon={f.weapon} skill={f.skill} />
                </span>
              </h3>
              <AttrChart attributes={f.attributes} height={80} codex />
              <dl className="kv two" style={{ marginTop: 12 }}>
                {BUILD_STATS.map((k) => (
                  <Kv key={k} k={STAT_DOCS[k].label} v={formatStat(k, stats[k])} codex={`stat:${k}`} />
                ))}
              </dl>
            </section>
          ) : null}

          <section className="ov-card">
            <h3>
              <span>Damage</span>
              <span className="dim">{mine ? 'by source, whole match' : 'so far'}</span>
            </h3>
            {mine ? (
              <div className="ov-dmg">
                <SourceBars title={`Dealt ${Math.round(mine.damageDealt)}`} by={mine.damageDealtBySource} color={fighter.color} />
                <SourceBars title={`Taken ${Math.round(mine.damageTaken)}`} by={mine.damageTakenBySource} color="var(--blood)" />
              </div>
            ) : f ? (
              <>
                <dl className="kv">
                  <Kv k="Dealt" v={String(Math.round(f.damageDealt))} />
                  <Kv k="Taken" v={String(Math.round(f.damageTaken))} />
                  {f.maxAmmo > 0 ? <Kv k="Ammo" v={`${f.ammo}/${f.maxAmmo}`} /> : null}
                </dl>
                <p className="faint ov-note">The split by source arrives with the battle report when the match ends.</p>
              </>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}

function SourceBars({ title, by, color }: { title: string; by: Partial<Record<DamageSource, number>>; color: string }) {
  const rows = (Object.entries(by) as [DamageSource, number][]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const top = Math.max(1, ...rows.map(([, n]) => n));
  return (
    <div>
      <div className="ov-sub">{title}</div>
      {rows.length === 0 ? <span className="faint">none</span> : null}
      <div className="barlist">
        {rows.map(([src, n]) => (
          <div key={src} className="barrow">
            <span>{SOURCE_LABEL[src]}</span>
            <span className="minibar">
              <div style={{ width: `${(n / top) * 100}%`, background: color }} />
            </span>
            <span className="num">{Math.round(n)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BehaviourUsage({ ticks, neverWon, color }: { ticks: Record<string, number>; neverWon: string[]; color: string }) {
  const rows = Object.entries(ticks).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((n, [, t]) => n + t, 0);
  return (
    <>
      <div className="barlist">
        {rows.map(([name, t]) => (
          <div key={name} className="barrow" title={`${name}: ${(t / TICK_HZ).toFixed(1)} s`}>
            <span>{name}</span>
            <span className="minibar">
              <div style={{ width: `${total > 0 ? (t / total) * 100 : 0}%`, background: color }} />
            </span>
            <span className="num">{total > 0 ? formatPercent(t / total) : '-'}</span>
          </div>
        ))}
      </div>
      {neverWon.length ? (
        <p className="side-note">
          Never won a think: {neverWon.map((n) => <code key={n}>{n}</code>)}. Usually a scoring bug.
        </p>
      ) : null}
    </>
  );
}

/** After the match: its numbers, where it spent its time, its kills and how it went out. */
function MatchSection({ report, fighterId, color, controller }: { report: MatchReport; fighterId: string; color: string; controller: GameController }) {
  const mine = report.fighters.find((x) => x.fighterId === fighterId)!;
  const roster = new Map(report.roster.map((r) => [r.fighterId, r]));
  const nameOf = (id: string) => roster.get(id)?.name ?? 'someone';
  const kills = report.kills.filter((k) => k.killerId === fighterId && k.victimId !== fighterId);
  return (
    <section className="ov-card ov-match">
      <h3>
        <span>The match, by the numbers</span>
        <span className="dim">
          {formatPlace(mine.place)} of {report.placements.length}
          {mine.diedAtTick !== null ? `, out at ${formatClock(mine.diedAtTick)}${mine.death?.title ? ` (${mine.death.title})` : ''}: ${howOut(fighterId, report.kills, nameOf)}` : ', survived'}
        </span>
      </h3>
      <div className="ov-match-grid">
        <div>
          <div className="ov-sub">Behaviours, share of its time alive</div>
          <BehaviourUsage ticks={mine.behaviourTicks} neverWon={mine.neverWon} color={color} />
          <div className="ov-sub" style={{ marginTop: 14 }}>
            Exposure
          </div>
          <dl className="kv">
            <Kv k="Alive" v={`${(mine.exposure.ticksAlive / TICK_HZ).toFixed(1)} s`} />
            <Kv k="Seen by an enemy" v={formatPercent(mine.exposure.ticksAlive ? mine.exposure.ticksSeen / mine.exposure.ticksAlive : 0)} />
            <Kv k="In shadow" v={formatPercent(mine.exposure.ticksAlive ? mine.exposure.ticksInShadow / mine.exposure.ticksAlive : 0)} />
            <Kv k="Attacks landed" v={`${mine.hitsLanded} of ${mine.attacks}`} />
            <Kv k="Skill uses" v={String(mine.skillUses)} />
            <Kv k="Parries" v={String(mine.parries)} />
          </dl>
        </div>
        <div>
          <div className="ov-sub">Movement and fighting</div>
          <dl className="stat-grid compact">
            {statLines(mine.stats).map((l) => (
              <div key={l.label} title={l.hint}>
                <dt>{l.label}</dt>
                <dd className="num">{l.value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <Heatmap heatmap={mine.heatmap} mapId={report.mapId} width={260} title="Where it spent its time" />
          <div className="ov-sub" style={{ marginTop: 12 }}>
            Kills
          </div>
          {kills.length === 0 ? <p className="faint">None.</p> : null}
          <ol className="kill-list">
            {kills.map((k, i) => {
              const v = roster.get(k.victimId);
              return (
                <li key={i}>
                  <span className="num faint">{formatClock(k.tick)}</span>
                  <span>
                    <b style={{ color: v?.color }}>{v?.name ?? k.victimId}</b>
                    {k.flags.length ? <span className="faint"> ({k.flags.join(', ')})</span> : null}
                  </span>
                  <button type="button" className="btn btn-sm btn-quiet" onClick={() => controller.seek(leadInTick(k.tick))}>
                    Replay
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}

/** The strategy itself, read-only: a visual summary (build, behaviours, terms, policies) or its JSON. */
function StrategyView({ strategy, color }: { strategy: Strategy; color: string }) {
  const [mode, setMode] = useState<'visual' | 'json'>('visual');
  const json = useMemo(() => prettyJson(strategy), [strategy]);
  const imports = strategy.imports ?? [];
  return (
    <div className="strat">
      <div className="strat-bar">
        <div className="seg" role="group" aria-label="Strategy view">
          <button type="button" aria-pressed={mode === 'visual'} onClick={() => setMode('visual')}>
            Visual
          </button>
          <button type="button" aria-pressed={mode === 'json'} onClick={() => setMode('json')}>
            JSON
          </button>
        </div>
        {mode === 'json' ? (
          <button type="button" className="btn btn-sm btn-quiet" onClick={() => void copyAndToast(json, 'Strategy JSON')}>
            <CopyIcon size={13} /> Copy JSON
          </button>
        ) : null}
        <span className="faint">Visible to everyone for now, for learning and debugging.</span>
      </div>
      {mode === 'json' ? (
        <pre className="strat-json">{json}</pre>
      ) : (
        <div className="strat-visual">
          <section className="ov-card strat-build">
            <h3>
              <span>Build</span>
              <span className="dim">
                <BuildLinks weapon={strategy.build.weapon} skill={strategy.build.skill} />
              </span>
            </h3>
            <AttrChart attributes={strategy.build.attributes} height={80} codex />
            <dl className="kv stack" style={{ marginTop: 12 }}>
              <Kv k="Target, highest wins" v={strategy.target} />
              <Kv k="Commit" v={`${strategy.commit} ticks (${(strategy.commit / TICK_HZ).toFixed(2)} s)`} />
              {imports.length ? <Kv k="Imports" v={imports.join(', ')} /> : null}
              {strategy.memory && Object.keys(strategy.memory).length ? (
                <Kv k="Memory" v={Object.entries(strategy.memory).map(([k, v]) => `${k} = ${v}`).join(', ')} />
              ) : null}
              {strategy.author ? <Kv k="Author" v={strategy.author} /> : null}
            </dl>
          </section>
          {Object.entries(strategy.behaviours).map(([name, b]) => {
            const top = Math.max(0.001, ...b.move.map((t) => Math.abs(t.weight)));
            return (
              <section key={name} className="ov-card strat-beh">
                <h3>
                  <span>{name}</span>
                  {b.stance && b.stance !== 'normal' ? <span className="chip">{b.stance}</span> : null}
                </h3>
                <div className="strat-row">
                  <span className="faint">Score</span>
                  <code>{b.score}</code>
                </div>
                <div className="strat-terms">
                  {b.move.map((t, i) => (
                    <div key={i} className="strat-term">
                      <code>{termLabel(t).replace(/ x[-\d.]+$/, '')}</code>
                      <span className="minibar">
                        <div style={{ width: `${(Math.abs(t.weight) / top) * 100}%`, background: t.weight < 0 ? 'var(--blood)' : color }} />
                      </span>
                      <span className="num faint">x{t.weight}</span>
                    </div>
                  ))}
                </div>
                <div className="strat-row">
                  <span className="faint">Attack</span>
                  <code>{b.attack}</code>
                </div>
                {b.skill ? (
                  <div className="strat-row">
                    <span className="faint">Skill</span>
                    <code>{b.skill}</code>
                  </div>
                ) : null}
                {b.set && Object.keys(b.set).length ? (
                  <div className="strat-row">
                    <span className="faint">Remembers</span>
                    <code>
                      {Object.entries(b.set)
                        .map(([k, v]) => `${k} = ${v}`)
                        .join('; ')}
                    </code>
                  </div>
                ) : null}
              </section>
            );
          })}
          {strategy.barks && Object.keys(strategy.barks).length ? (
            <section className="ov-card">
              <h3>
                <span>Barks</span>
              </h3>
              <dl className="kv stack">
                {Object.entries(strategy.barks).map(([k, v]) => (
                  <Kv key={k} k={k} v={Array.isArray(v) ? v.join(' / ') : String(v)} />
                ))}
              </dl>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** A sensor's name, opening its Codex card when it has one (memory slots are the strategy's own words). */
function SensorName({ name }: { name: string }) {
  const id = sensorCodexId(name);
  return id ? (
    <a className="word-link" href={codexHash(id)} title="Open in the Codex">
      <code>{name}</code>
    </a>
  ) : (
    <code>{name}</code>
  );
}
