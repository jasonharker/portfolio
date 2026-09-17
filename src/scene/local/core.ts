// Where the galactic core is, from a place. A leaf on purpose: every Local place needs this, and
// importing it from the tier that imports the places is a cycle.
import * as THREE from 'three';
import type { PlaceId, SceneContext } from '../types';

/** Unit vector from a place toward the core, which sits at the origin (topology.yaml). */
export function coreDirection(c: SceneContext, id: PlaceId): THREE.Vector3 {
  const w = c.topology.waypoints.find((p) => p.id === id)!;
  const v = new THREE.Vector3(-w.pos[0], -w.pos[1], -w.pos[2]);
  // At the core itself there is no direction to it; look along the disc instead.
  return v.lengthSq() < 1e-6 ? new THREE.Vector3(0, 0, -1) : v.normalize();
}
