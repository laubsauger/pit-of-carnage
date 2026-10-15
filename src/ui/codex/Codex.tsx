// Owned by: ui
// The Codex: a searchable reference of everything the LLM prompt contains (how a fighter thinks,
// every sensor, place, zone, term, policy, attribute, weapon, skill, map, limit and formula) with
// the starter library as worked examples. `Codex` fills whatever box it is mounted in; the editor
// opens it as `CodexDialog`.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CloseIcon } from '../icons';
import { Ctx, Hover } from '../editor/fields';
import type { BuilderCtx } from '../editor/fields';
import { entryForWord } from '../editor/lexicon';
import type { Entry } from '../editor/lexicon';
import { WordCard } from '../editor/WordCard';
import type { CardBuild } from '../editor/WordCard';
import { CODEX_SECTIONS, searchCodex, sectionEntries, sectionOf, sectionProse } from './sections';
import type { CodexSection } from './sections';
import { inline } from './markdown';
import type { MdBlock } from './markdown';
import '../editor/editor.css';
import './codex.css';

type Props = {
  /** An entry id to open on (scrolled to and flashed), or '' for the top. */
  initial?: string;
  /** The build being edited: attribute cards show what +10 does to it. */
  build?: CardBuild;
  onClose?: () => void;
};

export function Codex({ initial = '', build = null, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(CODEX_SECTIONS[0]!.id);
  const body = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => searchCodex(query), [query]);
  const searching = query.trim().length > 0;

  /** Scroll to an entry's card (clearing a search that hides it) and flash it. */
  const goTo = (id: string) => {
    const sec = sectionOf(id);
    if (searching && !hits.some((h) => h.entries.some((e) => e.id === id))) setQuery('');
    window.requestAnimationFrame(() => {
      const el = body.current?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(id)}"]`) ?? (sec ? document.getElementById(`codex-${sec.id}`) : null);
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.classList.remove('cx-flash');
      void el.offsetWidth;
      el.classList.add('cx-flash');
    });
  };

  const ctx = useMemo<BuilderCtx>(() => ({ build, memory: new Set(), open: (id) => goTo(id), editable: false, issues: [] }), [build]); // eslint-disable-line react-hooks/exhaustive-deps

  // Open on the entry the editor asked for. Timed after layout so the card exists.
  useEffect(() => {
    if (initial) {
      const t = window.setTimeout(() => goTo(initial), 30);
      return () => window.clearTimeout(t);
    }
    search.current?.focus();
    return undefined;
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Which section is on screen, for the contents list.
  useEffect(() => {
    const el = body.current;
    if (!el || searching) return;
    const onScroll = () => {
      const top = el.getBoundingClientRect().top + 90;
      let cur = CODEX_SECTIONS[0]!.id;
      for (const s of CODEX_SECTIONS) {
        const h = document.getElementById(`codex-${s.id}`);
        if (h && h.getBoundingClientRect().top <= top) cur = s.id;
      }
      setActive(cur);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [searching]);

  const count = hits.reduce((n, h) => n + h.entries.length + h.prose.length, 0);

  return (
    <Ctx.Provider value={ctx}>
      <div className="cx">
        <header className="cx-head">
          <div className="cx-brand">
            <h2>Codex</h2>
            <span className="faint">Everything a strategy can say, and what the pit does with it.</span>
          </div>
          <label className="cx-search">
            <span className="sr-only">Search the Codex</span>
            <input
              ref={search}
              className="input"
              type="search"
              placeholder="Search: shadow, backstab, haste, keep_range, cooldown…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.stopPropagation();
                  setQuery('');
                }
              }}
            />
            {searching ? <span className="cx-count faint num">{count ? `${count} found` : 'nothing found'}</span> : null}
          </label>
          {onClose ? (
            <button type="button" className="btn btn-sm btn-icon btn-quiet" onClick={onClose} aria-label="Close the Codex">
              <CloseIcon />
            </button>
          ) : null}
        </header>
        <div className="cx-main">
          <nav className="cx-nav" aria-label="Codex contents">
            {(searching ? hits.map((h) => h.section) : CODEX_SECTIONS).map((s) => {
              const n = searching ? (hits.find((h) => h.section === s)?.entries.length ?? 0) : sectionEntries(s).length;
              return (
                <a
                  key={s.id}
                  href={`#codex-${s.id}`}
                  aria-current={!searching && active === s.id ? 'true' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(`codex-${s.id}`)?.scrollIntoView({ block: 'start' });
                    setActive(s.id);
                  }}
                >
                  <span>{s.title}</span>
                  {n ? <span className="faint num">{n}</span> : null}
                </a>
              );
            })}
          </nav>
          <div className="cx-body" ref={body}>
            {searching ? (
              hits.length ? (
                hits.map((h) => <Section key={h.section.id} section={h.section} prose={h.prose} entries={h.entries} build={build} onOpen={goTo} />)
              ) : (
                <div className="cx-empty">
                  Nothing matches “{query.trim()}”. Try a sensor name, a weapon, or a word like <i>shadow</i>.
                </div>
              )
            ) : (
              CODEX_SECTIONS.map((s) => <Section key={s.id} section={s} prose={sectionProse(s)} entries={sectionEntries(s)} build={build} onOpen={goTo} />)
            )}
          </div>
        </div>
      </div>
    </Ctx.Provider>
  );
}

