// The sky behind the landing essay: one asterism per chapter, joined by a faint line of travel.
// Built from the data alone — adding a chapter to topology.yaml adds a figure with no code change.
//
// M5: the stars used to be the homelab's hosts, laid out by band and pushed apart so their labels
// would not collide. The essay is the subject now and the sky is its backdrop, so the figures are
// authored rather than generated (a relaxation solver makes a scatter, not a shape) and nothing is
// labelled. The chapter in view is lit; the others fall back far enough to read as background but
// not so far that the journey disappears.
//
// Layout, in constellation-local units (x right, y up, z toward the viewer): each chapter's stars
// are [x, y] about its `at`, and z comes from a stable hash per star. That depth is load-bearing —
// at a plate's worth of it the whole thing projects flat and reads as a decal printed over the
// galaxy rather than as something standing in it.
import * as THREE from 'three';
import { additive, SPIKES, vivid } from './jwst';
import type { SceneContext, Topology } from './types';

const HALF_W = 1.4;
const HALF_H = 1.05;
const DEPTH = 0.62;
// How large a figure is drawn relative to the spacing between figures. Authored star coordinates
// keep a shape legible on their own; this is the one knob for how much sky each chapter takes.
const FIGURE = 1.35;
const DIM = 0.26; // how far an unread chapter falls back
const TRAVEL = 0.3; // the line of travel between figures, relative to a lit chapter's links
const LIT_S = 0.55; // a chapter lights and falls back over this
const CHAPTER_TOKENS = ['--chapter-1', '--chapter-2', '--chapter-3', '--chapter-4'];

/** FNV-1a, 32-bit. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Two stable numbers in [0, 1) from a key. */
function unit2(key: string): [number, number] {
  let a = hash(key);
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return [next(), next()];
}

/** Every star of every chapter, flattened, in constellation-local units. */
export function layout(topology: Topology): { chapter: number; id: string; p: THREE.Vector3 }[] {
  const out: { chapter: number; id: string; p: THREE.Vector3 }[] = [];
  topology.chapters.forEach((c, ci) => {
    c.stars.forEach(([x, y], i) => {
      const [w] = unit2(`${c.id}/${i}`);
      out.push({
        chapter: ci,
        id: c.id,
        p: new THREE.Vector3(
          THREE.MathUtils.clamp(c.at[0] + x * FIGURE, -HALF_W, HALF_W),
          THREE.MathUtils.clamp(c.at[1] + y * FIGURE, -HALF_H, HALF_H),
          (w - 0.5) * 2 * DEPTH,
        ),
      });
    });
  });
  return out;
}

// Stars give way (spec §3). The pointer is projected onto the constellation's own plane and
// repels stars there, in constellation-local units — not a screen-space shove, so the effect is
// the same size relative to the sky however the page is framed.
const PUSH_R = 0.22; // radius of the dent, local units
const PUSH_F = 0.55; // how hard the centre pushes
const SPRING = 34; // pull back to rest, rad/s
const DAMP = 0.86; // velocity kept per frame; under 1 so it settles rather than rings
const REST_EPS = 1e-4; // below this the star is home and stops asking for frames
// Breath: the whole sky inhales, slowly. Idle life that survives on touch and with the pointer
// off-window, which the repulsion above cannot. Ambient frames only.
const BREATH = 0.015; // fraction of scale
const BREATH_S = 11; // seconds per breath
const SIZE = 110; // sprite CSS px at the framing distance; the core is a fraction, the rest is spikes

const vertex = /* glsl */ `
  attribute vec3 tint;
  attribute vec2 life; // twinkle phase 0..1, how lit this star's chapter is 0..1
  attribute float mag; // relative brightness, from how many lines the star carries
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
    // Full size at the framing distance; shrinks from afar so the sky doesn't read as one blob.
    float k = clamp(near / -mv.z, 0.12, 1.0);
    float px = size * k * mag * (0.82 + 0.28 * life.y);
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
    // A soft core in the chapter's colour under the PSF's white-hot centre, and a wider halo when lit.
    float core = exp(-r * r / 12.0);
    float halo = exp(-r / (4.0 + 5.0 * vHeat)) * (0.22 + 0.55 * vHeat) * smoothstep(1.0, 0.6, length(p));
    vec3 c = vec3(1.0) * (k.x + core * 0.5) * (0.9 + 0.9 * vHeat) + vColor * (core * 1.3 + halo + k.y * (1.4 + 1.4 * vHeat));
    // From afar the sky is a faint figure, not a bright clump.
    float far = mix(0.25, 1.0, vNear * vNear);
    gl_FragColor = vec4(c * far * smoothstep(1.0, 0.8, length(p)), 1.0);
    #include <colorspace_fragment>
  }
`;

