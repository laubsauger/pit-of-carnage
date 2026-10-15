// Owned by: render-fx
/**
 * The floor's gore composite in TSL: turns the decal target's data (see decals.ts) into lit colour
 * over the floor. The floor material (src/render/floor.ts) calls `goreFloor` with its own albedo,
 * light and shadow tint; everything about how blood looks lives here and in palette.ts, which holds
 * the same maths in plain TypeScript (`bloodAlbedo`, `bloodLit`) for the tests.
 *
 * - Blood replaces the floor's albedo by its coverage (it does not multiply it), so it reads the
 *   same red on pale sand, dark flagstones and flesh.
 * - Colour comes from one gradient by thickness, wetness and tone: arterial red, deep red, maroon.
 *   The darkest stop is still clearly red, every light channel on blood is at least
 *   `BLOOD_FLOOR.minLight` and lit blood never drops below `BLOOD_FLOOR.darkest`, so overlaps,
 *   shadow and dark floors never turn it grey or black.
 * - The cool gameplay-shadow tint applies to the bare floor only, never to blood (it pulled dark red
 *   toward blue-grey).
 * - Wet blood gets a tiny red gloss proportional to the light: view-independent, no noise.
 * - Scorch darkens whatever lies under it toward charred brown.
 */

import { clamp, exp, float, log, max, mix, pow, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { BLOOD_FLOOR, BLOOD_RAMP, LUMA } from './palette';
import type { Rgb } from './palette';

type F = Node<'float'>;
type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;

function v3(c: Rgb): V3 {
  return vec3(c.r, c.g, c.b);
}

/** Three-stop gradient at t in [0, 1] (same maths as palette.ts `ramp3`). */
function ramp3(s: readonly Rgb[], t: F): V3 {
  const a = clamp(t.mul(2), 0, 1);
  const b = clamp(t.mul(2).sub(1), 0, 1);
  return mix(mix(v3(s[0]), v3(s[1]), a), v3(s[2]), b);
}

/** Scorch colour multiplier at full soot: charred brown-black, warm rather than neutral. */
const CHAR = vec3(0.16, 0.11, 0.08);
/** Below this much blood the texel counts as clean (keeps tone from dividing by nothing). */
const EPS = 1e-4;

/**
 * Lit floor colour with gore. `ground` is the floor albedo (linear), `decal` the decal target sample
 * at this point, `light` the light field colour, `ao` ambient occlusion, `groundTint` the
 * multiplier for the bare floor only (the cool gameplay-shadow tint).
 */
export function goreFloor(ground: V3, decal: V4, light: V3, ao: F, groundTint: V3): V3 {
  const F = BLOOD_FLOOR;
  const D = log(max(decal.x, 1e-6)).negate();
  const T = log(max(decal.z, 1e-6)).negate();
  const tone = D.greaterThan(EPS).select(clamp(T.div(max(D, EPS)), 0, 1), float(F.tone));
  // Wet coverage 0..1 (the drying pass shrinks it linearly), then the wet layer over dried blood.
  const wet = clamp(float(1).sub(decal.y), 0, 1);
  const layer = float(1).sub(pow(float(1).sub(wet), F.layer));
  const th = float(1).sub(exp(D.mul(-F.thick)));
  const t = clamp(th.add(float(F.tone).sub(tone).mul(F.toneShift)), 0, 1);
  const albedo = mix(ramp3(BLOOD_RAMP.dry, t), ramp3(BLOOD_RAMP.wet, t), layer);
  const cover = float(1).sub(exp(D.mul(-F.cover)));

  const lit = light.mul(ao);
  const lum = lit.x.mul(LUMA.r).add(lit.y.mul(LUMA.g)).add(lit.z.mul(LUMA.b));
  const gloss = wet.mul(wet).mul(lum).mul(F.gloss);
  const blood = max(albedo.mul(max(lit, vec3(F.minLight))).add(vec3(gloss, gloss.mul(0.12), gloss.mul(0.1))), v3(F.darkest));
  const floor = ground.mul(lit).mul(groundTint);
  const soot = clamp(decal.w, 0, 1).mul(0.85);
  return mix(floor, blood, cover).mul(mix(vec3(1), CHAR, soot));
}
