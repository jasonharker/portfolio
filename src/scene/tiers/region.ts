// Region tier: everything below the galaxy. About a tenth of the disc around any waypoint, as a
// PHANGS-JWST crop of one arm segment, down to the destination objects themselves. The backdrop is
// the same seeded galaxy the Galaxy tier draws (galaxy-model), so the local arm segment and the core
// glow sit in their true directions, with young blue-white clusters along the arms and the most
// luminous of their stars carrying JWST's spikes.
//
// M4: the places live here, not in a tier of their own. Each sits at its waypoint as a group scaled
// so that the distance it asks to be read from is READ kpc, which buys the thing the site is for —
// one space from the whole disc down to a ship's hull, so a flight is a move rather than a cut, and
// the galaxy is still behind you when you arrive. A place's own units are untouched inside its
// group; nothing about it is faked in screen space.
//
// Units are galaxy units (≈ kpc), so waypoint positions from topology.yaml are used directly, and
// stars are sized in kpc: nearer ones read bigger and brighter.
// Draw calls: dust into its target (1), then deep field, stars, dust composite, core glow, bright
// stars, constellation links and stars, foreground stars (8), plus whatever the place being read adds.
import * as THREE from 'three';
import { createConstellation, type Constellation } from '../constellation';
import { createDust, type Dust } from '../dust';
import { DISC_RADIUS, galaxyModel, prng, SEED } from '../galaxy-model';
import { additive, createSky, palette, SPIKES, vivid, type Sky } from '../jwst';
import { createNebula } from '../local/nebula';
import { createOrrery } from '../local/orrery';
import { createShip } from '../local/ship';
import type { CameraPose, LocalPlace, PlaceId, SceneContext, Tier, Waypoint } from '../types';

const DISTANCE = 2.2; // camera to the framed place; ~3.5 wide at 16:9, a tenth of the disc
const CORE_DISTANCE = 4.5; // the core (documentation) is larger than a tenth; stand back to see the bulge
const ELEVATION = THREE.MathUtils.degToRad(24);
const AZIMUTH = THREE.MathUtils.degToRad(46); // swings the view so the core falls toward an edge
const FOV = 50;
const CONSTELLATION_SCALE = 1.0; // galaxy units per constellation-local unit
const OVERHEAD_FIT = 1.1; // resume's overhead frame: disc radii to the frame's short half-extent
const OVERHEAD_SHIFT = 0.45; // and how far off centre the disc sits, in half-extents
// The view distance a place is read from, in kpc, which is what sets its group's scale. Chosen, not
// physical: honest metres would put 17 empty decades between the arm and the object, and a scale
// nothing in frame can be measured against is no scale at all. What has to hold is that a place is
// consistent inside itself, and that arriving at one still shows the galaxy it sits in.
const READ = 0.03;
const SHOW = 2.5; // kpc: beyond this a place's object is a speck, and is not drawn
const STAR_SIZE = 0.012; // kpc per unit of star luminosity; the Galaxy tier's 60k stars use 0.05, these are resolved
const CLUSTER_RADIUS = [0.012, 0.05]; // kpc
const SPIKE_SIZE = 0.08; // kpc across a bright star's sprite at full luminosity

const starsVertex = /* glsl */ `
  attribute vec4 tint; // rgb, a = size in kpc
  uniform float uScale; // drawing-buffer pixels per unit at distance 1
  uniform float uExposure;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float px = tint.a * uScale / max(-mv.z, 1e-3);
    // A star is a point source: past the size at which it is resolved it stops growing rather than
    // swelling into a disc. The cap closes with the exposure, because the two views want different
    // things from the same field — from 2 kpc out the near stars are the subject and carry the arm's
    // texture, and from inside the disc they are a band, which is thousands of points and not
    // hundreds of bokeh discs.
    gl_PointSize = clamp(px, 2.0, mix(3.5, 24.0, uExposure));
    vAlpha = min(1.0, px * px / 16.0); // below 4 px a star keeps its flux, fading rather than shimmering
    vColor = tint.rgb * uExposure;
    gl_Position = projectionMatrix * mv;
    // Pinned to the far plane, so a place's hull occludes the backdrop behind it. The points are
    // still placed in 3D — only their depth is faked — so the parallax through a flight is intact.
    // Without this the backdrop is depth-free, draws last, and paints straight over the ship.
    gl_Position.z = gl_Position.w * 0.9999;
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
  uniform float uExposure;
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
    vGain = smoothstep(12.0, 36.0, px) * (0.12 + 1.4 * tint.a) * clamp(px / 80.0, 0.6, 1.4) * uExposure;
    gl_Position = projectionMatrix * mv;
    // Pinned to the far plane, so a place's hull occludes the backdrop behind it. The points are
    // still placed in 3D — only their depth is faked — so the parallax through a flight is intact.
    // Without this the backdrop is depth-free, draws last, and paints straight over the ship.
    gl_Position.z = gl_Position.w * 0.9999;
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
    // Pinned to the far plane, so a place's hull occludes the backdrop behind it. The points are
    // still placed in 3D — only their depth is faked — so the parallax through a flight is intact.
    // Without this the backdrop is depth-free, draws last, and paints straight over the ship.
    gl_Position.z = gl_Position.w * 0.9999;
  }
`;
const glowFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    float d = length(vUv) * 8.0; // kpc, the quad spans ±8
    float i = 2.2 * exp(-d * d / 0.06) + 0.5 * exp(-d * d / 0.6) + 0.06 * exp(-d / 1.5); // compact: wide blue wings read as a cataract
    i *= smoothstep(8.0, 5.0, d) * uStrength;
    gl_FragColor = vec4(mix(uColor, vec3(1.0), clamp(i - 0.6, 0.0, 1.0)) * i, 1.0);
    #include <colorspace_fragment>
  }
