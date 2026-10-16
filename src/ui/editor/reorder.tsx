// Owned by: ui
// Reordering in the visual builder: behaviours (the earlier one wins a tied score) and move terms.
// Each row gets a grip you drag onto another row of the same list, or focus and move with the arrow
// keys. The text edit itself is `moveMember` (edit.ts), which keeps every member's own text.
import { useState } from 'react';
import type { DragEvent, ReactNode } from 'react';

/** The row being dragged. Module state: a drag's data cannot be read while it is over a target. */
let dragging: { group: string; index: number } | null = null;

type DropSide = 'before' | 'after';

export type Reorder = {
  /** The grip to put at the start of the row. */
  grip: ReactNode;
  /** Spread on the row: makes it a drop target and marks where the dragged row would land. */
  target: {
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDragLeave: (e: DragEvent<HTMLElement>) => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
    'data-drop'?: DropSide;
  };
};

/**
 * @param group rows that can trade places (`behaviours`, `move:kite`); drags never cross groups.
 * @param onMove move the row at `from` to index `to`.
 */
export function useReorder(group: string, index: number, count: number, label: string, enabled: boolean, onMove: (from: number, to: number) => void): Reorder {
  const [over, setOver] = useState<DropSide | null>(null);
  const can = enabled && count > 1;
  const gripId = `${group}:${index}`;

  const move = (to: number) => {
    if (to < 0 || to >= count || to === index) return;
    onMove(index, to);
    // Keep the keyboard on the row that moved (rows keyed by index would otherwise keep the focus).
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-grip="${CSS.escape(`${group}:${to}`)}"]`)?.focus());
  };

  const grip = (
    <button
      type="button"
      className="sb-grip"
      data-grip={gripId}
      draggable={can}
      disabled={!can}
      aria-label={`Move ${label} (arrow keys)`}
      title={can ? 'Drag to reorder, or focus and press ↑ ↓' : undefined}
      onDragStart={(e) => {
        dragging = { group, index };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', label);
        const row = e.currentTarget.closest<HTMLElement>('[data-reorder]');
        if (row) e.dataTransfer.setDragImage(row, 12, 12);
      }}
      onDragEnd={() => {
        dragging = null;
      }}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
        if (!step || !can) return;
        e.preventDefault();
        e.stopPropagation();
        move(index + step);
      }}
    >
      <svg viewBox="0 0 8 14" width="8" height="14" aria-hidden>
        {[2, 7, 12].map((y) => (
          <g key={y}>
            <circle cx="2" cy={y} r="1.1" />
            <circle cx="6" cy={y} r="1.1" />
          </g>
        ))}
      </svg>
    </button>
  );

  const ours = () => (dragging && dragging.group === group && dragging.index !== index ? dragging : null);
  const target: Reorder['target'] = {
    onDragOver: (e) => {
      const d = ours();
      if (!d) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // The dragged row takes this row's place: above it when coming from below, else under it.
      const side: DropSide = d.index > index ? 'before' : 'after';
      if (over !== side) setOver(side);
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
    },
    onDrop: (e) => {
      const d = ours();
      setOver(null);
      if (!d) return;
      e.preventDefault();
      dragging = null;
      onMove(d.index, index);
    },
  };
  if (over) target['data-drop'] = over;
  return { grip, target };
}
