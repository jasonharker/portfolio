// Documentation (/documentation): a planetary nebula at the galactic core — the Southern Ring,
// NGC 3132, as NIRCam saw it (M4, replacing the black hole).
//
// Why this object. Documentation is the record a system leaves of itself, and a planetary nebula is
// exactly that: nested shells of material a star threw off, each ejection still legible as its own
// layer, lit from inside by what is left of the star. The black hole it replaces was the opposite —
// the thing that destroys the record — and it fought the page it sat behind.
//
// How it is drawn. Not volume rendering: nested ellipsoidal shells, each additive and depth-free,
// each brightest where the line of sight runs along it. That limb brightening is the whole trick and
// it is not a trick — a shell seen at its edge really is more material to look through, which is why
// a spherical nebula photographs as a ring. Clumps come from value noise in the shell's own space,
// so they hold still as the camera moves, and the rays are the shadows of those clumps: light from
// the central star escapes between them in spokes, which is what NIRCam's image is full of.
//
// Cost: one draw call per shell and one for the pair of central stars — five, and no full-screen
// pass at all, where the black hole's lens was the most expensive shader on the site.
import * as THREE from 'three';
import { additive, palette, SPIKES, vivid } from '../jwst';
import { coreDirection } from './core';
import type { CameraPose, LocalPlace, SceneContext, Vec3 } from '../types';

// The place's unit is such that the bright ring, the shell everyone photographs, has radius 10.
const RING = 10;
const FOV = 45;
const DISTANCE = 62;
const TILT = 0.22; // camera elevation above the nebula's equator, rad
const SPOKES = 7; // rays escaping between the clumps
// Shell radius, how oblate it is, colour temperature, how sharply it limb-brightens, brightness.
// Inner shells are ionised and hot; outward, the older ejections have cooled and reddened.
// One ring and a halo, not an onion. Four evenly spaced limb-brightened shells read as concentric
// rings however they are shaded, because that is what they are; the real object is one bright
// ionised shell, everything else being faint and ragged around it. The layering that makes this
// the right object for the page comes from the clumping inside each shell, which has no spacing to
// give it away, rather than from a stack of spheres.
const SHELLS: [number, number, number, number, number][] = [
  [1.0, 0.78, 11000, 6.5, 1.15], // the ring: ionised, and the only thing with a hard edge
  [1.62, 0.7, 3600, 5.0, 0.16], // the molecular halo, cooled and nearly gone
];

