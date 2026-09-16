// Documentation (/documentation): the supermassive black hole at the galactic core, with a lensed
// accretion disk (spec §3, decided 2026-09-16).
//
// The treatment is Gargantua's geometry and Gargantua's licence: computed lensing, the disk arcing
// over and under the shadow, the photon ring kept — but Doppler beaming damped, exactly as
// Interstellar shipped it, because the physically correct lopsidedness reads as a rendering error.
// Disk colour follows the scene's JWST false colour rather than blackbody: the whole site is an
// instrument's interpretation already, so mapping the disk the same way is consistent, not a cheat.
//
// Budget: the lens is the most expensive shader on the site and the reference machine is an Intel
// UHD 620. Ray-march into a half-resolution target at quality.lensScale and composite, exactly as
// dust.ts does — including its view-change memoisation, which is what makes ambient frames cheap.
//
// PLACEHOLDER. Owned by the M3 black hole agent; this is the contract standing in until it lands.
import * as THREE from 'three';
import { additive } from '../jwst';
import type { LocalPlace } from '../tiers/local';
import type { CameraPose, SceneContext } from '../types';

const SHADOW = 1; // the shadow's radius is this place's unit

export function createBlackHole(ctx: SceneContext): LocalPlace {
  const group = new THREE.Group();
  const kept: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => (kept.push(x), x);

  const shadowGeo = keep(new THREE.SphereGeometry(SHADOW, 48, 32));
  const shadowMat = keep(new THREE.MeshBasicMaterial({ color: 0x000000 }));
  group.add(new THREE.Mesh(shadowGeo, shadowMat));

  // Stand-in for the lensed disk: a flat annulus, no lensing. The real one arcs over the shadow.
  const diskGeo = keep(new THREE.RingGeometry(SHADOW * 2.2, SHADOW * 6, 96));
  const diskMat = keep(new THREE.MeshBasicMaterial({
    color: ctx.colour('--star-4300'), side: THREE.DoubleSide, ...additive, depthTest: true,
  }));
  const disk = new THREE.Mesh(diskGeo, diskMat);
  disk.rotation.x = Math.PI / 2.35;
  group.add(disk);

  return {
    group,
    pose(aspect): CameraPose {
      const d = 14 / Math.min(1, aspect / 1.4);
      return { position: [0, 2.2, d], target: [0, 0, 0], fov: 40 };
    },
    update: () => false,
    dispose() {
      for (const k of kept.splice(0)) k.dispose();
      group.clear();
    },
  };
}
