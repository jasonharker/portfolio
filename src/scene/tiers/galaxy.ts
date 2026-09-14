// Galaxy tier (spec §3): the whole disc, tilted, bulge brightest, the places as marked points. Nothing to read.
// Draw calls: disc haze, bulge glow, stars (one Points), place markers (one Points), plus bloom's passes.
import * as THREE from 'three';
import { DISC_RADIUS, galaxyModel } from '../galaxy-model';
import { createBloom, type Bloom } from '../post/bloom';
import type { CameraPose, PlaceId, SceneContext, Tier, Waypoint } from '../types';

const SEED = 20260914;
const ELEVATION = (35 * Math.PI) / 180; // camera height above the disc plane
const FOV = 50;
const PAN = 0.3; // how far toward a place the frame's centre moves, so pans between places read
const OFFSET = 0.28; // on wide screens, where the frame's centre sits in ndc x
const NEAR = 0.5;
const FAR = 300;
const SAMPLES = 48; // arm-angle samples for the haze shader, log-spaced in r; one vec4 per sample, one arm per component
const R_MIN = 0.5;
const R_MAX = DISC_RADIUS + 1;
/** Token kelvins in tokens.css; the values themselves are read from CSS. */
const KELVINS = [3000, 4300, 5600, 6800, 8500, 12000, 30000];

const outputChunks = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

const starsVertex = /* glsl */ `
  attribute vec4 tint; // rgb, a = size in kpc
  uniform float uScale; // drawing-buffer pixels per unit at distance 1
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float px = tint.a * uScale / -mv.z;
    gl_PointSize = max(px, 2.0);
    vAlpha = min(1.0, px * px / 4.0); // sub-pixel stars fade instead of shimmering
    vColor = tint.rgb;
    gl_Position = projectionMatrix * mv;
  }
`;
const starsFragment = /* glsl */ `
  uniform float uGain;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    gl_FragColor = vec4(vColor * min(1.0, exp(-4.0 * dot(c, c)) * vAlpha * uGain), 1.0);
    ${outputChunks}
  }
`;

const hazeVertex = /* glsl */ `
  varying vec2 vXZ;
  void main() {
    vXZ = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const hazeFragment = /* glsl */ `
  #define PI 3.141592653589793
  uniform vec4 uAngles[SAMPLES]; // 48 uniform slots, well inside WebGL2's minimum of 224
  uniform vec3 uArm;
  uniform vec3 uDisc;
  varying vec2 vXZ;
  float armAngle(int arm, float r) {
    float f = clamp((log(max(r, R_MIN)) - log(R_MIN)) / (log(R_MAX) - log(R_MIN)), 0.0, 1.0) * float(SAMPLES - 1);
    int i = int(f);
    int j = min(i + 1, SAMPLES - 1);
    return mix(uAngles[i][arm], uAngles[j][arm], fract(f));
  }
  void main() {
    float r = length(vXZ);
    float theta = atan(vXZ.y, vXZ.x);
    float arms = 0.0;
    for (int k = 0; k < ARMS; k++) {
      float d = mod(theta - armAngle(k, r) + PI, 2.0 * PI) - PI;
      float x = d * r / (0.7 + 0.09 * r);
      arms += exp(-0.5 * x * x);
    }
    float disc = exp(-r / 4.5) * smoothstep(R_MAX, R_MAX - 4.0, r);
    vec3 c = (uDisc * 0.25 + uArm * arms * smoothstep(0.8, 3.0, r)) * disc;
    gl_FragColor = vec4(c, 1.0);
    ${outputChunks}
  }
`;

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
  varying vec2 vUv;
  void main() {
    float d = length(vUv) * 8.0; // kpc-ish, the quad spans ±8
    float i = 1.3 * exp(-d * d / 0.4) + 0.45 * exp(-d * d / 3.0);
    i *= smoothstep(8.0, 5.0, d);
    gl_FragColor = vec4(uColor * i, 1.0);
    ${outputChunks}
  }
`;

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
  uniform float uPx;
  void main() {
    float d = length(gl_PointCoord * 2.0 - 1.0);
    float aa = 2.0 / uPx;
    float ring = 1.0 - smoothstep(0.0, aa * 1.5, abs(d - 0.72) - aa);
    float core = 1.0 - smoothstep(0.16, 0.16 + aa * 2.0, d);
    float mark = max(ring, core);
    // A dark keyline so the mark still reads over the bright bulge.
    float keyline = 1.0 - smoothstep(0.0, aa * 1.5, abs(d - 0.72) - aa * 3.5);
    gl_FragColor = vec4(mix(uGround, uColor, mark), max(mark, keyline * 0.6));
    ${outputChunks}
  }
