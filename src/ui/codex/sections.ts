// Owned by: ui
// The Codex's contents: the rulebook the LLM prompt is built from, cut into browsable sections,
// with the lexicon's cards for every word, build part and rule. Search runs over both.
import { STRATEGY_SCHEMA } from '../../core';
import { allEntries, rulebookMarkdown } from '../editor/lexicon';
import type { Entry, EntryKind } from '../editor/lexicon';
import { plain } from './markdown';
import type { MdBlock } from './markdown';

export type CodexSection = {
  id: string;
  title: string;
  /** One line under the title. */
  blurb: string;
  /** Rulebook headings whose text this section shows ("## Places" or "### Steering"), in order. */
  prose: string[];
  /** Only the first paragraph of the prose (the cards carry the rest). */
  intro?: boolean;
  /** Each heading's own text only, without its sub-headings. */
  shallow?: boolean;
  /** Which lexicon entries it shows as cards. */
  kinds: EntryKind[];
  filter?: (e: Entry) => boolean;
};

export const CODEX_SECTIONS: readonly CodexSection[] = [
  { id: 'intro', title: 'The pit', blurb: 'What a strategy is, and the units everything is measured in.', prose: [`# Pit of Carnage: strategy rulebook (${STRATEGY_SCHEMA})`], shallow: true, kinds: [] },
  { id: 'thinking', title: 'How a fighter thinks', blurb: 'Six steps, ten times a second.', prose: ['## How a fighter thinks'], kinds: [] },
  { id: 'knowing', title: 'What a fighter knows', blurb: 'Seen, heard, remembered: nobody is omniscient.', prose: ['## What a fighter knows'], kinds: [] },
  { id: 'document', title: 'The strategy document', blurb: 'Every field of the JSON.', prose: ['## The strategy document'], kinds: [] },
  { id: 'expressions', title: 'Expressions', blurb: 'Numbers, sensors, operators. No loops, no surprises.', prose: ['## Expressions'], kinds: ['function', 'keyword'] },
  { id: 'sensors', title: 'Sensors', blurb: 'What an expression can read about you and the world.', prose: ['## Sensors'], intro: true, kinds: ['sensor'] },
  { id: 'fighter-sensors', title: 'Fighter sensors', blurb: 'target.* in behaviours, it.* in the target expression.', prose: ['### Fighter sensors'], intro: true, kinds: ['fighter-sensor'] },
  { id: 'places', title: 'Places', blurb: 'Where a move term points: a fighter or a point.', prose: ['## Places'], intro: true, kinds: ['fighter', 'enemies', 'place', 'pickup-word'] },
  { id: 'zones', title: 'Zones', blurb: 'Areas with a strength at each point, for avoid and prefer.', prose: ['## Zones'], intro: true, kinds: ['zone'] },
  { id: 'terms', title: 'Move terms and steering', blurb: 'How a behaviour turns ratings into a heading.', prose: ['### Steering'], kinds: ['term', 'direction'] },
  { id: 'policies', title: 'Attack and skill policies', blurb: 'When to swing, when to fire the skill.', prose: ['## Attack and skill policies'], kinds: ['policy'] },
  { id: 'attributes', title: 'Attributes and derived stats', blurb: 'A hundred points, six attributes, every formula.', prose: ['## Builds'], intro: true, kinds: ['attribute', 'stat'] },
  { id: 'weapons', title: 'Weapons', blurb: 'Six ways to ruin someone’s afternoon.', prose: ['### Weapons'], intro: true, kinds: ['weapon'] },
  { id: 'skills', title: 'Skills and stances', blurb: 'One skill per build; stances per behaviour.', prose: [], kinds: ['skill', 'stance'] },
  { id: 'arena', title: 'Hazards, props and power-ups', blurb: 'Everything in the pit that is not a fighter.', prose: ['## The arena', '### Shrines and power-ups'], shallow: true, kinds: ['hazard', 'prop', 'pickup'] },
  { id: 'maps', title: 'Maps', blurb: 'Four arenas. Sensors and places work on all of them.', prose: [], kinds: ['map'] },
  { id: 'sudden-death', title: 'Sudden death', blurb: 'Hiding never wins: the walls close in.', prose: ['### Sudden death'], kinds: ['rule'], filter: (e) => e.word.startsWith('match.') },
  { id: 'validation', title: 'Validation and limits', blurb: 'One gate for every strategy, checked before the match.', prose: ['## Validation and safety'], kinds: ['limit'] },
  { id: 'barks', title: 'Barks', blurb: 'What your fighter says, and when.', prose: ['## Barks'], kinds: ['bark'] },
  { id: 'library', title: 'Starter library', blurb: 'Fifteen behaviours to import, and worked examples of the language.', prose: ['## Starter library'], intro: true, kinds: ['starter'] },
  { id: 'example', title: 'A complete strategy', blurb: 'One house stack, explained.', prose: ['## A complete strategy'], kinds: [] },
  { id: 'tips', title: 'Tips', blurb: 'What usually goes wrong, and the fix.', prose: ['## Tips'], kinds: [] },
  { id: 'rules', title: 'Rule tables', blurb: 'Every combat, perception and steering number.', prose: ['### Combat rules', '### Perception rules', '### Steering constants'], kinds: [] },
];

