// Owned by: ui
import { forwardRef } from 'react';
import type { GameController, MapObjectKind, ObjectInfo, UiFighter } from '../../core';
import { buildLine, formatValue } from '../format';
import { usePolled } from '../hooks';
import { AttrChart, HpBar } from '../widgets';

/**
 * Card for the living fighter under the pointer (a corpse shows nothing; dead fighters stay
 * inspectable from the scoreboard, the feed and the end card). Positioned by the parent through
 * the forwarded ref (moved on pointermove without re-rendering React).
 */
export const HoverCard = forwardRef<HTMLDivElement, { controller: GameController; fighter: UiFighter }>(function HoverCard(
  { controller, fighter },
  ref,
) {
  const id = fighter.id;
  const live = usePolled(
    controller,
    () => {
      const d = controller.decision(id);
      const f = controller.fighter(id);
      return {
        score: d ? d.scores[d.behaviour] : null,
        attributes: f ? { ...f.attributes } : null,
      };
    },
    [id],
  );
  return (
    <div className="hud-panel hovercard" ref={ref} role="tooltip">
      <div className="hc-name" style={{ color: fighter.color }}>
        {fighter.name}
      </div>
      <div className="hc-build">{buildLine(fighter.weapon, fighter.skill)}</div>
      <div className="hc-hp">
        <HpBar hp={fighter.hp} maxHp={fighter.maxHp} color={fighter.color} />
        <span className="num">
          {Math.ceil(fighter.hp)}
          <span className="faint">/{fighter.maxHp}</span>
        </span>
      </div>
      <div className="hc-row">
        <span className="dim">Doing</span>
        <span>
          {fighter.behaviour}
          {live.score !== null && live.score !== undefined ? <span className="num faint"> {formatValue(live.score)}</span> : null}
        </span>
      </div>
      <div className="hc-row">
        <span className="dim">Kills</span>
        <span className="num">{fighter.kills}</span>
      </div>
      {live.attributes ? <AttrChart attributes={live.attributes} height={34} compact /> : null}
      <div className="hc-foot faint">Click to inspect, I for the full view</div>
    </div>
  );
});

const KIND_LABEL: Record<MapObjectKind, string> = { shrine: 'Shrine', pickup: 'Power-up', hazard: 'Hazard', prop: 'Prop' };

/**
 * Card for the map object under the pointer: what it is, what it does with the real numbers, and
 * its live state ("Recharging, 3.2 s"). Polled while open; it disappears when the object does
 * (a broken keg, dried acid).
 */
export const ObjectCard = forwardRef<HTMLDivElement, { controller: GameController; kind: MapObjectKind; id: string; codex: boolean }>(function ObjectCard({ controller, kind, id, codex }, ref) {
  const info = usePolled<ObjectInfo | null>(
    controller,
    () => {
      const i = controller.objectInfo(kind, id);
      return i ? { ...i } : null;
    },
    [kind, id],
  );
  if (!info) return null;
  return (
    <div className={`hud-panel hovercard objcard kind-${info.kind}`} ref={ref} role="tooltip">
      <div className="oc-kind">{KIND_LABEL[info.kind]}</div>
      <div className="hc-name">{info.name}</div>
      <p className="oc-desc">{info.description}</p>
      {info.state ? (
        <div className={`oc-state${/^ready|^up\b/i.test(info.state) ? ' ready' : ''}`}>
          <i />
          {info.state}
        </div>
      ) : null}
      {/* The card follows the pointer, so it cannot hold a link: a click on the object opens the entry. */}
      {codex ? <div className="hc-foot faint">Click it for the Codex entry</div> : null}
    </div>
  );
});
