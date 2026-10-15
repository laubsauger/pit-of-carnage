// Owned by: render-fx
/**
 * Procedural gore masks in TSL, shared by every pass that paints the floor (CPU-queued stamps and
 * GPU droplets that land). Every stamp is a quad; `q` is the quad's local coordinate in [-1, 1]^2
 * with +x along the stamp's direction. Shapes come from Perlin noise seeded per stamp, so no two
 * splats repeat, and each kind has its own construction (lobed pool with fingers and satellite
 * drops, directional spray, crowned droplet, dragged streak, boot print, scorch).
 *
 * Output is data, not colour (see decals.ts for the target layout): blood writes how much blood
 * the stamp lays down at each point (thick middles and rims more), how much of it is wet and its
 * tone; scorch writes soot and dries what it burns. The floor turns the data into colour.
 */

import {
  Fn, If, abs, atan, clamp, cos, exp, floor, fract, fwidth, hash, length, max, mx_noise_float, pow, sin, step,
  vec2, vec3, vec4, float,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { sstep } from './quads';

/** Decal kinds (the `kind` value of a stamp). */
export const DECAL = {
  splat: 0,
  pool: 1,
  spray: 2,
  drop: 3,
  streak: 4,
  print: 5,
  scorch: 6,
} as const;

type F = Node<'float'>;
type V2 = Node<'vec2'>;

function noise(p: V2, seed: F): F {
  return mx_noise_float(vec3(p, seed));
}

type Shape = { mask: F; thick: F; ring: F };

/** Anti-aliasing width for an edge on `x`: a pixel's worth, clamped so tiny quads stay round. */
function edgeAa(x: F): F {
  return clamp(fwidth(x), 0.004, 0.12);
}

/** Lobed pool with fingers and satellite drops. `spiky` 0 = smooth puddle, 1 = violent splat. */
function splatShape(q: V2, seed: F, spiky: F): Shape {
  const r = length(q);
  const a = atan(q.y, q.x);
  const dir = vec2(cos(a), sin(a));
  const lobes = float(0.52).add(noise(dir.mul(1.4), seed).mul(0.16)).add(noise(dir.mul(3.0), seed.add(3.7)).mul(0.06));
  const finger = pow(max(noise(dir.mul(3.4), seed.add(9.1)), 0), 1.6).mul(0.75).mul(spiky);
  const R = lobes.add(finger);
  const aa = edgeAa(r);
  const body = sstep(R.add(aa), R.sub(aa), r);
  const sat = sstep(0.38, 0.46, noise(q.mul(4.2), seed.add(17.3)))
    .mul(sstep(0.98, 0.7, r))
    .mul(step(R.add(0.04), r))
    .mul(spiky.mul(0.7).add(0.3));
  const thick = clamp(R.sub(r).div(R), 0, 1).mul(body);
  const ring = sstep(0.09, 0.0, R.sub(r)).mul(body);
  return { mask: max(body, sat), thick, ring };
}

/** Directional spray: a teardrop where the blood left, then drops thinning out along +x in a cone. */
function sprayShape(q: V2, seed: F): Shape {
  const t = q.x.add(1).mul(0.5);
  const head = length(vec2(q.x.add(0.66).mul(1.7), q.y.mul(1.25)));
  const headR = float(0.3).add(noise(q.mul(3.0), seed).mul(0.07));
  const aa = edgeAa(head);
  const body = sstep(headR.add(aa), headR.sub(aa), head);
  const g = vec2(q.x.mul(3.4).add(100), q.y.mul(2.0).add(100));
  const cell = floor(g);
  const f = fract(g);
  const id = cell.x.add(cell.y.mul(37)).add(seed.mul(131));
  const h1 = hash(id);
  const h2 = hash(id.add(11));
  const h3 = hash(id.add(23));
  const centre = vec2(h1.mul(0.36).add(0.32), h2.mul(0.36).add(0.32));
  const rad = h3.mul(0.2).add(0.14).mul(float(1).sub(t.mul(0.45)));
  const d = length(f.sub(centre));
  const daa = edgeAa(d);
  const cone = sstep(t.mul(0.75).add(0.25), t.mul(0.6).add(0.1), abs(q.y));
  const present = step(h3, float(0.88).sub(t.mul(0.35)));
  const dots = sstep(rad.add(daa), rad.sub(daa), d).mul(cone).mul(present).mul(step(-0.45, q.x));
  const thick = body.mul(clamp(headR.sub(head).div(headR), 0, 1)).add(dots.mul(0.3));
  return { mask: max(body, dots), thick, ring: sstep(0.06, 0.0, headR.sub(head)).mul(body) };
}

/**
 * A single landed drop with a ragged crown, sitting well inside its quad so even a small stamp
 * stays round. The quad's stretch gives the impact direction; a satellite flicks ahead along +x.
 */
function dropShape(q: V2, seed: F): Shape {
  const r = length(q);
  const a = atan(q.y, q.x);
  const dir = vec2(cos(a), sin(a));
  const R = float(0.42).add(noise(dir.mul(3.0), seed).mul(0.07)).add(pow(max(noise(dir.mul(6.0), seed.add(5.3)), 0), 1.5).mul(0.18));
  const aa = edgeAa(r);
  const body = sstep(R.add(aa), R.sub(aa), r);
  const sd = length(q.sub(vec2(0.8, noise(vec2(seed, 1.7), seed).mul(0.2))));
  const sat = sstep(float(0.1).add(aa), float(0.1).sub(aa), sd).mul(step(0.0, noise(vec2(seed, 4.1), seed)));
  const thick = clamp(R.sub(r).div(R), 0, 1).mul(body);
  return { mask: max(body, sat), thick, ring: sstep(0.08, 0.0, R.sub(r)).mul(body) };
}

/** A dragged smear along +x: ragged sides, long soft ends (so overlapping stamps blend) and drag lines. */
function streakShape(q: V2, seed: F): Shape {
  const w = float(0.72).mul(float(0.85).add(noise(vec2(q.x.mul(1.8), 0.5), seed).mul(0.3)));
  const endR = float(0.3).add(noise(vec2(q.y.mul(2.0), 3.1), seed.add(4.0)).mul(0.15));
  const ends = sstep(1.0, endR, abs(q.x));
  const ay = abs(q.y);
  const aa = edgeAa(ay).add(0.01);
  const body = sstep(w.add(aa), w.sub(aa), ay).mul(ends);
  const drag = float(0.75).add(noise(vec2(q.x.mul(1.3), q.y.mul(9.0)), seed.add(2.0)).mul(0.3));
  const thick = clamp(float(1).sub(ay.div(w)), 0, 1).mul(body);
  return { mask: clamp(body.mul(drag), 0, 1), thick, ring: float(0) };
}

/** Bloody boot print, toe toward +x: sole and heel with tread bars and a patchy transfer. */
function printShape(q: V2, seed: F): Shape {
  const sole = length(vec2(q.x.sub(0.22).div(0.62), q.y.div(0.46)));
  const heel = length(vec2(q.x.add(0.62).div(0.3), q.y.div(0.4)));
  const aa = clamp(fwidth(sole), 0.04, 0.2);
  const shape = max(sstep(float(1).add(aa), float(1).sub(aa), sole), sstep(float(1).add(aa), float(1).sub(aa), heel));
  const tread = float(0.8).add(step(0.32, fract(q.x.mul(5.0).add(abs(q.y).mul(1.4)))).mul(0.2));
  const grain = float(0.65).add(sstep(-0.35, 0.25, noise(q.mul(6.5), seed)).mul(0.35));
  const mask = shape.mul(tread).mul(grain);
  return { mask, thick: mask.mul(0.6), ring: float(0) };
}

/** Soot burst: charred core, ragged rim and radial rays. */
function scorchShape(q: V2, seed: F): Shape {
  const r = length(q);
  const a = atan(q.y, q.x);
  const dir = vec2(cos(a), sin(a));
  const R = float(0.7).add(noise(dir.mul(2.5), seed).mul(0.14));
  const rays = pow(max(noise(dir.mul(11.0), seed.add(4.0)), 0), 1.5).mul(0.55);
  const soot = clamp(float(1).sub(r.div(R.add(rays))), 0, 1);
  const mottled = float(0.75).add(noise(q.mul(6.0), seed.add(8.0)).mul(0.35));
  const mask = clamp(pow(soot, 0.7).mul(mottled), 0, 1);
  return { mask, thick: sstep(0.55, 0.0, r), ring: float(0) };
}

export type DecalInputs = {
  /** Quad-local coordinate in [-1, 1]^2, +x along the stamp direction. */
  q: V2;
  kind: F;
  seed: F;
  /** Wet share of the blood laid down: 1 = fresh, 0 = already dry (catch-up after a seek). */
  wet: F;
  /** Tone 0..1: 1 = bright arterial spray, 0.4 = dark pooled blood. */
  tone: F;
  /** Blood laid down at the stamp's mid thickness (1 = a normal spray); for scorch, its strength. */
  density: F;
};

/**
 * Full decal shading: picks the shape by kind and returns the stamp's data.
 *
 * Blood: vec4(exp(-d), exp(-d x wet), exp(-d x tone), 0), where d is the blood laid down here. The
 * blood pass multiplies it into the target, so densities add up exactly (transmittance of the sum)
 * and a texel stores total density, wet density and tone-weighted density. Nothing about colour is
 * decided here: overlaps only ever mean "more blood", which the floor maps to a deeper red.
 *
 * Scorch: vec4(0, m, 0, soot); the scorch pass adds soot (alpha union) and dries the blood under it
 * (moves wet transmittance toward 1 by m).
 */
export function decalShade(i: DecalInputs): Node<'vec4'> {
  return Fn(() => {
    // Materialise shared inputs before branching: a temp first built inside one branch would
    // otherwise only be assigned there and read as garbage in the others.
    const q = vec2(i.q).toVar();
    const seed = float(i.seed).toVar();
    const k = float(i.kind).toVar();
    const mask = float(0).toVar();
    const thick = float(0).toVar();
    const ring = float(0).toVar();
    If(k.lessThan(DECAL.pool + 0.5), () => {
      const s = splatShape(q, seed, k.lessThan(0.5).select(float(1), float(0.25)));
      mask.assign(s.mask);
      thick.assign(s.thick);
      ring.assign(s.ring);
    })
      .ElseIf(k.lessThan(DECAL.spray + 0.5), () => {
        const s = sprayShape(q, seed);
        mask.assign(s.mask);
        thick.assign(s.thick);
        ring.assign(s.ring);
      })
      .ElseIf(k.lessThan(DECAL.drop + 0.5), () => {
        const s = dropShape(q, seed);
        mask.assign(s.mask);
        thick.assign(s.thick);
        ring.assign(s.ring);
      })
      .ElseIf(k.lessThan(DECAL.streak + 0.5), () => {
        const s = streakShape(q, seed);
        mask.assign(s.mask);
        thick.assign(s.thick);
      })
      .ElseIf(k.lessThan(DECAL.print + 0.5), () => {
        const s = printShape(q, seed);
        mask.assign(s.mask);
        thick.assign(s.thick);
      })
      .Else(() => {
        const s = scorchShape(q, seed);
        mask.assign(s.mask);
        thick.assign(s.thick);
      });

    const isScorch = k.greaterThan(DECAL.print + 0.5);
    // Blood: thick middles and dried rims hold more. Mask edges are anti-aliased, so density fades
    // out smoothly and overlapping edges blend instead of stepping.
    const d = max(i.density, 0).mul(float(0.55).add(thick.mul(0.8)).add(ring.mul(0.5))).mul(mask);
    const blood = vec4(exp(d.negate()), exp(d.mul(clamp(i.wet, 0, 1)).negate()), exp(d.mul(clamp(i.tone, 0, 1)).negate()), 0);
    const burn = clamp(mask.mul(i.density), 0, 1);
    return isScorch.select(vec4(0, burn, 0, burn), blood);
  })();
}
