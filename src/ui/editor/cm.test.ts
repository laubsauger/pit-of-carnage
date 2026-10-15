import { describe, expect, it } from 'vitest';
import { CompletionContext } from '@codemirror/autocomplete';
import type { CompletionResult } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { FIGHTER_SENSORS, PLACES } from '../../brain';
import { HOUSE_STACKS, loadStrategy } from '../../strategy';
import { placeIssues, prettyJson } from '../editor';
import { completionSource, scanField, toDiagnostics, wordAt } from './cm';

const cards = { build: () => null, open: () => {} };
const complete = completionSource(cards);

function stateWith(text: string) {
  return EditorState.create({ doc: text, extensions: [scanField] });
}

/** Completion at the `|` in `text`. */
function optionsAt(textWithCaret: string, explicit = false): { result: CompletionResult | null; labels: string[] } {
  const pos = textWithCaret.indexOf('|');
  const text = textWithCaret.replace('|', '');
  const result = complete(new CompletionContext(stateWith(text), pos, explicit));
  return { result, labels: result ? result.options.map((o) => o.label) : [] };
}

describe('completion from the registry', () => {
  it('offers it.* in the target expression and never target.* (the compiler rejects it there)', () => {
    const { labels } = optionsAt('{ "target": "it.|" }');
    for (const d of FIGHTER_SENSORS) expect(labels).toContain(`it.${d.key}`);
    expect(labels.some((l) => l.startsWith('target.'))).toBe(false);
  });

  it('offers target.*, self sensors, memory slots and functions in a behaviour score', () => {
    const { labels, result } = optionsAt('{ "memory": { "struck_at": 0 }, "behaviours": { "a": { "score": "0.5 + sel|" } } }');
    expect(labels).toContain('target.hp');
    expect(labels).toContain('self.hp');
    expect(labels).toContain('struck_at');
    expect(labels).toContain('clamp');
    expect(labels).not.toContain('it.hp');
    // It completes the word being typed, not the whole string.
    expect(result!.from).toBe('{ "memory": { "struck_at": 0 }, "behaviours": { "a": { "score": "0.5 + '.length);
  });

  it('offers places with their arguments filled in where a move term wants a place', () => {
    const { labels, result } = optionsAt('{ "behaviours": { "a": { "move": [{ "seek": "|", "weight": 1 }] } } }');
    for (const p of PLACES) expect(labels).toContain(p.name);
    expect(labels).toContain('nearest_enemy');
    expect(labels).not.toContain('shadow');
    // `behind` comes with its arguments, so what gets inserted already validates.
    const behind = result!.options.find((o) => o.label === 'behind')!;
    expect(typeof behind.apply).toBe('function');
  });

  it('offers zones where avoid wants one, and the policies where attack is written', () => {
    expect(optionsAt('{ "behaviours": { "a": { "move": [{ "avoid": "|" }] } } }').labels).toContain('seen_by');
    const attack = optionsAt('{ "behaviours": { "a": { "attack": "|" } } }').labels;
    expect(attack.slice(0, 3).sort()).toEqual(['if_blocked', 'in_range', 'never']);
  });

  it('offers the real weapons, and the keys a behaviour takes', () => {
    expect(optionsAt('{ "build": { "weapon": "L|" } }').labels).toEqual(['GREATSWORD', 'WARHAMMER', 'TWIN_DAGGERS', 'THROWING_AXES', 'LONGBOW', 'ARCANE_STAFF']);
    const keys = optionsAt('{ "behaviours": { "a": { "sc|" } } }').labels;
    expect(keys).toEqual(['score', 'move', 'attack', 'skill', 'set', 'stance']);
  });

  it('offers new keys between properties, as snippets with a value to fill in', () => {
    const { labels } = optionsAt('{\n  "behaviours": { "a": { "score": "1",\n    |\n  } }\n}', true);
    expect(labels).toContain('move');
    expect(labels).toContain('stance');
  });

  it('stays quiet inside names and free text', () => {
    expect(optionsAt('{ "name": "Ga|" }').result).toBeNull();
  });
});

describe('hover lookup', () => {
  const text = prettyJson(HOUSE_STACKS[0]);
  const state = stateWith(text);

  it('finds the card for a sensor inside an expression, headed with the word as written', () => {
    const i = text.indexOf('it.');
    expect(i).toBeGreaterThan(0);
    const w = wordAt(state, i + 3)!;
    expect(w.entry.kind).toBe('fighter-sensor');
    expect(w.entry.title.startsWith('it.')).toBe(true);
    expect(text.slice(w.from, w.to)).toBe(w.entry.title);
  });

  it('finds the card for a property key, an attribute and a weapon value', () => {
    expect(wordAt(state, text.indexOf('"commit"') + 2)?.entry.id).toBe('field:commit');
    expect(wordAt(state, text.indexOf('"vitality"') + 2)?.entry.id).toBe('attribute:vitality');
    const weapon = HOUSE_STACKS[0]!.build.weapon;
    expect(wordAt(state, text.indexOf(`"${weapon}"`) + 2)?.entry.id).toBe(`weapon:${weapon}`);
  });

  it('shows nothing over punctuation and whitespace', () => {
    expect(wordAt(state, 0)).toBeNull();
  });
});

describe('diagnostics', () => {
  it('turns every gate issue into an underline with the message, and a fix when there is a word to use', () => {
    const s = HOUSE_STACKS[0]!;
    const [name, b] = Object.entries(s.behaviours)[0]!;
    const broken = prettyJson({ ...s, behaviours: { ...s.behaviours, [name]: { ...b, score: 'enemies_sen * 0.5' } } });
    const report = loadStrategy(broken, 'editor');
    const spans = placeIssues(broken, [...report.errors, ...report.warnings]);
    const diags = toDiagnostics(broken, spans);
    const d = diags.find((x) => x.severity === 'error')!;
    expect(broken.slice(d.from, d.to)).toBe('enemies_sen');
    expect(d.message).toMatch(/enemies_sen/);
    expect(d.actions?.[0]?.name).toBe('Use enemies_seen');
  });
});