`;

let ctx: SceneContext;
let scene: THREE.Scene;
let constellation: Constellation;
let ground: THREE.Color;
let dust: Dust;
let sky: Sky;
let observer: ResizeObserver;
/** The destination objects, at their waypoints. `near` is the one the camera is close enough to read. */
const places = {} as Record<Exclude<PlaceId, 'constellation'>, { place: LocalPlace; unit: number; at: THREE.Vector3 }>;
let near: { place: LocalPlace; unit: number; at: THREE.Vector3 } | null = null;
let width = innerWidth;
let height = innerHeight;
let pointer = { x: NaN, y: NaN };
const disposables: { dispose(): void }[] = [];
const starUniforms = { uScale: { value: 1 }, uExposure: { value: 1 } };
const glowUniforms = { uSize: { value: 16 }, uColor: { value: new THREE.Color() }, uStrength: { value: 1 } };
const buffer = new THREE.Vector2();
let plane: THREE.Plane;
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const hit3 = new THREE.Vector3();

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

/**
 * Resume: the whole disc from straight above, the face-on view M74 is famous for. It is far past
 * CROSSOVER, so the flight hands it to the Galaxy tier; it lives here only because every place is
 * framed here. Straight down there is no horizon, so the pose names its own screen up: -z, which
 * keeps +x screen right.
 */
function overhead(aspect: number): CameraPose {
  const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  const fit = OVERHEAD_FIT * DISC_RADIUS;
  const d = aspect >= 1 ? fit / tan : fit / (tan * aspect);
  const half = d * tan;
  // Screen right is +x and screen up is -z: wide screens push the disc right of the wide CV,
  // portrait ones push it up above the bottom sheet.
  const [tx, tz] = aspect >= 1 ? [-OVERHEAD_SHIFT * half * aspect, 0] : [0, OVERHEAD_SHIFT * half];
  return { position: [tx, d, tz], target: [tx, 0, tz], fov: FOV, up: [0, 0, -1], pivot: [0, 0, 0] };
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
      // Along an arm's spine, from the disc's own exponential profile, clear of the bulge, as strong as the arm is there.
      let r: number, arm: number;
      do {
        r = 1.4 - 4.2 * Math.log(1 - rand());
        arm = Math.floor(rand() * model.arms);
      } while (r > DISC_RADIUS - 1 || r < 2 || rand() > model.armWeightAt(r, arm));
      const width = 0.12 + 0.018 * r; // across the arm, kpc
      const a = model.armAngleAt(r, arm) + (gauss() * width * 0.45 * model.along) / r;
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
    const starMaterial = track(new THREE.ShaderMaterial({ vertexShader: starsVertex, fragmentShader: starsFragment, uniforms: starUniforms, ...additive, depthTest: true }));

    const brightGeometry = track(new THREE.BufferGeometry());
    brightGeometry.setAttribute('position', new THREE.Float32BufferAttribute(bright, 3));
    brightGeometry.setAttribute('tint', new THREE.Float32BufferAttribute(brightTint, 4));
    const brightMaterial = track(new THREE.ShaderMaterial({ vertexShader: brightVertex, fragmentShader: brightFragment, uniforms: starUniforms, ...additive, depthTest: true }));

    // The core glow, a camera-facing quad at the origin.
    const glowGeometry = track(new THREE.PlaneGeometry(1, 1));
    glowUniforms.uColor.value = vivid(ctx.colour('--star-12000'), 1.6).multiplyScalar(0.8);
    const glowMaterial = track(new THREE.ShaderMaterial({ uniforms: glowUniforms, vertexShader: glowVertex, fragmentShader: glowFragment, ...additive, depthTest: true }));
    const glow = new THREE.Mesh(glowGeometry, glowMaterial);
    glow.frustumCulled = false;
    glow.renderOrder = 1;

    // The constellation stands in the arm rather than facing the camera square-on. A plate parallel
    // to the image plane is the strongest decal cue there is — no foreshortening, no parallax, every
    // star the same distance away — and it was why the topology read as printed over the galaxy
    // instead of sitting in it. Swung off the view axis, its own depth does the rest.
    const b = base('constellation');
    const basis = new THREE.Matrix4().makeBasis(b.right, b.up, b.back)
      .multiply(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(15)))
      .multiply(new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(-9)));
    constellation = createConstellation(ctx, b.target, CONSTELLATION_SCALE, basis, DISTANCE * 1.3);
    // The plane the stars lie in — now the swung one. The pointer is projected onto it so the
    // repulsion happens in the constellation's own space rather than in screen space (spec §3).
    const normal = new THREE.Vector3().setFromMatrixColumn(basis, 2).normalize();
    plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, b.target);
    constellation.resize(dpr);
    track(constellation);

    // The destinations. Each is built in its own units and then scaled so the distance its pose()
    // asks for is READ kpc; 16:9 is the reference, so the scale is a property of the place and not
    // of the viewport. Nothing else about the object is touched.
    const built = { incidents: createOrrery(ctx), gitops: createShip(ctx), documentation: createNebula(ctx) };
    for (const [id, place] of Object.entries(built) as [keyof typeof built, LocalPlace][]) {
      const p = place.pose(16 / 9);
      // The tier has one lens (a flight that changed FOV mid-move would read as a zoom on top of the
      // dolly), so a place composed for its own FOV keeps its composition through the tangent ratio.
      const fit = Math.tan(THREE.MathUtils.degToRad(FOV / 2)) / Math.tan(THREE.MathUtils.degToRad(p.fov / 2));
      const unit = (READ / new THREE.Vector3(...p.position).distanceTo(new THREE.Vector3(...p.target))) * fit;
      const at = new THREE.Vector3(...waypoint(id).pos);
      place.group.position.copy(at);
      place.group.scale.setScalar(unit);
      place.group.visible = false;
      places[id] = { place, unit, at };
      track(place);
    }

    // The same kpc dust field as the Galaxy tier, seen close (look 1: absorbing lanes, HII), and the same sky.
    dust = track(createDust(model, 1, 1, ctx.quality.dustScale, 5));
    dust.resize(width, height);
    dust.composite.renderOrder = 0.5;
    sky = track(createSky(ctx.quality.deepField, ctx.quality.foreground, dpr, ctx.colour));
    sky.gain(0.9, 1);

    scene.add(sky.group, points(starGeometry, starMaterial, 0), dust.composite, glow, points(brightGeometry, brightMaterial, 1.5),
      constellation.group, ...Object.values(places).map((p) => p.place.group));
    // Compile every place's materials now, while the groups are still in hand. Otherwise the first
    // frame that shows one compiles its shaders mid-flight, which stalls the dolly — a visible hitch
    // on an Intel UHD 620, and seconds under SwiftShader in the tests.
    for (const p of Object.values(places)) p.place.group.visible = true;
    ctx.renderer.compile(scene, ctx.camera);
    for (const p of Object.values(places)) p.place.group.visible = false;

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
    // A destination object frames itself, in its own units; the group's scale and position carry
    // that out into galaxy space, which is the only space the camera ever works in.
    if (place === 'resume') return overhead(width / height);
    const p = places[place as keyof typeof places];
    if (p) {
      const pose = p.place.pose(width / height);
      const out = (v: CameraPose['position']) => new THREE.Vector3(...v).multiplyScalar(p.unit).add(p.at).toArray() as CameraPose['position'];
      return { position: out(pose.position), target: out(pose.target), fov: FOV, pivot: out(pose.pivot ?? pose.target) };
    }
    const { target, position, right, up, back, distance: framed } = base(place);
    const pivot = target.toArray() as CameraPose['target'];
    // Spec §6: the object sits right of centre beside the reading column. On a portrait
    // screen the column is a bottom sheet, so it sits high instead, pulled back to fit the width.
    const aspect = width / height;
    const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const distance = aspect >= 1 ? framed : Math.max(framed, 1.1 / (tan * aspect));
    position.addScaledVector(back, distance - framed);
    const half = distance * tan;
    // Right of centre. A place is read with the column opened on demand over the scene, so it needs
    // only enough to clear the rail; the landing essay holds the column open the whole time it is
    // read, so its sky is pushed well right, though on a narrow desktop its left figures sit behind the text.
    const shift = place === 'constellation' ? 0.35 : 0.14;
    const pan = aspect >= 1
      ? right.multiplyScalar(-shift * half * aspect).addScaledVector(up, 0.08 * half)
      : up.multiplyScalar(-0.4 * half);
    return {
      position: position.add(pan).toArray() as CameraPose['position'],
      target: target.add(pan).toArray() as CameraPose['target'],
      fov: FOV,
      pivot,
    };
  },

  update(dt) {
    sky.update(dt);
    // The camera may have moved under a still pointer: test against last frame's label positions.
    if (!Number.isNaN(pointer.x)) region.hover!(pointer.x, pointer.y);
    // Idle life runs in the place being read, and only there: the others are a galaxy away.
    const moving = near?.place.update(dt) ?? false;
    return constellation.update(dt) || moving;
  },

  hover(x, y) {
    pointer = { x, y };
    near?.place.hover?.(x, y);
    // Where the pointer meets the constellation's plane, for the stars to give way from.
    if (Number.isNaN(x)) constellation.probe(null);
    else {
      const w = ctx.labels.clientWidth || innerWidth, h = ctx.labels.clientHeight || innerHeight;
      ray.setFromCamera(ndc.set((2 * x) / w - 1, 1 - (2 * y) / h), ctx.camera);
      constellation.probe(ray.ray.intersectPlane(plane, hit3) ? hit3 : null);
    }
  },

  hot: () => near?.place.hot?.() ?? null,


  reading: () => (near ? (Object.keys(places) as (keyof typeof places)[]).find((id) => places[id] === near) ?? null : null),

  href: () => near?.place.href?.() ?? null,

  render(renderer, camera) {
    const cam = camera as THREE.PerspectiveCamera;
    // Which place is close enough to read, and so to draw, update and hover. Nothing announces the
    // switch: at SHOW an object is a speck, and it grows from there as the dolly comes in.
    const was = near;
    near = null;
    for (const p of Object.values(places)) {
      const d = cam.position.distanceTo(p.at);
      p.place.group.visible = d < SHOW;
      if (p.place.group.visible && (!near || d < cam.position.distanceTo(near.at))) near = p;
    }
    // Flying away from a place ends whatever was hovered there: nothing else will call its update
    // again, so a label left showing would hang over the next thing you arrived at.
    if (was && was !== near) was.place.hover?.(NaN, NaN);
    // Near and far follow the camera: one tier now spans the whole disc down to a hull, and no fixed
    // pair holds both. Only a place's own geometry depth-tests — the backdrop is additive and
    // depth-free — so the range only has to bracket whatever is being read.
    const r = Math.max(near ? cam.position.distanceTo(near.at) : cam.position.length(), 1e-4);
    const [n, f] = [r / 200, Math.max(r * 400, 3 * DISC_RADIUS)];
    if (cam.near !== n || cam.far !== f) {
      cam.near = n;
      cam.far = f;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    near?.place.prepare?.(renderer, cam);
    renderer.getDrawingBufferSize(buffer);
    starUniforms.uScale.value = buffer.y / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    // Exposure. Coming in to a place the camera ends up inside the disc, looking along it, and the
    // sightline stacks the whole arm: an additive field that reads as dust and stars from 2 kpc out
    // saturates to white from within it. A camera exposing for a lit object a stone's throw away
    // cannot also expose for the galaxy behind it, so stop down as the dolly comes in — which is
    // also what leaves the band readable behind the object rather than blowing through it.
    const exposure = 0.2 + 0.8 * THREE.MathUtils.smoothstep(r, 0.06, 1.4);
    starUniforms.uExposure.value = exposure;
    sky.gain(0.9 * exposure, exposure);
    // Inside the bulge the stars are the core; the glow is for seeing it from the arms.
    glowUniforms.uStrength.value = THREE.MathUtils.smoothstep(cam.position.length(), 1.5, 7) * exposure;
    renderer.setClearColor(ground, 1);
    const far = cam.position.distanceTo(constellation.centre);
    constellation.fade(far);
    // Coming in to a place the camera descends into the disc, where the dust impostor breaks down.
    dust.fade(THREE.MathUtils.smoothstep(r, 0.2, 1.2));
    dust.render(renderer, cam);
    renderer.render(scene, cam);
  },

  resize(w, h) {
    width = ctx.labels.clientWidth || w;
    height = ctx.labels.clientHeight || h;
    dust?.resize(w, h);
    for (const p of Object.values(places)) p.place.resize?.(width, height);
  },

  dispose() {
    observer?.disconnect();
    for (const d of disposables.splice(0)) d.dispose();
  },
};
