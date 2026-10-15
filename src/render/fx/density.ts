// Owned by: render-fx
/**
 * Coarse CPU map of *fresh* blood on the floor, so footprints come from blood the viewer can see.
 * Every blood decal adds to it; it dries out over time. Boots that step into wet cells pick up
 * blood and print a fading trail of prints over the following steps.
 */

export const BLOOD_GRID = {
  /** Cell size (px). Coarse on purpose: prints only need "is there a puddle here". */
  cell: 16,
  /** Fresh blood half-life (s). Older blood is dry and no longer sticks to boots. */
  halfLife: 30,
  /** Fresh blood a cell needs before boots pick it up. */
  wetThreshold: 0.25,
  /** Cap per cell, so a huge pool does not stay "fresh" forever. */
  maxPerCell: 2,
};

export class BloodGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly data: Float32Array;

  constructor(width: number, height: number, cell = BLOOD_GRID.cell) {
    this.cell = cell;
    this.cols = Math.max(1, Math.ceil(width / cell));
    this.rows = Math.max(1, Math.ceil(height / cell));
    this.data = new Float32Array(this.cols * this.rows);
  }

  private index(x: number, y: number): number {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return -1;
    return cy * this.cols + cx;
  }

  /**
   * Add fresh blood over a disc. `amount` is coverage (1 = a fully soaked cell). A disc smaller than
   * a cell adds in proportion to its area, so a fine spray does not count as a puddle.
   */
  add(x: number, y: number, radius: number, amount: number): void {
    const c = this.cell;
    const max = BLOOD_GRID.maxPerCell;
    if (radius < c * 0.5) {
      const i = this.index(x, y);
      if (i < 0) return;
      const v = this.data[i] + (amount * Math.PI * radius * radius) / (c * c);
      this.data[i] = v > max ? max : v;
      return;
    }
    const x0 = Math.max(0, Math.floor((x - radius) / c));
    const x1 = Math.min(this.cols - 1, Math.floor((x + radius) / c));
    const y0 = Math.max(0, Math.floor((y - radius) / c));
    const y1 = Math.min(this.rows - 1, Math.floor((y + radius) / c));
    const r2 = radius * radius;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const dx = (cx + 0.5) * c - x;
        const dy = (cy + 0.5) * c - y;
        if (dx * dx + dy * dy > r2) continue;
        const i = cy * this.cols + cx;
        const v = this.data[i] + amount;
        this.data[i] = v > max ? max : v;
      }
    }
  }

  /** Fresh blood in the cell containing (x, y); 0 outside the map. */
  sample(x: number, y: number): number {
    const i = this.index(x, y);
    return i < 0 ? 0 : this.data[i];
  }

  /** Remove `fraction` of the cell's blood (boots soak some up). Returns the amount removed. */
  take(x: number, y: number, fraction: number): number {
    const i = this.index(x, y);
    if (i < 0) return 0;
    const taken = this.data[i] * fraction;
    this.data[i] -= taken;
    return taken;
  }

  /** Dry out by `dt` seconds. */
  decay(dt: number): void {
    if (dt <= 0) return;
    const k = Math.pow(0.5, dt / BLOOD_GRID.halfLife);
    const d = this.data;
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }

  clear(): void {
    this.data.fill(0);
  }
}

export const BOOTS = {
  /** Boot load picked up per unit of fresh blood under the foot. */
  pickup: 0.9,
  /** Each print uses up blood: load is multiplied by this per step. */
  decayPerStep: 0.8,
  /** Prints fainter than this are not stamped (the trail ends). */
  minPrint: 0.08,
  /** Load when the sim reports a bloody step (it tracks gore the fx grid may not know about). */
  hintLoad: 0.7,
  /** Fraction of a wet cell's blood a step soaks up. */
  soak: 0.04,
};

/** Per-fighter boot blood and left/right foot alternation. */
export class BootPrints {
  private load = new Map<string, number>();
  private foot = new Map<string, number>();

  /**
   * A footstep at (x, y). Returns the print strength in 0..1, or 0 for no print.
   * `bloodyHint` is the sim's own "this step is bloody" flag.
   */
  step(id: string, grid: BloodGrid, x: number, y: number, bloodyHint: boolean): number {
    let load = this.load.get(id) ?? 0;
    const fresh = grid.sample(x, y);
    if (fresh >= BLOOD_GRID.wetThreshold) {
      load = Math.max(load, Math.min(1, fresh * BOOTS.pickup));
      grid.take(x, y, BOOTS.soak);
    }
    if (bloodyHint) load = Math.max(load, BOOTS.hintLoad);
    const print = load >= BOOTS.minPrint ? load : 0;
    this.load.set(id, print > 0 ? load * BOOTS.decayPerStep : 0);
    return print;
  }

  /** Alternates -1 (left) / +1 (right) per call for this fighter. */
  nextFoot(id: string): number {
    const f = this.foot.get(id) === 1 ? -1 : 1;
    this.foot.set(id, f);
    return f;
  }

  loadOf(id: string): number {
    return this.load.get(id) ?? 0;
  }

  clear(): void {
    this.load.clear();
    this.foot.clear();
  }
}
