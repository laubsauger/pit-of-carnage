// Owned by: ui
import { useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { lineSeverity, underlineSpans } from '../editor';
import type { IssueSpan } from '../editor';

type Props = {
  areaRef: RefObject<HTMLTextAreaElement>;
  /** What the player is typing. */
  text: string;
  /** The text the issues were found in (validation runs on a deferred copy, a keystroke behind at most). */
  checked: string;
  /** Issues placed in `checked`. */
  spans: readonly IssueSpan[];
  onChange: (text: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onCaret: (offset: number) => void;
  /** Clicking a marked line number. */
  onJump: (span: IssueSpan) => void;
};

/**
 * The strategy text with its problems drawn in place: a gutter of line numbers flagging lines with
 * problems, and underlines under the exact token. The underlines live in a mirror of the text behind
 * the transparent textarea, so typing stays a plain, fast textarea.
 */
export function CodeArea({ areaRef, text, checked, spans, onChange, onKeyDown, onCaret, onJump }: Props) {
  const mirror = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lines = text.split('\n').length;
  const marks = lineSeverity(spans);

  const sync = () => {
    const t = areaRef.current;
    if (!t) return;
    if (mirror.current) {
      mirror.current.scrollTop = t.scrollTop;
      mirror.current.scrollLeft = t.scrollLeft;
    }
    if (gutter.current) gutter.current.style.transform = `translateY(${-t.scrollTop}px)`;
  };
  // Text changes and programmatic jumps move the scroll position without a scroll event.
  useLayoutEffect(sync);

  return (
    <div className="code-wrap">
      <div className="code-gutter" aria-hidden>
        <div ref={gutter}>
          {Array.from({ length: lines }, (_, i) => {
            const sev = marks.get(i + 1);
            const first = sev ? spans.find((s) => s.line === i + 1) : undefined;
            return (
              <div key={i} className={`ln${sev ? ` ${sev}` : ''}`} onClick={first ? () => onJump(first) : undefined}>
                {i + 1}
              </div>
            );
          })}
        </div>
      </div>
      <div className="code-stack">
        <pre ref={mirror} className="code code-mirror" aria-hidden>
          {mirrorContent(checked, spans)}
        </pre>
        <textarea
          ref={areaRef}
          className="code code-input"
          value={text}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Strategy JSON"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={sync}
          onSelect={(e) => onCaret(e.currentTarget.selectionStart)}
        />
      </div>
    </div>
  );
}

function mirrorContent(text: string, spans: readonly IssueSpan[]): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const s of underlineSpans(spans)) {
    if (s.start > at) out.push(text.slice(at, s.start));
    out.push(
      <mark key={s.start} className={s.severity}>
        {text.slice(s.start, s.end)}
      </mark>,
    );
    at = s.end;
  }
  // Trailing lines keep the mirror at least as tall as the textarea's scroll range.
  out.push(`${text.slice(at)}\n\n\n`);
  return out;
}
