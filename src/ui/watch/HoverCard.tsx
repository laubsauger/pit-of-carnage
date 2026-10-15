// Owned by: ui
import { forwardRef } from 'react';
import type { GameController, UiFighter } from '../../core';
import { buildLine, formatPlace, formatValue } from '../format';
import { usePolled } from '../hooks';
import { AttrBars, HpBar } from '../widgets';

/**
 * Card for the fighter under the pointer. Positioned by the parent through the forwarded ref
 * (moved on pointermove without re-rendering React).
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
      {fighter.alive ? (
        <div className="hc-hp">
          <HpBar hp={fighter.hp} maxHp={fighter.maxHp} color={fighter.color} />
          <span className="num">
            {Math.ceil(fighter.hp)}
            <span className="faint">/{fighter.maxHp}</span>
          </span>
        </div>
      ) : (
        <div className="hc-row">
          <span className="dim">Out</span>
          <span>{fighter.place ? `${formatPlace(fighter.place)} place` : ''}</span>
        </div>
      )}
      {fighter.alive ? (
        <div className="hc-row">
          <span className="dim">Doing</span>
          <span>
            {fighter.behaviour}
            {live.score !== null && live.score !== undefined ? <span className="num faint"> {formatValue(live.score)}</span> : null}
          </span>
        </div>
      ) : null}
      <div className="hc-row">
        <span className="dim">Kills</span>
        <span className="num">{fighter.kills}</span>
      </div>
      {live.attributes ? <AttrBars attributes={live.attributes} /> : null}
    </div>
  );
});
