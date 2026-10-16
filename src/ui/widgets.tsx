// Owned by: ui
// Small presentational pieces shared by several screens.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ATTRIBUTE_DOCS, ATTRIBUTE_KEYS, ATTRIBUTE_MAX } from '../core';
import type { AttributeKey, Attributes, Rating, SkillId, WeaponId } from '../core';
import { ATTRIBUTE_COLORS, attrBars } from './attrs';
import { readInt } from './batch';
import { codexHash } from './codexLink';
import { skillName, weaponName } from './format';
import { hpFraction } from './hud';
import { ChevronIcon } from './icons';
import { PANES, dragPaneWidth } from './panes';
import type { PaneId, PaneState } from './panes';
import { ratingView } from './reports';

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

/**
 * The build's distribution: six bars in the attributes' own colours, measured against the 40-point
 * maximum (dashed line at the top), so two builds side by side differ at a glance. Each bar keeps
 * its name and number, readable without colour; hovering shows what the attribute does.
 */
export function AttrChart({ attributes, height = 68, compact = false, codex = false }: { attributes: Attributes; height?: number; compact?: boolean; codex?: boolean }) {
  return (
    <div className={`attr-chart${compact ? ' compact' : ''}`} role={codex ? undefined : 'img'} aria-label={ATTRIBUTE_KEYS.map((k) => `${ATTRIBUTE_LABEL[k]} ${attributes[k]}`).join(', ')}>
      {attrBars(attributes).map((b) => {
        const body = (
          <>
            <span className="ac-val num">{b.value}</span>
            <div className="ac-track" style={{ height }}>
              <div className="ac-fill" style={{ height: `${b.height * 100}%`, background: b.color }} />
            </div>
            <span className="ac-key" style={{ color: b.color }}>
              {ATTRIBUTE_SHORT[b.key]}
            </span>
          </>
        );
        const title = `${ATTRIBUTE_LABEL[b.key]} ${b.value} of ${ATTRIBUTE_MAX}. ${ATTRIBUTE_DOCS[b.key]}`;
        // Where the chart can be clicked (not in a card that follows the pointer), each bar opens its Codex entry.
        return codex ? (
          <a className="ac-col ac-link" key={b.key} href={codexHash(`attribute:${b.key}`)} title={`${title} Click for the Codex entry.`}>
            {body}
          </a>
        ) : (
          <div className="ac-col" key={b.key} title={title}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

/** "Greatsword, Whirlwind" with each word opening its Codex entry (cards that stay put). */
export function BuildLinks({ weapon, skill }: { weapon: WeaponId; skill: SkillId }) {
  return (
    <>
      <a className="word-link" href={codexHash(`weapon:${weapon}`)} title="Open the weapon in the Codex">
        {weaponName(weapon)}
      </a>
      ,{' '}
      <a className="word-link" href={codexHash(`skill:${skill}`)} title="Open the skill in the Codex">
        {skillName(skill)}
      </a>
    </>
  );
}

/**
 * A small "Codex" link to one entry (`kind:word`), for inspector rows, sheets and cards that stay
 * put. Opens the Codex over the current screen; Esc comes back.
 */
export function CodexLink({ id, label = 'Codex', title }: { id: string; label?: string; title?: string }) {
  return (
    <a className="codex-link" href={codexHash(id)} title={title ?? 'Open this in the Codex'}>
      {label}
    </a>
  );
}

/**
 * A word with a proper hover card (not the easy-to-miss native title): shown on hover and on keyboard
 * focus, so every symbol in the UI can explain itself.
 */
export function Tip({ card, children, className = '' }: { card: string; children: ReactNode; className?: string }) {
  return (
    <span className={`hovertip ${className}`} tabIndex={0}>
      {children}
      <span className="hovertip-card" role="tooltip">
        {card}
      </span>
    </span>
  );
}

/**
 * A rating as every table shows it (SPEC "Showing a rating"): a fixed slot for the "new" mark (with a
 * hover card explaining provisional ratings), the number in tabular figures, then the muted ±. Right-
 * align the cell; the digits line up from row to row.
 */
export function RatingCell({ rating, matches }: { rating: Rating; matches?: number }) {
  const v = ratingView(rating, matches);
  return (
    <span className="rating" aria-label={v.label}>
      <span className="rating-slot">
        {v.provisional ? (
          <Tip card={v.card} className="rating-new">
            new
          </Tip>
        ) : null}
      </span>
      <span className="rating-value num">{v.value}</span>
      <span className="rating-pm num">{v.plusMinus}</span>
    </span>
  );
}

/** Small swatch in an attribute's colour, for legends and inline labels. */
export function AttrDot({ attr }: { attr: AttributeKey }) {
  return <i className="attr-dot" style={{ background: ATTRIBUTE_COLORS[attr] }} aria-hidden />;
}

export function HpBar({ hp, maxHp, color }: { hp: number; maxHp: number; color: string }) {
  const frac = hpFraction(hp, maxHp);
  return (
    <span className={`hp${frac < 0.25 ? ' low' : ''}`}>
      <div style={{ width: `${frac * 100}%`, background: color }} />
    </span>
  );
}

/**
 * Drag handle on a side pane's inner edge: drag to resize (clamped to the pane's range), double-click
 * to reset, arrow keys for 16 px steps. Lives inside the pane, absolutely placed on its edge.
 */
export function PaneHandle({ id, setPane, label }: { id: PaneId; setPane: (fn: (p: PaneState) => PaneState) => void; label: string }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [width, setWidthShown] = useState<number | null>(null);
  const spec = PANES[id];
  return (
    <div
      className={`pane-handle ${spec.side}${width !== null ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      tabIndex={0}
      title={`Drag to resize ${label.toLowerCase()}, double-click to reset`}
      // Pointer events alone do not stop the browser from starting a text selection.
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const w = e.currentTarget.parentElement?.getBoundingClientRect().width ?? spec.initial;
        drag.current = { x: e.clientX, w };
        setWidthShown(Math.round(w));
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const next = dragPaneWidth(id, d.w, d.x, e.clientX);
        setWidthShown(next);
        setPane((p) => (p.width === next && !p.collapsed ? p : { width: next, collapsed: false }));
      }}
      onPointerUp={() => {
        drag.current = null;
        setWidthShown(null);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setWidthShown(null);
      }}
      onDoubleClick={() => setPane((p) => ({ ...p, width: spec.initial }))}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowRight' ? 16 : e.key === 'ArrowLeft' ? -16 : 0;
        if (!step) return;
        e.preventDefault();
        e.stopPropagation();
        // The handle moves with the arrow, like dragging it: a left pane widens, a right pane narrows.
        setPane((p) => ({ ...p, width: dragPaneWidth(id, p.width, 0, step) }));
      }}
    >
      {width !== null ? <span className="pane-width num">{width}</span> : null}
    </div>
  );
}

/** Collapse a side pane to a thin rail, or bring it back. */
export function PaneToggle({ side, collapsed, onToggle, label }: { side: 'left' | 'right'; collapsed: boolean; onToggle: () => void; label: string }) {
  // A left pane collapses toward the left edge; its chevron points where the pane will go.
  const dir = (side === 'left') !== collapsed ? 'left' : 'right';
  return (
    <button
      type="button"
      className="btn btn-sm btn-icon btn-quiet pane-toggle"
      onClick={onToggle}
      aria-expanded={!collapsed}
      title={collapsed ? `Show ${label.toLowerCase()}` : `Collapse ${label.toLowerCase()}`}
      aria-label={collapsed ? `Show ${label.toLowerCase()}` : `Collapse ${label.toLowerCase()}`}
    >
      <ChevronIcon dir={dir} size={13} />
    </button>
  );
}

