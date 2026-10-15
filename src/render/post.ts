/**
 * Post-processing: one RenderPipeline built from TSL nodes.
 * - The scene pass writes colour and emissive (MRT); bloom runs on emissive only, so fire, orbs,
 *   weapon telegraphs and sparks glow while the floor and bodies stay crisp.
 * - Kill punch: a short radial chromatic split, contrast kick and red edge grade on every kill.
 * - Vignette and a faint film grain (hides banding in the dark gradients).
 * - MSAA on standard displays; on high-DPI displays MSAA is skipped for fill rate and FXAA
 *   smooths the final image instead.
 */

import * as THREE from 'three/webgpu';
import {
  Fn, emissive, float, hash, length, mix, mrt, output, pass, renderOutput, screenCoordinate, screenUV, smoothstep, time, vec2,
  uniform, vec3, vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';

export class Post {
  readonly pipeline: THREE.RenderPipeline;
  /** Kill punch strength 0..1 (decays in the renderer). */
  readonly punch = uniform(0);
  private readonly aspect = uniform(1);

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, msaa: boolean) {
    const scenePass = pass(scene, camera, { samples: msaa ? 4 : 0 });
    scenePass.setMRT(mrt({ output, emissive }));
    const colorTex = scenePass.getTextureNode('output');
    const emissiveTex = scenePass.getTextureNode('emissive');
    const glow = bloom(emissiveTex, 1.15, 0.55, 0.0);
    const punch = this.punch;
    const aspect = this.aspect;

    const graded = Fn(() => {
      const uv = screenUV;
      const centre = uv.sub(0.5);
      const dist = length(centre.mul(vec2(aspect, 1)));
      // Radial chromatic split, strongest at the edges, only during the punch.
      const split = centre.mul(punch.mul(0.022));
      const r = colorTex.sample(uv.add(split)).x;
      const g = colorTex.sample(uv).y;
      const b = colorTex.sample(uv.sub(split)).z;
      const col = vec3(r, g, b).add(glow.xyz).toVar();
      // Punch grade: contrast kick and a red bleed from the edges.
      const contrast = col.sub(0.18).mul(float(1).add(punch.mul(0.25))).add(0.18).max(0);
      col.assign(mix(col, contrast, punch));
      col.addAssign(vec3(0.22, 0.0, 0.0).mul(punch).mul(smoothstep(0.25, 0.75, dist)));
      // Vignette.
      const vig = smoothstep(0.3, 0.95, dist).oneMinus();
      col.mulAssign(mix(float(0.42), float(1), vig));
      // Grain.
      const n = hash(screenCoordinate.x.add(screenCoordinate.y.mul(1931)).add(time.mul(60).floor().mul(7.13))).sub(0.5);
      col.addAssign(vec3(n.mul(0.012)));
      return vec4(col, 1);
    })();

    this.pipeline = new THREE.RenderPipeline(renderer);
    if (msaa) {
      this.pipeline.outputNode = graded;
    } else {
      this.pipeline.outputColorTransform = false;
      this.pipeline.outputNode = fxaa(renderOutput(graded));
    }
  }

  setAspect(a: number): void {
    this.aspect.value = a;
  }

  render(): void {
    this.pipeline.render();
  }

  dispose(): void {
    this.pipeline.dispose();
  }
}
