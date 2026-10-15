// Owned by: ui
// CodeMirror 6 extensions for strategy JSON: a scan of the text kept in editor state, highlighting
// that renders every recognised word as a subtle badge, hover cards for every property and word,
// completion from the registry, diagnostics from the gate, and the flash the problem list uses.
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { snippetCompletion } from '@codemirror/autocomplete';
import type { Diagnostic } from '@codemirror/lint';
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, hoverTooltip } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import type { ValidationIssue } from '../../core';
import { ATTACK_POLICY_NAMES, ENEMIES_WORD, FIGHTER_REFS, PICKUP_ARG_WORDS, PLACES, ZONES } from '../../brain';
import type { ArgSpec } from '../../brain';
import type { IssueSpan } from '../editor';
import { SEVERITY_SVG, fixText, suggestionLine } from './issues';
import { scanJson, slotAt, stringContent, tokenAt } from './jsontext';
import type { JsonScan, JsonToken, PathSeg } from './jsontext';
import { ENUM_VALUES, expressionWords, keysFor, lexExpr, memoryNames, slotOf, wordKind } from './language';
import type { EnumKind, Slot } from './language';
import { entryById, entryForWord, fieldEntry } from './lexicon';
import type { Entry, EntryKind } from './lexicon';
import { WordCard } from './WordCard';
import type { CardBuild } from './WordCard';

// ---------------------------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------------------------

/** The lenient JSON scan of the current text, redone on every change (about 1 ms at the size limit). */
export const scanField = StateField.define<JsonScan>({
  create: (state) => scanJson(state.doc.toString()),
  update: (scan, tr) => (tr.docChanged ? scanJson(tr.state.doc.toString()) : scan),
});

const ENUM_KIND: Readonly<Record<EnumKind, EntryKind>> = {
  weapon: 'weapon',
  skill: 'skill',
  stance: 'stance',
  starter: 'starter',
  direction: 'direction',
  schema: 'field',
};

function isWordSlot(slot: Slot): boolean {
  return slot.kind === 'expr' || slot.kind === 'attack' || slot.kind === 'place' || slot.kind === 'zone';
}

/** Keys that are words themselves: attribute names and move-term kinds. */
function keyWord(path: readonly PathSeg[]): { kind: EntryKind; attr?: string } | null {
  const [a, b, c, d] = path;
  if (a === 'build' && b === 'attributes' && path.length === 3) return { kind: 'attribute', attr: String(path[2]) };
  if (a === 'behaviours' && c === 'move' && typeof d === 'number' && path.length === 5 && path[4] !== 'weight') return { kind: 'term' };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------------------------

const markCache = new Map<string, Decoration>();

function mark(cls: string, kind?: string, attr?: string): Decoration {
  const key = `${cls}|${kind ?? ''}|${attr ?? ''}`;
  let d = markCache.get(key);
  if (!d) {
    const attributes: Record<string, string> = {};
    if (kind) attributes['data-kind'] = kind;
    if (attr) attributes['data-attr'] = attr;
    d = Decoration.mark({ class: cls, attributes });
    markCache.set(key, d);
  }
  return d;
}

const PUNCT = mark('cm-j-punct');

function decorateString(b: RangeSetBuilder<Decoration>, text: string, t: JsonToken, memory: ReadonlySet<string>): void {
  const slot = slotOf(t.path);
  const { from, to } = stringContent(t);
  const content = text.slice(from, to);
  b.add(t.from, t.from + 1, PUNCT);
  if (slot.kind === 'enum' && ENUM_VALUES[slot.of].includes(content) && slot.of !== 'schema') {
    b.add(from, to, mark('cm-w', ENUM_KIND[slot.of]));
  } else if (isWordSlot(slot) && !content.includes('\\') && content.length) {
    for (const x of lexExpr(content)) {
      const xf = from + x.from;
      const xt = from + x.to;
      if (x.kind === 'name') {
        const kind = wordKind(x.text, slot, memory);
        b.add(xf, xt, kind ? mark('cm-w', kind) : mark('cm-x-unknown'));
      } else if (x.kind === 'num') b.add(xf, xt, mark('cm-x-num'));
      else if (x.kind === 'op') b.add(xf, xt, mark('cm-x-op'));
      else if (x.kind === 'bad') b.add(xf, xt, mark('cm-j-bad'));
      else b.add(xf, xt, mark('cm-x-paren'));
    }
  } else if (to > from) {
    b.add(from, to, mark('cm-j-str'));
  }
  if (t.closed) b.add(t.to - 1, t.to, PUNCT);
}

function buildDecorations(view: EditorView): DecorationSet {
  const scan = view.state.field(scanField);
  const text = view.state.doc.toString();
  const memory = memoryNames(scan.tokens);
  const b = new RangeSetBuilder<Decoration>();
  const { from, to } = view.viewport;
  {
    for (const t of scan.tokens) {
      if (t.to < from) continue;
      if (t.from > to) break;
      switch (t.kind) {
        case 'key': {
          const w = keyWord(t.path);
          b.add(t.from, t.to, w ? mark('cm-j-key cm-w cm-w-key', w.kind, w.attr) : mark('cm-j-key'));
          break;
        }
        case 'string':
          decorateString(b, text, t, memory);
          break;
        case 'number':
          b.add(t.from, t.to, mark('cm-j-num'));
          break;
        case 'literal':
          b.add(t.from, t.to, mark('cm-j-lit'));
          break;
        case 'bad':
          b.add(t.from, t.to, mark('cm-j-bad'));
          break;
        default:
          b.add(t.from, t.to, PUNCT);
      }
    }
  }
  return b.finish();
}

export const strategyHighlighting = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// ---------------------------------------------------------------------------------------------
// Wrapped lines keep their indentation
// ---------------------------------------------------------------------------------------------

const indentDeco = new Map<number, Decoration>();

/** A wrapped line continues 4 columns right of where it starts, not at the left edge. */
function hanging(n: number): Decoration {
  let d = indentDeco.get(n);
  if (!d) {
    d = Decoration.line({ attributes: { style: `padding-left: calc(${n + 4}ch + 10px); text-indent: -${n + 4}ch` } });
    indentDeco.set(n, d);
  }
  return d;
}

function indentDecorations(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const n = /^ */.exec(line.text)![0].length;
      b.add(line.from, line.from, hanging(n));
      pos = line.to + 1;
    }
  }
  return b.finish();
}

