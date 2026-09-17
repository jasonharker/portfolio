// Incidents (/incidents): the solar system, seen from above — orbit rings drawn like a brass
// orrery, one planet per incident, all legible at once, click a planet to drop to it (spec §3).
//
// The layout is the data. `order` is the ring, best nearest the sun; the count of `focus` — how
// much of the lab the incident touched — is the planet's disc area. A fifth incident adds a fifth
// ring with no code change, as a fifth node adds a star. Past FEATURED the rings stop reading as a
// catalogue, so the older incidents fall together into one outer belt and keep their planets small.
//
// Scale, in this place's own units: the sun is 1.2 across, the innermost ring 2.4 out, the camera
// far enough back to hold the outermost. Periods are Kepler's, T ∝ r^1.5, with the innermost turn
// taking INNER_PERIOD: nothing here is ever quite still, and nothing moves fast enough to watch.
//
// Colour is the instrument's, not a photograph's: a planet is tinted by its distance from the sun
// through palette(), on T ∝ 1/r rather than the radiative 1/√r, so four planets span the palette
// instead of crowding its blue end.
import * as THREE from 'three';
import { additive, palette, SPIKES } from '../jwst';
import type { LocalPlace } from '../tiers/local';
import { coreDirection } from './core';
import type { CameraPose, SceneContext } from '../types';

const R0 = 2.4; // innermost ring
const GAP = 1.75; // ring spacing, widening outward
const SPREAD = 1.1;
const FEATURED = 8; // planets read this far out; older incidents share the belt (spec §3)
const BELT_SPAN = 0.55; // belt bodies scatter this far either side of its radius
const SUN_R = 0.6;
const BODY_R = 0.19; // planet radius per √(focus nodes), so disc area is how much of the lab it touched
const INNER_PERIOD = 100; // seconds for one turn of the innermost ring
const ELEVATION = (58 * Math.PI) / 180; // raking enough that the rings read as ellipses
const FOV = 45;
const HOVER_S = 0.18; // hover lift and glow ease over this
const HOVER_PX = 9; // forgiveness around a planet's own projected disc, CSS px
const LIFT = 0.65; // units a hovered planet rises off the plane
const WIDTH = 0.016; // half-width of a drawn ring, in units: a hairline, not a tube
const TICKS = 24; // graduations engraved round a ring
const HOT = 12000; // the innermost ring's false colour, in kelvin; outward it falls as 1/r
const TAU = Math.PI * 2;

const ringVertex = /* glsl */ `
  attribute vec2 arc; // angle round the ring, and -1..1 across its width
  attribute vec4 ring; // radius, its planet's angle, hover heat, width in hairlines
  varying float vAcross;
  varying float vAngle;
  varying float vLead;
  varying float vHeat;
  varying float vSolid;
  uniform float uWidth;
  void main() {
    vAcross = arc.y;
    vAngle = arc.x;
    vHeat = ring.z;
    vSolid = step(ring.w, 1.5); // the belt is a band of dust, not a drawn orbit
    vLead = mod(ring.y - arc.x, ${TAU.toFixed(7)}); // radians this point lies behind the planet
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position * (ring.x + arc.y * uWidth * ring.w), 1.0);
  }
`;
const ringFragment = /* glsl */ `
  uniform vec3 uColor;
  varying float vAcross;
  varying float vAngle;
  varying float vLead;
  varying float vHeat;
  varying float vSolid;
  void main() {
    float line = exp(-vAcross * vAcross * 2.6);
    // Graduations, and the arc the planet has just swept, which is how a ring reads as occupied.
    float tick = smoothstep(0.80, 1.0, cos(vAngle * ${TICKS}.0));
    float wake = exp(-vLead * 3.2) + 0.4 * exp(-(${TAU.toFixed(7)} - vLead) * 10.0);
    // A featured orbit is a drawn line; the belt is a faint band of dust, thinning where it thins.
    float dust = 0.025 * (0.75 + 0.35 * sin(vAngle * 5.0 + 1.0) * sin(vAngle * 3.0));
    gl_FragColor = vec4(uColor * line * mix(dust, 0.14 + 0.8 * tick + (0.7 + 1.5 * vHeat) * wake + 0.5 * vHeat, vSolid), 1.0);
    #include <colorspace_fragment>
  }
`;

