// Owned by: ui
// Small presentational pieces shared by several screens.
import { ATTRIBUTE_DOCS, ATTRIBUTE_KEYS, ATTRIBUTE_MAX } from '../core';
import type { AttributeKey, Attributes } from '../core';
import { hpFraction } from './hud';

export const ATTRIBUTE_SHORT: Record<AttributeKey, string> = {
  vitality: 'Vit',
  power: 'Pow',
  agility: 'Agi',
  perception: 'Per',
  armor: 'Arm',
  haste: 'Hst',
};

export const ATTRIBUTE_LABEL: Record<AttributeKey, string> = {
  vitality: 'Vitality',
  power: 'Power',
  agility: 'Agility',
  perception: 'Perception',
  armor: 'Armor',
  haste: 'Haste',
};

/** Six small vertical bars: the build at a glance. */
export function AttrBars({ attributes }: { attributes: Attributes }) {
  return (
    <div className="attrs">
      {ATTRIBUTE_KEYS.map((k) => (
        <div className="attr" key={k} title={`${ATTRIBUTE_LABEL[k]} ${attributes[k]}. ${ATTRIBUTE_DOCS[k]}`}>
          <div className="attr-bar">
            <div style={{ height: `${(attributes[k] / ATTRIBUTE_MAX) * 100}%` }} />
          </div>
          <span>{ATTRIBUTE_SHORT[k]}</span>
        </div>
      ))}
    </div>
  );
}

export function HpBar({ hp, maxHp, color }: { hp: number; maxHp: number; color: string }) {
  const frac = hpFraction(hp, maxHp);
  return (
    <span className={`hp${frac < 0.25 ? ' low' : ''}`}>
      <div style={{ width: `${frac * 100}%`, background: color }} />
    </span>
  );
}
