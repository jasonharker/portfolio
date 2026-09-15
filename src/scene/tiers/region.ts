// Region tier: about a tenth of the disc around any waypoint. The backdrop is the same seeded
// galaxy the Galaxy tier draws (galaxy-model), so the local arm segment and the core glow sit in
// their true directions. The constellation lives at its waypoint; the other places get a
// placeholder marker until M3 brings the Local tier.
//
// Units are galaxy units (≈ kpc), so waypoint positions from topology.yaml are used directly.
import * as THREE from 'three';
import { createConstellation, type Constellation } from '../constellation';
import { galaxyModel, SEED } from '../galaxy-model';
import { createLabels, type Labels } from '../labels';
import type { CameraPose, PlaceId, SceneContext, Tier, Waypoint } from '../types';

const DISTANCE = 2.2; // camera to the framed place; ~3.5 wide at 16:9, a tenth of the disc
const CORE_DISTANCE = 4.5; // the core (documentation) is larger than a tenth; stand back to see the bulge
const ELEVATION = THREE.MathUtils.degToRad(24);
const AZIMUTH = THREE.MathUtils.degToRad(46); // swings the view so the core falls toward an edge
const FOV = 50;
const CONSTELLATION_SCALE = 0.62; // galaxy units per constellation-local unit
const LABEL_RANGE = 8; // labels show only when the constellation is near enough to read
const CORE_GLOW_RADIUS = 3.6;

// Blackbody tokens by kelvin; star temperatures are interpolated between them.
const KELVIN = [3000, 4300, 5600, 6800, 8500, 12000, 30000];

const backdropVertex = /* glsl */ `
  attribute vec3 tint;
  uniform float dpr;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float s = 2.4 / max(-mv.z, 0.001);
    vAlpha = clamp(s, 0.18, 1.0);
    vColor = tint;
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(s, 1.0, 3.0) * dpr;
  }
`;
const backdropFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float a = vAlpha * (1.0 - smoothstep(0.5, 1.0, r));
    gl_FragColor = vec4(vColor * a, 1.0);
    #include <colorspace_fragment>
  }
`;
const glowVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv * 2.0 - 1.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const glowFragment = /* glsl */ `
  uniform vec3 inner;
  uniform vec3 outer;
  uniform float strength;
  varying vec2 vUv;
  void main() {
    float r = length(vUv);
    float a = exp(-r * r * 9.0) * 0.55 + exp(-r * 3.2) * 0.16 * (1.0 - smoothstep(0.7, 1.0, r));
    gl_FragColor = vec4(mix(outer, inner, exp(-r * r * 14.0)) * a * strength, 1.0);
    #include <colorspace_fragment>
  }
`;
const markerVertex = /* glsl */ `
  attribute vec3 tint;
  uniform float size;
  varying vec3 vColor;
  void main() {
    vColor = tint;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size;
  }
`;
const markerFragment = /* glsl */ `
  varying vec3 vColor;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float ring = smoothstep(0.14, 0.0, abs(r - 0.72));
    float dot = smoothstep(0.2, 0.1, r);
    float a = ring * 0.8 + dot;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor * a, 1.0);
    #include <colorspace_fragment>
  }