/** The blocks under a heading (`## Title` or `### Title`) up to the next heading of the same or a higher level. */
export function proseUnder(heading: string, shallow = false): MdBlock[] {
  const m = /^(#+)\s+(.*)$/.exec(heading);
  if (!m) return [];
  const level = m[1]!.length;
  const title = m[2]!;
  const blocks = rulebookMarkdown();
  const out: MdBlock[] = [];
  let inside = false;
  for (const b of blocks) {
    if (b.t === 'h') {
      if (inside && (b.level <= level || shallow)) break;
      if (b.level === level && b.text === title) {
        inside = true;
        continue;
      }
    }
    if (inside) out.push(b);
  }
  return out;
}

export function sectionProse(s: CodexSection): MdBlock[] {
  const blocks = s.prose.flatMap((h) => proseUnder(h, s.shallow));
  if (!s.intro) return blocks;
  const first = blocks.find((b) => b.t === 'p');
  return first ? [first] : [];
}

export function sectionEntries(s: CodexSection): Entry[] {
  return allEntries().filter((e) => s.kinds.includes(e.kind) && (!s.filter || s.filter(e)));
}

/** The section an entry is shown in. */
export function sectionOf(id: string): CodexSection | null {
  const e = allEntries().find((x) => x.id === id);
  return e ? CODEX_SECTIONS.find((s) => s.kinds.includes(e.kind) && (!s.filter || s.filter(e))) ?? null : null;
}

function blockText(b: MdBlock): string {
  switch (b.t) {
    case 'h':
    case 'p':
      return plain(b.text);
    case 'ul':
    case 'ol':
      return b.items.map(plain).join(' ');
    case 'table':
      return [...b.head, ...b.rows.flat()].map(plain).join(' ');
    case 'code':
      return b.text;
  }
}

/** Every word of the query, lower case. */
function words(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function matches(text: string, ws: readonly string[]): boolean {
  const t = text.toLowerCase();
  return ws.every((w) => t.includes(w));
}

/** A block reduced to what matches: a table keeps its matching rows, a list its matching items. */
function matchBlock(b: MdBlock, ws: readonly string[]): MdBlock | null {
  if (b.t === 'table') {
    const rows = b.rows.filter((r) => matches(r.map(plain).join(' '), ws));
    return rows.length ? { ...b, rows } : null;
  }
  if (b.t === 'ul' || b.t === 'ol') {
    const items = b.items.filter((i) => matches(plain(i), ws));
    return items.length ? { ...b, items } : null;
  }
  if (b.t === 'h') return null;
  return matches(blockText(b), ws) ? b : null;
}

export type SearchHit = { section: CodexSection; entries: Entry[]; prose: MdBlock[] };

/**
 * What matches every word of `query`, by section: cards whose word, title, type, doc or numbers
 * match (exact word matches first), and the rulebook blocks that mention it.
 */
export function searchCodex(query: string): SearchHit[] {
  const ws = words(query);
  if (!ws.length) return [];
  const q = query.trim().toLowerCase();
  const out: SearchHit[] = [];
  const seenProse = new Set<MdBlock>();
  for (const section of CODEX_SECTIONS) {
    const entries = sectionEntries(section)
      .filter((e) => matches(e.search, ws))
      .sort((a, b) => Number(b.word.toLowerCase() === q) - Number(a.word.toLowerCase() === q) || Number(b.word.toLowerCase().includes(q)) - Number(a.word.toLowerCase().includes(q)));
    const prose: MdBlock[] = [];
    for (const b of sectionProse(section)) {
      if (seenProse.has(b)) continue;
      const m = matchBlock(b, ws);
      if (m) {
        prose.push(m);
        seenProse.add(b);
      }
    }
    if (entries.length || prose.length) out.push({ section, entries, prose });
  }
  return out;
}
