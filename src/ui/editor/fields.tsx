// Owned by: ui
// Controls the visual builder is made of: hover cards, scrubbable numbers, expression fields that
// show recognised words as chips and let every number be dragged, place and zone pickers, and a
// field frame that shows the gate's issue for its path.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ValidationIssue } from '../../core';
import { ENEMIES_WORD, FIGHTER_REFS, PICKUP_ARG_WORDS, PLACES, ZONES } from '../../brain';
import { SEVERITY_SVG, suggestionLine } from './issues';
import { argsOf, defaultCall, parseCall, printCall, replaceToken, scrubbed } from './exprtext';
import type { Call, CallArg } from './exprtext';
import { lexExpr, wordKind } from './language';
import type { Slot } from './language';
import { entryById, entryForWord, fieldEntry } from './lexicon';
import type { Entry } from './lexicon';
import { WordCard } from './WordCard';
import type { CardBuild } from './WordCard';

// ---------------------------------------------------------------------------------------------
// Card context and hover cards
// ---------------------------------------------------------------------------------------------

export type BuilderCtx = {
  build: CardBuild;
  memory: ReadonlySet<string>;
  open: (id: string) => void;
  editable: boolean;
  issues: readonly ValidationIssue[];
};

export const Ctx = createContext<BuilderCtx>({ build: null, memory: new Set(), open: () => {}, editable: true, issues: [] });

const SHOW_MS = 380;
const HIDE_MS = 160;

/** Wraps a word, label or tile; hovering it a moment shows the entry's card next to it. */
export function Hover({ entry, children, className, as: Tag = 'span', kind }: { entry: Entry | null; children: ReactNode; className?: string; as?: 'span' | 'div' | 'label'; kind?: string }) {
  const ctx = useContext(Ctx);
  const ref = useRef<HTMLElement>(null);
  const [at, setAt] = useState<DOMRect | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!entry) return <Tag className={className} data-kind={kind}>{children}</Tag>;
  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => ref.current && setAt(ref.current.getBoundingClientRect()), SHOW_MS);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAt(null), HIDE_MS);
  };
  return (
    <Tag ref={ref as never} className={className} data-kind={kind} data-attr={entry.attribute} onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {at
        ? createPortal(
            <Popover anchor={at} onEnter={() => window.clearTimeout(timer.current)} onLeave={hide}>
              <WordCard entry={entry} build={ctx.build} onOpen={(id) => {
                setAt(null);
                ctx.open(id);
              }} />
            </Popover>,
            document.body,
          )
        : null}
    </Tag>
  );
}

/** A floating panel next to `anchor`: below it when there is room, else above; kept on screen. */
function Popover({ anchor, children, onEnter, onLeave }: { anchor: DOMRect; children: ReactNode; onEnter: () => void; onLeave: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 6, ready: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const clampTop = (t: number) => Math.max(8, Math.min(t, vh - h - 8));
    const clampLeft = (l: number) => Math.max(8, Math.min(l, vw - w - 8));
    if (anchor.bottom + 6 + h <= vh - 8) setPos({ left: clampLeft(anchor.left), top: anchor.bottom + 6, ready: true });
    else if (anchor.top - 6 - h >= 8) setPos({ left: clampLeft(anchor.left), top: anchor.top - 6 - h, ready: true });
    else {
      // Too tall for above or below: beside the anchor, so it never covers what it explains.
      const right = anchor.right + 8 + w <= vw - 8;
      setPos({ left: right ? anchor.right + 8 : clampLeft(anchor.left - 8 - w), top: clampTop(anchor.top - 40), ready: true });
    }
  }, [anchor]);
  return (
    <div
      ref={ref}
      className="lx-pop"
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {children}
    </div>
  );
}

/** A property label with its card. */
export function Label({ path, children, entry }: { path?: readonly (string | number)[]; entry?: Entry | null; children: ReactNode }) {
  const e = entry !== undefined ? entry : path ? fieldEntry(path) : null;
  return (
    <Hover entry={e} className="sb-label">
      {children}
    </Hover>
  );
}

// ---------------------------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------------------------

