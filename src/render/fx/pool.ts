// Owned by: render-fx
/**
 * Fixed-size pools. Nothing in the fx module grows at runtime: when a pool is full the oldest entry
 * is recycled, so a bloodbath degrades gracefully instead of allocating or stalling.
 */

/**
 * Ring allocator over `capacity` slots for GPU-resident data (particles). `alloc()` hands out slots in
 * order and wraps around, overwriting the oldest. It records which slots were written since the
 * last `flush`, so only those ranges are uploaded and the GPU-simulated rest is left untouched.
 */
export class RingSlots {
  readonly capacity: number;
  private next = 0;
  private dirtyStart = 0;
  private dirtyCount = 0;

  constructor(capacity: number) {
    if (capacity < 1) throw new Error('RingSlots capacity must be >= 1');
    this.capacity = capacity;
  }

  alloc(): number {
    const i = this.next;
    if (this.dirtyCount === 0) this.dirtyStart = i;
    if (this.dirtyCount < this.capacity) this.dirtyCount++;
    this.next = (i + 1) % this.capacity;
    return i;
  }

  /** Slots written since the last flush (capped at capacity). */
  get pending(): number {
    return this.dirtyCount;
  }

  /**
   * Report the written slots as at most two contiguous runs `fn(start, count)` (two when the writes
   * wrapped past the end), then forget them. Returns the number of runs.
   */
  flush(fn: (start: number, count: number) => void): number {
    const n = this.dirtyCount;
    if (n === 0) return 0;
    this.dirtyCount = 0;
    if (n >= this.capacity) {
      fn(0, this.capacity);
      return 1;
    }
    const end = this.dirtyStart + n;
    if (end <= this.capacity) {
      fn(this.dirtyStart, n);
      return 1;
    }
    fn(this.dirtyStart, this.capacity - this.dirtyStart);
    fn(0, end - this.capacity);
    return 2;
  }

  reset(): void {
    this.next = 0;
    this.dirtyStart = 0;
    this.dirtyCount = 0;
  }
}

export type Pooled = { active: boolean; serial: number };

/**
 * Fixed array of reusable CPU objects. `acquire()` returns a free item, or recycles the oldest
 * active one when all are in use. Items are created once up front.
 */
export class FixedPool<T extends Pooled> {
  readonly items: T[];
  private serial = 0;

  constructor(size: number, make: () => T) {
    this.items = Array.from({ length: size }, make);
  }

  acquire(): T {
    let oldest = this.items[0];
    for (const it of this.items) {
      if (!it.active) {
        oldest = it;
        break;
      }
      if (it.serial < oldest.serial) oldest = it;
    }
    oldest.active = true;
    oldest.serial = ++this.serial;
    return oldest;
  }

  releaseAll(): void {
    for (const it of this.items) it.active = false;
  }

  countActive(): number {
    let n = 0;
    for (const it of this.items) if (it.active) n++;
    return n;
  }
}