export interface Constellation {
  group: THREE.Group;
  centre: THREE.Vector3;
  resize(dpr: number): void;
  /** Dim the lines with camera distance, as the stars shrink, so from afar the sky is a faint figure. */
  fade(cameraDistance: number): void;
  /** Light one chapter's asterism and let the rest fall back. null lights them all evenly. */
  chapter(id: string | null): void;
  /** Advance the twinkle and ease the lit chapter. true while easing. */
  update(dt: number): boolean;
  /** Where the pointer meets the constellation's plane, in world space, or null when it leaves. */
  probe(point: THREE.Vector3 | null): void;
  dispose(): void;
}

/**
 * @param scale galaxy units per local unit
 * @param basis the orientation the figures stand in (right, up, back), in galaxy units
 * @param viewDistance the framing camera's distance; stars are full size at or inside it
 */
export function createConstellation(ctx: SceneContext, centre: THREE.Vector3, scale: number, basis: THREE.Matrix4, viewDistance: number): Constellation {
  const { topology } = ctx;
  const stars = layout(topology);
  const n = stars.length;
  const chapters = topology.chapters.length;

  const positions = new Float32Array(n * 3);
  const colours = new Float32Array(n * 3);
  const life = new Float32Array(n * 2);
  const mag = new Float32Array(n);
  const tint = topology.chapters.map((_, i) => vivid(ctx.colour(CHAPTER_TOKENS[i % CHAPTER_TOKENS.length]), 2.4));

  // A real field has a luminosity function; a diagram where every point is identical reads as a
  // diagram. The variation is the figure rather than noise: a star where several lines meet is the
  // brighter one, so what holds a shape together is what catches the eye.
  let base = 0;
  topology.chapters.forEach((c, ci) => {
    const degree = c.stars.map(() => 0);
    for (const [a, b] of c.lines) (degree[a]++, degree[b]++);
    const busiest = Math.max(1, ...degree);
    c.stars.forEach((_, i) => {
      const k = base + i;
      stars[k].p.toArray(positions, k * 3);
      tint[ci].toArray(colours, k * 3);
      life[k * 2] = hash(`${c.id}/${i}`) / 4294967296;
      mag[k] = 0.62 + 0.55 * Math.sqrt(degree[i] / busiest);
    });
    base += c.stars.length;
  });

  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  starGeometry.setAttribute('tint', new THREE.BufferAttribute(colours, 3));
  const lifeAttribute = new THREE.BufferAttribute(life, 2);
  starGeometry.setAttribute('life', lifeAttribute);
  starGeometry.setAttribute('mag', new THREE.BufferAttribute(mag, 1));
  const uniforms = { size: { value: SIZE }, near: { value: viewDistance }, uTime: { value: 0 }, dpr: { value: 1 } };
  const starMaterial = new THREE.ShaderMaterial({ uniforms, vertexShader: vertex, fragmentShader: fragment, ...additive });
  const points = new THREE.Points(starGeometry, starMaterial);
  points.frustumCulled = false;
  points.renderOrder = 3;

  // Lines: each chapter's own figure, then the travel between figures — from a chapter's first star
  // to the next chapter's. The journey is the essay's shape, so it is drawn, faintly.
  const offset: number[] = [];
  base = 0;
  for (const c of topology.chapters) (offset.push(base), (base += c.stars.length));
  const edges: { a: number; b: number; chapter: number; travel: boolean }[] = [];
  topology.chapters.forEach((c, ci) => {
    for (const [a, b] of c.lines) edges.push({ a: offset[ci] + a, b: offset[ci] + b, chapter: ci, travel: false });
    if (ci + 1 < chapters) edges.push({ a: offset[ci], b: offset[ci + 1], chapter: ci, travel: true });
  });
  const segments = new Float32Array(edges.length * 6);
  edges.forEach((e, i) => {
    stars[e.a].p.toArray(segments, i * 6);
    stars[e.b].p.toArray(segments, i * 6 + 3);
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

  // How lit each chapter is: 1 for the one being read, DIM for the rest, eased. A plain array, not
  // a Float32Array: the ease stops when a value reaches its target exactly, and a Float32Array
  // rounds the target on the way in — 0.26 stores as 0.2599999904632568, never equals the double it
  // came from, and the whole scene eases at full rate for ever.
  const heat = new Array<number>(chapters).fill(1);
  const paint = () => {
    edges.forEach((e, i) => {
      const k = e.travel
        ? TRAVEL * Math.max(heat[e.chapter], heat[e.chapter + 1])
        : 0.34 + 0.9 * heat[e.chapter];
      for (let v = 0; v < 6; v += 3) {
        linkColours[i * 6 + v] = link.r * k;
        linkColours[i * 6 + v + 1] = link.g * k;
        linkColours[i * 6 + v + 2] = link.b * k;
      }
    });
    linkAttribute.needsUpdate = true;
    for (let i = 0; i < n; i++) life[i * 2 + 1] = heat[stars[i].chapter];
    lifeAttribute.needsUpdate = true;
  };
  paint();

  const group = new THREE.Group();
  group.add(lines, points);
  group.matrixAutoUpdate = false;
  const compose = (breath: number) => {
    group.matrix.copy(basis).scale(new THREE.Vector3(scale, scale, scale).multiplyScalar(breath)).setPosition(centre);
    group.matrixWorldNeedsUpdate = true;
  };
  compose(1);

  // Rest positions; `positions` is what gets drawn, so the lines follow a pushed star.
  const rest = positions.slice();
  const velocity = new Float32Array(n * 3);
  const starAttribute = starGeometry.getAttribute('position') as THREE.BufferAttribute;
  const toLocal = new THREE.Matrix4();
  const at = new THREE.Vector3();
  // Copied, never aliased: the tier hands us a scratch vector it reuses every frame.
  const probe = new THREE.Vector3();
  let probing = false;
  let settled = true; // every star is at rest and nothing needs a frame
  let breath = 0; // seconds, only advanced on rendered frames
  let reading: number | null = null; // index of the chapter in view

  /** Move the lines to wherever their stars actually are. */
  const restring = () => {
    edges.forEach((e, i) => {
      for (let v = 0; v < 3; v++) {
        segments[i * 6 + v] = positions[e.a * 3 + v];
        segments[i * 6 + 3 + v] = positions[e.b * 3 + v];
      }
    });
    lineGeometry.getAttribute('position').needsUpdate = true;
  };

  return {
    group,
    centre,
    resize(dpr) {
      uniforms.size.value = SIZE * dpr;
      uniforms.dpr.value = dpr;
    },
    fade(cameraDistance) {
      lineMaterial.opacity = THREE.MathUtils.clamp(viewDistance / cameraDistance, 0.15, 1);
    },
    chapter(id) {
      const next = id === null ? null : topology.chapters.findIndex((c) => c.id === id);
      reading = next === -1 ? null : next;
      // Reduced motion gets the state, not the ease: the same rule the stills follow.
      if (ctx.quality.reducedMotion) {
        for (let i = 0; i < chapters; i++) heat[i] = reading === null || reading === i ? 1 : DIM;
        paint();
      }
      ctx.invalidate();
    },
    probe(point) {
      // Only a *changed* pointer needs frames. A pointer resting over the scene with every star
      // home is as idle as no pointer at all, and must not hold the loop awake.
      if (!point) {
        if (probing) settled = false;
        probing = false;
        return;
      }
      if (!probing || !probe.equals(point)) settled = false;
      probing = true;
      probe.copy(point);
    },
    update(dt) {
      // Under reduced motion there are no ambient frames; the twinkle holds still rather than jump.
      if (!ctx.quality.reducedMotion) {
        uniforms.uTime.value += dt;
        breath += dt;
        compose(1 + BREATH * Math.sin((2 * Math.PI * breath) / BREATH_S));
      }

      let easing = false;
      if (!ctx.quality.reducedMotion) {
        for (let i = 0; i < chapters; i++) {
          const to = reading === null || reading === i ? 1 : DIM;
          if (heat[i] === to) continue;
          heat[i] = to > heat[i] ? Math.min(to, heat[i] + dt / LIT_S) : Math.max(to, heat[i] - dt / LIT_S);
          easing = true;
        }
        if (easing) paint();
      }

      // Stars give way, then spring home. Skipped entirely once everything is at rest, so an idle
      // sky costs nothing beyond the breath above.
      if (!ctx.quality.reducedMotion && !settled) {
        if (probing) at.copy(probe).applyMatrix4(toLocal.copy(group.matrix).invert());
        let moving = false;
        for (let i = 0; i < n; i++) {
          const o = i * 3;
          let [fx, fy, fz] = [0, 0, 0];
          if (probing) {
            const dx = positions[o] - at.x, dy = positions[o + 1] - at.y, dz = positions[o + 2] - at.z;
            const d = Math.hypot(dx, dy, dz);
            if (d < PUSH_R) {
              // Falls off smoothly to nothing at the rim, so a star never snaps as the pointer passes.
              const k = (PUSH_F * (1 - d / PUSH_R) ** 2) / Math.max(d, PUSH_R / 8);
              (fx = dx * k), (fy = dy * k), (fz = dz * k);
            }
          }
          for (let v = 0; v < 3; v++) {
            const j = o + v;
            const home = rest[j] - positions[j];
            velocity[j] = (velocity[j] + ([fx, fy, fz][v] + home * SPRING) * dt) * DAMP;
            positions[j] += velocity[j] * dt;
            if (Math.abs(positions[j] - rest[j]) > REST_EPS || Math.abs(velocity[j]) > REST_EPS) moving = true;
            else (positions[j] = rest[j]), (velocity[j] = 0);
          }
        }
        starAttribute.needsUpdate = true;
        restring();
        settled = !moving;
        if (moving) easing = true;
      }
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