/** Issues at exactly `path`, errors first. */
export function issuesAt(issues: readonly ValidationIssue[], path: string): ValidationIssue[] {
  return issues.filter((i) => i.path === path).sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

/** Issues at `path` or anywhere inside it. */
export function issuesUnder(issues: readonly ValidationIssue[], path: string): ValidationIssue[] {
  return issues.filter((i) => i.path === path || i.path.startsWith(`${path}.`) || i.path.startsWith(`${path}[`));
}

export function IssueLine({ issues }: { issues: readonly ValidationIssue[] }) {
  if (!issues.length) return null;
  return (
    <div className="sb-issues">
      {issues.map((i, n) => (
        <div key={n} className={`sb-issue ${i.severity}`}>
          <span className="dx-icon" dangerouslySetInnerHTML={{ __html: SEVERITY_SVG[i.severity] }} />
          <span>
            {i.message}
            {i.suggestion ? <span className="dim"> {suggestionLine(i.suggestion)}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

/** Pixels of drag per step; Shift moves ten steps at a time, Alt a tenth. */
const PX_PER_STEP = 4;

function dragSteps(e: { clientX: number; shiftKey: boolean; altKey: boolean }, startX: number): number {
  const raw = (e.clientX - startX) / PX_PER_STEP;
  const mul = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
  return Math.round(raw * mul);
}

/**
 * A number you drag sideways to change, or click to type. `step` is the unit one drag step moves;
 * the value is kept within [min, max] and rounded to `decimals`.
 */
export function ScrubNumber(props: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number; decimals?: number; suffix?: string; label?: string; disabled?: boolean }) {
  const { value, onChange, min, max, step = 1, decimals = 0, suffix, label, disabled } = props;
  const [typing, setTyping] = useState<string | null>(null);
  const drag = useRef<{ x: number; v: number; moved: boolean } | null>(null);
  const clampRound = (v: number) => Number(Math.min(max, Math.max(min, v)).toFixed(decimals));
  if (typing !== null) {
    const commit = () => {
      const n = Number(typing);
      if (typing.trim() !== '' && Number.isFinite(n)) onChange(clampRound(n));
      setTyping(null);
    };
    return (
      <input
        className="sb-num-input num"
        autoFocus
        value={typing}
        aria-label={label}
        onChange={(e) => setTyping(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setTyping(null);
        }}
        style={{ width: `${Math.max(3, typing.length + 1)}ch` }}
      />
    );
  }
  return (
    <span
      className={`sb-scrub num${disabled ? ' disabled' : ''}`}
      role="spinbutton"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      title={disabled ? undefined : 'Drag sideways to change (Shift: faster, Alt: finer), click to type'}
      onPointerDown={(e: ReactPointerEvent<HTMLSpanElement>) => {
        if (disabled || e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, v: value, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const steps = dragSteps(e, d.x);
        if (steps !== 0) d.moved = true;
        if (d.moved) {
          const next = clampRound(d.v + steps * step);
          if (next !== value) onChange(next);
        }
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved) setTyping(String(value));
      }}
      onKeyDown={(e: ReactKeyboardEvent) => {
        if (disabled) return;
        const k = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
        if (k) {
          e.preventDefault();
          onChange(clampRound(value + k * step * (e.shiftKey ? 10 : 1)));
        } else if (e.key === 'Enter') setTyping(String(value));
      }}
    >
      {value.toFixed(decimals)}
      {suffix ? <span className="sb-suffix">{suffix}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------------------------

/**
 * An expression shown as you would read it: recognised words as chips with their cards, every
 * number draggable. Click anywhere else to edit the text; every keystroke updates the strategy.
 */
export function ExprField(props: { value: string; onChange: (text: string) => void; slot: Slot; invalid?: 'error' | 'warning' | null; placeholder?: string; label?: string }) {
  const { value, onChange, slot, invalid, placeholder, label } = props;
  const ctx = useContext(Ctx);
  const [editing, setEditing] = useState<{ start: string } | null>(null);
  const drag = useRef<{ x: number; src: string; tok: { from: number; to: number; text: string }; moved: boolean } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  });

  if (editing && ctx.editable) {
    return (
      <textarea
        ref={area}
        className={`sb-expr-input${invalid ? ` ${invalid}` : ''}`}
        autoFocus
        rows={1}
        spellCheck={false}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\n/g, ' '))}
        onBlur={() => setEditing(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            setEditing(null);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onChange(editing.start);
            setEditing(null);
          }
        }}
      />
    );
  }

  const toks = lexExpr(value);
  const parts: ReactNode[] = [];
  let at = 0;
  toks.forEach((t, i) => {
    if (t.from > at) parts.push(value.slice(at, t.from));
    at = t.to;
    if (t.kind === 'name') {
      const kind = wordKind(t.text, slot, ctx.memory);
      const entry = kind === 'memory' ? fieldEntry(['memory', t.text]) : entryForWord(t.text, kind ?? undefined);
      parts.push(
        kind ? (
          <Hover key={i} entry={entry} className="lx-chip sb-word" kind={kind}>
            {t.text}
          </Hover>
        ) : (
          <span key={i} className="sb-unknown" title="Not a word the language knows here">
            {t.text}
          </span>
        ),
      );
    } else if (t.kind === 'num') {
      parts.push(
        <span
          key={i}
          className="sb-scrub sb-scrub-inline num"
          title={ctx.editable ? 'Drag sideways to change (Shift: faster, Alt: finer)' : undefined}
          onPointerDown={(e) => {
            if (!ctx.editable || e.button !== 0) return;
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, src: value, tok: t, moved: false };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const steps = dragSteps(e, d.x);
            if (steps !== 0) d.moved = true;
            if (d.moved) onChange(replaceToken(d.src, d.tok, scrubbed(d.tok.text, steps)));
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            drag.current = null;
            if (d && !d.moved) {
              e.stopPropagation();
              setEditing({ start: value });
            }
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {t.text}
        </span>,
      );
    } else parts.push(<span key={i} className={t.kind === 'op' ? 'sb-op' : t.kind === 'bad' ? 'sb-bad' : 'sb-paren'}>{t.text}</span>);
  });
  if (at < value.length) parts.push(value.slice(at));

  return (
    <div
      className={`sb-expr${invalid ? ` ${invalid}` : ''}${ctx.editable ? '' : ' disabled'}`}
      role="textbox"
      tabIndex={ctx.editable ? 0 : -1}
      aria-label={label}
      onClick={() => ctx.editable && setEditing({ start: value })}
      onKeyDown={(e) => {
        if (ctx.editable && (e.key === 'Enter' || e.key === 'F2')) {
          e.preventDefault();
          setEditing({ start: value });
        }
      }}
    >
      {value ? parts : <span className="faint">{placeholder ?? 'Click to write an expression'}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Places and zones
// ---------------------------------------------------------------------------------------------

const FIGHTERS = FIGHTER_REFS.map((r) => r.name);

function nameOptions(zone: boolean): ReactNode {
  if (zone) return ZONES.map((z) => <option key={z.name} value={z.name}>{z.name}</option>);
  return (
    <>
      <optgroup label="Fighters">
        {FIGHTERS.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </optgroup>
      <optgroup label="Points">
        {PLACES.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
          </option>
        ))}
      </optgroup>
    </>
  );
}

function WordSelect({ value, options, onChange, kind, label }: { value: string; options: readonly string[]; onChange: (v: string) => void; kind: Entry['kind']; label: string }) {
  const ctx = useContext(Ctx);
  return (
    <Hover entry={entryForWord(value, kind)} className="sb-pick" as="span">
      <select className="sb-select" data-kind={kind} value={value} disabled={!ctx.editable} aria-label={label} onChange={(e) => onChange(e.target.value)}>
        {options.includes(value) ? null : <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </Hover>
  );
}

function CallEditor({ call, zone, onChange }: { call: Call; zone: boolean; onChange: (c: Call) => void }) {
  const ctx = useContext(Ctx);
  const specs = argsOf(call.name, zone);
  const isFighter = FIGHTERS.includes(call.name);
  const kind: Entry['kind'] = zone ? 'zone' : isFighter ? 'fighter' : 'place';
  const setArg = (i: number, a: CallArg) => onChange({ ...call, args: call.args.map((x, j) => (j === i ? a : x)) });
  return (
    <span className="sb-call">
      <Hover entry={entryForWord(call.name, kind)} className="sb-pick">
        <select
          className="sb-select"
          data-kind={kind}
          value={call.name}
          disabled={!ctx.editable}
          aria-label={zone ? 'Zone' : 'Place'}
          onChange={(e) => onChange(defaultCall(e.target.value, zone, call))}
        >
          {nameOptions(zone)}
        </select>
      </Hover>
      {specs.length ? <span className="sb-paren">(</span> : null}
      {specs.map((spec, i) => {
        const arg = call.args[i];
        const sep = i > 0 ? <span className="sb-paren">, </span> : null;
        if (spec.kind === 'number') {
          const v = arg?.kind === 'num' ? arg.value : 0;
          return (
            <span key={i}>
              {sep}
              <ScrubNumber value={v} min={spec.min ?? -9999} max={spec.max ?? 9999} label={spec.name} disabled={!ctx.editable} onChange={(n) => setArg(i, { kind: 'num', value: n })} />
            </span>
          );
        }
        const name = arg?.kind === 'call' ? arg.call.name : '';
        if (spec.kind === 'place') {
          const sub = arg?.kind === 'call' ? arg.call : defaultCall('target', false);
          return (
            <span key={i}>
              {sep}
              <CallEditor call={sub} zone={false} onChange={(c) => setArg(i, { kind: 'call', call: c })} />
            </span>
          );
        }
        const options = spec.kind === 'pickup' ? PICKUP_ARG_WORDS : spec.kind === 'fighters' ? [...FIGHTERS, ENEMIES_WORD] : FIGHTERS;
        const wk: Entry['kind'] = spec.kind === 'pickup' ? 'pickup-word' : name === ENEMIES_WORD ? 'enemies' : 'fighter';
        return (
          <span key={i}>
            {sep}
            <WordSelect value={name} options={options} kind={wk} label={spec.name} onChange={(v) => setArg(i, { kind: 'call', call: { name: v, args: [] } })} />
          </span>
        );
      })}
      {specs.length ? <span className="sb-paren">)</span> : null}
    </span>
  );
}

/**
 * A place or zone: a picker for the name and one control per argument (fighters, numbers,
 * nested places). Text the pickers cannot show (an unknown name, odd arguments) is edited as text.
 */
export function PlaceField({ value, zone, onChange, invalid }: { value: string; zone: boolean; onChange: (text: string) => void; invalid?: 'error' | 'warning' | null }) {
  const ctx = useContext(Ctx);
  const call = parseCall(value);
  const known = call && (zone ? ZONES.some((z) => z.name === call.name) : FIGHTERS.includes(call.name) || PLACES.some((p) => p.name === call.name));
  if (!call || !known || call.args.length !== argsOf(call.name, zone).length) {
    return (
      <span className="sb-call">
        <input className={`sb-text${invalid ? ` ${invalid}` : ''}`} value={value} disabled={!ctx.editable} spellCheck={false} aria-label={zone ? 'Zone' : 'Place'} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="btn btn-sm btn-quiet" disabled={!ctx.editable} onClick={() => onChange(zone ? 'hazards' : 'target')} title="Replace with a picker">
          Pick
        </button>
      </span>
    );
  }
  return <CallEditor call={call} zone={zone} onChange={(c) => onChange(printCall(c))} />;
}

/** The card of an entry by id, for tiles that are not words in text. */
export function HoverId({ id, children, className, as }: { id: string; children: ReactNode; className?: string; as?: 'span' | 'div' | 'label' }) {
  return (
    <Hover entry={entryById(id)} className={className} as={as}>
      {children}
    </Hover>
  );
}

/** A small segmented control. */
export function Seg<T extends string>({ value, options, onChange, label, disabled }: { value: T | null; options: readonly { id: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <div className="seg sb-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} title={o.title} disabled={disabled} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
