// Owned by: render-fx
import { instancedArray } from 'three/tsl';

/**
 * Per-instance data the CPU rewrites every frame (decal stamps, pieces, rings), held in vec4
 * storage buffers that vertex shaders index with `instanceIndex`. Only the used prefix is uploaded.
 */
export class InstanceBuffers {
  readonly capacity: number;
  readonly nodes: ReturnType<typeof makeBuffer>[];
  readonly arrays: Float32Array[];

  constructor(capacity: number, buffers: number) {
    this.capacity = capacity;
    this.nodes = Array.from({ length: buffers }, () => makeBuffer(capacity));
    this.arrays = this.nodes.map((n) => n.value.array as Float32Array);
  }

  /** Upload instances [0, n). */
  upload(n: number): void {
    if (n <= 0) return;
    const count = Math.min(n, this.capacity) * 4;
    for (const node of this.nodes) {
      node.value.clearUpdateRanges();
      node.value.addUpdateRange(0, count);
      node.value.needsUpdate = true;
    }
  }
}

function makeBuffer(capacity: number) {
  return instancedArray(capacity, 'vec4');
}
