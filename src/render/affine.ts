/**
 * 2D affine transforms for the rig: local part coordinates (u = forward, v = right) to world
 * (x, y). Pure math, no allocation in the per-frame path (results are written into `out`).
 */

/** x = a·u + c·v + tx, y = b·u + d·v + ty. */
export type Affine = { a: number; b: number; c: number; d: number; tx: number; ty: number };

export function affine(): Affine {
  return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
}

/** Frame at (x, y) facing `angle` with uniform scale `s` (u along the facing). */
export function setFrame(out: Affine, x: number, y: number, angle: number, s: number): Affine {
  const co = Math.cos(angle) * s;
  const si = Math.sin(angle) * s;
  out.a = co;
  out.b = si;
  out.c = -si;
  out.d = co;
  out.tx = x;
  out.ty = y;
  return out;
}

/** out = parent ∘ (translate(u, v) · rotate(rot) · scale(su, sv)). `out` may alias neither input. */
export function setChild(out: Affine, parent: Affine, u: number, v: number, rot: number, su: number, sv: number): Affine {
  const co = Math.cos(rot);
  const si = Math.sin(rot);
  // Child linear part: [co·su, -si·sv; si·su, co·sv] in (u, v) columns.
  const la = co * su;
  const lb = si * su;
  const lc = -si * sv;
  const ld = co * sv;
  out.a = parent.a * la + parent.c * lb;
  out.b = parent.b * la + parent.d * lb;
  out.c = parent.a * lc + parent.c * ld;
  out.d = parent.b * lc + parent.d * ld;
  out.tx = parent.a * u + parent.c * v + parent.tx;
  out.ty = parent.b * u + parent.d * v + parent.ty;
  return out;
}

/** World point of local (u, v) under `t`. */
export function applyX(t: Affine, u: number, v: number): number {
  return t.a * u + t.c * v + t.tx;
}
export function applyY(t: Affine, u: number, v: number): number {
  return t.b * u + t.d * v + t.ty;
}

/** Bar from local point (u0, v0) to (u1, v1) with width scale `w` (geometry spans u 0..1). */
export function setSpan(out: Affine, parent: Affine, u0: number, v0: number, u1: number, v1: number, w: number): Affine {
  const len = Math.hypot(u1 - u0, v1 - v0);
  return setChild(out, parent, u0, v0, Math.atan2(v1 - v0, u1 - u0), Math.max(len, 1e-4), w);
}