`;

let ctx: SceneContext;
let scene: THREE.Scene;
let markers: THREE.Scene;
let bloom: Bloom | null = null;
let aspect = 16 / 9;
const disposables: { dispose(): void }[] = [];
const starUniforms = { uScale: { value: 1 }, uGain: { value: 1 } };
const markerUniforms = { uSize: { value: 18 }, uPx: { value: 18 }, uColor: { value: new THREE.Color() }, uGround: { value: new THREE.Color() } };
const buffer = new THREE.Vector2();

/** Colour for a temperature: log-interpolated between the blackbody tokens. */
function palette(c: SceneContext) {
  const stops = KELVINS.map((k) => ({ lk: Math.log(k), c: c.colour(`--star-${k}`) }));
  return (t: number, out: THREE.Color) => {
    const lt = Math.log(t);
    let i = 0;
    while (i < stops.length - 2 && lt > stops[i + 1].lk) i++;
    const f = THREE.MathUtils.clamp((lt - stops[i].lk) / (stops[i + 1].lk - stops[i].lk), 0, 1);
    return out.lerpColors(stops[i].c, stops[i + 1].c, f);
  };
}

function place(id: PlaceId): Waypoint {
  return ctx.topology.waypoints.find((w) => w.id === id)!;
}

/** Wide screens: the frame's centre sits right of centre, clear of the reading column (spec §6). */
const offset = () => (aspect > 1.2 ? OFFSET : 0);

/**
 * The smallest camera distance at which the whole disc fits, for a frame centred on (tx, tz) and slid left by
 * k = offset·d·tan(fov/2)·aspect. A rim point (dx, dz) from the centre has view depth d − dz·cos(e),
 * screen y −dz·sin(e) and screen x dx + k.
 */
function distance(tx: number, tz: number) {
  const tv = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
  const ce = Math.cos(ELEVATION), se = Math.sin(ELEVATION);
  const fits = (d: number) => {
    const k = offset() * d * tv * aspect;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const dx = DISC_RADIUS * Math.cos(a) - tx, dz = DISC_RADIUS * Math.sin(a) - tz;
      const depth = d - dz * ce;
      if (depth <= 0 || Math.abs(dz * se) > 0.88 * depth * tv || Math.abs(dx + k) > 0.94 * depth * tv * aspect) return false;
    }
    return true;
  };
  let lo = 1, hi = 400;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

function own<T extends { dispose(): void }>(x: T): T {
  disposables.push(x);
  return x;
}

export const galaxy: Tier = {
  id: 'galaxy',

  async load(c) {
    ctx = c;
    scene = new THREE.Scene();
    // As scene.background, not setClearColor: the clear is then encoded for whichever target is bound.
    scene.background = c.colour('--ground');
    markers = new THREE.Scene();
    // Screen blending, src + dst·(1 − src): light accumulates like additive but tops out at white, so the
    // dense bulge can't run away into HDR values that bloom would smear over the whole sky.
    const additive = {
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcColorFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      depthTest: false, depthWrite: false, transparent: true,
    };

    // Stars.
    const model = galaxyModel(SEED, c.quality.stars, c.topology.waypoints);
    const n = model.temperatures.length;
    const tint = new Float32Array(n * 4);
    const colourOf = palette(c);
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const t = model.temperatures[i];
      colourOf(t, col);
      // Hot stars are the luminous ones; a stable per-star hash varies the rest.
      const h = (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296;
      const lum = t > 8000 ? 1.6 + h : 0.6 + 0.7 * h;
      // The bulge's light comes from its glow; its stars alone would saturate.
      const x = model.positions[i * 3], y = model.positions[i * 3 + 1], z = model.positions[i * 3 + 2];
      const dim = THREE.MathUtils.smoothstep(Math.hypot(x, y, z), 0.5, 3) * 0.5 + 0.5;
      col.multiplyScalar(dim);
      tint.set([col.r, col.g, col.b, 0.05 * lum], i * 4);
    }
    const stars = own(new THREE.BufferGeometry());
    stars.setAttribute('position', new THREE.BufferAttribute(model.positions, 3));
    stars.setAttribute('tint', new THREE.BufferAttribute(tint, 4));
    const starsMat = own(new THREE.ShaderMaterial({ vertexShader: starsVertex, fragmentShader: starsFragment, uniforms: starUniforms, ...additive }));
    const points = new THREE.Points(stars, starsMat);
    points.frustumCulled = false;

    // Unresolved starlight along the arms, from the same model.
    if (model.arms > 4) throw new Error('galaxy: the haze shader packs at most four arms');
    const angles = new Float32Array(4 * SAMPLES);
    for (let s = 0; s < SAMPLES; s++) {
      const r = R_MIN * Math.pow(R_MAX / R_MIN, s / (SAMPLES - 1));
      for (let arm = 0; arm < model.arms; arm++) angles[s * 4 + arm] = model.armAngleAt(r, arm);
    }
    const hazeGeo = own(new THREE.PlaneGeometry(R_MAX * 2, R_MAX * 2).rotateX(-Math.PI / 2));
    const hazeMat = own(new THREE.ShaderMaterial({
      vertexShader: hazeVertex, fragmentShader: hazeFragment, ...additive,
      defines: { ARMS: model.arms, SAMPLES, R_MIN: R_MIN.toFixed(3), R_MAX: R_MAX.toFixed(3) },
      uniforms: {
        uAngles: { value: angles },
        uArm: { value: c.colour('--star-8500').multiplyScalar(0.12) },
        uDisc: { value: c.colour('--star-5600').multiplyScalar(0.12) },
      },
    }));
    const haze = new THREE.Mesh(hazeGeo, hazeMat);

    // Bulge glow: a camera-facing quad, the brightest thing in the frame.
    const glowGeo = own(new THREE.PlaneGeometry(1, 1));
    const glowMat = own(new THREE.ShaderMaterial({
      vertexShader: glowVertex, fragmentShader: glowFragment, ...additive,
      uniforms: { uSize: { value: 16 }, uColor: { value: c.colour('--star-4300').lerp(c.colour('--star-5600'), 0.5) } },
    }));
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.frustumCulled = false;

    scene.add(haze, glow, points);

    // Places, drawn after bloom so they stay crisp.
    const markerGeo = own(new THREE.BufferGeometry());
    markerGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(c.topology.waypoints.flatMap((w) => w.pos)), 3));
    markerUniforms.uColor.value = c.colour('--ink');
    markerUniforms.uGround.value = c.colour('--ground');
    const markerMat = own(new THREE.ShaderMaterial({
      vertexShader: markerVertex, fragmentShader: markerFragment, uniforms: markerUniforms,
      transparent: true, depthTest: false, depthWrite: false,
    }));
    const marks = new THREE.Points(markerGeo, markerMat);
    marks.frustumCulled = false;
    markers.add(marks);

    if (c.quality.bloom) bloom = createBloom(c.renderer, { strength: 0.6, radius: 0.2, threshold: 0.55 });
  },

  frame(id) {
    const [px, , pz] = place(id).pos;
    const tv = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
    // One distance for every place, so going from one frame to another is a pure pan.
    const d = Math.max(...ctx.topology.waypoints.map((w) => distance(w.pos[0] * PAN, w.pos[2] * PAN)));
    const k = offset() * d * tv * aspect;
    const [tx, tz] = [px * PAN - k, pz * PAN];
    const pose: CameraPose = { position: [tx, d * Math.sin(ELEVATION), tz + d * Math.cos(ELEVATION)], target: [tx, 0, tz], fov: FOV };
    return pose;
  },

  update: () => false,

  render(renderer, camera) {
    const cam = camera as THREE.PerspectiveCamera;
    if (cam.near !== NEAR || cam.far !== FAR) {
      cam.near = NEAR;
      cam.far = FAR;
      cam.updateProjectionMatrix();
    }
    renderer.getDrawingBufferSize(buffer);
    starUniforms.uScale.value = buffer.y / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    const px = 18 * renderer.getPixelRatio();
    markerUniforms.uSize.value = markerUniforms.uPx.value = px;

    if (bloom) bloom.render(scene, camera);
    else renderer.render(scene, camera);

    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(markers, camera);
    renderer.autoClear = autoClear;
  },

  resize(width, height) {
    aspect = width / height;
    bloom?.resize(width, height);
  },

  dispose() {
    bloom?.dispose();
    bloom = null;
    for (const d of disposables.splice(0)) d.dispose();
  },
};
