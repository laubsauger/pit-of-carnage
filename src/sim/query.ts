/**
 * WorldQuery: the spatial questions brains may ask. Every answer is computed from the live state
 * and static geometry, deterministically. Returned positions are the world's own objects (cover
 * anchors, item and prop positions): read them, never write them.
 */

import { HAZARD_RULES, PERCEPTION, TICK_HZ, clamp01, segmentCircleT } from '../core';
import type { HazardState, KnownFighter, FighterState, PickupInfo, PickupState, Vec2, WorldQuery } from '../core';
import type { SimCtx } from './context';
import { sampleLight, staticLosBlocked, staticSegmentT } from './geometry';
import { canSee, losBlocked, recordSees } from './perception';

/** Extra clearance treated as dangerous around a hazard (saws move, so they get more). */
const HAZARD_MARGIN = 6;
const SAW_MARGIN = 14;
/** Danger at the far end of the lookahead, relative to danger right at the body. */
const FAR_DANGER = 0.25;

export function hazardRadius(h: HazardState): number {
  return h.radius || HAZARD_RULES[h.kind].radius;
}

const a: Vec2 = { x: 0, y: 0 };
const b: Vec2 = { x: 0, y: 0 };
/** Reused answer of `nearestHazard` (valid until the next call, as the contract says). */
const hazardAnswer: { pos: Vec2; radius: number } = { pos: { x: 0, y: 0 }, radius: 0 };
/** Reused answer of `nearestPickup`. */
const pickupAnswer: PickupInfo = { id: '', kind: 'haste', pos: { x: 0, y: 0 }, ready: false, respawnIn: 0 };

