// Resume (/resume): a long-period comet (M4).
//
// Why this object. Resume was the one route that was not a place — the director froze wherever it
// happened to be and the page dimmed the scene to a twelfth — and being an exception is exactly what
// broke the flow. It needed a destination of its own, and of everything in the sky a comet is the
// only one that is a *path*: where it has been and where it is going are the same object, which is
// what a resume is. It also orients itself off the one bearing this tier guarantees — both tails
// point away from the light, so `coreDirection` places it rather than decorating it.
//
// How it is drawn. A dust tail and an ion tail, each a seeded point cloud drawn additively; a coma;
// and a nucleus lit from the core. The two tails are the physics and they are the whole silhouette:
// the ion tail is gas dragged straight back by the wind, the dust tail is heavier grains left behind
// along the orbit, so it lags and curves. Four draw calls, no pass.
//
// M5: it was static, and a comet that does not move is a rock. The grains stream now — a tail is
// material leaving, not a shape — so each grain's place along the tail is computed in the vertex
// shader from a phase that wraps, rather than baked into its position at build. What that buys is
// the one thing the object is for: you can see which way it is going. The body drifts on its long
// arc as well, and the jets breathe.
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
const DRIFT = 2.6; // how far the body wanders, in nucleus radii
const DRIFT_S = 41; // seconds for one swing of that arc

