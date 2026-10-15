// Owned by: ui
// Small presentational pieces shared by several screens.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ATTRIBUTE_DOCS, ATTRIBUTE_KEYS, ATTRIBUTE_MAX } from '../core';
import type { AttributeKey, Attributes } from '../core';
import { readInt } from './batch';
import { hpFraction } from './hud';

/**
 * Whole-number field. Keeps its own text so it can be cleared and retyped; the parent only ever
 * sees clamped numbers, and leaving the field shows the number that was actually taken.
 */
export function NumberField(props: { label: string; value: number; min: number; max: number; onChange: (n: number) => void; width?: number; after?: ReactNode }) {
  const { label, value, min, max, onChange, width = 90, after } = props;
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="field">
      <span>{label}</span>
      <span className="inline">
        <input
          className="input num"
          inputMode="numeric"
          style={{ width }}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const n = readInt(e.target.value, min, max, Number.NaN);
            if (!Number.isNaN(n) && n !== value) onChange(n);
          }}
          onBlur={() => setText(String(value))}
        />
        {after}
      </span>
    </label>
  );
}

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
