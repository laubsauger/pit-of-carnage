// Owned by: render-fx
import * as THREE from 'three/webgpu';
import { clamp, float } from 'three/tsl';

/**
 * Unit quad lying on the floor plane (three's XZ), facing up (+Y) toward the top-down camera.
 * Corners span [-0.5, 0.5] on x and z. UV v = 1 is the north edge (-z, world -y), so a canvas
 * texture drawn with +y down shows the right way up, and +x / +y in the canvas map to world +x / +y.
 */
export function floorQuad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  // Order: NW, SW, SE, NE. Triangles NW-SW-SE and NW-SE-NE are counter-clockwise seen from above.
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 0, -0.5], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 1, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/**
 * Premultiplied-alpha blending: colour = src + dst * (1 - srcAlpha). A shader that outputs alpha 0
 * with a non-zero colour adds light (sparks, flashes); alpha 1 covers (blood, dust). One draw can
 * then mix glowing and solid particles.
 */
export function usePremultipliedBlend(m: THREE.Material): void {
  m.transparent = true;
  m.depthWrite = false;
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendEquationAlpha = THREE.AddEquation;
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
}

/**
 * Emissive output for any node material. The renderer's post pass blooms the `emissive` MRT
 * target only, and `NodeMaterial.setupLighting` writes `emissiveNode` there for every node material
 * (the typings only declare it on lit materials).
 */
export function setEmissive(m: THREE.NodeMaterial, node: THREE.Node): void {
  (m as unknown as { emissiveNode: THREE.Node | null }).emissiveNode = node;
}

/**
 * Hermite smoothstep that works with either edge order. WGSL leaves `smoothstep(e0, e1, x)` with
 * e0 >= e1 undefined, and Metal really does return garbage for it, so falloffs written as
 * "1 at e0, 0 at e1" go through this instead.
 */
export function sstep(e0: THREE.Node<'float'> | number, e1: THREE.Node<'float'> | number, x: THREE.Node<'float'>): THREE.Node<'float'> {
  const a = typeof e0 === 'number' ? float(e0) : e0;
  const b = typeof e1 === 'number' ? float(e1) : e1;
  const t = clamp(x.sub(a).div(b.sub(a)), 0, 1);
  return t.mul(t).mul(float(3).sub(t.mul(2)));
}