export function createQuery(ctx: SimCtx): WorldQuery {
  const shrineAnswers = ctx.state.shrines.map((s) => ({ pos: s.pos, ready: s.cooldown === 0 }));
  const outside = (x: number, y: number): number => {
    const r = ctx.bounds;
    const ox = x < r.x ? r.x - x : x > r.x + r.w ? x - r.x - r.w : 0;
    const oy = y < r.y ? r.y - y : y > r.y + r.h ? y - r.y - r.h : 0;
    return Math.sqrt(ox * ox + oy * oy);
  };

  return {
    map: ctx.map,

    losBlocked: (p, q) => losBlocked(ctx, p.x, p.y, q.x, q.y),

    lightAt: (p) => sampleLight(ctx.geo, p.x, p.y),

    /**
     * The asker's own FighterState is judged from its true position and head; anything else is a
     * record from the asker's view and is judged only from what that record says (see `recordSees`).
     */
    inVisionOf(observer: KnownFighter | FighterState, p: Vec2): boolean {
      const i = ctx.byId.get(observer.id);
      if (i === undefined) return false;
      const o = ctx.rts[i]!;
      if (!o.f.alive) return false;
      const light = sampleLight(ctx.geo, p.x, p.y);
      if (observer === o.f) return canSee(ctx, o, p.x, p.y, 0, light);
      return recordSees(ctx, o, observer as KnownFighter, p.x, p.y, light);
    },

    /** 1 when a wall, pillar or prop is right at `from` along the direction, falling to 0 at `lookahead`. */
    wallDanger(from, dirX, dirY, lookahead) {
      const len = Math.sqrt(dirX * dirX + dirY * dirY);
      if (len < 1e-9 || lookahead <= 0) return 0;
      a.x = from.x;
      a.y = from.y;
      b.x = from.x + (dirX / len) * lookahead;
      b.y = from.y + (dirY / len) * lookahead;
      let t = staticSegmentT(ctx.geo, a, b);
      for (const p of ctx.state.props) {
        if (!p.alive) continue;
        const tp = segmentCircleT(a, b, p.pos, p.radius);
        if (tp >= 0 && (t < 0 || tp < t)) t = tp;
      }
      return t < 0 ? 0 : clamp01(1 - t);
    },

    /**
     * 1 when walking this way enters a hazard (or the sudden-death zone) right away, down to
     * FAR_DANGER when the entry is at the end of the lookahead, 0 when the path stays clear.
     */
    hazardDanger(from, dirX, dirY, lookahead) {
      const len = Math.sqrt(dirX * dirX + dirY * dirY);
      if (len < 1e-9 || lookahead <= 0) return 0;
      const ux = dirX / len;
      const uy = dirY / len;
      let danger = 0;
      for (const h of ctx.state.hazards) {
        const r = hazardRadius(h) + (h.kind === 'saw' ? SAW_MARGIN : HAZARD_MARGIN);
        const rx = h.pos.x - from.x;
        const ry = h.pos.y - from.y;
        const proj = Math.max(0, Math.min(lookahead, rx * ux + ry * uy));
        const cx = rx - ux * proj;
        const cy = ry - uy * proj;
        const d2 = cx * cx + cy * cy;
        if (d2 >= r * r) continue;
        const entry = Math.max(0, proj - Math.sqrt(r * r - d2));
        const v = 1 - (1 - FAR_DANGER) * (entry / lookahead);
        if (v > danger) danger = v;
      }
      if (ctx.state.suddenDeath.active) {
        const ex = from.x + ux * lookahead;
        const ey = from.y + uy * lookahead;
        const now = outside(from.x, from.y);
        const then = outside(ex, ey);
        let v = 0;
        if (now > 0) {
          // Already outside: every direction is bad, outward worst.
          v = clamp01(0.5 + (then - now) / (2 * lookahead));
        } else if (then > 0) {
          v = 1 - (1 - FAR_DANGER) * clamp01(1 - then / lookahead);
        }
        if (v > danger) danger = v;
      }
      return danger;
    },

    coverFrom(from, threat, maxDist) {
      let best: Vec2 | null = null;
      let bestD = maxDist * maxDist;
      for (const p of ctx.geo.coverAnchors) {
        const dx = p.x - from.x;
        const dy = p.y - from.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > bestD) continue;
        if (ctx.state.suddenDeath.active && outside(p.x, p.y) > 0) continue;
        if (!staticLosBlocked(ctx.geo, p.x, p.y, threat.x, threat.y)) continue;
        best = p;
        bestD = d2;
      }
      return best;
    },

    nearestShrine(p) {
      let best = -1;
      let bestD = Infinity;
      const shrines = ctx.state.shrines;
      for (let i = 0; i < shrines.length; i++) {
        const s = shrines[i]!;
        const d = (s.pos.x - p.x) ** 2 + (s.pos.y - p.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best < 0) return null;
      const answer = shrineAnswers[best]!;
      answer.ready = shrines[best]!.cooldown === 0;
      return answer;
    },

    /**
     * Arrows and axes stuck in a wall, prop or the floor count as floor items of their kind, at the
     * spot they are taken back from (`pickupPos`); ammo in a living body does not (out of play).
     */
    nearestFloorItem(p, kinds) {
      let best: Vec2 | null = null;
      let bestD = Infinity;
      for (const it of ctx.state.floor) {
        if (!kinds.includes(it.kind)) continue;
        const d = (it.pos.x - p.x) ** 2 + (it.pos.y - p.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = it.pos;
        }
      }
      for (const s of ctx.state.stuck) {
        const q = s.pickupPos;
        if (!q || !kinds.includes(s.kind)) continue;
        const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = q;
        }
      }
      return best;
    },

    nearestProp(p, kind) {
      let best: Vec2 | null = null;
      let bestD = Infinity;
      for (const pr of ctx.state.props) {
        if (!pr.alive || pr.kind !== kind) continue;
        const d = (pr.pos.x - p.x) ** 2 + (pr.pos.y - p.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = pr.pos;
        }
      }
      return best;
    },

    nearestHazard(p) {
      let best: HazardState | null = null;
      let bestD = Infinity;
      for (const h of ctx.state.hazards) {
        const d = (h.pos.x - p.x) ** 2 + (h.pos.y - p.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = h;
        }
      }
      if (!best) return null;
      hazardAnswer.pos = best.pos;
      hazardAnswer.radius = hazardRadius(best);
      return hazardAnswer;
    },

    nearestPickup(p, kind) {
      let best: PickupState | null = null;
      let bestD = Infinity;
      for (const pk of ctx.state.pickups) {
        if (kind !== 'any' && pk.kind !== kind) continue;
        const d = (pk.pos.x - p.x) ** 2 + (pk.pos.y - p.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = pk;
        }
      }
      if (!best) return null;
      pickupAnswer.id = best.id;
      pickupAnswer.kind = best.kind;
      pickupAnswer.pos = best.pos;
      pickupAnswer.ready = best.cooldown === 0;
      pickupAnswer.respawnIn = best.cooldown / TICK_HZ;
      return pickupAnswer;
    },

    fightsNear(p, r) {
      let n = 0;
      const tick = ctx.state.tick;
      for (const rt of ctx.rts) {
        if (!rt.f.alive || tick - rt.lastCombatTick > PERCEPTION.fightingWindowTicks) continue;
        const dx = rt.f.pos.x - p.x;
        const dy = rt.f.pos.y - p.y;
        if (dx * dx + dy * dy <= r * r) n++;
      }
      return n;
    },
  };
}