function Section({ section, prose, entries, build, onOpen }: { section: CodexSection; prose: MdBlock[]; entries: Entry[]; build: CardBuild; onOpen: (id: string) => void }) {
  return (
    <section className="cx-section" id={`codex-${section.id}`} aria-labelledby={`codex-${section.id}-title`}>
      <div className="cx-section-head">
        <h3 id={`codex-${section.id}-title`}>{section.title}</h3>
        <p className="dim">{section.blurb}</p>
      </div>
      {prose.length ? (
        <div className="cx-prose">
          <Blocks blocks={prose} />
        </div>
      ) : null}
      {entries.length ? (
        <div className="cx-cards">
          {entries.map((e) => (
            <div key={e.id} className="cx-card" data-entry={e.id}>
              <WordCard entry={e} build={build} onOpen={onOpen} codexLink={false} />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Blocks({ blocks }: { blocks: readonly MdBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h':
            return b.level <= 3 ? <h4 key={i}>{b.text}</h4> : <h5 key={i}>{b.text}</h5>;
          case 'p':
            return (
              <p key={i}>
                <Rich text={b.text} />
              </p>
            );
          case 'ul':
          case 'ol': {
            const List = b.t;
            return (
              <List key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Rich text={it} />
                  </li>
                ))}
              </List>
            );
          }
          case 'table':
            return (
              <div className="cx-table" key={i}>
                <table>
                  <thead>
                    <tr>
                      {b.head.map((h, j) => (
                        <th key={j}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, k) => (
                          <td key={k}>
                            <Rich text={c} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'code':
            return <pre key={i}>{b.text}</pre>;
        }
      })}
    </>
  );
}

/** Inline Markdown where every code span naming a word is a chip with its card on hover. */
function Rich({ text }: { text: string }): ReactNode {
  return inline(text).map((s, i) => {
    if (s.t === 'b') return <b key={i}>{s.text}</b>;
    if (s.t === 'i') return <i key={i}>{s.text}</i>;
    if (s.t === 'code') {
      const word = /^[a-z_][a-z0-9_.]*/i.exec(s.text)?.[0] ?? '';
      const e = word === s.text || `${word}(` === s.text.slice(0, word.length + 1) ? entryForWord(word) : null;
      return e ? (
        <Hover key={i} entry={e} className="lx-chip lx-chip-inline" kind={e.kind}>
          {s.text}
        </Hover>
      ) : (
        <code key={i}>{s.text}</code>
      );
    }
    return <Fragment key={i}>{s.text}</Fragment>;
  });
}

/** The Codex over everything else, closed with Escape or the close button. */
export function CodexDialog({ initial, build, onClose }: Props & { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="dialog-scrim cx-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cx-dialog" role="dialog" aria-modal="true" aria-label="Codex">
        <Codex initial={initial} build={build} onClose={onClose} />
      </div>
    </div>
  );
}
