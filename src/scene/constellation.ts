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
import { additive, SPIKES, vivid } from './jwst';
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

const HOVER_S = 0.15; // hover glow eases in and out over this
const SIZE = 110; // sprite CSS px at the framing distance; the core is a fraction, the rest is spikes

const vertex = /* glsl */ `
  attribute vec3 tint;
  attribute vec2 life; // twinkle phase 0..1, hover glow 0..1
  uniform float size;
  uniform float near;
  uniform float uTime;
  varying vec3 vColor;
  varying float vPx;
  varying float vHeat;
  varying float vNear;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Full size at the framing distance; shrinks from afar so the lab doesn't read as one blob.
    float k = clamp(near / -mv.z, 0.12, 1.0);
    float px = size * k * (1.0 + 0.3 * life.y);
    gl_PointSize = px;
    vPx = px * 0.5;
    vHeat = life.y;
    float twinkle = 1.0 + 0.13 * sin(uTime * (0.9 + 0.8 * life.x) + life.x * 40.0) * sin(uTime * 0.37 + life.x * 17.0);
    vColor = tint * twinkle;
    vNear = k;
  }
`;
const fragment = /* glsl */ `
  ${SPIKES}
  uniform float dpr;
  uniform float size;
  varying vec3 vColor;
  varying float vPx;
  varying float vHeat;
  varying float vNear;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    vec2 k = spikes(p, vPx, 0.55 + 0.3 * vHeat);
    float r = length(p) * size * 0.5 / dpr; // CSS px from the centre at full size: the core shrinks with the sprite
    // A soft core in the layer's colour under the PSF's white-hot centre, and a wider halo when hovered.
    float core = exp(-r * r / 12.0);
    float halo = exp(-r / (4.0 + 5.0 * vHeat)) * (0.22 + 0.55 * vHeat) * smoothstep(1.0, 0.6, length(p));
    vec3 c = vec3(1.0) * (k.x + core * 0.5) * (1.2 + 0.6 * vHeat) + vColor * (core * 1.3 + halo + k.y * (1.8 + 1.0 * vHeat));
    // From afar the lab is a faint figure, not a bright clump.
    float far = mix(0.25, 1.0, vNear * vNear);
    gl_FragColor = vec4(c * far * smoothstep(1.0, 0.8, length(p)), 1.0);
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
  /** Advance the twinkle and ease the hover glow toward `hot`. true while easing. */
  update(dt: number, hot: string | null): boolean;
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
  const life = new Float32Array(n * 2);
  const tint = new Map(LAYERS.map((l) => [l, vivid(ctx.colour(`--layer-${l}`), 2.4)]));
  topology.nodes.forEach((node, i) => {
    local.get(node.id)!.toArray(positions, i * 3);
    tint.get(node.layer)!.toArray(colours, i * 3);
    life[i * 2] = hash(node.id) / 4294967296;
  });

  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  starGeometry.setAttribute('tint', new THREE.BufferAttribute(colours, 3));
  const lifeAttribute = new THREE.BufferAttribute(life, 2);
  starGeometry.setAttribute('life', lifeAttribute);
  const uniforms = { size: { value: SIZE }, near: { value: viewDistance }, uTime: { value: 0 }, dpr: { value: 1 } };
  const starMaterial = new THREE.ShaderMaterial({ uniforms, vertexShader: vertex, fragmentShader: fragment, ...additive });
  const stars = new THREE.Points(starGeometry, starMaterial);
  stars.frustumCulled = false;
  stars.renderOrder = 3;

  // Links carry their brightness in their vertex colours: a hovered star lights the links it has.
  const index = new Map(topology.nodes.map((node, i) => [node.id, i]));
  const segments = new Float32Array(topology.links.length * 6);
  topology.links.forEach((l, i) => {
    local.get(l.from)!.toArray(segments, i * 6);
    local.get(l.to)!.toArray(segments, i * 6 + 3);
  });
  const link = vivid(ctx.colour('--link'), 1.6);
  const linkColours = new Float32Array(segments.length);
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.BufferAttribute(segments, 3));
  const linkAttribute = new THREE.BufferAttribute(linkColours, 3);
  lineGeometry.setAttribute('color', linkAttribute);
  const lineMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  lines.frustumCulled = false;
  lines.renderOrder = 2;

  const heat = new Float32Array(n);
  const paint = () => {
    topology.links.forEach((l, i) => {
      const k = 0.34 + 0.9 * Math.max(heat[index.get(l.from)!], heat[index.get(l.to)!]);
      for (let v = 0; v < 6; v += 3) {
        linkColours[i * 6 + v] = link.r * k;
        linkColours[i * 6 + v + 1] = link.g * k;
        linkColours[i * 6 + v + 2] = link.b * k;
      }
    });
    linkAttribute.needsUpdate = true;
    for (let i = 0; i < n; i++) life[i * 2 + 1] = heat[i];
    lifeAttribute.needsUpdate = true;
  };
  paint();

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
      uniforms.size.value = SIZE * dpr;
      uniforms.dpr.value = dpr;
    },
    fade(cameraDistance) {
      lineMaterial.opacity = THREE.MathUtils.clamp(viewDistance / cameraDistance, 0.15, 1);
    },
    update(dt, hot) {
      // Under reduced motion there are no ambient frames; the twinkle holds still rather than jump.
      if (!ctx.quality.reducedMotion) uniforms.uTime.value += dt;
      const target = hot === null ? -1 : index.get(hot) ?? -1;
      let easing = false;
      for (let i = 0; i < n; i++) {
        const to = i === target ? 1 : 0;
        if (heat[i] === to) continue;
        heat[i] = to > heat[i] ? Math.min(1, heat[i] + dt / HOVER_S) : Math.max(0, heat[i] - dt / HOVER_S);
        easing = true;
      }
      if (easing) paint();
      return easing;
    },
    dispose() {
      starGeometry.dispose();
      starMaterial.dispose();
      lineGeometry.dispose();
      lineMaterial.dispose();
    },
  };
}
