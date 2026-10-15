import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_KEYS, ATTRIBUTE_MAX, FIGHTER_COLORS } from '../core';
import { ATTRIBUTE_COLORS, attrBars } from './attrs';
import css from './theme.css?raw';

/** Saturation (HSL, 0..1) of a #rrggbb colour. */
function saturation(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return 0;
  return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
}

describe('ATTRIBUTE_COLORS', () => {
  it('gives each attribute its own hue, so a build is readable at a glance', () => {
    const colors = ATTRIBUTE_KEYS.map((k) => ATTRIBUTE_COLORS[k]);
    expect(new Set(colors).size).toBe(ATTRIBUTE_KEYS.length);
  });

  it('stays muted next to the fighter colours, which must dominate the arena', () => {
    const fighterSat = Math.min(...FIGHTER_COLORS.map(saturation));
    for (const k of ATTRIBUTE_KEYS) {
      expect(FIGHTER_COLORS).not.toContain(ATTRIBUTE_COLORS[k]);
      expect(saturation(ATTRIBUTE_COLORS[k]), k).toBeLessThan(Math.max(0.6, fighterSat));
    }
  });
});

describe('attrBars', () => {
  it('measures against the 40-point maximum, not the build\'s own top value', () => {
    // A modest build must not draw a full-height bar just because 20 is its highest attribute.
    const bars = attrBars({ vitality: 20, power: 10, agility: 10, perception: 10, armor: 10, haste: 10 });
    expect(bars[0]).toMatchObject({ key: 'vitality', value: 20, height: 20 / ATTRIBUTE_MAX });
    expect(bars.map((b) => b.key)).toEqual(ATTRIBUTE_KEYS);
  });

  it('clamps nonsense values instead of drawing outside the chart', () => {
    const bars = attrBars({ vitality: 90, power: -3, agility: Number.NaN, perception: 4, armor: 4, haste: 4 });
    expect(bars.map((b) => b.height).slice(0, 3)).toEqual([1, 0, 0]);
  });
});

// The editor (CodeMirror badges, budget meter) reads --attr-* from theme.css; the inspector, cards and
// reports read ATTRIBUTE_COLORS. Both must show the same hue, or an attribute changes colour between screens.
describe('attribute colour tokens', () => {
  it('theme.css defines --attr-<name> with exactly the ATTRIBUTE_COLORS values', () => {
    for (const key of ATTRIBUTE_KEYS) {
      const m = css.match(new RegExp(`--attr-${key}:\\s*(#[0-9a-fA-F]{6})`));
      expect(m?.[1]?.toLowerCase(), key).toBe(ATTRIBUTE_COLORS[key].toLowerCase());
    }
  });
});
