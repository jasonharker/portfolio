// Local tier (spec §3): the object fills the frame, the galaxy is a backdrop band with the core
// glowing in its true direction. Three places live here — the incidents orrery, the GitOps ship and
// the black hole at the core — and each is a group in one shared scene, so the sky, the core glow
// and the render path are built once rather than three times.
//
// Scale: each place works in its own units, because a solar system and a black hole are ~10^9 apart
// and no depth buffer holds both. What stays true across them is direction: `coreDirection` points
// at the galactic core from that place's real waypoint, so the backdrop is never arbitrary.
//
// Draw calls: the sky's two, the core glow (1), and whatever the shown place adds. Only one place's
// group is visible at a time; the other two cost nothing but memory.
import * as THREE from 'three';
import { additive, createSky, type Sky } from '../jwst';
import { createBlackHole } from '../local/blackhole';
import { createOrrery } from '../local/orrery';
import { createShip } from '../local/ship';
import type { CameraPose, PlaceId, SceneContext, Tier } from '../types';

const NEAR = 0.01;
const FAR = 4000;
const CORE_DISTANCE = 900; // where the core glow sits: far enough to read as background at any place scale

/**
 * One destination. An agent owns exactly one of these and nothing else in the tier: no camera
 * plumbing, no sky, no render loop.
 */
export interface LocalPlace {
  /** Everything the place draws. Added to the shared scene once; visibility is the tier's business. */
  group: THREE.Group;
  /** Where the camera sits to read this place, in the place's own units. `aspect` is width/height. */
  pose(aspect: number): CameraPose;
  /** Per rendered frame, ambient ones included. true only while something needs full rate. */
  update(dt: number): boolean;
  /** Offscreen passes before the scene is drawn — the black hole's lens target. Same shape as dust.ts. */
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

const coreGlowVertex = /* glsl */ `
  uniform float uSize;
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 2.0;
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * uSize;
    gl_Position = projectionMatrix * mv;
  }
`;
// The bulge seen from far out in an arm: a small, soft ellipse, not the Galaxy tier's blazing core.
const coreGlowFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    float d = length(vUv);
    float i = (0.9 * exp(-d * d * 9.0) + 0.25 * exp(-d * d * 1.4)) * uStrength;
    gl_FragColor = vec4(mix(uColor, vec3(1.0), clamp(i - 0.7, 0.0, 1.0)) * i, 1.0);
    #include <colorspace_fragment>
  }
`;

let ctx: SceneContext;
let scene: THREE.Scene;
let sky: Sky;
let core: THREE.Mesh;
let shown: PlaceId = 'documentation';
let aspect = 16 / 9;
const places = {} as Record<Exclude<PlaceId, 'constellation'>, LocalPlace>;
const disposables: { dispose(): void }[] = [];
const coreUniforms = { uSize: { value: 120 }, uStrength: { value: 1 }, uColor: { value: new THREE.Color() } };

function own<T extends { dispose(): void }>(x: T): T {
  disposables.push(x);
  return x;
}

/** Unit vector from a place toward the galactic core, which sits at the origin (topology.yaml). */
export function coreDirection(c: SceneContext, id: PlaceId): THREE.Vector3 {
  const w = c.topology.waypoints.find((p) => p.id === id)!;
  const v = new THREE.Vector3(-w.pos[0], -w.pos[1], -w.pos[2]);
  // At the core itself there is no direction to it; look along the disc instead.
  return v.lengthSq() < 1e-6 ? new THREE.Vector3(0, 0, -1) : v.normalize();
}

/** The place a PlaceId reads in here. `constellation` never arrives (routes.ts sends it to Region). */
const at = (id: PlaceId) => places[id === 'constellation' ? 'documentation' : id];

export const local: Tier = {
  id: 'local',

  async load(c) {
    ctx = c;
    scene = new THREE.Scene();
    scene.background = c.colour('--ground');

    sky = own(createSky(c.quality.deepField, c.quality.foreground, c.quality.dpr, c.colour));
    sky.gain(0.75, 1);

    const geo = own(new THREE.PlaneGeometry(1, 1));
    const mat = own(new THREE.ShaderMaterial({
      vertexShader: coreGlowVertex, fragmentShader: coreGlowFragment, ...additive, uniforms: coreUniforms,
    }));
    coreUniforms.uColor.value = c.colour('--star-12000');
    core = new THREE.Mesh(geo, mat);
    core.frustumCulled = false;
    core.renderOrder = 1;

    places.incidents = own(createOrrery(c));
    places.gitops = own(createShip(c));
    places.documentation = own(createBlackHole(c));

    scene.add(sky.group, core);
    for (const p of Object.values(places)) scene.add(p.group);
    // Compile every place's materials now, while all three groups are still visible. Otherwise the
    // first frame that shows a place compiles its shaders mid-flight, which stalls the cut — a
    // visible hitch on an Intel UHD 620, and seconds under SwiftShader in the tests.
    c.renderer.compile(scene, c.camera);
    this.show?.(false);
  },

  // Reading frame() is how the tier learns which place it is about to show: flight.ts calls it as a
  // beat starts, never earlier, precisely so a tier can switch what it draws.
  frame(id) {
    shown = id === 'constellation' ? shown : id;
    for (const [key, p] of Object.entries(places)) p.group.visible = key === shown;
    // The core sits at its true bearing from this place, far enough out to read as background.
    core.position.copy(coreDirection(ctx, shown)).multiplyScalar(CORE_DISTANCE);
    coreUniforms.uStrength.value = shown === 'documentation' ? 0 : 1; // at the core, the place *is* the core
    return at(shown).pose(aspect);
  },

  update(dt) {
    sky.update(dt);
    return at(shown).update(dt);
  },

  hover(x, y) {
    at(shown).hover?.(x, y);
  },

  hot() {
    return at(shown).hot?.() ?? null;
  },

  href() {
    return at(shown).href?.() ?? null;
  },

  render(renderer, camera) {
    const cam = camera as THREE.PerspectiveCamera;
    if (cam.near !== NEAR || cam.far !== FAR) {
      cam.near = NEAR;
      cam.far = FAR;
      cam.updateProjectionMatrix();
    }
    at(shown).prepare?.(renderer, camera);
    renderer.render(scene, camera);
  },

  resize(width, height) {
    aspect = width / height;
    for (const p of Object.values(places)) p.resize?.(width, height);
  },

  show(visible) {
    // Nothing DOM-side yet; kept so a place can hide its own overlay when the tier is cut away.
    for (const [key, p] of Object.entries(places)) p.group.visible = visible && key === shown;
  },

  dispose() {
    for (const d of disposables.splice(0)) d.dispose();
  },
};
