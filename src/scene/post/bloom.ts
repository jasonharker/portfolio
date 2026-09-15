// Desktop bloom (spec §5): three's UnrealBloomPass between a RenderPass and an OutputPass.
// Mobile gets cheap additive glow instead (M3), so tiers only build this when quality.bloom is set.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

export interface BloomOptions { strength: number; radius: number; threshold: number }

export interface Bloom {
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  resize(width: number, height: number): void; // CSS pixels
  dispose(): void;
}

export function createBloom(renderer: THREE.WebGLRenderer, { strength, radius, threshold }: BloomOptions): Bloom {
  const composer = new EffectComposer(renderer);
  const pass = new RenderPass(new THREE.Scene(), new THREE.Camera());
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), strength, radius, threshold);
  const output = new OutputPass();
  composer.addPass(pass);
  composer.addPass(bloom);
  composer.addPass(output);

  return {
    render(scene, camera) {
      pass.scene = scene;
      pass.camera = camera;
      composer.render();
    },
    resize(width, height) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(width, height);
    },
    dispose() {
      for (const p of [pass, bloom, output]) p.dispose();
      composer.dispose();
    },
  };
}
