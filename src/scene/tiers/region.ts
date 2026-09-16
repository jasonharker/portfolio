// Region tier: about a tenth of the disc around any waypoint, as a PHANGS-JWST crop of one arm
// segment. The backdrop is the same seeded galaxy the Galaxy tier draws (galaxy-model), so the local
// arm segment and the core glow sit in their true directions, with young blue-white clusters along
// the arms and the most luminous of their stars carrying JWST's spikes. The constellation lives at
// its waypoint; the other places get a placeholder marker until M3 brings the Local tier.
//
// Units are galaxy units (≈ kpc), so waypoint positions from topology.yaml are used directly, and
// stars are sized in kpc: nearer ones read bigger and brighter.
// Draw calls: dust into its target (1), then deep field, stars, dust composite, core glow, bright
// stars, constellation links and stars, foreground stars, place markers (9).
import * as THREE from 'three';
import { createConstellation, type Constellation } from '../constellation';
import { createDust, type Dust } from '../dust';
import { DISC_RADIUS, galaxyModel, prng, SEED } from '../galaxy-model';
import { additive, createSky, palette, SPIKES, vivid, type Sky } from '../jwst';
import { createLabels, type Labels } from '../labels';
import type { CameraPose, PlaceId, SceneContext, Tier, Waypoint } from '../types';

const DISTANCE = 2.2; // camera to the framed place; ~3.5 wide at 16:9, a tenth of the disc
const CORE_DISTANCE = 4.5; // the core (documentation) is larger than a tenth; stand back to see the bulge
const ELEVATION = THREE.MathUtils.degToRad(24);
const AZIMUTH = THREE.MathUtils.degToRad(46); // swings the view so the core falls toward an edge
const FOV = 50;
const CONSTELLATION_SCALE = 0.62; // galaxy units per constellation-local unit
const LABEL_RANGE = 8; // labels show only when the constellation is near enough to read
const HOVER_PX = 24; // CSS px from a star's projection that still hovers it
const STAR_SIZE = 0.012; // kpc per unit of star luminosity; the Galaxy tier's 60k stars use 0.05, these are resolved
const CLUSTER_RADIUS = [0.012, 0.05]; // kpc
const SPIKE_SIZE = 0.08; // kpc across a bright star's sprite at full luminosity

const starsVertex = /* glsl */ `
  attribute vec4 tint; // rgb, a = size in kpc
  uniform float uScale; // drawing-buffer pixels per unit at distance 1
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float px = tint.a * uScale / max(-mv.z, 1e-3);
    gl_PointSize = clamp(px, 2.0, 64.0);
    vAlpha = min(1.0, px * px / 16.0); // below 4 px a star keeps its flux, fading rather than shimmering
    vColor = tint.rgb;
    gl_Position = projectionMatrix * mv;
  }
`;
const starsFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    // The profile is lifted to zero at the sprite's edge: large sprites would otherwise show their square.
    float g = max(0.0, exp(-5.0 * dot(c, c)) - 0.0067) / 0.9933;
    gl_FragColor = vec4(vColor * min(1.0, g * vAlpha * 1.6), 1.0);
    #include <colorspace_fragment>
  }
`;

const brightVertex = /* glsl */ `
  attribute vec4 tint; // rgb, luminosity 0..1
  uniform float uScale;
  varying vec3 vColor;
  varying float vGain;
  varying float vPx;
  varying float vReach;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float px = (0.25 + tint.a) * ${SPIKE_SIZE.toFixed(3)} * uScale / max(-mv.z, 1e-3);
    // Spikes only when near enough to resolve them; farther, the backdrop's own point stands in.
    if (px < 12.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    px = min(px, 384.0);
    gl_PointSize = px;
    vPx = px * 0.5;
    vReach = 0.45 + 0.55 * tint.a;
    vColor = tint.rgb;
    vGain = smoothstep(12.0, 36.0, px) * (0.12 + 1.4 * tint.a) * clamp(px / 80.0, 0.6, 1.4);
    gl_Position = projectionMatrix * mv;
  }
`;
const brightFragment = /* glsl */ `
  ${SPIKES}
  varying vec3 vColor;
  varying float vGain;
  varying float vPx;
  varying float vReach;
  void main() {
    vec2 k = spikes(gl_PointCoord * 2.0 - 1.0, vPx, vReach);
    vec3 c = (mix(vColor, vec3(1.0), 0.55) * k.x * 1.2 + vColor * k.y * 2.6) * vGain;
    gl_FragColor = vec4(c * smoothstep(1.0, 0.8, length(gl_PointCoord * 2.0 - 1.0)), 1.0);
    #include <colorspace_fragment>
  }
`;

// The Galaxy tier's bulge glow, in the same kpc and colour, so a flight's cut doesn't jump.
const glowVertex = /* glsl */ `
  uniform float uSize;
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 2.0;
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * uSize;
    gl_Position = projectionMatrix * mv;
  }
