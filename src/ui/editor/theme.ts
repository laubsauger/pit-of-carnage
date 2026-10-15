// Owned by: ui
// CodeMirror chrome in the game's stone palette: gutters, selection, tooltips, completion list,
// diagnostics (errors: red circle and wavy red underline; warnings: amber triangle and dotted
// amber underline, so they differ in shape as well as colour).
import { EditorView } from '@codemirror/view';

const svg = (s: string) => `url("data:image/svg+xml,${encodeURIComponent(s)}")`;

const WAVE = svg('<svg xmlns="http://www.w3.org/2000/svg" width="6" height="3"><path d="m0 2.5 l1.5 -2 l1.5 2 l1.5 -2 l1.5 2" fill="none" stroke="#da4a42" stroke-width=".9"/></svg>');
const ERROR_MARK = svg('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.6" fill="#c4302b"/><path d="M4.9 4.9l4.2 4.2M9.1 4.9l-4.2 4.2" stroke="#fff6f0" stroke-width="1.5" stroke-linecap="round"/></svg>');
const WARN_MARK = svg('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 14 14"><path d="M7 1.6 12.6 12H1.4z" fill="#c9a55a"/><path d="M7 5.4v3" stroke="#1f1c19" stroke-width="1.5" stroke-linecap="round"/><circle cx="7" cy="10.1" r=".85" fill="#1f1c19"/></svg>');

export const strategyTheme = EditorView.theme(
  {
    '&': {
      color: 'var(--text)',
      backgroundColor: 'var(--stone-0)',
      fontSize: '12.5px',
      height: '100%',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'var(--font-num)',
      lineHeight: '1.65',
      fontVariantLigatures: 'none',
    },
    '.cm-content': { padding: '12px 0 48px', caretColor: 'var(--text)' },
    '.cm-line': { padding: '0 16px 0 10px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)', borderLeftWidth: '1.5px' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'rgba(196, 48, 43, 0.32) !important',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(232, 226, 217, 0.025)' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(232, 226, 217, 0.08)' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'transparent',
      outline: '1px solid var(--stone-5)',
      borderRadius: '2px',
      color: 'var(--text) !important',
    },
    '.cm-nonmatchingBracket': { color: 'var(--blood-hi) !important' },
    '.cm-gutters': {
      backgroundColor: 'var(--stone-0)',
      color: 'var(--text-faint)',
      borderRight: '1px solid var(--stone-2)',
      fontSize: '11px',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 10px', minWidth: '34px' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-dim)' },
    '.cm-foldGutter .cm-gutterElement': { padding: '0 4px', color: 'var(--stone-5)', cursor: 'pointer' },
    '.cm-foldGutter .cm-gutterElement:hover': { color: 'var(--text-dim)' },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--stone-3)',
      border: 'none',
      color: 'var(--text-dim)',
      padding: '0 6px',
      borderRadius: '3px',
    },

    // Diagnostics
    '.cm-lintRange-error': { backgroundImage: WAVE, backgroundColor: 'rgba(196, 48, 43, 0.1)' },
    '.cm-lintRange-warning': {
      backgroundImage: 'none',
      textDecoration: 'underline dotted #c9a55a',
      textDecorationThickness: '1.5px',
      textUnderlineOffset: '4px',
      textDecorationSkipInk: 'none',
    },
    '.cm-lintRange-active': { backgroundColor: 'rgba(232, 226, 217, 0.08)' },
    '.cm-gutter-lint': { width: '18px' },
    '.cm-gutter-lint .cm-gutterElement': { padding: '0 0 0 3px' },
    '.cm-lint-marker': { width: '13px', height: '13px', marginTop: '3px', cursor: 'help' },
    '.cm-lint-marker-error': { content: ERROR_MARK },
    '.cm-lint-marker-warning': { content: WARN_MARK },
    '.cm-diagnostic': { padding: '7px 10px', borderLeft: 'none', marginLeft: '0' },
    '.cm-diagnostic + .cm-diagnostic': { borderTop: '1px solid var(--stone-3)' },
    '.cm-diagnostic-error, .cm-diagnostic-warning': { borderLeft: 'none' },
    '.cm-diagnosticAction': {
      marginLeft: '24px',
      marginTop: '6px',
      padding: '2px 8px',
      borderRadius: 'var(--r-ctl)',
      backgroundColor: 'var(--stone-3)',
      color: 'var(--text)',
      fontFamily: 'var(--font-num)',
      fontSize: '11px',
      border: '1px solid var(--stone-5)',
    },
    '.cm-diagnosticAction:hover': { backgroundColor: 'var(--stone-4)' },

    // Tooltips (hover cards, diagnostics, completion info)
    '.cm-tooltip': {
      backgroundColor: 'var(--stone-2)',
      border: '1px solid var(--stone-4)',
      borderRadius: 'var(--r-panel)',
      boxShadow: '0 10px 30px rgba(0, 0, 0, 0.55)',
      color: 'var(--text)',
    },
    // Not on the completion list: its info card hangs outside it.
    '.cm-tooltip-hover, .cm-tooltip-lint': { overflow: 'hidden' },
    '.cm-tooltip-hover': { maxHeight: '70vh', overflowY: 'auto' },
    '.cm-tooltip-section:not(:first-child)': { borderTop: '1px solid var(--stone-4)' },
    '.cm-tooltip.cm-tooltip-arrow:before, .cm-tooltip.cm-tooltip-arrow:after': { display: 'none' },
    '.cm-tooltip-lint': { padding: '0' },

    // Completion
    '.cm-tooltip.cm-tooltip-autocomplete': { padding: '4px 0' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': {
      fontFamily: 'var(--font-num)',
      fontSize: '12px',
      maxHeight: '18em',
      minWidth: '220px',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 10px 2px 8px', lineHeight: '1.6' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--stone-4)', color: 'var(--text)' },
    '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--text)', fontWeight: '700' },
    '.cm-completionDetail': { marginLeft: '12px', color: 'var(--text-faint)', fontStyle: 'normal', fontSize: '11px' },
    '.cm-completionInfo': {
      padding: '0',
      maxWidth: 'none',
      backgroundColor: 'var(--stone-2)',
      border: '1px solid var(--stone-4)',
      borderRadius: 'var(--r-panel)',
    },
    '.cm-snippetField': { backgroundColor: 'rgba(232, 226, 217, 0.09)', borderRadius: '2px' },

    // Search panel
    '.cm-panels': { backgroundColor: 'var(--stone-1)', color: 'var(--text)', borderColor: 'var(--stone-3)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--stone-3)' },
    '.cm-panel.cm-search': { padding: '6px 10px', fontFamily: 'var(--font-ui)', fontSize: '12px' },
    '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontSize: '12px' },
    '.cm-textfield': {
      backgroundColor: 'var(--stone-0)',
      border: '1px solid var(--stone-4)',
      borderRadius: 'var(--r-ctl)',
      color: 'var(--text)',
      padding: '2px 6px',
    },
    '.cm-button': {
      backgroundImage: 'none',
      backgroundColor: 'var(--stone-2)',
      border: '1px solid var(--stone-4)',
      borderRadius: 'var(--r-ctl)',
      color: 'var(--text)',
    },
    '.cm-searchMatch': { backgroundColor: 'rgba(220, 192, 126, 0.22)', outline: '1px solid rgba(220, 192, 126, 0.4)' },
    '.cm-searchMatch-selected': { backgroundColor: 'rgba(220, 192, 126, 0.4)' },
  },
  { dark: true },
);
