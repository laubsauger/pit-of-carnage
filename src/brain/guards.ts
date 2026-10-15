/**
 * Runtime guard trip counters. Each guard that can fire at a spot in a strategy (a division, an
 * expression result, a score, the per-think budget) owns one counter, created once at compile
 * time; the hot path only bumps `n`. A brain reports the counters that fired as
 * `Decision.guardTrips`, running totals for the match.
 *
 * A strategy that passed the gate never trips a guard (the validator proves it); a trip means the
 * validator missed something, so it is surfaced (inspector badge, battle report), never hidden.
 */

import type { GuardTrip, GuardTripKind } from '../core';
import type { ExprGuards, TripCounter } from './expr';

export type GuardCounter = TripCounter & { readonly path: string; readonly kind: GuardTripKind };

export class Guards {
  private readonly counters: GuardCounter[] = [];

  counter(path: string, kind: GuardTripKind): GuardCounter {
    for (const c of this.counters) if (c.path === path && c.kind === kind) return c;
    const c: GuardCounter = { path, kind, n: 0 };
    this.counters.push(c);
    return c;
  }

  /** The guards for one expression at `path`. */
  expr(path: string): ExprGuards {
    return { divZero: this.counter(path, 'div_zero'), nan: this.counter(path, 'nan') };
  }

  /** Every counter that fired, as a fresh array of fresh objects (old decisions keep their numbers). */
  trips(): GuardTrip[] {
    const out: GuardTrip[] = [];
    for (const c of this.counters) if (c.n > 0) out.push({ path: c.path, kind: c.kind, count: c.n });
    return out;
  }
}
