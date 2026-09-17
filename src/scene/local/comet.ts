// Resume (/resume): a long-period comet (M4).
//
// Why this object. Resume was the one route that was not a place — the director froze wherever it
// happened to be and the page dimmed the scene to a twelfth — and being an exception is exactly what
// broke the flow. It needed a destination of its own, and of everything in the sky a comet is the
// only one that is a *path*: where it has been and where it is going are the same object, which is
// what a resume is. It also orients itself off the one bearing this tier guarantees — both tails
// point away from the light, so `coreDirection` places it rather than decorating it.
//
// How it is drawn. A dust tail and an ion tail, each a seeded point cloud laid along a curve and
// drawn additively; a coma; and a nucleus lit from the core. The two tails are the physics and they
// are the whole silhouette: the ion tail is gas dragged straight back by the wind, the dust tail is
// heavier grains left behind along the orbit, so it lags and curves. Four draw calls, no pass.
import * as THREE from 'three';
import { prng } from '../galaxy-model';
import { additive, palette, vivid } from '../jwst';
import { coreDirection } from './core';
import type { CameraPose, LocalPlace, SceneContext, Vec3 } from '../types';

const NUCLEUS = 1; // the place's unit: the nucleus has radius 1
const ION = 64; // ion tail length, straight back from the light
const DUST = 46; // dust tail length; it lags along the orbit and curves
const COMA = 5.5;
const FOV = 45;
const SEED = 20260917;
const COUNT = [2600, 3400]; // ion, dust

const tailVertex = /* glsl */ `
  attribute float seed; // 0 at the nucleus, 1 at the tail's end, plus a per-grain offset in the fraction
  uniform float uScale;
  uniform float uSize;
  uniform float uPhase;
  varying vec3 vColor;
  varying float vAlpha;
  uniform vec3 uColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float t = fract(seed);
    // Sized in the place's own units, so the group's scale has to be carried across by hand.
    float px = uSize * uScale * length(modelMatrix[0].xyz) / max(-mv.z, 1e-4);
    gl_PointSize = clamp(px, 1.0, 26.0);
    // The tail thins as it goes: fewer grains, less light, and every grain flickers at its own rate.
    float twinkle = 0.75 + 0.25 * sin(uPhase * (0.4 + t) + seed * 40.0);
    vAlpha = (1.0 - t) * (1.0 - t) * twinkle;
    vColor = uColor;
    gl_Position = projectionMatrix * mv;
  }
`;
const tailFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float g = exp(-4.0 * dot(c, c));
    gl_FragColor = vec4(vColor * g * vAlpha, 1.0);
    #include <colorspace_fragment>
  }
`;

const nucleusVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vPos;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
// Dirty ice: dark, and only the lit limb reads at all. Nothing in this tier is a THREE light, so
// the one direction the place is sure of does the lighting.
const nucleusFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uLight; // toward the core, in the place's own frame
  varying vec3 vNormal;
  varying vec3 vPos;
  void main() {
    float lambert = max(0.0, dot(normalize(vNormal), normalize(uLight)));
    // Jets: the lit side is where the ice is boiling off, so it is brighter than the rock deserves.
    float jets = pow(lambert, 5.0) * 0.6;
    vec3 c = uColor * (0.05 + 0.75 * lambert) + vec3(0.7, 0.8, 1.0) * jets;
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
  }
`;

const comaVertex = /* glsl */ `
  uniform float uSize;
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 2.0;
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    // A billboard's half-size is added in view space, which the group's scale does not reach.
    mv.xy += position.xy * uSize * length(modelMatrix[0].xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const comaFragment = /* glsl */ `
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    float d = length(vUv);
    // Taken to zero at the quad's rim: the wide term is still 0.06 there, and an additive sprite
    // that stops short of zero draws its own square.
    float i = (0.9 * exp(-d * d * 7.0) + 0.3 * exp(-d * d * 1.6)) * smoothstep(1.0, 0.55, d);
    gl_FragColor = vec4(mix(uColor, vec3(1.0), clamp(i - 0.6, 0.0, 0.4)) * i, 1.0);
    #include <colorspace_fragment>
  }