`;
const glowFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    float d = length(vUv) * 8.0; // kpc, the quad spans ±8
    float i = 1.5 * exp(-d * d / 0.06) + 0.35 * exp(-d * d / 0.8) + 0.1 * exp(-d / 1.6);
    i *= smoothstep(8.0, 5.0, d) * uStrength;
    gl_FragColor = vec4(mix(uColor, vec3(1.0), clamp(i - 0.6, 0.0, 1.0)) * i, 1.0);
    #include <colorspace_fragment>
  }
`;

// Placeholders, as the Galaxy tier marks places: an ink ring and dot with a dark keyline, so they read
// over the bright arm.
const markerVertex = /* glsl */ `
  uniform float uSize;
  void main() {
    gl_PointSize = uSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const markerFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uGround;
  uniform float uSize;
  void main() {
    float d = length(gl_PointCoord * 2.0 - 1.0);
    float aa = 2.0 / uSize;
    float ring = 1.0 - smoothstep(0.0, aa * 1.5, abs(d - 0.66) - aa * 1.5);
    float core = 1.0 - smoothstep(0.14, 0.14 + aa * 2.0, d);
    float mark = max(ring, core);
    float keyline = max(1.0 - smoothstep(0.0, aa * 2.0, abs(d - 0.66) - aa * 5.0), 1.0 - smoothstep(0.22, 0.22 + aa * 3.0, d));
    gl_FragColor = vec4(mix(uGround, uColor, mark), max(mark, keyline * 0.7));
    #include <colorspace_fragment>
  }
`;

let ctx: SceneContext;
let scene: THREE.Scene;
let constellation: Constellation;
let labels: Labels;
let ground: THREE.Color;
let dust: Dust;
let sky: Sky;
let observer: ResizeObserver;
let visible = false;
let width = innerWidth;
let height = innerHeight;
let pointer = { x: NaN, y: NaN };
let hot: string | null = null;
let labelsOn = false;
const disposables: { dispose(): void }[] = [];
const starUniforms = { uScale: { value: 1 } };
const glowUniforms = { uSize: { value: 16 }, uColor: { value: new THREE.Color() }, uStrength: { value: 1 } };
const markerUniforms = { uSize: { value: 30 }, uColor: { value: new THREE.Color() }, uGround: { value: new THREE.Color() } };
const buffer = new THREE.Vector2();

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

function track<T extends { dispose(): void }>(d: T): T {
  disposables.push(d);
  return d;
}

function points(geometry: THREE.BufferGeometry, material: THREE.Material, order: number) {
  const p = new THREE.Points(geometry, material);
  p.frustumCulled = false;
  p.renderOrder = order;
  return p;
}