export const hangingIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = indentDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = indentDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// ---------------------------------------------------------------------------------------------
// What is at a position
// ---------------------------------------------------------------------------------------------

export type WordAt = { entry: Entry; from: number; to: number };

/** The entry for whatever sits at `pos`: a property key, an enum value, a word inside an expression. */
export function wordAt(state: EditorState, pos: number): WordAt | null {
  const scan = state.field(scanField);
  const t = tokenAt(scan.tokens, pos);
  if (!t) return null;
  if (t.kind === 'key') {
    const entry = fieldEntry(t.path);
    return entry ? { entry, from: t.from, to: t.to } : null;
  }
  if (t.kind === 'number' || t.kind === 'literal') {
    const entry = fieldEntry(t.path);
    return entry ? { entry, from: t.from, to: t.to } : null;
  }
  if (t.kind !== 'string') return null;
  const slot = slotOf(t.path);
  const { from, to } = stringContent(t);
  const content = state.doc.sliceString(from, to);
  if (slot.kind === 'enum') {
    const entry = slot.of === 'schema' ? fieldEntry(['schema']) : entryForWord(content, ENUM_KIND[slot.of]);
    return entry ? { entry, from, to } : null;
  }
  if (!isWordSlot(slot) || content.includes('\\')) return null;
  const memory = memoryNames(scan.tokens);
  for (const x of lexExpr(content)) {
    if (x.kind !== 'name' || pos < from + x.from || pos > from + x.to) continue;
    const kind = wordKind(x.text, slot, memory);
    if (kind === 'memory') {
      const entry = fieldEntry(['memory', x.text]);
      return entry ? { entry: { ...entry, title: x.text, word: x.text }, from: from + x.from, to: from + x.to } : null;
    }
    const entry = entryForWord(x.text, kind ?? undefined);
    if (!entry) return null;
    // `it.hp` and `target.hp` share a card; head it with the word as written.
    return { entry: entry.kind === 'fighter-sensor' ? { ...entry, title: x.text } : entry, from: from + x.from, to: from + x.to };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Cards in tooltips
// ---------------------------------------------------------------------------------------------

/** What cards need from the editor around them. */
export type CardContext = { build: () => CardBuild; open: (id: string) => void };

/** A WordCard rendered into a detached element (tooltips and completion info live outside React). */
export function mountCard(entry: Entry, ctx: CardContext, compact = false): { dom: HTMLElement; destroy: () => void } {
  const dom = document.createElement('div');
  dom.className = 'lx-host';
  const root = createRoot(dom);
  flushSync(() => root.render(createElement(WordCard, { entry, build: ctx.build(), onOpen: ctx.open, compact })));
  // Unmounting inside CodeMirror's update cycle is fine, but never during a React render.
  return { dom, destroy: () => queueMicrotask(() => root.unmount()) };
}

export function wordHover(ctx: CardContext): Extension {
  return hoverTooltip(
    (view, pos) => {
      const w = wordAt(view.state, pos);
      if (!w) return null;
      return { pos: w.from, end: w.to, above: true, create: () => mountCard(w.entry, ctx) };
    },
    { hoverTime: 350 },
  );
}

// ---------------------------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------------------------

function argDefault(a: ArgSpec): string {
  switch (a.kind) {
    case 'fighter':
      return 'target';
    case 'fighters':
      return ENEMIES_WORD;
    case 'place':
      return 'target';
    case 'pickup':
      return 'any';
    case 'number': {
      const lo = a.min ?? 0;
      const hi = a.max ?? 100;
      return String(lo <= 40 && 40 <= hi ? 40 : lo);
    }
  }
}

function option(entry: Entry | null, label: string, kind: string, ctx: CardContext, template?: string): Completion {
  const base: Completion = {
    label,
    type: kind,
    detail: entry?.range ?? entry?.unit ?? undefined,
    info: entry ? () => mountCard(entry, ctx, true) : undefined,
    boost: kind === 'sensor' || kind === 'fighter-sensor' ? 1 : 0,
  };
  return template ? snippetCompletion(template, base) : base;
}

function callTemplate(name: string, args: readonly ArgSpec[]): string | undefined {
  return args.length ? `${name}(${args.map((a) => `\${${argDefault(a)}}`).join(', ')})` : undefined;
}

function placeOptions(zone: boolean, ctx: CardContext): Completion[] {
  const out: Completion[] = [];
  for (const r of FIGHTER_REFS) out.push(option(entryById(`fighter:${r.name}`), r.name, 'fighter', ctx));
  out.push(option(entryById(`enemies:${ENEMIES_WORD}`), ENEMIES_WORD, 'enemies', ctx));
  for (const w of PICKUP_ARG_WORDS) out.push(option(entryById(`pickup-word:${w}`), w, 'pickup-word', ctx));
  if (zone) for (const z of ZONES) out.push(option(entryById(`zone:${z.name}`), z.name, 'zone', ctx, callTemplate(z.name, z.args)));
  else for (const p of PLACES) out.push(option(entryById(`place:${p.name}`), p.name, 'place', ctx, callTemplate(p.name, p.args)));
  return out;
}

function wordOptions(slot: Slot, memory: Set<string>, ctx: CardContext): Completion[] {
  if (slot.kind === 'place' || slot.kind === 'zone') return placeOptions(slot.kind === 'zone', ctx);
  const scope = slot.kind === 'expr' ? slot.scope : 'behaviour';
  const out = expressionWords(scope, memory).map(({ word, kind }) => {
    const entry = kind === 'memory' ? fieldEntry(['memory', word]) : entryForWord(word, kind);
    return option(entry, word, kind, ctx, kind === 'function' ? `${word}(\${})` : undefined);
  });
  if (slot.kind === 'attack') for (const p of ATTACK_POLICY_NAMES) out.unshift(option(entryById(`policy:${p}`), p, 'policy', ctx));
  return out;
}

const KEY_TEMPLATE: Readonly<Record<string, string>> = {
  score: '"score": "${}"',
  skill: '"skill": "${}"',
  target: '"target": "${}"',
  attack: '"attack": "${in_range}"',
  move: '"move": [${}]',
  set: '"set": { ${} }',
  memory: '"memory": { ${} }',
  barks: '"barks": { ${} }',
  imports: '"imports": [${}]',
  look: '"look": { ${} }',
  commit: '"commit": ${30}',
  weight: '"weight": ${1}',
  stance: '"stance": "${normal}"',
  seek: '"seek": "${target}"',
  flee: '"flee": "${nearest_enemy}"',
  avoid: '"avoid": "${hazards}"',
  prefer: '"prefer": "${shadow}"',
  keep_range: '"keep_range": ["${target}", ${180}, ${260}]',
  orbit: '"orbit": ["${target}", "${cw}"]',
};

/** Completion from the registry, aware of where the caret is in the JSON. */
export function completionSource(ctx: CardContext) {
  return (cx: CompletionContext): CompletionResult | null => {
    const scan = cx.state.field(scanField);
    const t = tokenAt(scan.tokens, cx.pos);
    const memory = memoryNames(scan.tokens);
    if (t && (t.kind === 'key' || t.kind === 'string')) {
      const { from, to } = stringContent(t);
      if (cx.pos < from) return null;
      if (t.kind === 'key') {
        const parent = t.path.slice(0, -1);
        const keys = keysFor(parent);
        if (!keys) return null;
        const options = keys.map(({ key, required }) => {
          const entry = fieldEntry([...parent, key]);
          const kw = parent[0] === 'build' && parent[1] === 'attributes' ? 'attribute' : parent.length === 4 && key !== 'weight' ? 'term' : 'field';
          return { ...option(entry, key, kw, ctx), detail: required ? 'required' : undefined };
        });
        return { from, to, options, validFor: /^[\w$]*$/ };
      }
      const slot = slotOf(t.path);
      if (slot.kind === 'enum') {
        const kind = ENUM_KIND[slot.of];
        const options = ENUM_VALUES[slot.of].map((v) => option(slot.of === 'schema' ? null : entryForWord(v, kind), v, kind, ctx));
        return { from, to, options, validFor: /^[\w/-]*$/ };
      }
      if (!isWordSlot(slot)) return null;
      const before = cx.state.doc.sliceString(from, cx.pos);
      const word = /[A-Za-z_][\w.]*$|$/.exec(before)![0];
      if (!word && !cx.explicit && !/[(\s,]$|^$/.test(before)) return null;
      return { from: cx.pos - word.length, options: wordOptions(slot, memory, ctx), validFor: /^[\w.]*$/ };
    }
    // Between tokens: a new key in an object.
    if (t) return null;
    const at = slotAt(cx.state.doc.toString(), cx.pos);
    if (at?.at !== 'key') return null;
    const keys = keysFor(at.object);
    if (!keys) return null;
    const typed = cx.matchBefore(/\w*$/);
    if (!cx.explicit && !typed?.text) return null;
    const options = keys.map(({ key, required }) => {
      const entry = fieldEntry([...at.object, key]);
      const template = KEY_TEMPLATE[key] ?? `"${key}": \${}`;
      return { ...option(entry, key, 'field', ctx, template), detail: required ? 'required' : undefined };
    });
    return { from: typed?.from ?? cx.pos, options, validFor: /^\w*$/ };
  };
}

/** A coloured dot before each option, in its kind colour. */
export const completionDot = {
  render: (c: Completion): Node => {
    const dot = document.createElement('span');
    dot.className = 'cx-dot';
    dot.setAttribute('data-kind', c.type ?? 'field');
    return dot;
  },
  position: 20,
};

// ---------------------------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------------------------

function severityIcon(severity: ValidationIssue['severity']): HTMLElement {
  const span = document.createElement('span');
  span.className = 'dx-icon';
  span.innerHTML = SEVERITY_SVG[severity];
  return span;
}

export function toDiagnostics(text: string, spans: readonly IssueSpan[]): Diagnostic[] {
  return spans.map((sp) => {
    const { issue } = sp;
    const fix = fixText(text, sp, issue.suggestion);
    return {
      from: sp.start,
      to: Math.max(sp.end, sp.start + 1),
      severity: issue.severity,
      message: issue.message,
      renderMessage: () => {
        const root = document.createElement('div');
        root.className = `dx dx-${issue.severity}`;
        root.appendChild(severityIcon(issue.severity));
        const msg = document.createElement('div');
        msg.className = 'dx-msg';
        const b = document.createElement('b');
        b.textContent = issue.severity === 'error' ? 'Error' : 'Warning';
        msg.append(b, issue.message);
        root.appendChild(msg);
        if (issue.suggestion) {
          const s = document.createElement('div');
          s.className = 'dx-fix';
          s.textContent = suggestionLine(issue.suggestion);
          root.appendChild(s);
        }
        if (issue.path) {
          const p = document.createElement('div');
          p.className = 'dx-path';
          p.textContent = issue.path;
          root.appendChild(p);
        }
        return root;
      },
      actions: fix
        ? [
            {
              name: `Use ${issue.suggestion}`,
              apply: (view: EditorView, from: number, to: number) => view.dispatch({ changes: { from, to, insert: fix } }),
            },
          ]
        : undefined,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Flash
// ---------------------------------------------------------------------------------------------

const flashEffect = StateEffect.define<{ from: number; to: number } | null>();

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(flashEffect)) continue;
      if (!e.value) deco = Decoration.none;
      else {
        const line = tr.state.doc.lineAt(e.value.from);
        deco = Decoration.set([
          Decoration.line({ class: 'cm-flash-line' }).range(line.from),
          Decoration.mark({ class: 'cm-flash' }).range(e.value.from, Math.max(e.value.to, e.value.from + 1)),
        ]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const flashExtension: Extension = flashField;

/** Select the spot, scroll it to the middle of the view and flash it. */
export function revealAndFlash(view: EditorView, from: number, to: number): void {
  const len = view.state.doc.length;
  const a = Math.max(0, Math.min(from, len));
  const b = Math.max(a, Math.min(to, len));
  view.dispatch({
    selection: { anchor: a, head: b },
    effects: [EditorView.scrollIntoView(a, { y: 'center' }), flashEffect.of({ from: a, to: b })],
  });
  view.focus();
  window.setTimeout(() => {
    // The view may be gone by then (tab switched, editor closed).
    if (view.dom.isConnected) view.dispatch({ effects: flashEffect.of(null) });
  }, 1200);
}
