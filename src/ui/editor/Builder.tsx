// Owned by: ui
// The visual strategy builder. It reads the same draft as the code view and writes back through
// small text edits (edit.ts), so a change in either shows in the other at once and the player's own
// formatting survives. Every property has its card on hover, every number can be dragged, and the
// gate's issues show on the field they are about.
import { useContext, useMemo, useRef, useState } from 'react';
import type { HTMLAttributes, MutableRefObject, ReactNode } from 'react';
import {
  ATTRIBUTE_BUDGET,
  ATTRIBUTE_KEYS,
  ATTRIBUTE_MAX,
  ATTRIBUTE_MIN,
  BARK_RULES,
  COMMIT_BONUS,
  MAX_BEHAVIOURS,
  MAX_MEMORY_SLOTS,
  MAX_MOVE_TERMS,
  SKILLS,
  SKILL_IDS,
  STAT_DOCS,
  TICK_HZ,
  WEAPONS,
  WEAPON_IDS,
  deriveStats,
} from '../../core';
import type { AttributeKey, Attributes, BarkKind, DerivedStats, SkillId, ValidationIssue, WeaponId } from '../../core';
import { ATTACK_POLICY_NAMES, FIGHTER_SENSORS, MOVE_TERMS } from '../../brain';
import type { TermKind } from '../../brain';
import { BARK_KINDS, LIMITS, STARTER_DOCS, STARTER_LIBRARY, STARTER_NAMES, mergeBehaviours } from '../../strategy';
import { formatStat } from '../format';
import { WeaponIcon } from '../icons';
import { moveMember, renameKey, renameMemory } from './edit';
import { joinSum, splitSum } from './exprtext';
import type { SumTerm } from './exprtext';
import { Ctx, ExprField, Hover, HoverId, IssueLine, Label, PlaceField, ScrubNumber, Seg, issuesAt, issuesUnder } from './fields';
import type { BuilderCtx } from './fields';
import { pathKey } from './jsontext';
import type { PathSeg } from './jsontext';
import { attributeLabel, entryById, fieldEntry } from './lexicon';
import { useReorder } from './reorder';
import type { CardBuild } from './WordCard';
import './builder.css';

export type BuilderApi = {
  /** Scroll to the field an issue path names (or its nearest shown parent) and flash it. */
  reveal(path: string): void;
};

type Edit = (path: readonly PathSeg[], value: unknown) => void;

type Props = {
  apiRef: MutableRefObject<BuilderApi | null>;
  /** The parsed draft (the last one that parsed while the JSON is broken). */
  value: unknown;
  /** False while the JSON does not parse: everything shows, nothing can be changed. */
  editable: boolean;
  issues: readonly ValidationIssue[];
  build: CardBuild;
  onEdit: Edit;
  /** The draft text, for edits that are not a single value (renames). */
  text: string;
  onText: (text: string) => void;
  onOpenCodex: (id: string) => void;
};

/** What the builder reads from a draft that may be half written: every field optional and unchecked. */
type Loose = {
  name?: unknown;
  author?: unknown;
  build?: { weapon?: unknown; skill?: unknown; attributes?: Record<string, unknown> };
  target?: unknown;
  behaviours?: Record<string, LooseBehaviour>;
  imports?: unknown;
  memory?: Record<string, unknown>;
  commit?: unknown;
  barks?: Record<string, unknown>;
  look?: { color?: unknown; glyph?: unknown };
};
type LooseBehaviour = { score?: unknown; move?: unknown; attack?: unknown; skill?: unknown; set?: Record<string, unknown>; stance?: unknown };
type LooseTerm = Record<string, unknown>;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const numOr = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const obj = <T,>(v: unknown): Record<string, T> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {});

export function Builder({ apiRef, value, editable, issues, build, onEdit, text, onText, onOpenCodex }: Props) {
  const s = obj<unknown>(value) as Loose;
  const memoryKey = JSON.stringify(Object.keys(obj(s.memory)));
  const memory = useMemo(() => new Set<string>(JSON.parse(memoryKey) as string[]), [memoryKey]);
  const root = useRef<HTMLDivElement>(null);
  const ctx = useMemo<BuilderCtx>(() => ({ build, memory, open: onOpenCodex, editable, issues }), [build, memory, onOpenCodex, editable, issues]);

  apiRef.current = {
    reveal(path) {
      const el = root.current;
      if (!el) return;
      let best: HTMLElement | null = null;
      for (const c of el.querySelectorAll<HTMLElement>('[data-path]')) {
        const p = c.dataset.path ?? '';
        const inside = p === path || path.startsWith(`${p}.`) || path.startsWith(`${p}[`) || p === '';
        if (inside && (!best || p.length > (best.dataset.path ?? '').length)) best = c;
      }
      if (!best) return;
      best.scrollIntoView({ block: 'center', behavior: 'smooth' });
      best.classList.remove('sb-flash');
      // Restart the animation even when the same field flashes twice in a row.
      void best.offsetWidth;
      best.classList.add('sb-flash');
      window.setTimeout(() => best?.classList.remove('sb-flash'), 1300);
    },
  };

  return (
    <Ctx.Provider value={ctx}>
      <div className="sb" ref={root} aria-label="Visual strategy editor">
        {!editable ? (
          <div className="sb-banner">
            The JSON has a syntax error, so this view is read-only until it parses again. The Checks list shows where it breaks.
          </div>
        ) : null}
        <IdentityCard s={s} onEdit={onEdit} />
        <BuildCard s={s} onEdit={onEdit} />
        <TargetCard s={s} onEdit={onEdit} />
        <BehavioursSection s={s} onEdit={onEdit} text={text} onText={onText} />
        <MemoryCard s={s} onEdit={onEdit} text={text} onText={onText} />
        <BarksCard s={s} onEdit={onEdit} />
      </div>
    </Ctx.Provider>
  );
}

