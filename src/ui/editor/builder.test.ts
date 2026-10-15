import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HOUSE_STACKS, loadStrategy } from '../../strategy';
import { Builder } from './Builder';

/** The builder as the editor mounts it, rendered to a string (node has no DOM). */
function render(doc: unknown): string {
  const text = JSON.stringify(doc, null, 2);
  const r = loadStrategy(text, 'paste');
  return renderToString(
    createElement(Builder, {
      apiRef: { current: null }, value: doc, editable: true, issues: [...r.errors, ...r.warnings], build: null, onEdit: () => {}, text,
      onText: () => {}, onOpenCodex: () => {},
    }),
  );
}

describe('visual builder', () => {
  // The builder draws whatever JSON parses, and the draft is stored: a render that throws on a
  // half-right strategy takes the Gym screen down, and it comes back down on every reload. A move
  // term written as a word or a behaviour left as null is a typo the gate reports, never a crash.
  it('draws drafts that parse but are not strategies yet, instead of crashing the Gym', () => {
    const base = structuredClone(HOUSE_STACKS[0]!) as unknown as { behaviours: Record<string, { move?: unknown }> };
    const name = Object.keys(base.behaviours)[0]!;
    for (const odd of [['seek'], [null], [1], [[]], 'seek', null]) {
      const doc = structuredClone(base);
      doc.behaviours[name]!.move = odd;
      expect(() => render(doc), `move: ${JSON.stringify(odd)}`).not.toThrow();
    }
    for (const odd of [null, 3, 'flee', []]) {
      const doc = structuredClone(base) as unknown as { behaviours: Record<string, unknown> };
      doc.behaviours[name] = odd;
      const html = render(doc);
      // The broken behaviour still has its card, so the player can see and fix it in place.
      expect(html, `behaviour: ${JSON.stringify(odd)}`).toContain(name);
    }
  });
});