export const region: Tier = {
  id: 'region',

  async load(c) {
    ctx = c;
    scene = new THREE.Scene();
    ground = ctx.colour('--ground');
    const dpr = ctx.quality.dpr;
    const colourOf = palette(ctx.colour);
    const col = new THREE.Color();

    // Stars: the seeded galaxy (a superset of the Galaxy tier's), then young clusters along the arms.
    const model = galaxyModel(SEED, ctx.quality.regionStars, ctx.topology.waypoints);
    const clusters = ctx.quality.brightStars;
    const rand = prng(SEED ^ 0xc1a5);
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    const members: number[] = [], memberTint: number[] = [], bright: number[] = [], brightTint: number[] = [];
    for (let i = 0; i < clusters; i++) {
      // Along an arm's spine, from the disc's own exponential profile, clear of the bulge.
      let r: number;
      do r = 1.4 - 4.2 * Math.log(1 - rand());
      while (r > DISC_RADIUS - 1 || r < 2);
      const width = 0.45 + 0.07 * r;
      const a = model.armAngleAt(r, Math.floor(rand() * model.arms)) + (gauss() * width * 0.45) / r;
      const cx = r * Math.cos(a), cy = gauss() * 0.04, cz = r * Math.sin(a);
      const radius = CLUSTER_RADIUS[0] + (CLUSTER_RADIUS[1] - CLUSTER_RADIUS[0]) * rand();
      // Mostly sparse associations, a few rich clusters: equal knots would read as a string of pearls.
      const count = 3 + Math.floor(45 * Math.pow(rand(), 4));
      for (let j = 0; j < count; j++) {
        members.push(cx + gauss() * radius, cy + gauss() * radius * 0.5, cz + gauss() * radius);
        colourOf(9000 * Math.pow(30000 / 9000, rand()), col);
        col.multiplyScalar(0.3 + 0.6 * rand());
        memberTint.push(col.r, col.g, col.b, STAR_SIZE * (0.5 + 0.7 * rand()));
      }
      // Its most luminous star: few are bright enough for long spikes.
      bright.push(cx, cy, cz);
      colourOf(14000 + 16000 * rand(), col);
      brightTint.push(col.r, col.g, col.b, Math.pow(rand(), 2.5));
    }

    const n = model.temperatures.length;
    const positions = new Float32Array(n * 3 + members.length);
    positions.set(model.positions);
    positions.set(members, n * 3);
    const tint = new Float32Array(n * 4 + memberTint.length);
    for (let i = 0; i < n; i++) {
      const t = model.temperatures[i];
      colourOf(t, col);
      // As the Galaxy tier: hot stars are the luminous ones, a stable per-star hash varies the rest,
      // and the bulge's light comes from its glow.
      const h = (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296;
      const lum = t > 8000 ? 0.55 + 0.8 * h : 0.3 + 0.45 * h;
      const x = model.positions[i * 3], y = model.positions[i * 3 + 1], z = model.positions[i * 3 + 2];
      col.multiplyScalar(THREE.MathUtils.smoothstep(Math.hypot(x, y, z), 0.5, 6) * 0.6 + 0.15);
      tint.set([col.r, col.g, col.b, STAR_SIZE * lum], i * 4);
    }
    tint.set(memberTint, n * 4);
    const starGeometry = track(new THREE.BufferGeometry());
    starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    starGeometry.setAttribute('tint', new THREE.BufferAttribute(tint, 4));
    const starMaterial = track(new THREE.ShaderMaterial({ vertexShader: starsVertex, fragmentShader: starsFragment, uniforms: starUniforms, ...additive }));

    const brightGeometry = track(new THREE.BufferGeometry());
    brightGeometry.setAttribute('position', new THREE.Float32BufferAttribute(bright, 3));
    brightGeometry.setAttribute('tint', new THREE.Float32BufferAttribute(brightTint, 4));
    const brightMaterial = track(new THREE.ShaderMaterial({ vertexShader: brightVertex, fragmentShader: brightFragment, uniforms: starUniforms, ...additive }));

    // The core glow, a camera-facing quad at the origin.
    const glowGeometry = track(new THREE.PlaneGeometry(1, 1));
    glowUniforms.uColor.value = vivid(ctx.colour('--star-12000'), 1.6).multiplyScalar(0.8);
    const glowMaterial = track(new THREE.ShaderMaterial({ uniforms: glowUniforms, vertexShader: glowVertex, fragmentShader: glowFragment, ...additive }));
    const glow = new THREE.Mesh(glowGeometry, glowMaterial);
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
    const markerGeometry = track(new THREE.BufferGeometry());
    markerGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(others.flatMap((w) => w.pos)), 3));
    markerUniforms.uSize.value = 30 * dpr;
    markerUniforms.uColor.value = ctx.colour('--ink');
    markerUniforms.uGround.value = ground;
    const markerMaterial = track(new THREE.ShaderMaterial({
      uniforms: markerUniforms, vertexShader: markerVertex, fragmentShader: markerFragment,
      transparent: true, depthTest: false, depthWrite: false,
    }));

    // The same kpc dust field as the Galaxy tier, seen close (look 1: absorbing lanes, HII), and the same sky.
    dust = track(createDust(model, 1, 1, ctx.quality.dustScale, 5));
    dust.resize(width, height);
    dust.composite.renderOrder = 0.5;
    sky = track(createSky(ctx.quality.deepField, ctx.quality.foreground, dpr, ctx.colour));
    sky.gain(0.9, 1);

    scene.add(sky.group, points(starGeometry, starMaterial, 0), dust.composite, glow, points(brightGeometry, brightMaterial, 1.5),
      constellation.group, points(markerGeometry, markerMaterial, 11));

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

  update(dt) {
    sky.update(dt);
    // The camera may have moved under a still pointer: test against last frame's label positions.
    if (!Number.isNaN(pointer.x)) region.hover!(pointer.x, pointer.y);
    return constellation.update(dt, hot);
  },

  hover(x, y) {
    pointer = { x, y };
    const next = Number.isNaN(x) || !labelsOn ? null : labels.hit(x, y, HOVER_PX);
    if (next === hot) return;
    hot = next;
    labels.highlight(hot);
    ctx.invalidate();
  },

  hot: () => hot,

  render(renderer, camera) {
    const cam = camera as THREE.PerspectiveCamera;
    if (cam.near !== 0.01 || cam.far !== 80) {
      cam.near = 0.01;
      cam.far = 80;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    renderer.getDrawingBufferSize(buffer);
    starUniforms.uScale.value = buffer.y / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    // Inside the bulge the stars are the core; the glow is for seeing it from the arms.
    glowUniforms.uStrength.value = THREE.MathUtils.smoothstep(cam.position.length(), 1.5, 7);
    renderer.setClearColor(ground, 1);
    const far = cam.position.distanceTo(constellation.centre);
    constellation.fade(far);
    dust.render(renderer, cam);
    renderer.render(scene, cam);
    labelsOn = visible && far < LABEL_RANGE;
    labels.update(cam, width, height, labelsOn);
  },

  resize(w, h) {
    width = ctx.labels.clientWidth || w;
    height = ctx.labels.clientHeight || h;
    dust?.resize(w, h);
  },

  show(on) {
    visible = on;
    labels?.show(on);
    if (on || !labels) return;
    // Cut away: nothing is hovered, though the pointer is still where it was for the way back.
    labelsOn = false;
    hot = null;
    labels.highlight(null);
  },

  dispose() {
    observer?.disconnect();
    for (const d of disposables.splice(0)) d.dispose();
  },
};
