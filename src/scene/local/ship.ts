// GitOps (/gitops): the ship, seen from alongside — the camera flies in formation, exterior, and
// the pipeline stages are bays down the spine that light in sequence as a build passes (spec §3).
//
// One key light, and it is a real one: the galactic core, at the bearing coreDirection() gives for
// this waypoint. The ship holds a heading a few degrees off that bearing, so the key rakes the
// leading edges and leaves the flanks to the working lights, which is where the pipeline lives.
// The four bay lamps, the build itself and the engines are point lights in the hull shader, so a
// stage coming up lights the structure around it rather than only its own face.
//
// Draw calls: three. Every member is baked into one merged hull mesh at load, every lit face into a
// second, and the glows into one additive billboard pass; the build cycle is uniform writes only.
import * as THREE from 'three';
import { additive, vivid } from '../jwst';

import { coreDirection } from './core';
import type { CameraPose, LocalPlace, SceneContext, Vec3 } from '../types';

const BAYS = 4;
const BAY_Z = [2.9, 1.15, -0.6, -2.35]; // down the spine, bow to stern
const CYCLE = 9.5; // seconds: one build the length of the line, then a beat before the next
const RUN = 0.68; // the fraction of the cycle the build spends moving
const FROM = 3.6, TO = -5.2; // where the build enters the spine and where it leaves it
const LAMPS = 8; // the lamp ids: 0 to BAYS-1 are the bays, then
const ENGINES = BAYS, BRIDGE = 5, BEACONS = 6, BEAD = 7;
const ATTITUDE: Vec3 = [0.22, -0.62, 0.03]; // heading, held a little off the core's bearing
const EYE: Vec3 = [0.93, 0.31, 0.2]; // where the camera flies, in the ship's own frame
const CENTRE: Vec3 = [0, -0.2, -0.2]; // what it holds in the middle of the frame
const FOV = 45;
const FRAMED = 19.5;

// Lit only by the core, so the flanks are dark and the leading edges are not: what shapes the hull
// is the falloff across a plate, the seams, and the lamps working on the spine. Seams and plate
// tone are object-space, never screen-space, so they hold at any distance.
const hullVertex = /* glsl */ `
  attribute float shade; // per-plate tone: the ship is not painted one grey
  varying vec3 vPos;
  varying vec3 vNormal;
  varying vec3 vEye;
  varying float vShade;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // The eye in the ship's own frame: modelView is rigid here, so its transpose is its inverse.
    mat3 r = mat3(modelViewMatrix);
    vec3 t = modelViewMatrix[3].xyz;
    vEye = -vec3(dot(t, r[0]), dot(t, r[1]), dot(t, r[2])) - position;
    vPos = position;
    vNormal = normal;
    vShade = shade;
    gl_Position = projectionMatrix * mv;
  }
`;
const hullFragment = /* glsl */ `
  uniform vec3 uKey; // toward the core, in the ship's frame
  uniform vec3 uKeyTint;
  uniform vec3 uFill;
  uniform vec3 uHull;
  uniform vec4 uLamp[6]; // xyz where a working light hangs, w how hard it is burning
  uniform vec3 uLampTint[6];
  varying vec3 vPos;
  varying vec3 vNormal;
  varying vec3 vEye;
  varying float vShade;

  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(vEye);

    // Plating: seams on the face's own two axes, and a tone per panel. No texture, no screen space.
    vec3 a = abs(n);
    vec2 uv = (a.x > max(a.y, a.z) ? vPos.zy : a.y > a.z ? vPos.xz : vPos.xy) * 2.3;
    vec2 g = abs(fract(uv) - 0.5) / max(fwidth(uv), 1e-4);
    float seam = 1.0 - 0.24 * (1.0 - smoothstep(0.35, 1.1, min(g.x, g.y)));
    float plate = fract(sin(dot(floor(uv), vec2(41.3, 17.7))) * 4137.1);
    // Plates are not one grey and not one colour: a hull is patched, and the patches show.
    vec3 albedo = uHull * vShade * seam * (0.88 + 0.2 * plate) * mix(vec3(1.0), vec3(1.08, 1.0, 0.9), plate);

    float key = dot(n, uKey);
    vec3 lit = albedo * uKeyTint * max(key, 0.0) * 1.85;
    lit += albedo * uFill * (0.6 + 0.4 * n.y); // the disc behind, and nothing out here is pitch black
    vec3 h = normalize(uKey + v);
    lit += uKeyTint * pow(max(dot(n, h), 0.0), 40.0) * 0.3 * step(0.0, key) * vShade;

    // The working lights. Four bays, the build between them, and the engines aft.
    for (int i = 0; i < 6; i++) {
      vec3 d = uLamp[i].xyz - vPos;
      float r2 = dot(d, d);
      lit += albedo * uLampTint[i] * uLamp[i].w * max(dot(n, d * inversesqrt(r2)), 0.0) / (1.0 + 1.6 * r2);
    }

    // The limb: every edge turned away from us catches the core, which is what says it is metal.
    float rim = pow(1.0 - max(dot(n, v), 0.0), 5.0);
    lit += uKeyTint * rim * smoothstep(-0.4, 0.5, key) * 0.16;

    gl_FragColor = vec4(lit, 1.0);
    #include <colorspace_fragment>
  }
`;

