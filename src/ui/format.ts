// Owned by: ui
// Pure display formatting. No React, no DOM, so it is unit-tested directly.
import { SKILLS, TICK_HZ, WEAPONS } from '../core';
import type { SkillId, WeaponId } from '../core';

/** Match clock: whole seconds as m:ss. Ticks before 0 read as 0:00. */
export function formatClock(ticks: number): string {
  const total = Math.max(0, Math.floor(ticks / TICK_HZ));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/** Clock with tenths, for the scrubber tooltip where single steps matter. */
export function formatClockTenths(ticks: number): string {
  const t = Math.max(0, ticks);
  const tenths = Math.floor(((t % TICK_HZ) / TICK_HZ) * 10);
  return `${formatClock(t)}.${tenths}`;
}

/** 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th ... 21st. */
export function formatPlace(place: number): string {
  const n = Math.round(place);
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Fraction 0..1 as a percentage string. */
export function formatPercent(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return '–';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/**
 * Behaviour scores and sensor values come from player-written expressions, so they can be tiny
 * fractions or four-digit numbers. Keep about three significant figures without exponent noise.
 */
export function formatValue(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000) return Math.round(v).toString();
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (Number.isInteger(v)) return v.toString();
  return v.toFixed(2);
}

/** Roman numerals for de-duplicated fighter names ("Apologetic Gary II"). Supports 1..3999. */
export function roman(n: number): string {
  const table: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let rest = Math.max(1, Math.min(3999, Math.floor(n)));
  let out = '';
  for (const [value, glyph] of table) {
    while (rest >= value) {
      out += glyph;
      rest -= value;
    }
  }
  return out;
}

/** "just now", "4 min ago", "3 h ago", "2 days ago". `now` is passed in so tests stay fixed. */
export function formatAgo(thenMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

export function weaponName(id: WeaponId): string {
  return WEAPONS[id]?.name ?? id;
}

export function skillName(id: SkillId): string {
  return SKILLS[id]?.name ?? id;
}

/** "Greatsword, Whirlwind" — the one-line build used on cards. */
export function buildLine(weapon: WeaponId, skill: SkillId): string {
  return `${weaponName(weapon)}, ${skillName(skill)}`;
}

/** Squad letter for squads mode: 0 -> A, 1 -> B ... */
export function squadLetter(squad: number): string {
  return String.fromCharCode(65 + (Math.max(0, squad) % 26));
}

/** Strategy identity as shown to players: "Lurking Daggers v3". */
export function strategyLabel(name: string, version: number | undefined): string {
  return `${name} v${version ?? 1}`;
}

/** Parse a `name@vN` strategy key back into a label; unknown shapes pass through unchanged. */
export function keyLabel(key: string): string {
  const m = /^(.*)@v(\d+)$/.exec(key);
  return m ? `${m[1]} v${m[2]}` : key;
}