`;

let ctx: SceneContext;
let scene: THREE.Scene;
let constellation: Constellation;
let labels: Labels;
let ground: THREE.Color;
let glow: THREE.Mesh;
let observer: ResizeObserver;
let visible = false;
let width = innerWidth;
let height = innerHeight;
const disposables: { dispose(): void }[] = [];

function waypoint(place: PlaceId): Waypoint {
  return ctx.topology.waypoints.find((w) => w.id === place)!;
}

/** Camera placement for a place before the right-of-centre pan: position, target and basis. */
function base(place: PlaceId) {
  const target = new THREE.Vector3(...waypoint(place).pos);
  // Outward from the core; the core itself (documentation) looks in along +z.
  const out = new THREE.Vector3(target.x, 0, target.z);
  const core = out.length() < 1;
  if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
  out.normalize();
  const distance = core ? CORE_DISTANCE : DISTANCE;
  const side = new THREE.Vector3(out.z, 0, -out.x);
  const flat = out.multiplyScalar(Math.cos(AZIMUTH)).addScaledVector(side, Math.sin(AZIMUTH));
  const position = target.clone()
    .addScaledVector(flat, distance * Math.cos(ELEVATION))
    .add(new THREE.Vector3(0, distance * Math.sin(ELEVATION), 0));
  const back = position.clone().sub(target).normalize(); // toward the camera
  const right = new THREE.Vector3(0, 1, 0).cross(back).normalize();
  const up = back.clone().cross(right);
  return { target, position, right, up, back, distance };
}

function temperatureColours(temperatures: Float32Array): Float32Array {
  const stops = KELVIN.map((k) => ctx.colour(`--star-${k}`));
  const out = new Float32Array(temperatures.length * 3);
  const c = new THREE.Color();
  for (let i = 0; i < temperatures.length; i++) {
    const t = temperatures[i];
    let j = 0;
    while (j < KELVIN.length - 2 && t > KELVIN[j + 1]) j++;
    const f = THREE.MathUtils.clamp((t - KELVIN[j]) / (KELVIN[j + 1] - KELVIN[j]), 0, 1);
    c.copy(stops[j]).lerp(stops[j + 1], f).toArray(out, i * 3);
  }
  return out;
}

function track<T extends { dispose(): void }>(d: T): T {
  disposables.push(d);
  return d;
}

export const region: Tier = {
  id: 'region',

  async load(c) {
    ctx = c;
    scene = new THREE.Scene();
    ground = ctx.colour('--ground');
    const dpr = ctx.quality.dpr;

    // Backdrop: the seeded galaxy.
    const model = galaxyModel(SEED, ctx.quality.stars, ctx.topology.waypoints);
    const starGeometry = track(new THREE.BufferGeometry());
    starGeometry.setAttribute('position', new THREE.BufferAttribute(model.positions, 3));
    starGeometry.setAttribute('tint', new THREE.BufferAttribute(temperatureColours(model.temperatures), 3));
    const starMaterial = track(new THREE.ShaderMaterial({
      uniforms: { dpr: { value: dpr } },
      vertexShader: backdropVertex,
      fragmentShader: backdropFragment,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    }));
    const backdrop = new THREE.Points(starGeometry, starMaterial);
    backdrop.frustumCulled = false;
    backdrop.renderOrder = 0;

    // The core glow, a camera-facing quad at the origin.
    const glowGeometry = track(new THREE.PlaneGeometry(CORE_GLOW_RADIUS * 2, CORE_GLOW_RADIUS * 2));
    const glowMaterial = track(new THREE.ShaderMaterial({
      uniforms: { inner: { value: ctx.colour('--star-5600') }, outer: { value: ctx.colour('--star-4300') }, strength: { value: 1 } },
      vertexShader: glowVertex,
      fragmentShader: glowFragment,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    }));
    glow = new THREE.Mesh(glowGeometry, glowMaterial);
    glow.frustumCulled = false;
    glow.renderOrder = 1;

    // The constellation faces the camera that frames it.
    const b = base('constellation');
    constellation = createConstellation(ctx, b.target, CONSTELLATION_SCALE, new THREE.Matrix4().makeBasis(b.right, b.up, b.back), DISTANCE * 1.3);
    constellation.resize(dpr);
    track(constellation);
    labels = createLabels(ctx.labels, ctx.topology.nodes, constellation.world);
    labels.show(visible);
    track(labels);

    // Placeholder markers for the places M3 makes Local.
    const others = ctx.topology.waypoints.filter((w) => w.id !== 'constellation');
    const markerTokens: Record<PlaceId, string> = { constellation: '--star-5600', incidents: '--star-3000', gitops: '--star-8500', documentation: '--star-12000' };
    const markerPositions = new Float32Array(others.flatMap((w) => w.pos));
    const markerColours = new Float32Array(others.length * 3);
    others.forEach((w, i) => ctx.colour(markerTokens[w.id]).toArray(markerColours, i * 3));
    const markerGeometry = track(new THREE.BufferGeometry());
    markerGeometry.setAttribute('position', new THREE.BufferAttribute(markerPositions, 3));
    markerGeometry.setAttribute('tint', new THREE.BufferAttribute(markerColours, 3));
    const markerMaterial = track(new THREE.ShaderMaterial({
      uniforms: { size: { value: 30 * dpr } },
      vertexShader: markerVertex,
      fragmentShader: markerFragment,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    }));
    const markers = new THREE.Points(markerGeometry, markerMaterial);
    markers.frustumCulled = false;
    markers.renderOrder = 4;

    scene.add(backdrop, glow, constellation.group, markers);

    // The label layer's box is the canvas's box (both fixed, inset 0), which excludes a scrollbar
    // that innerWidth includes; watch it directly.
    observer = new ResizeObserver(() => {
      width = ctx.labels.clientWidth || innerWidth;
      height = ctx.labels.clientHeight || innerHeight;
      ctx.invalidate();
    });
    observer.observe(ctx.labels);
  },

  frame(place) {
    const { target, position, right, up, back, distance: framed } = base(place);
    // Spec §6: the object sits right of centre beside the reading column. On a portrait
    // screen the column is a bottom sheet, so it sits high instead, pulled back to fit the width.
    const aspect = width / height;
    const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const distance = aspect >= 1 ? framed : Math.max(framed, 1.1 / (tan * aspect));
    position.addScaledVector(back, distance - framed);
    const half = distance * tan;
    const pan = aspect >= 1
      ? right.multiplyScalar(-0.33 * half * aspect).addScaledVector(up, 0.08 * half)
      : up.multiplyScalar(-0.4 * half);
    return {
      position: position.add(pan).toArray() as CameraPose['position'],
      target: target.add(pan).toArray() as CameraPose['target'],
      fov: FOV,
    };
  },

  update: () => false,

  render(renderer, camera) {
    const cam = camera as THREE.PerspectiveCamera;
    if (cam.near !== 0.01 || cam.far !== 80) {
      cam.near = 0.01;
      cam.far = 80;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    glow.quaternion.copy(cam.quaternion);
    // Inside the bulge the stars are the core; the glow is for seeing it from the arms.
    (glow.material as THREE.ShaderMaterial).uniforms.strength.value = THREE.MathUtils.smoothstep(cam.position.length(), 1.5, 7);
    renderer.setClearColor(ground, 1);
    const far = cam.position.distanceTo(constellation.centre);
    constellation.fade(far);
    renderer.render(scene, cam);
    labels.update(cam, width, height, visible && far < LABEL_RANGE);
  },

  resize(w, h) {
    width = ctx.labels.clientWidth || w;
    height = ctx.labels.clientHeight || h;
  },

  show(on) {
    visible = on;
    labels?.show(on);
  },

  dispose() {
    observer?.disconnect();
    for (const d of disposables.splice(0)) d.dispose();
  },
};