// The grain's place along the tail is computed here, not baked: `phase` is where it started and
// uFlow carries it away from the nucleus, wrapping at the end. Position from a parameter is what
// makes the tail stream rather than glitter in place — and it costs one fract() a grain.
const tailVertex = /* glsl */ `
  attribute float phase; // where this grain starts along the tail, 0..1
  attribute vec3 jitter; // its own offset across the tail, in units of the spread
  uniform float uScale;
  uniform float uSize;
  uniform float uPhase;
  uniform float uFlow; // tail lengths per second
  uniform float uLength;
  uniform float uCurve;
  uniform float uSpread;
  uniform vec3 uAway; // anti-sunward: where the wind pushes
  uniform vec3 uHeading; // where the comet is going; the dust lags along it
  uniform vec3 uColor;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float t = fract(phase + uPhase * uFlow);
    // Grains bunch near the nucleus: everything released long ago has spread out and faded.
    float s = pow(t, 1.9);
    vec3 p = uAway * (s * uLength)
      - uHeading * (uCurve * s * s * uLength)
      + jitter * (uSpread * (0.12 + s));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    // Sized in the place's own units, so the group's scale has to be carried across by hand.
    float px = uSize * uScale * length(modelMatrix[0].xyz) / max(-mv.z, 1e-4);
    gl_PointSize = clamp(px, 1.0, 26.0);
    // The tail thins as it goes, and a grain fades in as it leaves rather than popping into being.
    float twinkle = 0.75 + 0.25 * sin(uPhase * (0.4 + t) + phase * 40.0);
    vAlpha = (1.0 - s) * (1.0 - s) * twinkle * smoothstep(0.0, 0.05, s);
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
  uniform float uJet; // how hard the ice is boiling off just now
  varying vec3 vNormal;
  varying vec3 vPos;
  void main() {
    float lambert = max(0.0, dot(normalize(vNormal), normalize(uLight)));
    // Jets: the lit side is where the ice is boiling off, so it is brighter than the rock deserves.
    // They breathe — outgassing is not steady, and a comet whose light never changes is a model.
    float jets = pow(lambert, 5.0) * 0.6 * uJet;
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
  // Everything hangs off `body`, which drifts: the tier owns `group`'s position (it is the waypoint,
  // in galaxy units) and moving that would take the comet out of its own place.
  const body = new THREE.Group();
  group.add(body);
  const kept: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => (kept.push(x), x);
  const at = palette(ctx.colour);
  const rand = prng(SEED);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

  // Anti-sunward is the tails' axis; the orbit's heading is what the dust lags along. Both are
  // fixed in the place's own frame — the group is turned to the core by the tier's bearing below.
  const away = new THREE.Vector3(1, 0, 0); // the light is at -x in the place's frame
  const heading = new THREE.Vector3(-0.28, 0.12, 0.95).normalize(); // where it is going

  /** A tail: `curve` bends it from the anti-sunward axis toward the orbit, `spread` is its width.
   *  Only the per-grain constants live in the buffer; where a grain *is* comes from the shader. */
  function tail(count: number, length: number, curve: number, spread: number, kelvin: number, size: number, flow: number, order: number) {
    const phases = new Float32Array(count);
    const jitter = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      phases[i] = rand();
      jitter.set([gauss(), gauss(), gauss()], i * 3);
    }
    const geometry = keep(new THREE.BufferGeometry());
    // Nothing here is a position, so there is no position attribute to cull against: every grain is
    // placed in the vertex shader and the draw is never culled (frustumCulled is off below).
    geometry.setAttribute('phase', new THREE.BufferAttribute(phases, 1));
    geometry.setAttribute('jitter', new THREE.BufferAttribute(jitter, 3));
    geometry.setDrawRange(0, count);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), length * 2);
    const uniforms = {
      uScale: { value: 1 }, uSize: { value: size }, uPhase: { value: 0 }, uFlow: { value: flow },
      uLength: { value: length }, uCurve: { value: curve }, uSpread: { value: spread * NUCLEUS },
      uAway: { value: away.clone() }, uHeading: { value: heading.clone() },
      uColor: { value: vivid(at(kelvin, new THREE.Color()), 1.3) },
    };
    const material = keep(new THREE.ShaderMaterial({
      vertexShader: tailVertex, fragmentShader: tailFragment, uniforms, ...additive,
    }));
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = order;
    body.add(points);
    return uniforms;
  }

  // Ion first: it is behind the dust from most angles, and narrower. Gas leaves faster than grit,
  // which is the whole difference between the two tails.
  const ionUniforms = tail(COUNT[0], ION, 0.04, 0.5, 22000, 0.9, 0.085, 1);
  const dustUniforms = tail(COUNT[1], DUST, 0.42, 1.5, 4800, 1.4, 0.035, 2);

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
    uJet: { value: 1 },
  };
  const nucleus = new THREE.Mesh(nucleusGeometry, keep(new THREE.ShaderMaterial({
    vertexShader: nucleusVertex, fragmentShader: nucleusFragment, uniforms: nucleusUniforms,
  })));
  nucleus.renderOrder = 3;
  body.add(nucleus);

  const comaUniforms = { uSize: { value: COMA }, uColor: { value: vivid(at(9000, new THREE.Color()), 1.2) } };
  const coma = new THREE.Mesh(keep(new THREE.PlaneGeometry(1, 1)), keep(new THREE.ShaderMaterial({
    vertexShader: comaVertex, fragmentShader: comaFragment, uniforms: comaUniforms, ...additive,
  })));
  coma.frustumCulled = false;
  coma.renderOrder = 4;
  body.add(coma);

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
      // Everything here is idle life at ambient rate: the grains streaming away, the nucleus
      // turning under its own jets, and the body running its arc.
      t += dt;
      ionUniforms.uPhase.value = t;
      dustUniforms.uPhase.value = t;
      nucleus.rotation.y = t * 0.05;
      nucleus.rotation.x = t * 0.021;
      // Outgassing is gusty. Two periods well apart, so it never reads as a pulse.
      nucleusUniforms.uJet.value = 0.7 + 0.3 * Math.sin(t * 0.7) * Math.sin(t * 0.23 + 1.1);
      // The arc. Small against the tail's length and slow enough to be movement rather than motion,
      // but it is the difference between a comet passing and a comet pinned to the sky.
      body.position
        .copy(heading).multiplyScalar(DRIFT * Math.sin((2 * Math.PI * t) / DRIFT_S))
        .addScaledVector(away, DRIFT * 0.35 * Math.sin((2 * Math.PI * t) / (DRIFT_S * 1.7) + 0.9));
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
