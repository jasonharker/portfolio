// W0 stub: a coloured clear so the page runs before W1 lands. Replaced by galaxy.ts.
import * as THREE from 'three';
import type { Tier } from '../types';

let clear: THREE.Color;

export const galaxy: Tier = {
  id: 'galaxy',
  async load(ctx) { clear = ctx.colour('--ground-raised'); },
  frame: () => ({ position: [0, 12, 20], target: [0, 0, 0], fov: 50 }),
  update: () => false,
  render(renderer) { renderer.setClearColor(clear); renderer.clear(); },
  dispose() {},
};
