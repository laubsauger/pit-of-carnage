import { describe, expect, it } from 'vitest';
import { FixedPool, RingSlots } from './pool';

function runs(ring: RingSlots): [number, number][] {
  const out: [number, number][] = [];
  ring.flush((s, c) => out.push([s, c]));
  return out;
}

describe('RingSlots (GPU particle slots)', () => {
  // Only freshly written slots may be uploaded: re-uploading a whole buffer would reset every
  // particle the GPU is simulating back to its spawn state.
  it('reports exactly the slots written since the last flush', () => {
    const ring = new RingSlots(8);
    ring.alloc();
    ring.alloc();
    expect(runs(ring)).toEqual([[0, 2]]);
    ring.alloc();
    expect(runs(ring)).toEqual([[2, 1]]);
    expect(runs(ring)).toEqual([]);
  });

  it('splits a write that wraps past the end into two runs', () => {
    const ring = new RingSlots(4);
    for (let i = 0; i < 3; i++) ring.alloc();
    runs(ring);
    ring.alloc(); // slot 3
    ring.alloc(); // wraps to slot 0
    expect(runs(ring)).toEqual([[3, 1], [0, 1]]);
  });

  // A burst bigger than the pool overwrites the oldest particles; the upload must then cover all.
  it('uploads the whole buffer once more slots were written than exist', () => {
    const ring = new RingSlots(4);
    for (let i = 0; i < 9; i++) ring.alloc();
    expect(runs(ring)).toEqual([[0, 4]]);
  });

  it('hands out slots in order and wraps, so the oldest particle is the one recycled', () => {
    const ring = new RingSlots(3);
    expect([ring.alloc(), ring.alloc(), ring.alloc(), ring.alloc()]).toEqual([0, 1, 2, 0]);
  });
});

describe('FixedPool', () => {
  type Item = { active: boolean; serial: number; tag: number };
  const make = (): Item => ({ active: false, serial: 0, tag: 0 });

  it('reuses free items before recycling live ones', () => {
    const pool = new FixedPool(3, make);
    const a = pool.acquire();
    a.tag = 1;
    a.active = false;
    const b = pool.acquire();
    expect(b).toBe(a);
    expect(pool.countActive()).toBe(1);
  });

  // When the floor is full of gibs, the oldest one makes room: never the piece just thrown.
  it('recycles the oldest active item when full', () => {
    const pool = new FixedPool(3, make);
    const first = pool.acquire();
    const second = pool.acquire();
    pool.acquire();
    expect(pool.acquire()).toBe(first);
    expect(pool.acquire()).toBe(second);
    expect(pool.items.length).toBe(3);
  });
});
