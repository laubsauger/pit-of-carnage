// Owned by: ui
// The IntelliSense-style card for one lexicon entry: what it is, type, unit and range, the doc,
// formulas, numbers, what +10 changes (attributes, on the build being edited), a real example from
// the starter library or a house stack, and related words. Hover tooltips, completion info, the
// visual builder and the Codex all render this one card.
import { Fragment } from 'react';
import type { ReactNode } from 'react';
import type { Attributes, WeaponId } from '../../core';
import { WEAPONS } from '../../core';
import { inline } from '../codex/markdown';
import { EVEN_BUILD, KIND_LABEL, attributeEffect, attributeLabel, entryById, entryForWord } from './lexicon';
import type { Entry } from './lexicon';
import './editor.css';

export type CardBuild = { attributes: Attributes; weapon: WeaponId } | null;

type Props = {
  entry: Entry;
  /** The build being edited: attribute cards show what +10 does to it. */
  build?: CardBuild;
  /** Clicking a related word or "Codex". Without it, related words are plain chips. */
  onOpen?: (id: string) => void;
  /** Hover tooltips leave out the example and related words when space is short. */
  compact?: boolean;
  /** Show the "Open in the Codex" link (not inside the Codex itself). */
  codexLink?: boolean;
};

export function WordCard({ entry, build = null, onOpen, compact = false, codexLink = true }: Props) {
  const meta = [entry.type, entry.unit && entry.unit !== entry.type ? entry.unit : null, entry.range ? `range ${entry.range}` : null].filter(Boolean);
  return (
    <div className="lx-card" data-kind={entry.kind} data-attr={entry.attribute}>
      <div className="lx-head">
        <span className={`lx-title${/^[A-Z]/.test(entry.title) && entry.title !== entry.word ? ' lx-title-name' : ''}`}>{entry.title}</span>
        <span className="lx-kind">{KIND_LABEL[entry.kind]}</span>
      </div>
      {meta.length ? <div className="lx-meta">{meta.join(' · ')}</div> : null}
      <p className="lx-doc">
        <Md text={entry.doc} />
      </p>
      {entry.args?.length ? (
        <Facts title="Arguments" rows={entry.args} mono />
      ) : null}
      {entry.values?.length ? (
        <div className="lx-values">
          {entry.values.map((v) => (
            <code key={v}>{v}</code>
          ))}
        </div>
      ) : null}
      {entry.formulas?.length ? <Facts title={entry.kind === 'attribute' ? 'Formulas' : undefined} rows={entry.formulas} /> : null}
      {entry.attribute ? <AttributeEffect attr={entry.attribute} build={build} /> : null}
      {entry.facts?.length ? <Facts rows={entry.facts} /> : null}
      {!compact && entry.example ? (
        <div className="lx-example">
          <div className="lx-sub">
            Example <span>{entry.example.source}</span>
          </div>
          <pre>{entry.example.code}</pre>
        </div>
      ) : null}
      {entry.related.length ? (
        <div className="lx-related">
          <span className="lx-sub">Related</span>
          {entry.related.map((id) => {
            const r = entryById(id);
            if (!r) return null;
            return onOpen ? (
              <button key={id} type="button" className="lx-chip" data-kind={r.kind} data-attr={r.attribute} onClick={() => onOpen(id)}>
                {chipText(r)}
              </button>
            ) : (
              <span key={id} className="lx-chip" data-kind={r.kind} data-attr={r.attribute}>
                {chipText(r)}
              </span>
            );
          })}
        </div>
      ) : null}
      {onOpen && codexLink ? (
        <div className="lx-foot">
          <button type="button" className="lx-link" onClick={() => onOpen(entry.id)}>
            Open in the Codex
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Words read as written; stats by their label ("Max HP", not maxHp). */
function chipText(e: Entry): string {
  return e.kind === 'stat' ? e.title : e.word;
}

function Facts({ rows, title, mono = false }: { rows: readonly { label: string; value: string }[]; title?: string; mono?: boolean }) {
  return (
    <div className="lx-facts">
      {title ? <div className="lx-sub">{title}</div> : null}
      <dl>
        {rows.map((r) => (
          <Fragment key={r.label}>
            <dt className={mono ? 'mono' : undefined}>{r.label}</dt>
            <dd>
              <Md text={r.value} />
            </dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

function AttributeEffect({ attr, build }: { attr: Entry['attribute'] & string; build: CardBuild }) {
  const attrs = build?.attributes ?? EVEN_BUILD;
  const weapon = build?.weapon ?? 'GREATSWORD';
  const { to, changes } = attributeEffect(attr, attrs, weapon);
  const from = attrs[attr];
  return (
    <div className="lx-effect">
      <div className="lx-sub">
        {to === from
          ? `${attributeLabel(attr)} is at its maximum`
          : `${attributeLabel(attr)} ${from} → ${to} ${build ? 'on this build' : `on an even ${WEAPONS[weapon].name.toLowerCase()} build`}`}
      </div>
      {to !== from ? (
        <table>
          <tbody>
            {changes.map((c) => (
              <tr key={c.key}>
                <th>{c.label}</th>
                <td className="num">{c.from}</td>
                <td className="lx-arrow">→</td>
                <td className={`num ${c.better ? 'up' : 'down'}`}>{c.to}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

/** Inline Markdown from the registry docs. Code spans that name a word render as its chip. */
export function Md({ text }: { text: string }): ReactNode {
  return inline(text).map((s, i) => {
    if (s.t === 'b') return <b key={i}>{s.text}</b>;
    if (s.t === 'i') return <i key={i}>{s.text}</i>;
    if (s.t === 'code') {
      // A word, or a call of one (`cover_from(X)`), is the word's chip.
      const word = /^[a-z_][a-z0-9_.]*/i.exec(s.text)?.[0] ?? '';
      const e = word && (word === s.text || s.text.startsWith(`${word}(`)) ? entryForWord(word) : null;
      return e ? (
        <span key={i} className="lx-chip lx-chip-inline" data-kind={e.kind} data-attr={e.attribute}>
          {s.text}
        </span>
      ) : (
        <code key={i}>{s.text}</code>
      );
    }
    return <Fragment key={i}>{s.text}</Fragment>;
  });
}
