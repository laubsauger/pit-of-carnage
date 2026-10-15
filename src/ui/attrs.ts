// Owned by: ui
// Attribute colours and the distribution chart model. One fixed, muted hue per attribute, used
// everywhere attributes appear (inspector, hover card, overview, reports, editor budget meter), so
// a build reads at a glance. Muted on purpose: fighter colours must still dominate the arena.
import { ATTRIBUTE_KEYS, ATTRIBUTE_MAX } from '../core';
import type { AttributeKey, Attributes } from '../core';

export const ATTRIBUTE_COLORS: Readonly<Record<AttributeKey, string>> = {
  vitality: '#b85c55',
  power: '#c47a42',
  agility: '#6e9e5f',
  perception: '#4e9ba6',
  armor: '#8090a0',
  haste: '#c8a347',
};

export type AttrBar = { key: AttributeKey; value: number; color: string; /** 0..1 of ATTRIBUTE_MAX. */ height: number };

/**
 * Bars for the attribute chart. Heights are against the 40-point maximum, never the build's own
 * maximum: two builds side by side must differ visibly when their points differ.
 */
export function attrBars(a: Attributes): AttrBar[] {
  return ATTRIBUTE_KEYS.map((key) => {
    const value = a[key];
    const height = Number.isFinite(value) ? Math.min(1, Math.max(0, value / ATTRIBUTE_MAX)) : 0;
    return { key, value, color: ATTRIBUTE_COLORS[key], height };
  });
}
