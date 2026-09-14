// W0 stub: one coloured clear per place so navigation is visible. Replaced by region.ts.
import * as THREE from 'three';
import type { PlaceId, SceneContext, Tier } from '../types';

const tokens: Record<PlaceId, string> = { constellation: '--star-12000', incidents: '--star-3000', gitops: '--star-5600', documentation: '--ground' };
let ctx: SceneContext;
let place: PlaceId = 'constellation';

export const region: Tier = {
  id: 'region',
  async load(c) { ctx = c; },
  frame(p) {
    place = p;
    const [x, y, z] = ctx.topology.waypoints.find((w) => w.id === p)!.pos;
    return { position: [x, y + 1, z + 2], target: [x, y, z], fov: 50 };
  },
  update: () => false,
  render(renderer) { renderer.setClearColor(ctx.colour(tokens[place]).multiplyScalar(0.25)); renderer.clear(); },
  dispose() {},
};
