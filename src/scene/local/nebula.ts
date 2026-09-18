// Documentation (/documentation): an emission nebula at the galactic core.
//
// Why this object. Documentation is the record a system leaves of itself, and a nebula is exactly
// that: material a star threw off, still legible long after the event that shed it, lit from inside
// by what is left behind. The black hole it replaced was the opposite — the thing that destroys the
// record — and it fought the page it sat behind.
//
// How it is drawn, and why it stopped being shells. Twice this was nested limb-brightened
// ellipsoids, and twice it read as blown glass: concentric surfaces about one centre are rings
// whatever you shade them with, and a surface has a rim, which gas does not. It is a volume now —
// one seeded point cloud of tens of thousands of additive sprites — because what makes gas read as
// gas is that you see through it, and a cloud of points is see-through for free. Density and colour
// come from the same lumpy field, so where the nebula is thick it is also hot and runs teal-blue,
// and the thin material trailing out of it cools through gold to rose.
//
// Cost: two draw calls, the cloud and the pair of central stars, and no full-screen pass at all —
// where the black hole's lens march was the most expensive shader on the site.
import * as THREE from 'three';
import { prng } from '../galaxy-model';
import { additive, palette, SPIKES, vivid } from '../jwst';
import { coreDirection } from './core';
import type { CameraPose, LocalPlace, SceneContext, Vec3 } from '../types';

// The place's unit: the bright body of the nebula has radius 10.
const RING = 10;
const FOV = 45;
const DISTANCE = 62;
const TILT = 0.22; // camera elevation above the nebula's equator, rad
const SEED = 20260918;
const COUNT = 90000; // sprites in the cloud: enough that the gas stops reading as grains
const SPAN = 2.3; // how far the faintest streamers reach, in RING
const FLAT = 0.74; // the cloud is oblate: it was thrown off a rotating star

const cloudVertex = /* glsl */ `
  attribute vec4 tint; // rgb, and how bright this grain is
  uniform float uScale; // drawing-buffer pixels per place unit at distance 1
  uniform float uSize;
  uniform float uPhase;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Sized in the place's own units, so the group's scale has to be carried across by hand.
    float px = uSize * uScale * length(modelMatrix[0].xyz) / max(-mv.z, 1e-4);
    gl_PointSize = clamp(px, 1.5, 30.0);
    vColor = tint.rgb;
    // Every grain breathes on its own clock, so the cloud never quite repeats.
    vAlpha = tint.a * (0.82 + 0.18 * sin(uPhase + tint.a * 41.0));
    gl_Position = projectionMatrix * mv;
  }
`;
const cloudFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    // Taken to zero at the rim: an additive sprite that stops short of zero draws its own square.
    float g = max(0.0, exp(-3.2 * dot(c, c)) - 0.04) / 0.96;
    gl_FragColor = vec4(vColor * g * vAlpha, 1.0);
    #include <colorspace_fragment>
  }
`;

const starVertex = /* glsl */ `
  attribute vec3 tint;
  attribute float mag;
  uniform float uScale;
  varying vec3 vColor;
  varying float vPx;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // The sprite is sized in the place's own units, so the group's scale has to be carried across.
    float px = clamp(mag * uScale * length(modelMatrix[0].xyz) / max(-mv.z, 1e-4), 24.0, 420.0);
    gl_PointSize = px;
    vPx = px * 0.5;
    vColor = tint;
    gl_Position = projectionMatrix * mv;
  }
`;
const starFragment = /* glsl */ `
  ${SPIKES}
  varying vec3 vColor;
  varying float vPx;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    vec2 k = spikes(p, vPx, 0.8);
    vec3 c = mix(vColor, vec3(1.0), 0.6) * k.x * 1.6 + vColor * k.y * 2.2;
    gl_FragColor = vec4(c * smoothstep(1.0, 0.82, length(p)), 1.0);
    #include <colorspace_fragment>
  }
