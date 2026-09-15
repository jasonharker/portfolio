// The constellation: one star per topology node, one line per link. Built from the data
// alone; adding a node to topology.yaml adds a star with no code change.
//
// Layout, in constellation-local units (x right, y up, z toward the viewer; the whole thing
// spans x ±1.4, y ±1.05; labels extend right of that): layers are horizontal bands, physical at the bottom and
// services on top (the old site's layer stack). Within its band a node starts where a stable
// hash of its id puts it, then a fixed number of relaxation steps pushes apart stars whose
// labels would overlap. A node's optional `pos:` is taken as its local position and never
// moved. Deterministic: the same YAML gives the same sky.
import * as THREE from 'three';
import type { Layer, SceneContext, Topology, Vec3 } from './types';

export const LAYERS: Layer[] = ['physical', 'proxmox', 'kubernetes', 'services'];
const HALF_W = 1.4;
const HALF_H = 1.05;
// A label's footprint in local units (hostname over role, right of the star) at the reference
// 1080p framing; stars closer than this in both axes have overlapping labels.
const CELL_W = 0.5;
const CELL_H = 0.14;
const DEPTH = 0.12;

/** FNV-1a, 32-bit. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Three stable numbers in [0, 1) from an id. */
function unit3(id: string): Vec3 {
  let a = hash(id);
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return [next(), next(), next()];
}

export function layout(topology: Topology): Map<string, THREE.Vector3> {
  const counts = LAYERS.map((l) => topology.nodes.filter((n) => n.layer === l).length);
  const total = Math.max(1, counts.reduce((a, b) => a + b, 0));
  // Band heights in proportion to how many nodes a layer holds, with a floor so a lone node still has room.
  const weights = counts.map((c) => Math.max(c, 2));
  const sum = weights.reduce((a, b) => a + b, 0);
  const bands = new Map<Layer, [number, number]>();
  let y = -HALF_H;
  LAYERS.forEach((l, i) => {
    const h = (2 * HALF_H * weights[i]) / sum;
    bands.set(l, [y, y + h]);
    y += h;
  });

  const stars = topology.nodes.map((n) => {
    const [u, v, w] = unit3(n.id);
    const [lo, hi] = bands.get(n.layer)!;
    const p = n.pos
      ? new THREE.Vector3(...n.pos)
      : new THREE.Vector3(-HALF_W + u * 2 * HALF_W, lo + CELL_H / 2 + v * Math.max(0, hi - lo - CELL_H), (w - 0.5) * 2 * DEPTH);
    return { id: n.id, p, fixed: !!n.pos, lo, hi };
  });

  // Anisotropic relaxation: two labels overlap when |dx| < CELL_W and |dy| < CELL_H.
  for (let it = 0; it < 400 && total > 1; it++) {
    let moved = false;
    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        const a = stars[i], b = stars[j];
        const dx = (b.p.x - a.p.x) / CELL_W;
        const dy = (b.p.y - a.p.y) / CELL_H;
        const d = Math.hypot(dx, dy);
        if (d >= 1) continue;
        moved = true;
        // Coincident stars separate along x; YAML order makes every build separate them alike.
        const nx = d > 1e-6 ? dx / d : 1, ny = d > 1e-6 ? dy / d : 0;
        const push = 1 - d;
        const share = a.fixed || b.fixed ? (a.fixed && b.fixed ? 0 : 1) : 0.5;
        if (!a.fixed) (a.p.x -= nx * push * CELL_W * share), (a.p.y -= ny * push * CELL_H * share);
        if (!b.fixed) (b.p.x += nx * push * CELL_W * share), (b.p.y += ny * push * CELL_H * share);
      }
    }
    for (const s of stars) {
      if (s.fixed) continue;
      s.p.x = Math.min(HALF_W, Math.max(-HALF_W, s.p.x));
      s.p.y = Math.min(s.hi - CELL_H / 2, Math.max(s.lo + CELL_H / 2, s.p.y));
    }
    if (!moved) break;
  }
  return new Map(stars.map((s) => [s.id, s.p]));
}