// A lit face is opaque geometry, not a sprite: it occludes, and the glow pass puts the halo on top.
const litVertex = /* glsl */ `
  attribute float shade; // which lamp this face belongs to
  uniform float uLevel[${LAMPS}];
  uniform vec3 uTint[${LAMPS}];
  varying vec3 vColor;
  varying vec3 vNormal;
  varying vec3 vEye;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vColor = uTint[int(shade)] * uLevel[int(shade)];
    vNormal = normalMatrix * normal;
    vEye = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;
const litFragment = /* glsl */ `
  varying vec3 vColor;
  varying vec3 vNormal;
  varying vec3 vEye;
  void main() {
    gl_FragColor = vec4(vColor * (0.5 + 0.5 * max(dot(normalize(vNormal), normalize(vEye)), 0.0)), 1.0);
    #include <colorspace_fragment>
  }
`;

// Glows, sized in the ship's own units and billboarded in view space: no bloom pass runs in this
// tier, so the halo around a lamp is geometry like everything else.
const glowVertex = /* glsl */ `
  attribute vec3 quad; // corner xy, half-size
  attribute float shade;
  uniform float uLevel[${LAMPS}];
  uniform vec3 uTint[${LAMPS}];
  uniform vec3 uBead;
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    int i = int(shade);
    vec4 mv = modelViewMatrix * vec4(i == ${BEAD} ? uBead : position, 1.0);
    // The half-size is added in view space, where the group's scale doesn't reach; carry it across
    // from the model matrix (the tier scales a place's group into galaxy units, tiers/region.ts).
    mv.xy += quad.xy * quad.z * length(modelMatrix[0].xyz);
    vUv = quad.xy * 2.0;
    vColor = uTint[i] * uLevel[i];
    gl_Position = projectionMatrix * mv;
  }
`;
const glowFragment = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    float d = dot(vUv, vUv);
    float i = 0.85 * exp(-d * 8.0) + 0.22 * exp(-d * 2.2);
    gl_FragColor = vec4(vColor * i * smoothstep(1.0, 0.55, sqrt(d)), 1.0);
    #include <colorspace_fragment>
  }
`;

/** Every member of the ship in one pair of arrays: the hull is one draw call, not a hundred. */
function parts() {
  const position: number[] = [], normal: number[] = [], shade: number[] = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const p = new THREE.Vector3(), s = new THREE.Vector3();
  return {
    /** A template, placed and scaled in the ship's frame. `v` is a plate tone, or a lamp index. */
    add(src: THREE.BufferGeometry, at: Vec3, size: Vec3, v: number, rot?: Vec3) {
      q.setFromEuler(rot ? e.fromArray(rot) : e.set(0, 0, 0));
      const baked = src.clone().applyMatrix4(m.compose(p.fromArray(at), q, s.fromArray(size)));
      const g = baked.toNonIndexed();
      const pa = g.attributes.position.array, na = g.attributes.normal.array;
      for (let i = 0; i < pa.length; i += 3) {
        position.push(pa[i], pa[i + 1], pa[i + 2]);
        normal.push(na[i], na[i + 1], na[i + 2]);
        shade.push(v);
      }
      baked.dispose();
      g.dispose();
    },
    geometry() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
      g.setAttribute('shade', new THREE.Float32BufferAttribute(shade, 1));
      return g;
    },
  };
}