`;

export function createNebula(ctx: SceneContext): LocalPlace {
  const group = new THREE.Group();
  const kept: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => (kept.push(x), x);
  const at = palette(ctx.colour);
  const rand = prng(SEED);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

  // The lumpy field. One function of direction gives the cloud its filaments, its bites and its
  // lobes, and the same value decides how hot the gas there is — thick gas is lit gas. Sines rather
  // than a hash: this runs once, at build, and what matters is that it is smooth and not a sphere.
  // Cross terms carry most of the weight on purpose: a sum of sin(x), sin(y), sin(z) is separable,
  // and a separable field makes four lobes square to the axes, which is a flower, not a nebula.
  const lump = (x: number, y: number, z: number) =>
    0.34 * Math.sin(2.1 * x + 1.1) + 0.3 * Math.sin(1.7 * y - 0.4) + 0.26 * Math.sin(2.6 * z + 2.2)
    + 0.52 * Math.sin(1.9 * (x + 0.7 * y - 0.4 * z) + 0.8) + 0.46 * Math.sin(2.7 * (z - 0.8 * x + 0.5 * y) + 1.9)
    + 0.38 * Math.sin(3.3 * (y - 0.6 * z + 0.3 * x) + 2.7) + 0.24 * Math.sin(5.1 * (x * y + 0.4 * z));

  const positions = new Float32Array(COUNT * 3);
  const tint = new Float32Array(COUNT * 4);
  const p = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < COUNT; i++) {
    // A direction, then a radius: most of the material sits in a thick body, with streamers out.
    p.set(gauss(), gauss(), gauss());
    if (p.lengthSq() < 1e-6) p.set(0, 1, 0);
    p.normalize();
    const shape = lump(p.x * 2.4, p.y * 2.4, p.z * 2.4);
    const r = RING * (0.34 + 0.66 * Math.pow(rand(), 0.55)) * (1 + 0.28 * shape)
      * (rand() < 0.14 ? 1 + SPAN * Math.pow(rand(), 2.4) : 1);
    p.multiplyScalar(r);
    p.y *= FLAT;
    p.x += gauss() * RING * 0.05;
    p.y += gauss() * RING * 0.04;
    p.z += gauss() * RING * 0.05;
    p.toArray(positions, i * 3);

    // Hot and blue where the gas is thick and near the star; cooling outward through gold to rose.
    const far = Math.min(1, p.length() / (RING * 1.5));
    const heat = THREE.MathUtils.clamp(0.72 - 0.55 * far + 0.22 * shape + 0.1 * gauss(), 0, 1);
    vivid(at(2200 * Math.pow(18000 / 2200, heat), col), 1.35);
    // The thin outskirts are faint, and every grain varies: an even cloud reads as a solid.
    const bright = (0.1 + 0.9 * Math.pow(1 - far, 2.2)) * (0.35 + 0.9 * rand()) * (0.5 + 0.5 * Math.max(0, shape));
    tint.set([col.r, col.g, col.b, 0.03 + 0.17 * bright], i * 4);
  }

  const cloudGeometry = keep(new THREE.BufferGeometry());
  cloudGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  cloudGeometry.setAttribute('tint', new THREE.BufferAttribute(tint, 4));
  const cloudUniforms = { uScale: { value: 1 }, uSize: { value: 0.34 }, uPhase: { value: 0 } };
  const cloudMaterial = keep(new THREE.ShaderMaterial({
    vertexShader: cloudVertex, fragmentShader: cloudFragment, uniforms: cloudUniforms, ...additive,
  }));
  const cloud = new THREE.Points(cloudGeometry, cloudMaterial);
  cloud.frustumCulled = false;
  cloud.renderOrder = 1;
  group.add(cloud);

  // The pair at the centre. The white dwarf is what lights all of the above; the companion is the
  // brighter of the two to the eye and lights none of it, which is the joke the real object plays.
  const stars: Vec3[] = [[-0.5, 0.08, 0.2], [0.62, -0.05, -0.3]];
  const starGeometry = keep(new THREE.BufferGeometry());
  starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(stars.flat(), 3));
  const tints = [at(30000, new THREE.Color()), at(5200, new THREE.Color())];
  starGeometry.setAttribute('tint', new THREE.Float32BufferAttribute(tints.flatMap((c) => [c.r, c.g, c.b]), 3));
  starGeometry.setAttribute('mag', new THREE.Float32BufferAttribute([0.5, 1.0], 1));
  const starUniforms = { uScale: { value: 1 } };
  const starMaterial = keep(new THREE.ShaderMaterial({
    vertexShader: starVertex, fragmentShader: starFragment, uniforms: starUniforms, ...additive,
  }));
  const pair = new THREE.Points(starGeometry, starMaterial);
  pair.frustumCulled = false;
  pair.renderOrder = 2;
  group.add(pair);

  // The cloud leans away from the core, so its long axis crosses the arm rather than pointing
  // nowhere: the one bearing this place actually knows (core.ts).
  const pole = coreDirection(ctx, 'documentation');
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pole.clone().negate());

  const buffer = new THREE.Vector2();
  let t = 0;

  return {
    group,

    pose(aspect): CameraPose {
      const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
      // Spec §6: the nebula sits right of centre beside the reading column, or high over a sheet.
      const shift = aspect >= 1 ? 0.3 : 0;
      const span = RING * 1.45;
      const d = Math.max(DISTANCE, span / ((0.92 - shift) * tan * Math.max(aspect, 0.4)));
      const half = d * tan;
      const pan: Vec3 = aspect >= 1 ? [-shift * half * aspect, 0, 0] : [0, -0.36 * half, 0];
      return {
        position: [pan[0], d * Math.sin(TILT) + pan[1], d * Math.cos(TILT) + pan[2]],
        target: pan,
        fov: FOV,
      };
    },

    update(dt) {
      // The cloud shimmers rather than moves: gas this size goes nowhere in a lifetime, and a
      // nebula is the slowest thing on the site. Ambient rate is more than enough for both.
      t += dt;
      cloudUniforms.uPhase.value = t * 0.35;
      group.rotation.y = t * 0.004;
      return false;
    },

    resize() {
      ctx.renderer.getDrawingBufferSize(buffer);
      const scale = buffer.y / (2 * Math.tan(THREE.MathUtils.degToRad(FOV) / 2));
      starUniforms.uScale.value = scale;
      cloudUniforms.uScale.value = scale;
    },

    dispose() {
      for (const k of kept.splice(0)) k.dispose();
    },
  };
}