// ---------------------------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------------------------

function Card({ title, path, entryPath, aside, children, className, rootProps }: { title: ReactNode; path?: string; entryPath?: PathSeg[]; aside?: ReactNode; children: ReactNode; className?: string; rootProps?: HTMLAttributes<HTMLElement> }) {
  const { issues } = useContext(Ctx);
  const under = path !== undefined ? issuesUnder(issues, path) : [];
  const errors = under.filter((i) => i.severity === 'error').length;
  return (
    <section {...rootProps} className={`sb-card${className ? ` ${className}` : ''}`} data-path={path}>
      <header className="sb-card-head">
        <h3>{entryPath ? <Label path={entryPath}>{title}</Label> : title}</h3>
        {under.length ? <span className={`sb-count ${errors ? 'error' : 'warning'}`}>{errors ? `${errors} ${errors === 1 ? 'error' : 'errors'}` : `${under.length} ${under.length === 1 ? 'warning' : 'warnings'}`}</span> : null}
        <span className="spacer" />
        {aside}
      </header>
      <div className="sb-card-body">{children}</div>
    </section>
  );
}

/** One labelled row; shows the gate's issues for exactly its path. */
function Field({ path, label, children, entry, wide }: { path: readonly PathSeg[]; label: ReactNode; children: ReactNode; entry?: ReturnType<typeof entryById>; wide?: boolean }) {
  const { issues } = useContext(Ctx);
  const key = pathKey(path);
  const own = issuesAt(issues, key);
  return (
    <div className={`sb-field${wide ? ' wide' : ''}${own.length ? ` has-${own[0]!.severity}` : ''}`} data-path={key}>
      <Label path={path} entry={entry}>
        {label}
      </Label>
      <div className="sb-field-body">
        {children}
        <IssueLine issues={own} />
      </div>
    </div>
  );
}

function severityAt(issues: readonly ValidationIssue[], path: readonly PathSeg[]): 'error' | 'warning' | null {
  return issuesAt(issues, pathKey(path))[0]?.severity ?? null;
}

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

