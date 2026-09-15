// Galaxy tier (spec §3): the whole disc, tilted, bulge brightest, the places as marked points. Nothing to read.
// The look is JWST's Phantom Galaxy (M74): orange-red dust filaments tracing the arms, a blue-white core,
// many-coloured stars, a deep field behind, spikes on the foreground stars (dust.ts, jwst.ts).
// Draw calls: dust into its target (1), then deep field, stars, dust composite, bulge glow, foreground
// stars (5), bloom's passes, place markers (1).
import * as THREE from 'three';
import { createDust, type Dust } from '../dust';
import { DISC_RADIUS, galaxyModel, SEED } from '../galaxy-model';
import { additive, createSky, vivid, type Sky } from '../jwst';
import { createBloom, type Bloom } from '../post/bloom';
import type { CameraPose, PlaceId, SceneContext, Tier, Waypoint } from '../types';

const ELEVATION = (35 * Math.PI) / 180; // camera height above the disc plane
const FOV = 50;
const PAN = 0.3; // how far toward a place the frame's centre moves, so pans between places read
const OFFSET = 0.28; // on wide screens, where the frame's centre sits in ndc x
const NEAR = 0.5;
const FAR = 300;
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
    float i = 1.5 * exp(-d * d / 0.06) + 0.35 * exp(-d * d / 0.8) + 0.1 * exp(-d / 1.6);
    i *= smoothstep(8.0, 5.0, d);
    // Blue-white: white where it saturates, the tint in the wings.
    gl_FragColor = vec4(mix(uColor, vec3(1.0), clamp(i - 0.6, 0.0, 1.0)) * i, 1.0);
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
let dust: Dust;
let sky: Sky;
let aspect = 16 / 9;
const disposables: { dispose(): void }[] = [];
const starUniforms = { uScale: { value: 1 }, uGain: { value: 1 } };
const markerUniforms = { uSize: { value: 18 }, uPx: { value: 18 }, uColor: { value: new THREE.Color() }, uGround: { value: new THREE.Color() } };
const buffer = new THREE.Vector2();

/** Colour for a temperature: log-interpolated between the blackbody tokens, chroma pushed (jwst.ts). */
function palette(c: SceneContext) {
  const stops = KELVINS.map((k) => ({ lk: Math.log(k), c: vivid(c.colour(`--star-${k}`), 2.4) }));
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
    // Blending is jwst.ts's screen blend, src + dst·(1 − src): light accumulates like additive but tops out
    // at white, so the dense bulge can't run away into HDR values that bloom would smear over the whole sky.

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
      const lum = t > 8000 ? 0.55 + 0.8 * h : 0.3 + 0.45 * h;
      // The bulge's light comes from its glow; its stars alone would saturate.
      const x = model.positions[i * 3], y = model.positions[i * 3 + 1], z = model.positions[i * 3 + 2];
      const dim = THREE.MathUtils.smoothstep(Math.hypot(x, y, z), 0.5, 6) * 0.6 + 0.15;
      col.multiplyScalar(dim);
      tint.set([col.r, col.g, col.b, 0.05 * lum], i * 4);
    }
    const stars = own(new THREE.BufferGeometry());
    stars.setAttribute('position', new THREE.BufferAttribute(model.positions, 3));
    stars.setAttribute('tint', new THREE.BufferAttribute(tint, 4));
    const starsMat = own(new THREE.ShaderMaterial({ vertexShader: starsVertex, fragmentShader: starsFragment, uniforms: starUniforms, ...additive }));
    const points = new THREE.Points(stars, starsMat);
    points.frustumCulled = false;
    points.renderOrder = 0;

    // Unresolved starlight, dust and HII along the arms, from the same model.
    dust = own(createDust(model, 0, 1.15, c.quality.dustScale, 5));
    dust.composite.renderOrder = 1;
    sky = own(createSky(c.quality.deepField, c.quality.foreground, c.quality.dpr, c.colour));
    sky.gain(0.9, 1);
    // Bulge glow: a camera-facing quad, the brightest thing in the frame.
    const glowGeo = own(new THREE.PlaneGeometry(1, 1));
    const glowMat = own(new THREE.ShaderMaterial({
      vertexShader: glowVertex, fragmentShader: glowFragment, ...additive,
      uniforms: { uSize: { value: 16 }, uColor: { value: vivid(c.colour('--star-12000'), 1.6).multiplyScalar(0.8) } },
    }));
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.frustumCulled = false;
    glow.renderOrder = 2;

    scene.add(sky.group, points, dust.composite, glow);

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

    if (c.quality.bloom) bloom = createBloom(c.renderer, { strength: 0.55, radius: 0.35, threshold: 0.6 });
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

  update(dt) {
    sky.update(dt);
    return false;
  },

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

    dust.render(renderer, camera);
    if (bloom) bloom.render(scene, camera);
    else renderer.render(scene, camera);

    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(markers, camera);
    renderer.autoClear = autoClear;
  },

  resize(width, height) {
    aspect = width / height;
    dust?.resize(width, height);
    bloom?.resize(width, height);
  },

  dispose() {
    bloom?.dispose();
    bloom = null;
    for (const d of disposables.splice(0)) d.dispose();
  },
};
