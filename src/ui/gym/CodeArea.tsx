// Owned by: ui
import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from '@codemirror/language';
import { lintGutter, lintKeymap, setDiagnostics } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Annotation, EditorState, Prec } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import type { IssueSpan } from '../editor';
import { completionDot, completionSource, flashExtension, hangingIndent, revealAndFlash, scanField, strategyHighlighting, toDiagnostics, wordHover } from '../editor/cm';
import { strategyTheme } from '../editor/theme';
import type { CardBuild } from '../editor/WordCard';
import '../editor/editor.css';

/** What the strategy editor can do with the code view. */
export type CodeAreaApi = {
  /** Select `from..to`, scroll it to the middle and flash it. */
  reveal(from: number, to: number): void;
  focus(): void;
  /** The text in the view right now (may be ahead of React state by one keystroke). */
  text(): string;
};

type Props = {
  apiRef: MutableRefObject<CodeAreaApi | null>;
  /** What the player is typing. */
  text: string;
  onChange: (text: string) => void;
  /** The text the issues were found in (validation runs on a deferred copy, a keystroke behind at most). */
  checked: string;
  /** Issues placed in `checked`. */
  spans: readonly IssueSpan[];
  onCaret: (offset: number) => void;
  onSave: () => void;
  /** The build being edited, for attribute hover cards. */
  build: CardBuild;
  /** "Open in the Codex" and related words on hover cards. */
  onOpenCodex: (id: string) => void;
};

/** Marks text changes that came from React (load, format, the visual builder), not from typing. */
const External = Annotation.define<boolean>();

/**
 * The strategy JSON in CodeMirror 6: highlighting with recognised words as badges, hover cards for
 * every property and word, completion from the registry, the gate's errors and warnings in place
 * (gutter icons, underlines, tooltips with the fix), and the flash the problem list jumps to.
 * React owns the text; the view follows it with minimal edits so undo, the caret and scroll survive
 * changes from the visual builder.
 */
export function CodeArea({ apiRef, text, onChange, checked, spans, onCaret, onSave, build, onOpenCodex }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Callbacks change every render; the view is built once and reads them through this ref.
  const live = useRef({ onChange, onCaret, onSave, build, onOpenCodex });
  live.current = { onChange, onCaret, onSave, build, onOpenCodex };

  useEffect(() => {
    if (!host.current) return;
    const cards = { build: () => live.current.build, open: (id: string) => live.current.onOpenCodex(id) };
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
          foldGutter({ markerDOM: (open) => Object.assign(document.createElement('span'), { textContent: open ? '▾' : '▸' }) }),
          lintGutter({ hoverTime: 150 }),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          EditorView.lineWrapping,
          hangingIndent,
          EditorState.tabSize.of(2),
          indentUnit.of('  '),
          json(),
          scanField,
          strategyHighlighting,
          wordHover(cards),
          autocompletion({ override: [completionSource(cards)], icons: false, addToOptions: [completionDot], activateOnTypingDelay: 80 }),
          flashExtension,
          strategyTheme,
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-s',
                preventDefault: true,
                run: () => {
                  live.current.onSave();
                  return true;
                },
              },
            ]),
          ),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
          EditorView.contentAttributes.of({ 'aria-label': 'Strategy JSON', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
          // A dropped file goes to the import dialog (the editor's drop handler), never into the text.
          EditorView.domEventHandlers({ drop: (e) => Boolean(e.dataTransfer?.files.length) }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((tr) => tr.annotation(External))) live.current.onChange(u.state.doc.toString());
            if (u.selectionSet || u.docChanged) live.current.onCaret(u.state.selection.main.head);
          }),
        ],
      }),
    });
    view.current = v;
    apiRef.current = {
      reveal: (from, to) => revealAndFlash(v, from, to),
      focus: () => v.focus(),
      text: () => v.state.doc.toString(),
    };
    return () => {
      apiRef.current = null;
      view.current = null;
      v.destroy();
    };
    // The view is created once; `text` changes arrive through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Text changed outside the view: apply the smallest edit that turns the view's text into it.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur === text) return;
    let start = 0;
    const max = Math.min(cur.length, text.length);
    while (start < max && cur.charCodeAt(start) === text.charCodeAt(start)) start++;
    let endCur = cur.length;
    let endNew = text.length;
    while (endCur > start && endNew > start && cur.charCodeAt(endCur - 1) === text.charCodeAt(endNew - 1)) {
      endCur--;
      endNew--;
    }
    v.dispatch({ changes: { from: start, to: endCur, insert: text.slice(start, endNew) }, annotations: External.of(true) });
  }, [text]);

  // The gate's issues, once they describe the text in the view (validation trails typing slightly).
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() !== checked) return;
    v.dispatch(setDiagnostics(v.state, toDiagnostics(checked, spans)));
  }, [checked, spans, text]);

  return <div ref={host} className="code-cm" />;
}
