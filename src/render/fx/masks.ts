// Owned by: render-fx
/**
 * Procedural gore masks in TSL, shared by every pass that paints the floor (CPU-queued stamps and
 * GPU droplets that land). Every stamp is a quad; `q` is the quad's local coordinate in [-1, 1]^2
 * with +x along the stamp's direction. Shapes come from Perlin noise seeded per stamp, so no two
 * splats repeat, and each kind has its own construction (lobed pool with fingers and satellite
 * drops, directional spray, crowned droplet, dragged streak, boot print, scorch).
 *
 * Output is a transmittance that the decal pass multiplies into the floor target, plus wetness:
 * thick blood absorbs more, dried rims more still, and the side facing the light is wetter, which
 * the floor shows as a sheen that dries off over time (see `DRYING`).
 */

import {
  Fn, If, abs, atan, clamp, cos, dot, floor, fract, fwidth, hash, length, max, mix, mx_noise_float,
  normalize, pow, sin, step, vec2, vec3, vec4, float,
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
type V3 = Node<'vec3'>;

function noise(p: V2, seed: F): F {
  return mx_noise_float(vec3(p, seed));
}

/** Rotate a 2D vector by `a` radians. */
function rot(v: V2, a: F): V2 {
  const c = cos(a);
  const s = sin(a);
  return vec2(v.x.mul(c).sub(v.y.mul(s)), v.x.mul(s).add(v.y.mul(c)));
}

/** World direction toward the key light (north-west, top-left on screen), as seen in stamp space. */
function lightDirLocal(angle: F): V2 {
  return rot(vec2(-0.6, -0.8), angle.negate());
}

type Shape = { mask: F; thick: F; ring: F; edge: F };

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
  return { mask: max(body, sat), thick, ring, edge: R };
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
  return { mask: max(body, dots), thick, ring: sstep(0.06, 0.0, headR.sub(head)).mul(body), edge: headR };
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
  return { mask: max(body, sat), thick, ring: sstep(0.08, 0.0, R.sub(r)).mul(body), edge: R };
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
  return { mask: clamp(body.mul(drag), 0, 1), thick, ring: float(0), edge: w };
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
  return { mask, thick: mask.mul(0.6), ring: float(0), edge: float(1) };
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
  return { mask, thick: sstep(0.55, 0.0, r), ring: float(0), edge: R };
}

export type DecalInputs = {
  /** Quad-local coordinate in [-1, 1]^2, +x along the stamp direction. */
  q: V2;
  kind: F;
  seed: F;
  /** 0 = dry/old, 1 = fresh and glossy. */
  wet: F;
  /** Stamp rotation (radians, world convention), for the light-facing highlight. */
  angle: F;
  /** Base multiply colour (linear). */
  color: V3;
  alpha: F;
};

const SOOT_CORE = vec3(0.07, 0.06, 0.055);
const SOOT_EDGE = vec3(0.32, 0.26, 0.21);

/**
 * Full decal shading: picks the shape by kind and returns vec4(transmittance, coverage).
 *
 * Blood is an absorbing film: a stamp's colour is `base ^ density`, so thin blood is a light,
 * saturated red and thick blood a deep maroon. The decal pass multiplies it into the target
 * (`DstColor x src`), so overlapping blood keeps absorbing and pools darken toward near-black,
 * like the real thing. `alpha` of the inputs is the stamp's density (1 = `base` at mid
 * thickness). The target's alpha holds wetness, which the floor turns into a sheen.
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
    const edge = float(1).toVar();
    If(k.lessThan(DECAL.pool + 0.5), () => {
      const s = splatShape(q, seed, k.lessThan(0.5).select(float(1), float(0.25)));
      mask.assign(s.mask);
      thick.assign(s.thick);
      ring.assign(s.ring);
      edge.assign(s.edge);
    })
      .ElseIf(k.lessThan(DECAL.spray + 0.5), () => {
        const s = sprayShape(q, seed);
        mask.assign(s.mask);
        thick.assign(s.thick);
        ring.assign(s.ring);
        edge.assign(s.edge);
      })
      .ElseIf(k.lessThan(DECAL.drop + 0.5), () => {
        const s = dropShape(q, seed);
        mask.assign(s.mask);
        thick.assign(s.thick);
        ring.assign(s.ring);
        edge.assign(s.edge);
      })
      .ElseIf(k.lessThan(DECAL.streak + 0.5), () => {
        const s = streakShape(q, seed);
        mask.assign(s.mask);
        thick.assign(s.thick);
        edge.assign(s.edge);
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
    // Blood: thick parts and dried rims absorb more. A faint, low-frequency variation keeps big
    // pools from looking flat without breaking them into patches.
    const mottle = float(0.95).add(noise(q.mul(4.0), seed.add(21.0)).mul(0.1));
    const density = i.alpha.mul(float(0.5).add(thick.mul(0.8)).add(ring.mul(0.45))).mul(mottle);
    const blood = pow(max(i.color, vec3(0.002)), vec3(density));
    // The wet highlight is not baked into the colour (it would never dry): it raises the wetness
    // in alpha on the light-facing side, which the floor shows as a sheen that dries off over time.
    const ld = lightDirLocal(i.angle);
    const glossSpot = sstep(0.22, 0.0, length(q.sub(ld.mul(edge.mul(0.5)))));
    const rq = normalize(q.add(vec2(0.0001, 0)));
    const rim = sstep(0.07, 0.0, abs(edge.sub(0.08).sub(length(q)))).mul(max(dot(rq, ld), 0));
    const gloss = clamp(glossSpot.mul(pow(thick, 0.5)).mul(0.3).add(rim.mul(0.35)), 0, 1).mul(i.wet).mul(mask);
    const soot = mix(SOOT_EDGE, SOOT_CORE, thick);
    const film = isScorch.select(mix(vec3(1), soot, clamp(mask.mul(i.alpha), 0, 1)), mix(vec3(1), blood, mask));
    // Alpha: blood writes its wetness (the floor turns it into a sheen; full strength washes the red
    // out to pink, so it stays modest); scorch writes how much it dries out what is under it.
    const wetness = clamp(mask.mul(i.wet).mul(clamp(i.alpha, 0, 1)).mul(0.45).add(gloss), 0, 1);
    return vec4(film, isScorch.select(clamp(mask.mul(i.alpha), 0, 1), wetness));
  })();
}
