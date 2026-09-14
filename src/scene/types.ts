// Scene contracts (M2 handoff §4). After W0 merges, changes here go through the lead.
import type * as THREE from 'three';

export type PlaceId = 'constellation' | 'incidents' | 'gitops' | 'documentation';
export type TierId = 'galaxy' | 'region'; // 'local' arrives in M3
export type Vec3 = [number, number, number];
export type Layer = 'physical' | 'proxmox' | 'kubernetes' | 'services';

export interface TopologyNode { id: string; role: string; layer: Layer; pos?: Vec3 }
export interface Waypoint { id: PlaceId; pos: Vec3; focus?: string[] }
/** Mirrors the validated schema in src/content.config.ts. Galaxy units ≈ kpc, disc in XZ, core at origin. */
export interface Topology { nodes: TopologyNode[]; links: { from: string; to: string }[]; waypoints: Waypoint[] }

/** Chosen once at startup (quality.ts). Tiers read counts from here, never hardcode them. */
export interface Quality { dpr: number; stars: number; bloom: boolean; reducedMotion: boolean }

/** Camera placement in the active tier's own units. Tiers set their own near/far in render(). */
export interface CameraPose { position: Vec3; target: Vec3; fov: number }

export interface SceneContext {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  topology: Topology;
  quality: Quality;
  /** DOM layer for labels, persisted across navigation, sized to the viewport. */
  labels: HTMLElement;
  /** A token from tokens.css, e.g. colour('--star-5600'). tokens.css stays the only source. */
  colour(token: string): THREE.Color;
  /** Request a frame; the loop otherwise idles. */
  invalidate(): void;
}

export interface Tier {
  id: TierId;
  load(ctx: SceneContext): Promise<void>; // called once, on first use
  frame(place: PlaceId): CameraPose; // where the camera sits to show this place
  update(dt: number): boolean; // true = still animating, keep rendering
  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void;
  resize?(width: number, height: number): void; // CSS pixels; renderer is already resized
  show?(visible: boolean): void; // e.g. hide DOM labels when the tier is cut away
  dispose(): void;
}

/** What index.ts hands a flight director (flight.ts, reduced-motion.ts). */
export interface Stage {
  ctx: SceneContext;
  tier(id: TierId): Promise<Tier>; // loads once, then cached
  cut(id: TierId): void; // make a loaded tier the one that renders (a stepped cut)
  current(): { tier: TierId | null; pose: CameraPose }; // tier is null until the first cut
  pose(p: CameraPose): void; // apply to the camera
}

/** A flight director: flight.ts, or reduced-motion.ts under prefers-reduced-motion. */
export interface Director {
  to(place: PlaceId | 'resume', opts: { instant: boolean }): void; // mid-flight: retarget, don't queue
  skip(): void; // jump to the end of the current flight
  update(dt: number): boolean; // true = still flying
}

export interface Scene {
  goTo(path: string, opts?: { instant?: boolean }): void;
  skip(): void;
  invalidate(): void;
}

/** window.__scene, read by tests/scene.py through page.evaluate (the CSP forbids eval-based waits). */
export interface SceneDebug {
  born: string;
  canvas: HTMLCanvasElement;
  webgl2: true;
  frames: number;
  contextLost: number;
  path: string;
  place: PlaceId | 'resume';
  instantAt: string | null; // path of the deep link the scene opened at; cleared by the first flight
  flights: string[]; // every non-instant goTo, in order
  flying: boolean; // the director reported a flight in progress on the last frame
  idle: boolean; // no frame is scheduled
  paused: boolean;
}
