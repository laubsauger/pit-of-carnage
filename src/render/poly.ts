/**
 * 2D polygon helpers for the vector-cutout art (fighters, props, items). Pure, no three.js.
 * Polygons are flat arrays [u0, v0, u1, v1, ...] in a part's local frame: u = forward, v = right.
 */

export type Poly = number[];

export function circle(cu: number, cv: number, r: number, n = 20): Poly {
  return ellipse(cu, cv, r, r, n);
}

export function ellipse(cu: number, cv: number, ru: number, rv: number, n = 22, a0 = 0, a1 = Math.PI * 2): Poly {
  const out: Poly = [];
  const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-9;
  const steps = full ? n : n + 1;
  for (let i = 0; i < steps; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push(cu + Math.cos(a) * ru, cv + Math.sin(a) * rv);
  }
  return out;
}

/** Rounded rectangle centred on (cu, cv), size w (along u) x h (along v). */
export function roundRect(cu: number, cv: number, w: number, h: number, rad: number, seg = 4): Poly {
  const r = Math.min(rad, w / 2, h / 2);
  const out: Poly = [];
  const corners: [number, number, number][] = [
    [cu + w / 2 - r, cv + h / 2 - r, 0],
    [cu - w / 2 + r, cv + h / 2 - r, Math.PI / 2],
    [cu - w / 2 + r, cv - h / 2 + r, Math.PI],
    [cu + w / 2 - r, cv - h / 2 + r, Math.PI * 1.5],
  ];
  for (const [ccu, ccv, start] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = start + (Math.PI / 2) * (i / seg);
      out.push(ccu + Math.cos(a) * r, ccv + Math.sin(a) * r);
    }
  }
  return out;
}

export function rect(u0: number, v0: number, u1: number, v1: number): Poly {
  return [u0, v0, u1, v0, u1, v1, u0, v1];
}

export function star(cu: number, cv: number, rOuter: number, rInner: number, points: number, rot = 0): Poly {
  const out: Poly = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = rot + (i * Math.PI) / points;
    out.push(cu + Math.cos(a) * r, cv + Math.sin(a) * r);
  }
  return out;
}

/** Band between two arcs (a ring segment), from angle a0 to a1. */
export function arcBand(cu: number, cv: number, r0: number, r1: number, a0: number, a1: number, n = 16): Poly {
  const out: Poly = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push(cu + Math.cos(a) * r1, cv + Math.sin(a) * r1);
  }
  for (let i = n; i >= 0; i--) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push(cu + Math.cos(a) * r0, cv + Math.sin(a) * r0);
  }
  return out;
}

/** Quadratic-bezier tapered stroke from p0 via p1 to p2, width w0 at the start and w1 at the end. */
export function taperedCurve(p0: [number, number], p1: [number, number], p2: [number, number], w0: number, w1: number, n = 12): Poly {
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    const u = mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0];
    const v = mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1];
    const du = 2 * mt * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0]);
    const dv = 2 * mt * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1]);
    const len = Math.hypot(du, dv) || 1;
    const w = (w0 + (w1 - w0) * t) / 2;
    const nu = -dv / len;
    const nv = du / len;
    left.push(u + nu * w, v + nv * w);
    right.push(u - nu * w, v - nv * w);
  }
  const out: Poly = [...left];
  for (let i = right.length - 2; i >= 0; i -= 2) out.push(right[i]!, right[i + 1]!);
  return out;
}

/** Signed area (positive = counter-clockwise in a y-up frame). */
export function signedArea(p: Poly): number {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2]! * p[j * 2 + 1]! - p[j * 2]! * p[i * 2 + 1]!;
  }
  return a / 2;
}

/**
 * Grow a polygon outward by `d` (miter joins, clamped so sharp tips do not spike). Used for the
 * dark outline drawn under every fill, which keeps fighters readable on any floor and in gore.
 */
export function offsetPoly(p: Poly, d: number): Poly {
  const n = p.length / 2;
  const sign = signedArea(p) >= 0 ? 1 : -1;
  const out: Poly = new Array(p.length);
  for (let i = 0; i < n; i++) {
    const ip = (i - 1 + n) % n;
    const inx = (i + 1) % n;
    const x = p[i * 2]!;
    const y = p[i * 2 + 1]!;
    // Outward normals of the edges before and after this vertex.
    let e1x = x - p[ip * 2]!;
    let e1y = y - p[ip * 2 + 1]!;
    let e2x = p[inx * 2]! - x;
    let e2y = p[inx * 2 + 1]! - y;
    const l1 = Math.hypot(e1x, e1y) || 1;
    const l2 = Math.hypot(e2x, e2y) || 1;
    e1x /= l1;
    e1y /= l1;
    e2x /= l2;
    e2y /= l2;
    const n1x = e1y * sign;
    const n1y = -e1x * sign;
    const n2x = e2y * sign;
    const n2y = -e2x * sign;
    let mx = n1x + n2x;
    let my = n1y + n2y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) {
      mx = n1x;
      my = n1y;
    } else {
      mx /= ml;
      my /= ml;
    }
    const cos = Math.max(0.4, mx * n1x + my * n1y);
    out[i * 2] = x + (mx * d) / cos;
    out[i * 2 + 1] = y + (my * d) / cos;
  }
  return out;
}

/** Translate, rotate (radians, + toward +v) and scale a polygon. */
export function transformPoly(p: Poly, du: number, dv: number, rot = 0, su = 1, sv = su): Poly {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const out: Poly = new Array(p.length);
  for (let i = 0; i < p.length; i += 2) {
    const u = p[i]! * su;
    const v = p[i + 1]! * sv;
    out[i] = du + u * c - v * s;
    out[i + 1] = dv + u * s + v * c;
  }
  return out;
}

/** Mirror across the forward axis (v -> -v), keeping the winding consistent. */
export function mirrorV(p: Poly): Poly {
  const out: Poly = [];
  for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i]!, -p[i + 1]!);
  return out;
}