const shellVertex = /* glsl */ `
  varying vec3 vPos;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vPos = position;
    vNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;
const shellFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uGain;
  uniform float uEdge;
  uniform float uPhase;
  uniform float uClump;
  varying vec3 vPos;
  varying vec3 vNormal;
  varying vec3 vView;

  // Value noise, three octaves. The nebula's clumps live in the shell's own space, so they hold
  // still under the camera rather than swimming with it.
  // No sin() in here on purpose: the argument is tens to hundreds by the time a shell's own
  // coordinates reach it, and sin at that magnitude is precision-dependent — on some drivers, and
  // on the software GL the shot harness runs, it comes back near enough constant that the whole
  // nebula shades as blown glass. This one is float-safe everywhere.
  float hash(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  float noise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
                   mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
                   mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    return 0.56 * noise(p) + 0.28 * noise(p * 2.03) + 0.16 * noise(p * 4.11);
  }

  void main() {
    // Limb brightening: along the rim the sight line runs through the shell rather than across it.
    float nv = abs(dot(normalize(vNormal), normalize(vView)));
    float limb = pow(1.0 - nv, uEdge);
    // Clumps, and the rays that escape between them. The spokes are radial in the shell's own frame,
    // so they line up across the shells the way a shadow cast from one centre has to.
    vec3 d = normalize(vPos);
    float a = atan(d.z, d.x);
    // Clumps eat most of the light where they are thick, which is what makes the shell ragged
    // rather than blown glass.
    // Clumps eat the light where they are thick. Most of a shell is gaps: a nebula is ragged, and
    // an evenly lit one reads as blown glass.
    float clumps = pow(fbm(vPos * uClump + uPhase), 2.6) * 6.5;
    float spoke = 0.22 + 0.78 * pow(abs(sin(float(${SPOKES}) * a * 0.5 + 2.2 * d.y + uPhase)), 2.0);
    // Ionisation is not symmetric: one pair of limbs is always brighter than the other.
    float lobes = 0.55 + 0.65 * abs(d.x);
    float i = limb * clumps * spoke * lobes * uGain;
    // The hottest parts burn toward white, as an exposure that holds the faint halo has to.
    gl_FragColor = vec4(mix(uColor, vec3(1.0), clamp(i - 0.75, 0.0, 0.45)) * i, 1.0);
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

  // The nebula's pole leans away from the core, so the rays that escape its equator sweep the arm
  // rather than pointing nowhere: the one bearing this place actually knows (core.ts).
  const pole = coreDirection(ctx, 'documentation');
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pole.clone().negate());

  const phases: { value: number }[] = [];
  for (const [r, flat, kelvin, edge, gain] of SHELLS) {
    // Offset and rolled a little: shells thrown off at different times are not concentric, and
    // four perfect spheres about one point read as a diagram of a nebula rather than as one.
    const geometry = keep(new THREE.SphereGeometry(RING * r, 48, 32).scale(1, flat, 1)
      .rotateZ(0.17 * r).rotateX(0.09 * r)
      .translate(RING * 0.06 * (r - 1), RING * 0.09 * (r - 1), 0));
    const uniforms = {
      uColor: { value: vivid(at(kelvin, new THREE.Color()), 1.25) },
      uGain: { value: gain },
      uEdge: { value: edge },
      uClump: { value: 1.5 / r },
      uPhase: { value: 0 },
    };
    phases.push(uniforms.uPhase);
    const material = keep(new THREE.ShaderMaterial({
      vertexShader: shellVertex, fragmentShader: shellFragment, uniforms,
      side: THREE.DoubleSide, ...additive,
    }));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2 - r; // the halo first, the ring over it: outside in, as the light leaves
    group.add(mesh);
  }

  // The pair at the centre. The white dwarf is what lights all of the above; the companion is the
  // brighter of the two to the eye and lights none of it, which is the joke the real object plays.
  const positions: Vec3[] = [[-0.5, 0.08, 0.2], [0.62, -0.05, -0.3]];
  const starGeometry = keep(new THREE.BufferGeometry());
  starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions.flat(), 3));
  const tints = [at(30000, new THREE.Color()), at(5200, new THREE.Color())];
  starGeometry.setAttribute('tint', new THREE.Float32BufferAttribute(tints.flatMap((c) => [c.r, c.g, c.b]), 3));
  starGeometry.setAttribute('mag', new THREE.Float32BufferAttribute([0.5, 1.0], 1));
  const starUniforms = { uScale: { value: 1 } };
  const starMaterial = keep(new THREE.ShaderMaterial({
    vertexShader: starVertex, fragmentShader: starFragment, uniforms: starUniforms, ...additive,
  }));
  const stars = new THREE.Points(starGeometry, starMaterial);
  stars.frustumCulled = false;
  stars.renderOrder = 3;
  group.add(stars);

  const buffer = new THREE.Vector2();
  let t = 0;

  return {
    group,

    pose(aspect): CameraPose {
      const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
      // Spec §6: the nebula sits right of centre beside the reading column, or high over a sheet.
      const shift = aspect >= 1 ? 0.3 : 0;
      const span = RING * SHELLS[SHELLS.length - 1][0];
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
      // The shells drift, slowly and at different rates, so the clumps are never quite the same
      // twice. Nothing here needs full rate: a nebula is the slowest thing on the site.
      t += dt;
      for (let i = 0; i < phases.length; i++) phases[i].value = t * (0.004 + 0.002 * i);
      return false;
    },

    resize() {
      ctx.renderer.getDrawingBufferSize(buffer);
      starUniforms.uScale.value = buffer.y / (2 * Math.tan(THREE.MathUtils.degToRad(FOV) / 2));
    },

    dispose() {
      for (const k of kept.splice(0)) k.dispose();
    },
  };
}