const planetVertex = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vP = world.xyz;
    vV = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
const planetFragment = /* glsl */ `
  uniform vec3 uTint;
  uniform vec3 uCore;
  uniform vec3 uCoreDir;
  uniform float uHeat;
  uniform float uSeed;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  void main() {
    vec3 l = -normalize(vP); // the sun is this place's origin, so every body carries a real phase
    float lit = smoothstep(-0.05, 0.35, dot(vN, l));
    float face = max(dot(vN, vV), 0.0);
    float limb = 0.45 + 0.55 * pow(face, 0.45);
    // Latitude banding from the body's own seed: weather, not a paint job.
    float band = 1.0 + 0.09 * sin(vN.y * (6.0 + 9.0 * uSeed) + uSeed * 6.2831853) + 0.05 * sin(vN.y * 19.0 - uSeed * 11.0);
    float rim = pow(1.0 - face, 3.0);
    vec3 c = uTint * (lit * limb * band + 0.035);
    c += uCore * rim * (0.12 + 0.30 * max(dot(vN, uCoreDir), 0.0)); // the galaxy behind, on the limb
    c += (uTint + vec3(0.7)) * uHeat * (0.22 * lit + 0.7 * pow(1.0 - face, 4.0));
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
  }
`;

const sunVertex = /* glsl */ `
  uniform float uHeight; // drawing-buffer pixels
  uniform float uRadius;
  varying float vPx;
  varying float vDisc;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // The disc is world scale; the PSF around it is the instrument's, held to a sane sprite.
    vDisc = uRadius * projectionMatrix[1][1] * 0.5 * uHeight / max(-mv.z, 0.001);
    float px = clamp(vDisc * 7.0, 48.0, 720.0);
    gl_PointSize = px;
    vPx = px * 0.5;
  }
`;
const sunFragment = /* glsl */ `
  ${SPIKES}
  uniform vec3 uColor;
  varying float vPx;
  varying float vDisc;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float u = length(p) * vPx / max(vDisc, 1.0); // disc radii from the centre
    vec2 k = spikes(p, vPx, 0.8);
    float disc = smoothstep(1.0, 1.0 - 1.5 / max(vDisc, 2.0), u) * (1.0 - 0.35 * u * u);
    float corona = 0.22 * exp(-(u - 1.0) * 2.1) * smoothstep(1.0, 0.25, length(p));
    vec3 c = mix(uColor, vec3(1.0), 0.7) * disc * 1.7 + uColor * (corona + k.y * 2.6) + vec3(1.0) * k.x * 0.5;
    gl_FragColor = vec4(c * smoothstep(1.0, 0.92, max(abs(p.x), abs(p.y))), 1.0);
    #include <colorspace_fragment>
  }
`;

const SEGMENTS = 192;

