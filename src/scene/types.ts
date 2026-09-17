// Scene contracts (M2 handoff §4). After W0 merges, changes here go through the lead.
import type * as THREE from 'three';

export type PlaceId = 'constellation' | 'incidents' | 'gitops' | 'documentation';
// M4: two tiers, not three. Every place is read in Region, at its own scale but in one space, so
// the only cut left in the site is Galaxy <-> Region, between two views of the same seeded galaxy.
export type TierId = 'galaxy' | 'region';
export type Vec3 = [number, number, number];
export type Layer = 'physical' | 'proxmox' | 'kubernetes' | 'services';

export interface TopologyNode { id: string; role: string; layer: Layer; pos?: Vec3 }
export interface Waypoint { id: PlaceId; pos: Vec3; focus?: string[] }
/** Mirrors the validated schema in src/content.config.ts. Galaxy units ≈ kpc, disc in XZ, core at origin. */
export interface Topology { nodes: TopologyNode[]; links: { from: string; to: string }[]; waypoints: Waypoint[] }

/** One incident, one planet in the Local orrery. Mirrors the collection schema in src/content.config.ts. */
export interface Incident { slug: string; label: string; order: number; focus: string[] }

/** Chosen once at startup (quality.ts). Tiers read counts from here, never hardcode them. */
export interface Quality {
  dpr: number;
  stars: number; // galaxy-model stars in the Galaxy tier
  regionStars: number; // galaxy-model stars in the Region tier; same seed, so a superset of the Galaxy tier's
  deepField: number; // background galaxies, shared by both tiers
  foreground: number; // foreground stars with diffraction spikes, shared by both tiers
  brightStars: number; // Region: the most luminous young stars, drawn with spikes when near enough
  dustScale: number; // the disc dust pass renders at this fraction of CSS pixels
  bloom: boolean;
  reducedMotion: boolean;
}

/**
 * Camera placement, always in galaxy units (kpc). M4: one space for the whole site, so a flight is
 * one continuous move rather than a cut between tiers whose poses can't be compared. A place's own
 * units reach it through its group's scale (see LocalPlace). Tiers set their near/far in render().
 */
export interface CameraPose { position: Vec3; target: Vec3; fov: number }

export interface SceneContext {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  topology: Topology;
  incidents: Incident[]; // sorted by `order`, best first
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
  // Where the camera sits to read a place, in galaxy units. Only Region has one: places are read
  // there and nowhere else, and the Galaxy tier is flown across rather than framed (spec §3).
  frame?(place: PlaceId): CameraPose;
  // Called every rendered frame, ambient ones included. true = animating at full rate (a hover
  // easing, say). Idle life (twinkle, drift) advances by dt and returns false: the loop keeps it at <=30 fps.
  update(dt: number): boolean;
  /** Mouse pointer in CSS pixels, NaN when it leaves. Not called for touch. Return nothing; call ctx.invalidate() to animate. */
  hover?(x: number, y: number): void;
  hot?(): string | null; // id of the topology node under the pointer, or null (read into __scene.hot)
  reading?(): PlaceId | null; // the place close enough to be read, or null out among the arms
  href?(): string | null; // the URL a click on the pointer's target would open, or null
  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void;
  resize?(width: number, height: number): void; // CSS pixels; renderer is already resized
  show?(visible: boolean): void; // e.g. hide DOM labels when the tier is cut away
  dispose(): void;
}

/**
 * One destination object. An agent owns exactly one of these and nothing else: no camera plumbing,
 * no sky, no render loop. M4: a place is no longer a tier of its own — Region adds `group` at the
 * place's waypoint and scales it, so the object works in its own units while the camera never
 * leaves galaxy space. The scale is derived from `pose()`, not declared: whatever distance the
 * place asks to be read from becomes READ_DISTANCE kpc (tiers/region.ts).
 */
export interface LocalPlace {
  /**
   * Everything the place draws, in the place's own units, about its own origin.
   *
   * ⚠ The tier gives this group a scale. Anything a shader computes in *view* space or in pixels —
   * a billboard's half-size, a sprite radius from a uniform — is not reached by it, and a place that
   * ignores this fills the screen with a white lamp. Carry the scale across with
   * `length(modelMatrix[0].xyz)`; positions and geometry need nothing.
   */
  group: THREE.Group;
  /** Where the camera sits to read this place, in the place's own units. `aspect` is width/height. */
  pose(aspect: number): CameraPose;
  /** Per rendered frame, ambient ones included. true only while something needs full rate. */
  update(dt: number): boolean;
  /** Offscreen passes before the scene is drawn. Same shape as dust.ts. */
  prepare?(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void;
  resize?(width: number, height: number): void;
  /** Mouse pointer in CSS pixels, NaN when it leaves. Never called for touch. */
  hover?(x: number, y: number): void;
  /** What the pointer is over, for __scene.hot and the tests. */
  hot?(): string | null;
  /** The URL a click would open, or null. The tier turns it into a navigation. */
  href?(): string | null;
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
  rate: 'full' | 'ambient' | 'idle'; // ambient: only the ≤30 fps idle animation is running
  hot: string | null; // the constellation star under the pointer, or null
  reading: PlaceId | null; // the place the camera is close enough to read; null while out among the arms
  tier: TierId | null; // the tier being rendered; null until the first cut
  paused: boolean;
  parallax: number; // eased mouse offset, 0 at rest, up to ~1.4 in a viewport corner
  sway: number; // camera offset from the director's pose, as a fraction of view distance (parallax + drift)
  hoverable: boolean; // the active tier implements hot()
}