function IdentityCard({ s, onEdit }: { s: Loose; onEdit: Edit }) {
  const { editable } = useContext(Ctx);
  const look = obj<unknown>(s.look);
  const color = str(look.color);
  return (
    <Card title="Fighter" className="sb-identity">
      <div className="sb-grid2">
        <Field path={['name']} label="Name">
          <input className="sb-text sb-name" value={str(s.name)} maxLength={LIMITS.nameLength + 10} disabled={!editable} onChange={(e) => onEdit(['name'], e.target.value)} aria-label="Name" />
        </Field>
        <Field path={['author']} label="Author">
          <input className="sb-text" value={str(s.author)} placeholder="optional" disabled={!editable} onChange={(e) => onEdit(['author'], e.target.value || undefined)} aria-label="Author" />
        </Field>
      </div>
      <div className="sb-grid2">
        <Field path={['look', 'color']} label="Colour">
          <span className="sb-inline">
            <input type="color" className="sb-color" value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : '#888888'} disabled={!editable} onChange={(e) => onEdit(['look', 'color'], e.target.value)} aria-label="Colour" />
            {color ? (
              <button type="button" className="btn btn-sm btn-quiet" disabled={!editable} onClick={() => onEdit(['look', 'color'], undefined)}>
                Clear
              </button>
            ) : (
              <span className="faint">match picks one</span>
            )}
          </span>
        </Field>
        <Field path={['look', 'glyph']} label="Glyph">
          <input className="sb-text sb-glyph" value={str(look.glyph)} placeholder="1-2 characters" maxLength={LIMITS.glyphLength} disabled={!editable} onChange={(e) => onEdit(['look', 'glyph'], e.target.value || undefined)} aria-label="Glyph" />
        </Field>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

/** The one stat each attribute shows beside its slider. */
const HEADLINE: Readonly<Record<AttributeKey, keyof DerivedStats>> = {
  vitality: 'maxHp',
  power: 'damageMultiplier',
  agility: 'moveSpeed',
  perception: 'visionRange',
  armor: 'armorMitigation',
  haste: 'attackCooldown',
};

function readAttrs(s: Loose): Record<AttributeKey, number> {
  const a = obj<unknown>(s.build?.attributes);
  return Object.fromEntries(ATTRIBUTE_KEYS.map((k) => [k, numOr(a[k], ATTRIBUTE_MIN)])) as Record<AttributeKey, number>;
}

function BuildCard({ s, onEdit }: { s: Loose; onEdit: Edit }) {
  const { editable, issues } = useContext(Ctx);
  const weapon = (WEAPON_IDS as readonly string[]).includes(str(s.build?.weapon)) ? (str(s.build?.weapon) as WeaponId) : null;
  const skill = (SKILL_IDS as readonly string[]).includes(str(s.build?.skill)) ? (str(s.build?.skill) as SkillId) : null;
  const attrs = readAttrs(s);
  const total = ATTRIBUTE_KEYS.reduce((n, k) => n + attrs[k], 0);
  const left = ATTRIBUTE_BUDGET - total;
  const stats = weapon ? deriveStats(attrs as Attributes, weapon) : null;
  const scale = Math.max(total, ATTRIBUTE_BUDGET);
  const setAttr = (k: AttributeKey, v: number) => {
    // Never past the budget from here: raising one attribute means lowering another first.
    const cap = Math.min(ATTRIBUTE_MAX, attrs[k] + Math.max(0, left));
    onEdit(['build', 'attributes', k], Math.round(Math.max(ATTRIBUTE_MIN, Math.min(cap, v))));
  };

  return (
    <Card title="Build" path="build" entryPath={['build']}>
      <Field path={['build', 'weapon']} label="Weapon" wide>
        <div className="sb-tiles sb-tiles-weapons" role="radiogroup" aria-label="Weapon">
          {WEAPON_IDS.map((id) => {
            const w = WEAPONS[id];
            return (
              <HoverId key={id} id={`weapon:${id}`} as="div" className="sb-tile-wrap">
                <button type="button" role="radio" aria-checked={weapon === id} className="sb-tile" disabled={!editable} onClick={() => onEdit(['build', 'weapon'], id)}>
                  <span className="sb-tile-top">
                    <WeaponIcon weapon={id} size={18} />
                    <span className="sb-tile-name">{w.name}</span>
                  </span>
                  <span className="sb-tile-family">{w.family}</span>
                  <span className="sb-tile-stats num">
                    {w.range} px · {w.damage} dmg · {(w.cooldown / TICK_HZ).toFixed(2)} s
                  </span>
                </button>
              </HoverId>
            );
          })}
        </div>
      </Field>
      <Field path={['build', 'skill']} label="Skill" wide>
        <div className="sb-tiles sb-tiles-skills" role="radiogroup" aria-label="Skill">
          {SKILL_IDS.map((id) => (
            <HoverId key={id} id={`skill:${id}`} as="div" className="sb-tile-wrap">
              <button type="button" role="radio" aria-checked={skill === id} className="sb-tile sb-tile-skill" disabled={!editable} onClick={() => onEdit(['build', 'skill'], id)}>
                <span className="sb-tile-name">{SKILLS[id].name}</span>
                <span className="sb-tile-doc">{SKILLS[id].doc}</span>
              </button>
            </HoverId>
          ))}
        </div>
      </Field>

      <div className="sb-attrs" data-path="build.attributes">
        <div className="sb-attrs-head">
          <Label path={['build', 'attributes']}>Attributes</Label>
          <span className={`sb-budget-total${left < 0 ? ' over' : ''}`}>
            <b className="num">{total}</b>
            <span className="dim"> / {ATTRIBUTE_BUDGET}</span>
          </span>
          <span className={`sb-budget-left${left < 0 ? ' over' : left === 0 ? ' done' : ''}`}>
            {left < 0 ? `${-left} over budget` : left > 0 ? `${left} ${left === 1 ? 'point' : 'points'} left` : 'every point spent'}
          </span>
        </div>
        <div className="sb-budget" aria-hidden>
          {ATTRIBUTE_KEYS.map((k) => (
            <div key={k} data-attr={k} style={{ width: `${(attrs[k] / scale) * 100}%` }} />
          ))}
          {left < 0 ? <i style={{ left: `${(ATTRIBUTE_BUDGET / scale) * 100}%` }} /> : null}
        </div>
        <IssueLine issues={issuesAt(issues, 'build.attributes')} />
        {ATTRIBUTE_KEYS.map((k) => {
          const v = attrs[k];
          const reach = Math.min(ATTRIBUTE_MAX, v + Math.max(0, left));
          const own = issuesAt(issues, `build.attributes.${k}`);
          return (
            <div key={k} className={`sb-attr${own.length ? ` has-${own[0]!.severity}` : ''}`} data-attr={k} data-path={`build.attributes.${k}`}>
              <HoverId id={`attribute:${k}`} className="sb-attr-name">
                <i className="sb-swatch" />
                {attributeLabel(k)}
              </HoverId>
              <input
                type="range"
                className="sb-range"
                min={ATTRIBUTE_MIN}
                max={ATTRIBUTE_MAX}
                step={1}
                value={v}
                disabled={!editable}
                aria-label={attributeLabel(k)}
                style={{
                  ['--fill' as string]: `${((v - ATTRIBUTE_MIN) / (ATTRIBUTE_MAX - ATTRIBUTE_MIN)) * 100}%`,
                  ['--reach' as string]: `${((reach - ATTRIBUTE_MIN) / (ATTRIBUTE_MAX - ATTRIBUTE_MIN)) * 100}%`,
                }}
                onChange={(e) => setAttr(k, Number(e.target.value))}
              />
              <ScrubNumber value={v} min={ATTRIBUTE_MIN} max={reach} label={attributeLabel(k)} disabled={!editable} onChange={(n) => setAttr(k, n)} />
              <span className="sb-attr-stat" title={STAT_DOCS[HEADLINE[k]].doc}>
                {stats ? (
                  <>
                    <span className="faint">{STAT_DOCS[HEADLINE[k]].label}</span> <span className="num">{formatStat(HEADLINE[k], stats[HEADLINE[k]])}</span>
                  </>
                ) : null}
              </span>
              {own.length ? <div className="sb-attr-issue"><IssueLine issues={own} /></div> : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------------------------

/** A first term for "Add a preference": a distance is better small, a flag or count better big. */
function preferenceFor(key: string, unit: string): SumTerm {
  if (unit === 'px' || unit === 's' || unit === 'ticks') return { sign: -1, text: `it.${key}` };
  if (unit === 'fraction') return { sign: -1, text: `200 * it.${key}` };
  return { sign: 1, text: `${unit === 'count' ? 50 : 150} * it.${key}` };
}

function TargetCard({ s, onEdit }: { s: Loose; onEdit: Edit }) {
  const { editable, issues } = useContext(Ctx);
  const target = str(s.target);
  const terms = splitSum(target);
  const sev = severityAt(issues, ['target']);
  const set = (t: string) => onEdit(['target'], t);
  const setTerms = (next: SumTerm[]) => set(next.length ? joinSum(next) : '0');
  return (
    <Card title="Target" path="target" entryPath={['target']}>
      <p className="sb-hint">Every known enemy gets this rating; the highest becomes your target. Each line adds to it.</p>
      <div data-path="target">
        {terms ? (
          <div className="sb-terms">
            {terms.map((t, i) => (
              <div className="sb-term" key={i}>
                <button
                  type="button"
                  className={`sb-sign ${t.sign < 0 ? 'minus' : 'plus'}`}
                  disabled={!editable}
                  title={t.sign < 0 ? 'Subtracted: less of this is better. Click to add it instead.' : 'Added: more of this is better. Click to subtract it instead.'}
                  onClick={() => setTerms(terms.map((x, j) => (j === i ? { ...x, sign: x.sign < 0 ? 1 : -1 } : x)))}
                >
                  {t.sign < 0 ? '−' : '+'}
                </button>
                <ExprField value={t.text} slot={{ kind: 'expr', scope: 'target' }} invalid={sev} label="Target preference" onChange={(text) => setTerms(terms.map((x, j) => (j === i ? { ...x, text: text.trim() || '0' } : x)))} />
                <button type="button" className="btn btn-sm btn-icon btn-quiet sb-x" disabled={!editable || terms.length < 2} aria-label="Remove this preference" onClick={() => setTerms(terms.filter((_, j) => j !== i))}>
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <ExprField value={target} slot={{ kind: 'expr', scope: 'target' }} invalid={sev} label="Target expression" onChange={set} />
        )}
        <IssueLine issues={issuesAt(issues, 'target')} />
        <div className="sb-add-row">
          <select
            className="sb-select sb-add"
            value=""
            disabled={!editable}
            aria-label="Add a preference"
            onChange={(e) => {
              const d = FIGHTER_SENSORS.find((f) => f.key === e.target.value);
              if (!d) return;
              const add = preferenceFor(d.key, d.unit);
              set(terms ? joinSum([...terms, add]) : `${target ? `(${target}) ` : ''}${add.sign < 0 ? '-' : '+'} ${add.text}`);
            }}
          >
            <option value="">+ Add a preference…</option>
            {FIGHTER_SENSORS.map((f) => (
              <option key={f.key} value={f.key}>
                it.{f.key} ({f.unit})
              </option>
            ))}
          </select>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Behaviours
// ---------------------------------------------------------------------------------------------

const IDENT = /^[a-z][a-z0-9_]*$/;
const TERM_KINDS = MOVE_TERMS.map((t) => t.key);

function termKindOf(t: LooseTerm): TermKind | null {
  for (const k of TERM_KINDS) if (k in t) return k;
  return null;
}

function placeOfTerm(t: LooseTerm): string | null {
  const k = termKindOf(t);
  if (!k) return null;
  const v = t[k];
  if (k === 'seek' || k === 'flee') return str(v, 'target');
  if (k === 'keep_range' || k === 'orbit') return Array.isArray(v) ? str(v[0], 'target') : 'target';
  return null;
}

/** The term converted to another kind, keeping its place or zone and weight where they still fit. */
function convertTerm(t: LooseTerm, to: TermKind): LooseTerm {
  const weight = numOr(t.weight, 1);
  const from = termKindOf(t);
  const place = placeOfTerm(t) ?? 'target';
  const zone = from === 'avoid' || from === 'prefer' ? str(t[from], 'hazards') : to === 'prefer' ? 'shadow' : 'hazards';
  switch (to) {
    case 'seek':
    case 'flee':
      return { [to]: place, weight };
    case 'keep_range':
      return { keep_range: [place, 180, 260], weight };
    case 'orbit':
      return { orbit: [place, 'cw'], weight };
    default:
      return { [to]: zone, weight };
  }
}

function freeName(taken: Iterable<string>, base: string): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) if (!set.has(`${base}_${i}`)) return `${base}_${i}`;
}

function BehavioursSection({ s, onEdit, text, onText }: { s: Loose; onEdit: Edit; text: string; onText: (t: string) => void }) {
  const { editable, issues } = useContext(Ctx);
  const own = obj<LooseBehaviour>(s.behaviours);
  const names = Object.keys(own);
  const imports = Array.isArray(s.imports) ? (s.imports.filter((x) => typeof x === 'string') as string[]) : [];
  const merged = mergeBehaviours({ behaviours: {}, imports: imports.filter((n) => !names.includes(n)) }).length + names.length;
  const full = merged >= MAX_BEHAVIOURS;

  const add = (from: string) => {
    const name = freeName(names, from === '' ? 'plan' : from);
    const b = from === '' ? { score: '0.5', move: [{ seek: 'target', weight: 1 }, { avoid: 'hazards', weight: 0.8 }], attack: 'in_range' } : STARTER_LIBRARY[from];
    onEdit(['behaviours', name], b);
  };

  return (
    <div className="sb-section" data-path="behaviours">
      <div className="sb-section-head">
        <h2>
          <Label path={['behaviours']}>Behaviours</Label>
        </h2>
        <span className={`dim num${full ? ' sb-full' : ''}`}>
          {merged} of {MAX_BEHAVIOURS} with imports
        </span>
        <span className="spacer" />
        <select className="sb-select sb-add" value="" disabled={!editable || full} aria-label="Add a behaviour" onChange={(e) => e.target.value !== '-' && add(e.target.value === '+' ? '' : e.target.value)}>
          <option value="-">+ Add behaviour…</option>
          <option value="+">Blank behaviour</option>
          <optgroup label="Copy from the starter library">
            {STARTER_NAMES.map((n) => (
              <option key={n} value={n}>
                {n}: {STARTER_DOCS[n]?.slice(0, 60)}
              </option>
            ))}
          </optgroup>
        </select>
      </div>
      <IssueLine issues={issuesAt(issues, 'behaviours')} />
      {names.map((n, i) => (
        <BehaviourCard
          key={n}
          name={n}
          index={i}
          b={obj<unknown>(own[n]) as LooseBehaviour}
          names={names}
          onEdit={onEdit}
          onRename={(to) => onText(renameKey(text, ['behaviours', n], to))}
          onRemove={() => onEdit(['behaviours', n], undefined)}
          onMove={(from, to) => onText(moveMember(text, ['behaviours'], from, to))}
          onMoveTerm={(from, to) => onText(moveMember(text, ['behaviours', n, 'move'], from, to))}
        />
      ))}
      <ImportsCard imports={imports} own={names} onEdit={onEdit} full={full} />
    </div>
  );
}

function NameInput({ value, taken, onRename, label }: { value: string; taken: readonly string[]; onRename: (to: string) => void; label: string }) {
  const { editable } = useContext(Ctx);
  const [draft, setDraft] = useState<string | null>(null);
  const v = draft ?? value;
  const bad = draft !== null && draft !== value && (!IDENT.test(draft) || draft.length > LIMITS.identLength || taken.includes(draft));
  const commit = () => {
    if (draft !== null && draft !== value && !bad) onRename(draft);
    setDraft(null);
  };
  return (
    <input
      className={`sb-text sb-ident${bad ? ' error' : ''}`}
      value={v}
      disabled={!editable}
      spellCheck={false}
      aria-label={label}
      title={bad ? `Lowercase letters, digits and _, starting with a letter, at most ${LIMITS.identLength}, not already used.` : 'Rename'}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

const STANCE_OPTIONS = [
  { id: 'normal', label: 'normal' },
  { id: 'creep', label: 'creep' },
  { id: 'guard', label: 'guard' },
] as const;

type Move = (from: number, to: number) => void;

function BehaviourCard(props: { name: string; index: number; b: LooseBehaviour; names: readonly string[]; onEdit: Edit; onRename: (to: string) => void; onRemove: () => void; onMove: Move; onMoveTerm: Move }) {
  const { name, index, b, names, onEdit, onRename, onRemove, onMove, onMoveTerm } = props;
  const { editable, issues, memory } = useContext(Ctx);
  // Order matters here: on a tied score the earlier behaviour wins.
  const reorder = useReorder('behaviours', index, names.length, name, editable, onMove);
  const base: PathSeg[] = ['behaviours', name];
  const p = (...rest: PathSeg[]) => [...base, ...rest];
  const move = Array.isArray(b.move) ? (b.move as LooseTerm[]) : [];
  const attack = str(b.attack, 'in_range');
  const policy = ATTACK_POLICY_NAMES.includes(attack) ? attack : 'expr';
  const skill = typeof b.skill === 'string' ? b.skill : null;
  const sets = obj<unknown>(b.set);
  const stance = str(b.stance, 'normal');
  const shadows = Object.hasOwn(STARTER_LIBRARY, name);

  return (
    <Card
      className="sb-behaviour"
      path={pathKey(base)}
      rootProps={{ ...reorder.target, 'data-reorder': '' } as HTMLAttributes<HTMLElement>}
      title={
        <span className="sb-bname">
          {reorder.grip}
          <NameInput value={name} taken={names.filter((n) => n !== name)} onRename={onRename} label="Behaviour name" />
          {shadows ? (
            <HoverId id={`starter:${name}`} className="sb-tag">
              replaces starter {name}
            </HoverId>
          ) : null}
        </span>
      }
      aside={
        <button type="button" className="btn btn-sm btn-icon btn-quiet sb-x" disabled={!editable} aria-label={`Remove ${name}`} title="Remove this behaviour" onClick={onRemove}>
          ×
        </button>
      }
    >
      <Field path={p('score')} label="Wins when">
        <ExprField value={str(b.score)} slot={{ kind: 'expr', scope: 'behaviour' }} invalid={severityAt(issues, p('score'))} label="Score" onChange={(t) => onEdit(p('score'), t)} />
      </Field>

      <Field path={p('stance')} label="Stance">
        <span className="sb-inline">
          <Seg
            label="Stance"
            value={stance}
            disabled={!editable}
            options={STANCE_OPTIONS.map((o) => ({ ...o, title: entryById(`stance:${o.id}`)?.doc }))}
            onChange={(v) => onEdit(p('stance'), v === 'normal' ? undefined : v)}
          />
          <span className="faint sb-mini">{entryById(`stance:${stance}`)?.doc}</span>
        </span>
      </Field>

      <div className="sb-field wide" data-path={pathKey(p('move'))}>
        <Label path={p('move')}>Moves</Label>
        <div className="sb-field-body">
          {move.length === 0 ? <div className="faint sb-empty">Stands still.</div> : null}
          {move.map((t, i) => (
            <TermRow key={i} t={obj<unknown>(t)} path={p('move', i)} group={`move:${name}`} index={i} count={move.length} onEdit={onEdit} onRemove={() => onEdit(p('move'), move.filter((_, j) => j !== i))} onMove={onMoveTerm} />
          ))}
          <IssueLine issues={issuesAt(issues, pathKey(p('move')))} />
          <button
            type="button"
            className="btn btn-sm btn-quiet sb-add-btn"
            disabled={!editable || move.length >= MAX_MOVE_TERMS}
            onClick={() => onEdit(p('move'), [...move, { seek: 'target', weight: 1 }])}
            title={move.length >= MAX_MOVE_TERMS ? `At most ${MAX_MOVE_TERMS} move terms` : undefined}
          >
            + Add move term
          </button>
        </div>
      </div>

      <Field path={p('attack')} label="Attacks">
        <div className="sb-stack">
          <Seg
            label="Attack policy"
            value={policy}
            disabled={!editable}
            options={[
              { id: 'in_range', label: 'in range', title: entryById('policy:in_range')?.doc },
              { id: 'if_blocked', label: 'if blocked', title: entryById('policy:if_blocked')?.doc },
              { id: 'never', label: 'never', title: entryById('policy:never')?.doc },
              { id: 'expr', label: 'when…', title: 'Attack the target whenever an expression is above 0' },
            ]}
            onChange={(v) => onEdit(p('attack'), v === 'expr' ? 'target.in_reach' : v)}
          />
          {policy === 'expr' ? <ExprField value={attack} slot={{ kind: 'attack' }} invalid={severityAt(issues, p('attack'))} label="Attack when" onChange={(t) => onEdit(p('attack'), t)} /> : null}
        </div>
      </Field>

      <Field path={p('skill')} label="Skill">
        <div className="sb-stack">
          <Seg
            label="Skill policy"
            value={skill === null ? 'never' : 'when'}
            disabled={!editable}
            options={[
              { id: 'never', label: 'never' },
              { id: 'when', label: 'when…' },
            ]}
            onChange={(v) => onEdit(p('skill'), v === 'never' ? undefined : (skill ?? 'target.distance < 90'))}
          />
          {skill !== null ? <ExprField value={skill} slot={{ kind: 'expr', scope: 'behaviour' }} invalid={severityAt(issues, p('skill'))} label="Use skill when" onChange={(t) => onEdit(p('skill'), t)} /> : null}
        </div>
      </Field>

      {Object.keys(sets).length || memory.size ? (
        <div className="sb-field wide" data-path={pathKey(p('set'))}>
          <Label path={p('set')}>Remembers</Label>
          <div className="sb-field-body">
            {Object.entries(sets).map(([slot, e]) => (
              <div className="sb-set" key={slot} data-path={pathKey(p('set', slot))}>
                <HoverId id="field:memory.*" className="lx-chip" as="span">
                  <span data-kind="memory">{slot}</span>
                </HoverId>
                <span className="sb-op">=</span>
                <ExprField value={str(e)} slot={{ kind: 'expr', scope: 'behaviour' }} invalid={severityAt(issues, p('set', slot))} label={`Set ${slot}`} onChange={(t) => onEdit(p('set', slot), t)} />
                <button type="button" className="btn btn-sm btn-icon btn-quiet sb-x" disabled={!editable} aria-label={`Stop writing ${slot}`} onClick={() => onEdit(p('set', slot), undefined)}>
                  ×
                </button>
                <IssueLine issues={issuesAt(issues, pathKey(p('set', slot)))} />
              </div>
            ))}
            {[...memory].some((m) => !(m in sets)) ? (
              <select className="sb-select sb-add" value="" disabled={!editable} aria-label="Write a memory slot" onChange={(e) => e.target.value && onEdit(p('set', e.target.value), 'time')}>
                <option value="">+ Write a memory slot…</option>
                {[...memory]
                  .filter((m) => !(m in sets))
                  .map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
              </select>
            ) : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function TermRow(props: { t: LooseTerm; path: PathSeg[]; group: string; index: number; count: number; onEdit: Edit; onRemove: () => void; onMove: Move }) {
  const { t, path, group, index, count, onEdit, onRemove, onMove } = props;
  const { editable, issues } = useContext(Ctx);
  const kind = termKindOf(t);
  const reorder = useReorder(group, index, count, `move term ${index + 1}`, editable, onMove);
  const weight = numOr(t.weight, 1);
  const v = kind ? t[kind] : undefined;
  const own = issuesUnder(issues, pathKey(path));
  const sev = own[0]?.severity ?? null;
  const at = (...rest: PathSeg[]) => [...path, ...rest];

  let arg: ReactNode = <span className="faint">unknown term</span>;
  if (kind === 'seek' || kind === 'flee') arg = <PlaceField value={str(v, 'target')} zone={false} invalid={sev} onChange={(x) => onEdit(at(kind), x)} />;
  else if (kind === 'avoid' || kind === 'prefer') arg = <PlaceField value={str(v, 'hazards')} zone invalid={sev} onChange={(x) => onEdit(at(kind), x)} />;
  else if (kind === 'keep_range') {
    const arr = Array.isArray(v) ? v : ['target', 180, 260];
    arg = (
      <>
        <PlaceField value={str(arr[0], 'target')} zone={false} invalid={sev} onChange={(x) => onEdit(at(kind, 0), x)} />
        <span className="sb-op">from</span>
        <ScrubNumber value={numOr(arr[1], 0)} min={0} max={LIMITS.rangeMax} step={5} label="min" suffix="px" disabled={!editable} onChange={(n) => onEdit(at(kind, 1), n)} />
        <span className="sb-op">to</span>
        <ScrubNumber value={numOr(arr[2], 0)} min={0} max={LIMITS.rangeMax} step={5} label="max" suffix="px" disabled={!editable} onChange={(n) => onEdit(at(kind, 2), n)} />
      </>
    );
  } else if (kind === 'orbit') {
    const arr = Array.isArray(v) ? v : ['target', 'cw'];
    arg = (
      <>
        <PlaceField value={str(arr[0], 'target')} zone={false} invalid={sev} onChange={(x) => onEdit(at(kind, 0), x)} />
        <Seg
          label="Direction"
          value={str(arr[1], 'cw')}
          disabled={!editable}
          options={[
            { id: 'cw', label: '↻ cw', title: entryById('direction:cw')?.doc },
            { id: 'ccw', label: '↺ ccw', title: entryById('direction:ccw')?.doc },
          ]}
          onChange={(d) => onEdit(at(kind, 1), d)}
        />
      </>
    );
  }

  return (
    <div className={`sb-move${sev ? ` has-${sev}` : ''}`} data-path={pathKey(path)} data-reorder="" {...reorder.target}>
      {reorder.grip}
      <Hover entry={kind ? entryById(`term:${kind}`) : null} className="sb-pick">
        <select className="sb-select sb-term-kind" data-kind="term" value={kind ?? ''} disabled={!editable} aria-label="Move term" onChange={(e) => onEdit(path, convertTerm(t, e.target.value as TermKind))}>
          {kind ? null : <option value="">?</option>}
          {TERM_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </Hover>
      <span className="sb-move-arg">{arg}</span>
      <span className="sb-weight" data-path={pathKey(at('weight'))}>
        <Hover entry={fieldEntry(at('weight'))} className="sb-mini faint">
          weight
        </Hover>
        <input
          type="range"
          className="sb-range sb-range-weight"
          min={0}
          max={LIMITS.weightMax}
          step={0.05}
          value={weight}
          disabled={!editable}
          aria-label="Weight"
          style={{ ['--fill' as string]: `${(weight / LIMITS.weightMax) * 100}%`, ['--reach' as string]: '100%' }}
          onChange={(e) => onEdit(at('weight'), Number(e.target.value))}
        />
        <ScrubNumber value={weight} min={0} max={LIMITS.weightMax} step={0.05} decimals={2} label="Weight" disabled={!editable} onChange={(n) => onEdit(at('weight'), n)} />
      </span>
      <button type="button" className="btn btn-sm btn-icon btn-quiet sb-x" disabled={!editable} aria-label="Remove this move term" onClick={onRemove}>
        ×
      </button>
      {own.length ? (
        <div className="sb-move-issues">
          <IssueLine issues={own} />
        </div>
      ) : null}
    </div>
  );
}

function ImportsCard({ imports, own, onEdit, full }: { imports: string[]; own: readonly string[]; onEdit: Edit; full: boolean }) {
  const { editable, issues } = useContext(Ctx);
  const toggle = (n: string) => onEdit(['imports'], imports.includes(n) ? imports.filter((x) => x !== n) : [...imports, n]);
  return (
    <Card title="Imported from the starter library" path="imports" entryPath={['imports']} className="sb-imports">
      <p className="sb-hint">Switch on ready-made behaviours. Your own behaviour with the same name replaces the import.</p>
      <div className="sb-chips">
        {STARTER_NAMES.map((n) => {
          const on = imports.includes(n);
          const replaced = on && own.includes(n);
          return (
            <HoverId key={n} id={`starter:${n}`} className="sb-chip-wrap">
              <button
                type="button"
                className={`sb-import${on ? ' on' : ''}${replaced ? ' replaced' : ''}`}
                aria-pressed={on}
                disabled={!editable || (!on && full)}
                onClick={() => toggle(n)}
              >
                {n}
              </button>
            </HoverId>
          );
        })}
      </div>
      <IssueLine issues={issuesUnder(issues, 'imports')} />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Memory and commit
// ---------------------------------------------------------------------------------------------

function MemoryCard({ s, onEdit, text, onText }: { s: Loose; onEdit: Edit; text: string; onText: (t: string) => void }) {
  const { editable, issues } = useContext(Ctx);
  const mem = obj<unknown>(s.memory);
  const names = Object.keys(mem);
  const commit = numOr(s.commit, LIMITS.commitDefault);
  return (
    <Card title="Memory and commitment" className="sb-memory">
      <Field path={['commit']} label="Commit">
        <span className="sb-inline">
          <input
            type="range"
            className="sb-range"
            min={0}
            max={LIMITS.commitMax}
            step={5}
            value={commit}
            disabled={!editable}
            aria-label="Commit ticks"
            style={{ ['--fill' as string]: `${(commit / LIMITS.commitMax) * 100}%`, ['--reach' as string]: '100%' }}
            onChange={(e) => onEdit(['commit'], Number(e.target.value))}
          />
          <ScrubNumber value={commit} min={0} max={LIMITS.commitMax} step={1} suffix="ticks" label="Commit" disabled={!editable} onChange={(n) => onEdit(['commit'], n)} />
          <span className="faint num">{(commit / TICK_HZ).toFixed(2)} s</span>
        </span>
        <p className="sb-hint">A newly chosen behaviour keeps +{COMMIT_BONUS} for this long, so close scores do not flip-flop.</p>
      </Field>
      <div className="sb-field wide" data-path="memory">
        <Label path={['memory']}>Memory slots</Label>
        <div className="sb-field-body">
          {names.length === 0 ? <div className="faint sb-empty">None. A slot remembers a number between thinks (when you last vanished, how often you were hit).</div> : null}
          {names.map((n) => (
            <div className="sb-mem" key={n} data-path={`memory.${n}`}>
              <NameInput value={n} taken={names.filter((x) => x !== n)} label="Memory slot name" onRename={(to) => onText(renameMemory(text, n, to))} />
              <span className="sb-op">starts at</span>
              <input
                className="sb-text sb-mem-value num"
                defaultValue={String(numOr(mem[n], 0))}
                key={String(mem[n])}
                disabled={!editable}
                aria-label={`${n} starting value`}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (e.target.value.trim() !== '' && Number.isFinite(v)) onEdit(['memory', n], v);
                }}
              />
              <button type="button" className="btn btn-sm btn-icon btn-quiet sb-x" disabled={!editable} aria-label={`Remove ${n}`} onClick={() => onEdit(['memory', n], undefined)}>
                ×
              </button>
              <IssueLine issues={issuesUnder(issues, `memory.${n}`)} />
            </div>
          ))}
          <button type="button" className="btn btn-sm btn-quiet sb-add-btn" disabled={!editable || names.length >= MAX_MEMORY_SLOTS} onClick={() => onEdit(['memory', freeName(names, 'slot')], 0)}>
            + Add memory slot
          </button>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Barks
// ---------------------------------------------------------------------------------------------

function BarksCard({ s, onEdit }: { s: Loose; onEdit: Edit }) {
  const { editable } = useContext(Ctx);
  const barks = obj<unknown>(s.barks);
  return (
    <Card title="Barks" path="barks" entryPath={['barks']} className="sb-barks">
      <p className="sb-hint">Short and dry lands best. The game picks the moment; each kind has its own chance.</p>
      {BARK_KINDS.map((k: BarkKind) => {
        const raw = barks[k];
        const lines = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.map((x) => str(x)) : [];
        const write = (next: string[]) => onEdit(['barks', k], next.length ? next : undefined);
        return (
          <div className="sb-bark" key={k} data-path={`barks.${k}`}>
            <HoverId id={`bark:${k}`} className="sb-label">
              {k.replace('_', ' ')}
            </HoverId>
            <div className="sb-bark-lines">
              {lines.map((line, i) => (
                <span className="sb-bark-line" key={i}>
                  <input className={`sb-text${line.length > BARK_RULES.maxLength ? ' error' : ''}`} value={line} disabled={!editable} aria-label={`${k} line ${i + 1}`} onChange={(e) => write(lines.map((x, j) => (j === i ? e.target.value : x)))} />
                  <span className={`num sb-count-chars${line.length > BARK_RULES.maxLength ? ' over' : ''}`}>{line.length}</span>
                  <button type="button" className="btn btn-sm btn-icon btn-quiet sb-x" disabled={!editable} aria-label="Remove line" onClick={() => write(lines.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </span>
              ))}
              <button type="button" className="btn btn-sm btn-quiet sb-add-btn" disabled={!editable || lines.length >= LIMITS.barkLinesPerKind} onClick={() => write([...lines, ''])}>
                + line
              </button>
            </div>
          </div>
        );
      })}
    </Card>
  );
}