`;

export function createComet(ctx: SceneContext): LocalPlace {
  const group = new THREE.Group();
  const kept: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => (kept.push(x), x);
  const at = palette(ctx.colour);
  const rand = prng(SEED);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

  // Anti-sunward is the tails' axis; the orbit's heading is what the dust lags along. Both are
  // fixed in the place's own frame — the group is turned to the core by the tier's bearing below.
  const away = new THREE.Vector3(1, 0, 0); // the light is at -x in the place's frame
  const heading = new THREE.Vector3(-0.28, 0.12, 0.95).normalize(); // where it is going

  /** A tail: `curve` bends it from the anti-sunward axis toward the orbit, `spread` is its width. */
  function tail(count: number, length: number, curve: number, spread: number, kelvin: number, size: number, order: number) {
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const p = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      // Denser near the nucleus: grains released long ago have spread out and faded.
      const t = Math.pow(rand(), 1.9);
      const w = spread * (0.12 + t) * NUCLEUS;
      p.copy(away).multiplyScalar(t * length)
        .addScaledVector(heading, -curve * t * t * length)
        .add(new THREE.Vector3(gauss() * w, gauss() * w, gauss() * w));
      p.toArray(positions, i * 3);
      seeds[i] = t + Math.floor(rand() * 64); // fraction is position along the tail, integer part is the grain
    }
    const geometry = keep(new THREE.BufferGeometry());
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
    const uniforms = {
      uScale: { value: 1 }, uSize: { value: size }, uPhase: { value: 0 },
      uColor: { value: vivid(at(kelvin, new THREE.Color()), 1.3) },
    };
    const material = keep(new THREE.ShaderMaterial({
      vertexShader: tailVertex, fragmentShader: tailFragment, uniforms, ...additive,
    }));
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = order;
    group.add(points);
    return uniforms;
  }

  // Ion first: it is behind the dust from most angles, and narrower.
  const ionUniforms = tail(COUNT[0], ION, 0.04, 0.5, 22000, 0.9, 1);
  const dustUniforms = tail(COUNT[1], DUST, 0.42, 1.5, 4800, 1.4, 2);

  // The nucleus: a lumpy, dark, dirty snowball.
  const nucleusGeometry = keep(new THREE.IcosahedronGeometry(NUCLEUS, 3));
  const np = nucleusGeometry.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < np.count; i++) {
    v.fromBufferAttribute(np, i);
    const lumps = 0.82 + 0.18 * Math.sin(v.x * 3.1 + 1.3) + 0.14 * Math.sin(v.y * 4.7) + 0.1 * Math.sin(v.z * 6.2 + 2.1);
    v.multiplyScalar(lumps);
    np.setXYZ(i, v.x, v.y, v.z);
  }
  nucleusGeometry.computeVertexNormals();
  const nucleusUniforms = {
    uColor: { value: ctx.colour('--ink').multiplyScalar(0.55) },
    uLight: { value: away.clone().negate() },
  };
  const nucleus = new THREE.Mesh(nucleusGeometry, keep(new THREE.ShaderMaterial({
    vertexShader: nucleusVertex, fragmentShader: nucleusFragment, uniforms: nucleusUniforms,
  })));
  nucleus.renderOrder = 3;
  group.add(nucleus);

  const comaUniforms = { uSize: { value: COMA }, uColor: { value: vivid(at(9000, new THREE.Color()), 1.2) } };
  const coma = new THREE.Mesh(keep(new THREE.PlaneGeometry(1, 1)), keep(new THREE.ShaderMaterial({
    vertexShader: comaVertex, fragmentShader: comaFragment, uniforms: comaUniforms, ...additive,
  })));
  coma.frustumCulled = false;
  coma.renderOrder = 4;
  group.add(coma);

  // Turn the whole thing so the tails point away from the core: the tier's one true bearing.
  group.quaternion.setFromUnitVectors(away, coreDirection(ctx, 'resume').negate());

  const buffer = new THREE.Vector2();
  let t = 0;

  return {
    group,

    pose(aspect): CameraPose {
      const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
      // Across the tail rather than along it, and from the lit side. Spec §6: right of centre
      // beside the reading column, or high over a bottom sheet.
      const shift = aspect >= 1 ? 0.34 : 0;
      const span = ION * 0.66;
      const d = Math.max(span / ((0.92 - shift) * tan * Math.max(aspect, 0.4)), 40);
      const half = d * tan;
      const eye = new THREE.Vector3(0.36, 0.42, 1).normalize().multiplyScalar(d);
      // The nucleus sits off to one side, so the tail has the frame to sweep across.
      const centre = new THREE.Vector3().copy(away).multiplyScalar(ION * 0.12);
      const pan = aspect >= 1
        ? new THREE.Vector3(-shift * half * aspect, 0, 0)
        : new THREE.Vector3(0, -0.34 * half, 0);
      return {
        position: eye.add(centre).add(pan).toArray() as Vec3,
        target: centre.add(pan).toArray() as Vec3,
        fov: FOV,
      };
    },

    update(dt) {
      // A comet's tail is quasi-static: what moves is the grains glittering in it, and the nucleus
      // turning. Ambient rate is plenty for both.
      t += dt;
      ionUniforms.uPhase.value = t * 1.6;
      dustUniforms.uPhase.value = t * 0.7;
      nucleus.rotation.y = t * 0.05;
      nucleus.rotation.x = t * 0.021;
      return false;
    },

    resize() {
      ctx.renderer.getDrawingBufferSize(buffer);
      const scale = buffer.y / (2 * Math.tan(THREE.MathUtils.degToRad(FOV) / 2));
      ionUniforms.uScale.value = scale;
      dustUniforms.uScale.value = scale;
    },

    dispose() {
      for (const k of kept.splice(0)) k.dispose();
    },
  };
}
