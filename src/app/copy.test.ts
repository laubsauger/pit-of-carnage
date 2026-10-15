import { describe, expect, it } from 'vitest';
import { copyInto } from './copy';

type Item = { id: string; pos: { x: number; y: number }; path?: { x: number; y: number }[] };
type State = { tick: number; items: Item[]; flags: { on: boolean }; owner: string | null };

function state(tick: number, n: number): State {
  return {
    tick,
    items: Array.from({ length: n }, (_, i) => ({ id: `i${i}`, pos: { x: i * 10 + tick, y: i } })),
    flags: { on: tick % 2 === 0 },
    owner: tick > 1 ? 'f1' : null,
  };
}

describe('copyInto', () => {
  // The renderer interpolates prev -> curr; the sim mutates curr in place, so prev must not alias it.
  it('makes an independent copy: later sim mutations do not leak into the previous tick', () => {
    const curr = state(1, 3);
    const prev = copyInto(null, curr);
    expect(prev).toEqual(curr);
    curr.tick = 2;
    curr.items[0]!.pos.x = 999;
    curr.flags.on = true;
    expect(prev.tick).toBe(1);
    expect(prev.items[0]!.pos.x).toBe(1);
    expect(prev.flags.on).toBe(false);
  });

  // Copying runs every tick while playing; it must not churn the garbage collector.
  it('reuses the nested objects of the destination instead of allocating new ones', () => {
    const prev = copyInto(null, state(1, 3));
    const item = prev.items[1]!;
    const pos = item.pos;
    const again = copyInto(prev, state(2, 3));
    expect(again).toBe(prev);
    expect(again.items[1]).toBe(item);
    expect(again.items[1]!.pos).toBe(pos);
    expect(again).toEqual(state(2, 3));
  });

  it('follows arrays that shrink and grow (projectiles, floor items)', () => {
    const prev = copyInto(null, state(1, 4));
    copyInto(prev, state(2, 1));
    expect(prev.items).toHaveLength(1);
    copyInto(prev, state(3, 5));
    expect(prev).toEqual(state(3, 5));
  });

  it('drops keys the source no longer has, so a reused slot never keeps a stale field', () => {
    const withPath: State = { ...state(1, 1), items: [{ id: 'saw', pos: { x: 0, y: 0 }, path: [{ x: 1, y: 1 }] }] };
    const prev = copyInto(null, withPath);
    copyInto(prev, state(2, 1));
    expect('path' in prev.items[0]!).toBe(false);
    expect(prev.owner).toBe('f1');
  });
});
