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
// gas is that you see through it, and a cloud of points is see-through for free.
//
// A cloud of noise is still a blob, which is what the first volume was. What gives it features is
// absence: the star has blown a cavity, so the material is a thin wall around a hole and the middle
// of the object is empty; and the wall is sampled on the ridges of the field rather than its bulk,
// so it is filaments with lanes between them and not a fog. Colour rides the same field — the hot
// inner wall runs teal-blue, the older material outside it cools through gold to rose.
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

  // Octaves of it, so the structure has a size range rather than one wavelength.
  const fbm = (x: number, y: number, z: number) =>
    0.56 * lump(x, y, z) + 0.28 * lump(2.03 * x + 5.1, 2.03 * y - 3.2, 2.03 * z + 1.7)
    + 0.16 * lump(4.11 * x - 2.3, 4.11 * y + 7.7, 4.11 * z - 5.5);

  // Where the gas is. Two terms, and both of them are about absence, which is what the first
  // attempt lacked: a ball of noise is a blob however you colour it.
  //  - A shell. The star blew a cavity and swept the material into a wall around it, so density
  //    peaks off-centre and the middle is empty. This is also why the core stopped blowing out:
  //    nothing is drawn where every grain used to stack.
  //  - Ridges. Taking 1 - |noise| keeps the thin zero-crossing sheets of the field and throws the
  //    bulk away, and a thin sheet seen edge-on is a filament. High power = thin, and empty
  //    between, so there are lanes to read the shape against.
  // Both are in the star's frame, where the cavity is spherical; the oblateness is a squash of it.
  // The wall, per unit radius (so with its r²): narrow, and cut hard inside — a thin wall seen
  // through is bright at the limb and empty in the middle, and that ring is the difference between
  // a nebula and a fuzzy star.
  const shell = (r: number) =>
    r * r * (Math.exp(-(((r - 0.78) / 0.13) ** 2)) + 0.05 * Math.exp(-(((r - 1.1) / 0.33) ** 2))) * THREE.MathUtils.smoothstep(r, 0.45, 0.68);
  const ridge = (x: number, yy: number, z: number) => Math.max(0, 1 - Math.abs(1.05 * fbm(x * 0.34, yy * 0.34, z * 0.34))) ** 4;
  let top = 0;
  for (let r = 0.45; r <= SPAN; r += 1e-3) top = Math.max(top, shell(r));
  top *= 1.01;

  const positions = new Float32Array(COUNT * 3);
  const tint = new Float32Array(COUNT * 4);
  const p = new THREE.Vector3();
  const col = new THREE.Color();
  // Rejection sampling, so grains land in proportion to the field and the cloud's shape is the
  // field's shape with nothing shaped by hand. In two stages: a radius from the wall's profile (1D,
  // cheap), a direction at random, then accept on the ridges. Sampling the whole field out of a
  // cube took ~130 tries a grain and seconds of main thread before the site could draw; this is ~3.
  // Still ~0.7 s on a laptop, so it runs in idle slices after the first frame (below): the landing
  // page never shows this place. Resumable, so the seeded sequence and the cloud are unchanged.
  let i = 0;
  const sample = (until: number) => {
    for (; i < until; i++) {
      for (let tries = 0; tries < 400; tries++) {
        let r: number;
        do r = 0.45 + (SPAN - 0.45) * rand();
        while (rand() * top > shell(r));
        p.set(gauss(), gauss(), gauss()).setLength(r * RING);
        if (rand() < ridge(p.x, p.y, p.z)) break;
      }
      p.y *= FLAT;
      // A grain is a parcel of gas, not a point: blur it, or the filaments look like wire.
      p.x += gauss() * RING * 0.012;
      p.y += gauss() * RING * 0.01;
      p.z += gauss() * RING * 0.012;
      p.toArray(positions, i * 3);

      // Hot and blue on the inner wall the star is lighting; cooling outward through gold to rose.
      const far = Math.min(1, Math.hypot(p.x, p.y / FLAT, p.z) / (RING * 1.3));
      const heat = THREE.MathUtils.clamp(0.82 - 0.42 * far + 0.3 * fbm(p.x * 0.15, p.y * 0.15, p.z * 0.15) + 0.06 * gauss(), 0, 1);
      vivid(at(2200 * Math.pow(18000 / 2200, heat), col), 1.4);
      // Flat and low: the count already carries the density, so brightness only has to keep the
      // bright parts off the ceiling. An additive cloud that saturates is a white shape with a
      // coloured edge, which is exactly what it looked like.
      const bright = (0.3 + 0.7 * Math.pow(1 - far, 2.2)) * (0.4 + 0.9 * rand());
      tint.set([col.r, col.g, col.b, 0.014 + 0.036 * bright], i * 4);
    }
    if (i < COUNT) return;
    cloudGeometry.attributes.position.needsUpdate = cloudGeometry.attributes.tint.needsUpdate = true;
    ctx.invalidate();
  };

  const cloudGeometry = keep(new THREE.BufferGeometry());
  cloudGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  cloudGeometry.setAttribute('tint', new THREE.BufferAttribute(tint, 4));
  // ponytail: fixed slices, not deadline-sized; ~15 ms each on a T480. Safari has no requestIdleCallback.
  const idle = window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 50));
  const slice = () => (sample(Math.min(COUNT, i + 2000)), i < COUNT && idle(slice));
  idle(slice);
  const cloudUniforms = { uScale: { value: 1 }, uSize: { value: 0.34 }, uPhase: { value: 0 } };
  const cloudMaterial = keep(new THREE.ShaderMaterial({
    vertexShader: cloudVertex, fragmentShader: cloudFragment, uniforms: cloudUniforms, ...additive,
  }));
  const cloud = new THREE.Points(cloudGeometry, cloudMaterial);
  cloud.frustumCulled = false;
  cloud.renderOrder = 1;
  // Drawn before the slices finish (a direct load of /documentation): finish now. The upload lands
  // on the next frame, which ctx.invalidate() asks for; until then the grains are all alpha 0.
  cloud.onBeforeRender = () => i < COUNT && sample(COUNT);
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