/** One ring as a flat strip of width 2 about a unit circle; `ring` places and lights it per instance. */
function ringStrip(count: number): THREE.InstancedBufferGeometry {
  const vertices = (SEGMENTS + 1) * 2;
  const position = new Float32Array(vertices * 3);
  const arc = new Float32Array(vertices * 2);
  const index = new Uint16Array(SEGMENTS * 6);
  for (let j = 0; j <= SEGMENTS; j++) {
    const a = (j / SEGMENTS) * TAU;
    for (let k = 0; k < 2; k++) {
      const i = j * 2 + k;
      position[i * 3] = Math.cos(a);
      position[i * 3 + 2] = Math.sin(a);
      arc[i * 2] = a;
      arc[i * 2 + 1] = k ? 1 : -1;
    }
    if (j < SEGMENTS) index.set([j * 2, j * 2 + 1, j * 2 + 3, j * 2, j * 2 + 3, j * 2 + 2], j * 6);
  }
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('arc', new THREE.BufferAttribute(arc, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.instanceCount = count;
  return geometry;
}

export function createOrrery(ctx: SceneContext): LocalPlace {
  const group = new THREE.Group();
  const kept: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => (kept.push(x), x);

  const pal = palette(ctx.colour);
  const core = ctx.colour('--star-12000');
  const coreDir = coreDirection(ctx, 'incidents');
  const n = ctx.incidents.length;
  const belted = Math.max(0, n - FEATURED);
  const orbit = (i: number) => R0 + GAP * Math.pow(i, SPREAD);
  const belt = orbit(FEATURED - 0.5);

  // Ring instances: one per featured incident, plus the belt's own band when there is one.
  const ringCount = Math.min(n, FEATURED) + (belted ? 1 : 0);
  const ringData = new Float32Array(ringCount * 4);
  const ringGeometry = keep(ringStrip(ringCount));
  const ringAttribute = new THREE.InstancedBufferAttribute(ringData, 4);
  ringAttribute.setUsage(THREE.DynamicDrawUsage);
  ringGeometry.setAttribute('ring', ringAttribute);
  for (let i = 0; i < ringCount; i++) {
    const last = belted && i === ringCount - 1;
    ringData[i * 4] = last ? belt : orbit(i);
    ringData[i * 4 + 3] = last ? BELT_SPAN / WIDTH : 1;
  }
  // Brass: the orrery is an instrument, and its rings are the one warm thing that isn't a body.
  const ringMaterial = keep(new THREE.ShaderMaterial({
    vertexShader: ringVertex, fragmentShader: ringFragment, ...additive, transparent: false, depthTest: true, side: THREE.DoubleSide,
    uniforms: { uColor: { value: pal(4300, new THREE.Color()) }, uWidth: { value: WIDTH } },
  }));
  const ringMesh = new THREE.Mesh(ringGeometry, ringMaterial);
  ringMesh.frustumCulled = false;
  ringMesh.renderOrder = 2;
  group.add(ringMesh);

  const sunGeometry = keep(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3)));
  const sunMaterial = keep(new THREE.ShaderMaterial({
    vertexShader: sunVertex, fragmentShader: sunFragment, ...additive,
    uniforms: { uColor: { value: pal(5600, new THREE.Color()) }, uRadius: { value: SUN_R }, uHeight: { value: innerHeight * ctx.renderer.getPixelRatio() } },
  }));
  const sun = new THREE.Points(sunGeometry, sunMaterial);
  sun.frustumCulled = false;
  sun.renderOrder = 3;
  group.add(sun);

  const sphere = keep(new THREE.SphereGeometry(1, 28, 20));
  const bodies = ctx.incidents.map((incident, i) => {
    // Golden-angle phases: deterministic, and no two planets ever line up.
    const phase = i * 2.39996;
    const drop = i - FEATURED; // how far into the belt, for the ones past the featured rings
    const spread = belted ? ((drop + 0.5) / belted) * 2 - 1 : 0;
    const radius = drop < 0 ? orbit(i) : belt + BELT_SPAN * spread * 0.8;
    const size = BODY_R * Math.sqrt(incident.focus.length) * (drop < 0 ? 1 : 0.55);
    const material = keep(new THREE.ShaderMaterial({
      vertexShader: planetVertex, fragmentShader: planetFragment,
      uniforms: {
        uTint: { value: pal((HOT * R0) / radius, new THREE.Color()) },
        uCore: { value: core }, uCoreDir: { value: coreDir },
        uHeat: { value: 0 }, uSeed: { value: (i * 0.6180339887) % 1 },
      },
    }));
    const mesh = new THREE.Mesh(sphere, material);
    mesh.scale.setScalar(size);
    mesh.renderOrder = 1;
    group.add(mesh);
    // Kepler: the outer rings are slower, so the arrangement is never twice the same.
    return { incident, mesh, material, radius, size, phase, period: INNER_PERIOD * Math.pow(radius / R0, 1.5), heat: 0 };
  });

  const outer = (bodies.length ? Math.max(...bodies.map((b) => b.radius)) : R0) + (belted ? BELT_SPAN : 0);
  const pointer = new THREE.Vector2(NaN, NaN);
  const v = new THREE.Vector3();
  let width = ctx.labels.clientWidth || innerWidth;
  let height = ctx.labels.clientHeight || innerHeight;
  let hot: string | null = null;
  let t = 0;

  /** The body under the pointer: its own projected disc, plus a few px of forgiveness. */
  function pick(x: number, y: number) {
    if (Number.isNaN(x) || !group.visible) return null;
    const camera = ctx.camera;
    const scale = (height * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    let best: string | null = null;
    let nearest = Infinity;
    for (const b of bodies) {
      // The body's place on the plane, not where the hover lift has raised it: a target that moved
      // out from under the pointer as it rose would flicker between hovered and not.
      v.set(b.mesh.position.x, 0, b.mesh.position.z).project(camera);
      if (v.z >= 1) continue;
      const d = Math.hypot((v.x + 1) * 0.5 * width - x, (1 - v.y) * 0.5 * height - y);
      const r = (b.size * scale) / camera.position.distanceTo(b.mesh.position);
      if (d <= r + HOVER_PX && d < nearest) (nearest = d), (best = b.incident.slug);
    }
    return best;
  }

  const look = (next: string | null) => {
    if (next === hot) return;
    hot = next;
    ctx.invalidate();
  };

  return {
    group,

    pose(aspect): CameraPose {
      const tan = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
      const span = outer + (bodies[0]?.size ?? 0) + 0.3;
      // Spec §6: the object sits right of centre beside the reading column, or high above a bottom sheet.
      const shift = aspect >= 1 ? 0.30 : 0;
      // The near edge of the widest ring is a whole radius closer than the sun, and that, not the
      // ring's width, is what sets the distance: fit it, then check the ring is no wider than the frame.
      const d = Math.max(
        (span * Math.sin(ELEVATION)) / (0.9 * tan) + span * Math.cos(ELEVATION),
        span / ((0.92 - shift) * tan * Math.max(aspect, 0.4)),
      );
      const half = d * tan;
      const pan = aspect >= 1
        ? new THREE.Vector3(-shift * half * aspect, 0, 0)
        : new THREE.Vector3(0, -0.34 * half * Math.cos(ELEVATION), 0.34 * half * Math.sin(ELEVATION));
      return {
        position: [pan.x, d * Math.sin(ELEVATION) + pan.y, d * Math.cos(ELEVATION) + pan.z],
        target: pan.toArray() as CameraPose['position'],
        fov: FOV,
      };
    },

    update(dt) {
      // Idle life: the catalogue turns whether or not anyone is watching, at ambient rate.
      if (!ctx.quality.reducedMotion) t += dt;
      bodies.forEach((b, i) => {
        const a = b.phase + (TAU * t) / b.period;
        b.mesh.position.set(b.radius * Math.cos(a), LIFT * b.heat, b.radius * Math.sin(a));
        if (i < FEATURED) ringData[i * 4 + 1] = a;
      });
      // The camera may have moved under a still pointer, and the planets certainly have.
      look(pick(pointer.x, pointer.y));

      let easing = false;
      bodies.forEach((b, i) => {
        const to = b.incident.slug === hot ? 1 : 0;
        if (b.heat !== to) {
          b.heat = to > b.heat ? Math.min(1, b.heat + dt / HOVER_S) : Math.max(0, b.heat - dt / HOVER_S);
          easing = true;
        }
        b.material.uniforms.uHeat.value = b.heat;
        if (i < FEATURED) ringData[i * 4 + 2] = b.heat;
      });
      ringAttribute.needsUpdate = true;
      return easing;
    },

    hover(x, y) {
      pointer.set(x, y);
      look(pick(x, y));
    },

    hot: () => hot,
    href: () => (hot ? `/incidents/${hot}/` : null),

    resize(w, h) {
      width = ctx.labels.clientWidth || w;
      height = ctx.labels.clientHeight || h;
      sunMaterial.uniforms.uHeight.value = height * ctx.renderer.getPixelRatio();
    },

    dispose() {
      for (const k of kept.splice(0)) k.dispose();
      group.clear();
      bodies.length = 0;
    },
  };
}