export function createShip(ctx: SceneContext): LocalPlace {
  const group = new THREE.Group();
  const kept: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => (kept.push(x), x);
  const tint = (token: string, amount: number, gain = 1) => vivid(ctx.colour(token), amount).multiplyScalar(gain);

  // Templates, merged into the two meshes below and thrown away: nothing is drawn from them.
  const box = new THREE.BoxGeometry(1, 1, 1);
  const tube = new THREE.CylinderGeometry(1, 1, 1, 12).rotateX(Math.PI / 2);
  const bell = new THREE.CylinderGeometry(0.45, 1, 1, 12).rotateX(Math.PI / 2);
  const cap = new THREE.CylinderGeometry(0.4, 1, 1, 4, 1, false, Math.PI / 4).rotateX(Math.PI / 2).scale(1.4142, 1.4142, 1);

  const hull = parts(), lit = parts();
  const glow: { pos: number[]; quad: number[]; shade: number[] } = { pos: [], quad: [], shade: [] };
  const lamp = (at: Vec3, size: number, i: number) => {
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) {
      glow.pos.push(...at);
      glow.quad.push(x * 0.5, y * 0.5, size);
      glow.shade.push(i);
    }
  };

  // Bow: a blunt command block under a tapered cap, a sensor deck on its back, a dock beneath it.
  hull.add(box, [0, 0.1, 4.95], [1.6, 1.3, 2.5], 1);
  hull.add(cap, [0, 0.1, 6.6], [0.8, 0.66, 0.8], 1.05);
  hull.add(box, [0, 0.92, 4.5], [1.05, 0.34, 1.5], 1.2);
  hull.add(box, [0, -0.66, 5.0], [1.15, 0.3, 1.7], 0.85);
  hull.add(box, [0, 0.05, 3.5], [0.95, 0.9, 0.7], 0.95);
  for (const x of [-0.84, 0.84]) hull.add(box, [x, -0.15, 4.4], [0.16, 0.5, 1.1], 1.2);
  hull.add(tube, [0, 0.1, 3.95], [0.72, 0.72, 0.2], 1.15);
  hull.add(tube, [0.48, 0.82, 5.5], [0.26, 0.26, 1.1], 1.1);
  hull.add(tube, [-0.48, 0.82, 5.5], [0.26, 0.26, 1.1], 1.1);
  hull.add(box, [0.83, 0.42, 5.4], [0.12, 0.3, 0.5], 1.25);
  hull.add(box, [0.83, -0.32, 5.5], [0.1, 0.34, 0.9], 1.25);
  hull.add(box, [0, -0.86, 4.6], [0.5, 0.2, 0.5], 1.2);
  lit.add(box, [0, 0.42, 5.85], [1.66, 0.14, 0.5], BRIDGE);
  lamp([0.85, 0.42, 5.85], 0.8, BRIDGE);
  lamp([0, 0.1, 7.05], 0.45, BEACONS);

  // Spine: an open truss — four longerons, a ring frame every cell, braces alternating along it.
  // Nothing is enclosed. It is a working vessel and the structure is most of what it is.
  const SPAN: [number, number] = [-4.4, 3.5], R = 0.33, CELLS = 12;
  const step = (SPAN[1] - SPAN[0]) / CELLS;
  for (const x of [-R, R]) for (const y of [-R, R]) {
    hull.add(box, [x, y, (SPAN[0] + SPAN[1]) / 2], [0.1, 0.1, SPAN[1] - SPAN[0]], 1);
  }
  const brace = Math.hypot(2 * R, step);
  for (let k = 0; k <= CELLS; k++) {
    const z = SPAN[0] + k * step;
    for (const y of [-R, R]) hull.add(box, [0, y, z], [2 * R + 0.1, 0.09, 0.1], 1.1);
    for (const x of [-R, R]) hull.add(box, [x, 0, z], [0.09, 2 * R - 0.09, 0.1], 1.1);
    if (k === CELLS) break;
    const sign = k % 2 ? 1 : -1;
    hull.add(box, [0, R, z + step / 2], [0.06, 0.06, brace], 0.9, [0, sign * Math.atan2(2 * R, step), 0]);
    hull.add(box, [R, 0, z + step / 2], [0.06, 0.06, brace], 0.9, [-sign * Math.atan2(2 * R, step), 0, 0]);
  }

  // The bays: a yoke off the spine, a container slung in it, an arch over the top. The band round
  // the container and the lamp under the arch are the stage — four of them, and a build runs the line.
  BAY_Z.forEach((z, i) => {
    for (const dz of [-0.55, 0.55]) hull.add(box, [0, -0.66, z + dz], [1.36, 0.62, 0.16], 1.15);
    hull.add(box, [0, -1.34, z], [1.5, 1.05, 1.4], 0.8);
    for (const dz of [-0.62, 0.62]) hull.add(box, [0, -1.34, z + dz], [1.58, 1.12, 0.1], 1.1);
    hull.add(box, [0, 0.58, z], [1.0, 0.16, 0.5], 1.15);
    for (const x of [-0.42, 0.42]) hull.add(box, [x, 0.25, z], [0.14, 0.5, 0.42], 1.1);
    lit.add(box, [0, -1.34, z], [1.56, 0.22, 1.0], i);
    lit.add(box, [0, 0.47, z], [0.8, 0.05, 0.34], i);
    lamp([0.9, -1.3, z], 1.0, i);
    lamp([0, 0.42, z], 0.55, i);
  });

  // Radiators: two panels off the aft spine, angled up and outboard. The largest calm planes on the
  // ship, and the only ones the core lights squarely.
  for (const side of [-1, 1]) {
    hull.add(box, [side * 0.52, 0.66, -3.5], [0.14, 0.8, 0.22], 1.1);
    hull.add(box, [side * 1.02, 1.3, -3.5], [1.5, 0.07, 2.0], 1.25, [0, 0, side * 0.85]);
    hull.add(box, [side * 1.02, 1.3, -3.5], [1.54, 0.1, 0.14], 1.0, [0, 0, side * 0.85]);
    lamp([side * 1.52, 1.86, -3.5], 0.3, BEACONS);
  }

  // Stern: the engine block, three bells, and the only warm light on the ship.
  hull.add(box, [0, 0, -5.05], [1.5, 1.45, 1.3], 1.05);
  hull.add(box, [0, 0.92, -5.05], [0.95, 0.4, 1.0], 1.15);
  hull.add(box, [0, -0.2, -4.5], [1.7, 1.0, 0.22], 1.2);
  const BELLS: Vec3[] = [[-0.52, -0.16, -6.2], [0.52, -0.16, -6.2], [0, 0.46, -6.2]];
  for (const at of BELLS) {
    hull.add(bell, at, [0.5, 0.5, 1.1], 1.0);
    lit.add(tube, [at[0], at[1], at[2] - 0.52], [0.44, 0.44, 0.05], ENGINES);
    lamp([at[0], at[1], at[2] - 0.7], 1.6, ENGINES);
  }
  lamp([0, 1.15, -5.05], 0.4, BEACONS);

  // The build itself: a bead running the spine, a core inside two widths of halo.
  for (const size of [0.3, 0.85, 2.0]) lamp([0, 0, 0], size, BEAD);

  for (const g of [box, tube, bell, cap]) g.dispose();

  // A bay works in warm white, the engines burn orange, and the build itself is the coldest and
  // brightest thing aboard — the same blue-white the core is drawn in.
  const level = new Array(LAMPS).fill(0);
  const tints = [
    ...BAY_Z.map(() => tint('--star-5600', 1.9)),
    tint('--star-3000', 2.0, 1.7), tint('--star-4300', 1.4, 0.8),
    tint('--star-12000', 2.0, 1.4), tint('--star-12000', 2.2, 1.9),
  ];
  const bead = new THREE.Vector3(0, 0, FROM);
  const shared = { uLevel: { value: level }, uTint: { value: tints }, uBead: { value: bead } };

  // Six point lights for the hull: the four bays, the engines, then the build where it has got to.
  const ENGINE = BAYS, TRAVEL = BAYS + 1; // the last two of the six
  const lamps = [
    ...BAY_Z.map((z) => new THREE.Vector4(1.5, -1.1, z, 0)),
    new THREE.Vector4(0, 0, -6.1, 0), new THREE.Vector4(0, 0, FROM, 0),
  ];
  const hullUniforms = {
    uKey: { value: new THREE.Vector3() },
    uKeyTint: { value: tint('--star-12000', 1.6, 1.15) },
    uFill: { value: tint('--star-30000', 1.2, 0.08) },
    uHull: { value: tint('--muted', 0.85, 0.62) },
    uLamp: { value: lamps },
    uLampTint: { value: [...tints.slice(0, BAYS), tints[ENGINE], tints[BEAD]] },
  };

  const hullMesh = new THREE.Mesh(keep(hull.geometry()), keep(new THREE.ShaderMaterial({
    vertexShader: hullVertex, fragmentShader: hullFragment, uniforms: hullUniforms,
  })));
  const litMesh = new THREE.Mesh(keep(lit.geometry()), keep(new THREE.ShaderMaterial({
    vertexShader: litVertex, fragmentShader: litFragment, uniforms: shared,
  })));
  const glowGeometry = keep(new THREE.BufferGeometry());
  glowGeometry.setAttribute('position', new THREE.Float32BufferAttribute(glow.pos, 3));
  glowGeometry.setAttribute('quad', new THREE.Float32BufferAttribute(glow.quad, 3));
  glowGeometry.setAttribute('shade', new THREE.Float32BufferAttribute(glow.shade, 1));
  const glowMesh = new THREE.Mesh(glowGeometry, keep(new THREE.ShaderMaterial({
    vertexShader: glowVertex, fragmentShader: glowFragment, uniforms: shared, ...additive, depthTest: true,
  })));
  glowMesh.renderOrder = 2;
  glowMesh.frustumCulled = false;
  group.add(hullMesh, litMesh, glowMesh);

  // The heading is held a few degrees off the bearing to the core, which is the one light there is.
  group.rotation.fromArray(ATTITUDE);
  const key = coreDirection(ctx, 'gitops');
  const held = new THREE.Quaternion();
  const carry = () => hullUniforms.uKey.value.copy(key).applyQuaternion(held.copy(group.quaternion).invert());
  carry();

  const eye = new THREE.Vector3().fromArray(EYE).normalize().applyEuler(group.rotation);
  const forward = eye.clone().negate();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward);
  const centre = new THREE.Vector3().fromArray(CENTRE).applyEuler(group.rotation);

  let t = 0, life = 0;
  const position = new THREE.Vector3(), pan = new THREE.Vector3();
  return {
    group,
    pose(aspect): CameraPose {
      // Spec §6: the ship sits right of centre beside the reading column; on a portrait screen the
      // column is a bottom sheet, so it rides high instead, pulled back to fit the length in.
      const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
      const distance = aspect >= 1 ? FRAMED : Math.max(FRAMED, 8.6 / (tan * aspect));
      const half = distance * tan;
      pan.copy(aspect >= 1 ? right : up).multiplyScalar(aspect >= 1 ? -0.31 * half * aspect : -0.42 * half);
      if (aspect >= 1) pan.addScaledVector(up, -0.08 * half);
      position.copy(eye).multiplyScalar(distance).add(centre).add(pan);
      return {
        position: position.toArray() as Vec3,
        target: pan.add(centre).toArray() as Vec3,
        fov: FOV,
      };
    },
    update(dt) {
      // Idle life: the line runs whether or not anyone is watching, and ambient rate is enough for
      // it. A stage lights as the build reaches it and stays lit until the run is done.
      t = (t + dt) % CYCLE;
      life += dt;
      const run = Math.min(t / (CYCLE * RUN), 1);
      const fade = 1 - THREE.MathUtils.smoothstep(t / CYCLE, RUN, 1);
      bead.set(0, 0, THREE.MathUtils.lerp(FROM, TO, run));
      for (let i = 0; i < BAYS; i++) {
        const d = (bead.z - BAY_Z[i]) / 0.85;
        level[i] = 0.03 + (1.1 * Math.exp(-d * d) + (bead.z < BAY_Z[i] ? 0.18 : 0)) * fade;
        lamps[i].w = level[i] * 0.9;
      }
      // The engines take the finished build out: a flare as it reaches them, then back to station.
      const out = Math.max(0, (bead.z - TO) / (FROM - TO));
      level[ENGINES] = 0.55 + 0.45 * Math.exp(-out * out * 24) * fade + 0.04 * Math.sin(life * 0.7);
      level[BRIDGE] = 0.5 + 0.03 * Math.sin(life * 0.9);
      level[BEACONS] = 0.25 + 0.75 * Math.pow(Math.max(0, Math.sin(life * 2.1)), 16);
      level[BEAD] = THREE.MathUtils.smoothstep(run, 0, 0.05) * (1 - THREE.MathUtils.smoothstep(run, 0.93, 1)) * fade;
      lamps[ENGINE].w = level[ENGINES] * 0.7;
      lamps[TRAVEL].z = bead.z;
      lamps[TRAVEL].w = level[BEAD] * 1.3;
      // Station-keeping: a degree of attitude, on periods long enough not to read as a wobble.
      group.rotation.set(
        ATTITUDE[0] + 0.011 * Math.sin(life * 0.17),
        ATTITUDE[1] + 0.018 * Math.sin(life * 0.11 + 1.3),
        ATTITUDE[2] + 0.008 * Math.sin(life * 0.13 + 2.2),
      );
      carry();
      return false;
    },
    dispose() {
      for (const k of kept.splice(0)) k.dispose();
      group.clear();
    },
  };
}
