// Incidents (/incidents): the solar system, seen from above — orbit rings drawn like a brass
// orrery, one planet per incident, all legible at once, click a planet to drop to it (spec §3).
//
// PLACEHOLDER. Owned by the M3 orrery agent; this is the contract standing in until it lands.
import * as THREE from 'three';
import { additive } from '../jwst';
import type { LocalPlace } from '../tiers/local';
import type { CameraPose, SceneContext } from '../types';

const RINGS = [2.4, 4.1, 6, 8.2]; // orbit radii, units of this place's own scale
const ELEVATION = (58 * Math.PI) / 180;

export function createOrrery(ctx: SceneContext): LocalPlace {
  const group = new THREE.Group();
  const kept: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => (kept.push(x), x);

  const ring = keep(new THREE.RingGeometry(1, 1.004, 128));
  const ringMat = keep(new THREE.MeshBasicMaterial({ color: ctx.colour('--rule'), side: THREE.DoubleSide, transparent: true, opacity: 0.7 }));
  ctx.incidents.forEach((_, i) => {
    const r = RINGS[Math.min(i, RINGS.length - 1)];
    const orbit = new THREE.Mesh(ring, ringMat);
    orbit.rotation.x = Math.PI / 2;
    orbit.scale.setScalar(r);
    group.add(orbit);
  });

  const sunGeo = keep(new THREE.SphereGeometry(0.5, 24, 16));
  const sunMat = keep(new THREE.MeshBasicMaterial({ color: ctx.colour('--star-4300') }));
  group.add(new THREE.Mesh(sunGeo, sunMat));

  const planetGeo = keep(new THREE.SphereGeometry(0.34, 20, 14));
  const planetMat = keep(new THREE.MeshBasicMaterial({ color: ctx.colour('--star-8500'), ...additive, depthTest: true }));
  const planets = ctx.incidents.map((incident, i) => {
    const mesh = new THREE.Mesh(planetGeo, planetMat);
    const r = RINGS[Math.min(i, RINGS.length - 1)];
    const a = (i / Math.max(1, ctx.incidents.length)) * Math.PI * 2;
    mesh.position.set(r * Math.cos(a), 0, r * Math.sin(a));
    group.add(mesh);
    return { incident, mesh };
  });

  return {
    group,
    pose(aspect): CameraPose {
      const d = 15 / Math.min(1, aspect / 1.4);
      return { position: [0, d * Math.sin(ELEVATION), d * Math.cos(ELEVATION)], target: [0, 0, 0], fov: 45 };
    },
    update: () => false,
    hot: () => null,
    href: () => null,
    dispose() {
      for (const k of kept.splice(0)) k.dispose();
      group.clear();
      planets.length = 0;
    },
  };
}