const vertex = /* glsl */ `
  attribute vec3 tint;
  uniform float size;
  uniform float near;
  varying vec3 vColor;
  void main() {
    vColor = tint;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Full size at the framing distance; shrinks from afar so the lab doesn't read as one blob.
    gl_PointSize = size * clamp(near / -mv.z, 0.12, 1.0);
  }
`;
const fragment = /* glsl */ `
  varying vec3 vColor;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float core = smoothstep(0.34, 0.22, r);
    float halo = pow(max(0.0, 1.0 - r), 2.5) * 0.55;
    float a = core + halo;
    if (a < 0.003) discard;
    gl_FragColor = vec4(mix(vColor, vec3(1.0), core * 0.35) * a, 1.0);
    #include <colorspace_fragment>
  }
`;

export interface Constellation {
  group: THREE.Group;
  /** World position of each star, by node id, once the group is placed. */
  world(id: string, out: THREE.Vector3): THREE.Vector3;
  centre: THREE.Vector3;
  resize(dpr: number): void;
  /** Dim the links with camera distance, as the stars shrink, so from afar the lab is a faint figure. */
  fade(cameraDistance: number): void;
  dispose(): void;
}

/**
 * @param scale galaxy units per local unit
 * @param basis the camera basis the constellation faces (right, up, toward camera), in galaxy units
 * @param viewDistance the framing camera's distance; stars are full size at or inside it
 */
export function createConstellation(ctx: SceneContext, centre: THREE.Vector3, scale: number, basis: THREE.Matrix4, viewDistance: number): Constellation {
  const { topology } = ctx;
  const local = layout(topology);
  const n = topology.nodes.length;

  const positions = new Float32Array(n * 3);
  const colours = new Float32Array(n * 3);
  const tint = new Map(LAYERS.map((l) => [l, ctx.colour(`--layer-${l}`)]));
  topology.nodes.forEach((node, i) => {
    local.get(node.id)!.toArray(positions, i * 3);
    tint.get(node.layer)!.toArray(colours, i * 3);
  });

  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  starGeometry.setAttribute('tint', new THREE.BufferAttribute(colours, 3));
  const starMaterial = new THREE.ShaderMaterial({
    uniforms: { size: { value: 22 }, near: { value: viewDistance } },
    vertexShader: vertex,
    fragmentShader: fragment,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  const stars = new THREE.Points(starGeometry, starMaterial);
  stars.frustumCulled = false;
  stars.renderOrder = 3;

  const index = new Map(topology.nodes.map((node, i) => [node.id, i]));
  const segments = new Float32Array(topology.links.length * 6);
  topology.links.forEach((l, i) => {
    local.get(l.from)!.toArray(segments, i * 6);
    local.get(l.to)!.toArray(segments, i * 6 + 3);
  });
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.BufferAttribute(segments, 3));
  const lineMaterial = new THREE.LineBasicMaterial({
    color: ctx.colour('--link'),
    transparent: true,
    opacity: 0.32,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  lines.frustumCulled = false;
  lines.renderOrder = 2;

  const group = new THREE.Group();
  group.add(lines, stars);
  group.matrixAutoUpdate = false;
  group.matrix.copy(basis).scale(new THREE.Vector3(scale, scale, scale)).setPosition(centre);
  group.matrixWorldNeedsUpdate = true;

  return {
    group,
    centre,
    world(id, out) {
      return out.fromArray(positions, index.get(id)! * 3).applyMatrix4(group.matrix);
    },
    resize(dpr) {
      starMaterial.uniforms.size.value = 22 * dpr;
    },
    fade(cameraDistance) {
      lineMaterial.opacity = 0.32 * THREE.MathUtils.clamp(viewDistance / cameraDistance, 0.15, 1);
    },
    dispose() {
      starGeometry.dispose();
      starMaterial.dispose();
      lineGeometry.dispose();
      lineMaterial.dispose();
    },
  };
}
