// Owned by: ui
import { useState } from 'react';
import { TICK_HZ, deriveStats } from '../../core';
import type { GameController, UiFighter, UiSnapshot } from '../../core';
import { buildLine, formatPercent, formatPlace, formatValue } from '../format';
import { usePolled } from '../hooks';
import { scoreBars } from '../hud';
import { CloseIcon, FollowIcon } from '../icons';
import { AttrBars, HpBar } from '../widgets';
import { SteeringRing } from './SteeringRing';
import { readLive, statusChips } from './fighterData';

type Props = { controller: GameController; snap: UiSnapshot; fighter: UiFighter };

/** Pinned panel for the selected fighter: what it thinks, where it wants to go, what it has done. */
export function Inspector({ controller, snap, fighter }: Props) {
  const id = fighter.id;
  const { f, d } = usePolled(controller, () => readLive(controller, id), [id]);
  const [termFocus, setTermFocus] = useState<number | null>(null);
  const following = snap.followId === id;
  const target = d?.targetId ? snap.fighters.find((x) => x.id === d.targetId) ?? null : null;
  const stats = f ? deriveStats(f.attributes, f.weapon) : null;
  const seconds = (ticks: number) => (ticks <= 0 ? 'ready' : `${(ticks / TICK_HZ).toFixed(1)} s`);

  return (
    <aside className="hud-panel inspector" aria-label={`Inspector: ${fighter.name}`}>
      <div className="ins-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="hc-name" style={{ color: fighter.color }}>
            {fighter.name}
          </div>
          <div className="hc-build">{buildLine(fighter.weapon, fighter.skill)}</div>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-icon btn-quiet"
          aria-pressed={following}
          onClick={() => controller.follow(following ? null : id)}
          title={following ? 'Stop following (F)' : 'Follow with the camera (F)'}
          style={following ? { color: 'var(--text)', background: 'var(--stone-3)' } : undefined}
        >
          <FollowIcon />
        </button>
        <button type="button" className="btn btn-sm btn-icon btn-quiet" onClick={() => controller.select(null)} title="Close (Esc)">
          <CloseIcon />
        </button>
      </div>

      <div className="ins-body">
        <div className="ins-section">
          {fighter.alive ? (
            <div className="hc-hp" style={{ marginTop: 0 }}>
              <HpBar hp={fighter.hp} maxHp={fighter.maxHp} color={fighter.color} />
              <span className="num">
                {Math.ceil(fighter.hp)}
                <span className="faint">/{fighter.maxHp}</span>
              </span>
            </div>
          ) : (
            <div className="dim">Out in {fighter.place ? formatPlace(fighter.place) : '?'} place.</div>
          )}
          {f ? (
            <div className="status-row">
              {statusChips(f).map((c) => (
                <span key={c.text} className={`chip${c.hot ? ' chip-hot' : ''}`}>
                  {c.text}
                </span>
              ))}
            </div>
          ) : null}
          {fighter.alive && d ? (
            <div className="hc-row">
              <span className="dim">Target</span>
              {target ? (
                <span>
                  <b style={{ color: target.color, fontWeight: 600 }}>{target.name}</b>
                  {d.sensors['target.distance'] !== undefined ? (
                    <span className="num faint"> {Math.round(d.sensors['target.distance'])} px</span>
                  ) : null}
                </span>
              ) : (
                <span className="faint">nobody yet</span>
              )}
            </div>
          ) : null}
        </div>

        {d ? (
          <div className="ins-section">
            <div className="ins-title">
              <span>Behaviours</span>
              <span className="dim">running {d.behaviour}</span>
            </div>
            {scoreBars(d.scores, d.behaviour).map((b) => (
              <div key={b.name} className={`bh-row${b.active ? ' active' : ''}`}>
                <span className="bh-name" title={b.name}>
                  {b.name}
                </span>
                <span className="bh-bar">
                  <div style={{ width: `${b.fraction * 100}%` }} />
                </span>
                <span className="bh-val">{formatValue(b.score)}</span>
              </div>
            ))}
            <div className="status-row">
              {d.attack ? <span className="chip chip-hot">Attacking</span> : null}
              {d.useSkill ? <span className="chip chip-hot">Using skill</span> : null}
              {d.parry ? <span className="chip">Will parry</span> : <span className="chip">No parry</span>}
              <span className="chip">Throttle {formatPercent(d.speed)}</span>
            </div>
          </div>
        ) : (
          <div className="ins-section dim">{fighter.alive ? 'Waiting for the first think.' : 'No more thinking for this one.'}</div>
        )}

        {d && d.ring.length > 0 ? (
          <div className="ins-section">
            <div className="ins-title">
              <span>Steering</span>
              <span className="dim">{termFocus !== null && d.terms[termFocus] ? d.terms[termFocus].label : 'final ring'}</span>
            </div>
            <div className="ring-wrap">
              <SteeringRing
                ratings={d.ring}
                size={132}
                heading={d.speed > 0.01 ? d.heading : null}
                facing={f?.facing ?? null}
                color={fighter.color}
                overlay={termFocus !== null ? d.terms[termFocus]?.ratings ?? null : null}
              />
              <div className="ring-terms">
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
                    <SteeringRing ratings={t.ratings} size={52} color={fighter.color} label={t.label} />
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {d && Object.keys(d.sensors).length > 0 ? (
          <div className="ins-section">
            <div className="ins-title">
              <span>Sensors</span>
              <span className="dim">this think</span>
            </div>
            <dl className="kv">
              {Object.entries(d.sensors).map(([k, v]) => (
                <Kv key={k} k={k} v={formatValue(v)} />
              ))}
            </dl>
          </div>
        ) : null}

        {f && stats ? (
          <div className="ins-section">
            <div className="ins-title">
              <span>Fight so far</span>
            </div>
            <dl className="kv">
              <Kv k="Kills" v={String(f.kills)} />
              <Kv k="Damage dealt" v={String(Math.round(f.damageDealt))} />
              <Kv k="Damage taken" v={String(Math.round(f.damageTaken))} />
              {f.maxAmmo > 0 ? <Kv k="Ammo" v={`${f.ammo}/${f.maxAmmo}`} /> : null}
              <Kv k="Next attack" v={seconds(f.attackCd)} />
              <Kv k="Skill" v={seconds(f.skillCd)} />
            </dl>
          </div>
        ) : null}

        {f && stats ? (
          <div className="ins-section">
            <div className="ins-title">
              <span>Build</span>
            </div>
            <AttrBars attributes={f.attributes} />
            <dl className="kv" style={{ marginTop: 10 }}>
              <Kv k="Vision" v={`${Math.round(stats.visionRange)} px`} />
              <Kv k="Hearing" v={`${Math.round(stats.hearingRadius)} px`} />
              <Kv k="Speed" v={`${Math.round(stats.moveSpeed * TICK_HZ)} px/s`} />
              <Kv k="Armor" v={formatPercent(stats.armorMitigation)} />
              <Kv k="Parry chance" v={formatPercent(stats.parryChance)} />
            </dl>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt title={k}>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
