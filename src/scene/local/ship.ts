// GitOps (/gitops): the spaceship, seen from alongside — the camera flies in formation, and the
// pipeline stages are bays down the spine that light in sequence as a build passes (spec §3).
//
// PLACEHOLDER. Owned by the M3 ship agent; this is the contract standing in until it lands.
import * as THREE from 'three';
import type { LocalPlace } from '../tiers/local';
import type { CameraPose, SceneContext } from '../types';

const BAYS = 4; // build, scan, push, deploy — lit in sequence, never labelled in the scene
const CYCLE = 6; // seconds for one pass down the spine

export function createShip(ctx: SceneContext): LocalPlace {
  const group = new THREE.Group();
  const kept: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => (kept.push(x), x);

  const hullGeo = keep(new THREE.CapsuleGeometry(0.5, 5, 6, 16));
  const hullMat = keep(new THREE.MeshBasicMaterial({ color: ctx.colour('--ground-raised') }));
  const hull = new THREE.Mesh(hullGeo, hullMat);
  hull.rotation.z = Math.PI / 2;
  group.add(hull);

  const bayGeo = keep(new THREE.SphereGeometry(0.16, 12, 8));
  const bays = Array.from({ length: BAYS }, (_, i) => {
    const mat = keep(new THREE.MeshBasicMaterial({ color: ctx.colour('--star-5600') }));
    const bay = new THREE.Mesh(bayGeo, mat);
    bay.position.set(-2 + i * 1.35, 0.55, 0);
    group.add(bay);
    return mat;
  });

  let t = 0;
  return {
    group,
    pose(aspect): CameraPose {
      const d = 11 / Math.min(1, aspect / 1.4);
      return { position: [1.5, 1.6, d], target: [0, 0, 0], fov: 45 };
    },
    update(dt) {
      // Idle life: the build runs whether or not anyone is watching. Ambient rate is enough.
      t = (t + dt) % CYCLE;
      const head = (t / CYCLE) * BAYS;
      bays.forEach((mat, i) => mat.color.copy(ctx.colour(head > i && head < i + 1.4 ? '--star-12000' : '--rule')));
      return false;
    },
    dispose() {
      for (const k of kept.splice(0)) k.dispose();
      group.clear();
    },
  };
}
