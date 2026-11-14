// The JWST look, shared by both tiers: the false-colour palette, diffraction spikes, and the sky
// beyond the galaxy (a deep field of small galaxies, and a few foreground stars).
//
// Colour. Star and layer tints still come from tokens.css; the scene pushes their chroma (vivid())
// so hot stars read blue, sun-like ones white and cool ones orange-red, as in a NIRCam composite.
// The tokens themselves are held at one lightness for text, which is right for the UI and too
// pastel for a false-colour photo. Dust, HII and background-galaxy colours are instrument false
// colour, not blackbody, so they are constants here and in dust.ts rather than tokens.
//
// The sky is direction-only: at infinity it has the same angular size in every tier and no parallax,
// which is what keeps it true to scale from the whole disc down to one arm segment.
import * as THREE from 'three';
import { prng, SEED } from './galaxy-model';

/** Scale a colour's chroma about its luminance, in linear RGB. */
export function vivid(c: THREE.Color, amount: number): THREE.Color {
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return c.setRGB(...([c.r, c.g, c.b].map((v) => Math.max(0, l + (v - l) * amount)) as [number, number, number]));
}

/** Token kelvins in tokens.css; the values themselves are read from CSS. */
export const KELVINS = [3000, 4300, 5600, 6800, 8500, 12000, 30000];

/** Colour for a temperature: log-interpolated between the blackbody tokens, chroma pushed. */
export function palette(colour: (token: string) => THREE.Color) {
  const stops = KELVINS.map((k) => ({ lk: Math.log(k), c: vivid(colour(`--star-${k}`), 2.4) }));
  return (t: number, out: THREE.Color) => {
    const lt = Math.log(t);
    let i = 0;
    while (i < stops.length - 2 && lt > stops[i + 1].lk) i++;
    const f = THREE.MathUtils.clamp((lt - stops[i].lk) / (stops[i + 1].lk - stops[i].lk), 0, 1);
    return out.lerpColors(stops[i].c, stops[i + 1].c, f);
  };
}

/** Screen-like blending: light accumulates but tops out, so dense regions don't run away into bloom. */
export const additive = {
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcColorFactor,
  blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  depthTest: false, depthWrite: false, transparent: true,
} as const;

/**
 * JWST's point-spread function, in a point sprite: six long spikes from the hexagonal primary
 * (one vertical pair, two pairs at ±30° from horizontal) and two short, faint horizontal ones from
 * the secondary's vertical strut, over a core and a halo. Screen-aligned, as the instrument's are.
 * spikes(p, px, reach): p in [-1, 1] across the sprite, px its half-size in drawing-buffer pixels,
 * reach 0..1 how far the spikes extend. Returns (core, spikes).
 * spikesRGB does the same per channel. The PSF scales with wavelength, so red spikes and halo reach
 * further and the beads along a spike fall at different radii per channel: the colour fringing on
 * NIRCam spikes, white at the core and splitting into colour outward. Three times the cost.
 */
export const SPIKES = /* glsl */ `
  float spikeArm(vec2 p, vec2 d, float len, float w) {
    float t = abs(dot(p, d)) / len;
    float across = abs(p.x * d.y - p.y * d.x);
    // Bright at the core, a long faint tail, tapering out rather than stopping.
    float fall = pow(max(0.0, 1.0 - t), 1.5) / (1.0 + 9.0 * t);
    return exp(-across * across / (w * w)) * fall;
  }
  vec2 spikes(vec2 p, float px, float reach) {
    float w = 1.0 / px; // ~1 px either side of the spike's axis
    float len = max(reach, 0.001);
    float s = spikeArm(p, vec2(0.0, 1.0), len, w)
            + spikeArm(p, vec2(0.8660254, 0.5), len, w)
            + spikeArm(p, vec2(0.8660254, -0.5), len, w)
            + 0.5 * spikeArm(p, vec2(1.0, 0.0), 0.45 * len, w * 0.8);
    float r = length(p) * px; // pixels
    s *= 0.7 + 0.3 * cos(r * 0.8); // the beading along real spikes
    // A sharp peak and a halo that widens with the star.
    float q = length(p);
    float core = exp(-r * r / 5.0) + 0.12 * exp(-q / (0.05 + 0.1 * reach)) * smoothstep(1.0, 0.6, q);
    return vec2(core, s);
  }
  void spikesRGB(vec2 p, float px, float reach, out vec3 core, out vec3 spike) {
    vec2 r = spikes(p * 0.87, px, reach), g = spikes(p, px, reach), b = spikes(p * 1.13, px, reach);
    core = vec3(r.x, g.x, b.x);
    spike = vec3(r.y, g.y, b.y);
  }
`;

const skyVertex = /* glsl */ `
  // Direction-only: the point sits at infinity, pinned to the far plane — and depth-tested there,
  // so anything in the scene occludes it. Without that the sky draws over the hull it is behind and
  // the ship reads as transparent.
  vec4 skyPosition(vec3 dir) {
    vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * dir, 1.0);
    clip.z = clip.w * 0.9999;
    return clip;
  }
  // Angular size is fixed; a wider lens (a flight's whoosh) makes it smaller on screen.
  float zoom() { return projectionMatrix[1][1] / 2.1445; } // 1/tan(25°), the tiers' 50° lens
`;

const fieldVertex = /* glsl */ `
  ${skyVertex}
  // css px, axis ratio (negative mirrors a spiral) or an arc's bend, angle or an arc's seed,
  // kind (0 elliptical, 1 spiral, 2 clumpy, 4 lensed arc)
  attribute vec4 shape;
  attribute vec4 tint; // rgb, brightness
  attribute vec3 lens; // an arc's cluster centre
  uniform float uDpr;
  varying vec4 vShape;
  varying vec3 vColor;
  varying float vAngle;
  void main() {
    gl_Position = skyPosition(position);
    float px = shape.x * uDpr * zoom();
    gl_PointSize = max(px, 1.5);
    vShape = vec4(px, shape.yzw);
    vAngle = shape.z;
    if (shape.w > 3.5) {
      // An arc lies tangent to its cluster: turn the sprite's y axis toward the centre on screen.
      vec4 c = skyPosition(lens);
      vec2 d = c.xy / c.w - gl_Position.xy / gl_Position.w;
      vAngle = atan(d.y, d.x * projectionMatrix[1][1] / projectionMatrix[0][0]) - 1.5707963;
    }
    vColor = tint.rgb * tint.a * min(1.0, px * px / 2.25);
  }
`;
const fieldFragment = /* glsl */ `
  uniform float uGain;
  varying vec4 vShape;
  varying vec3 vColor;
  varying float vAngle;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    p.y = -p.y;
    float c = cos(vAngle), s = sin(vAngle);
    p = mat2(c, -s, s, c) * p;
    vec3 col = vColor;
    float I;
    if (vShape.w > 3.5) {
      // Lensed arc: a thin, knotted crescent whose ends bend toward the cluster.
      float y = (p.y - vShape.y * (p.x * p.x - 0.5)) * vShape.x * 0.55;
      I = exp(-y * y) * exp(-pow(abs(p.x) / 0.8, 4.0)) * (0.7 + 0.3 * sin(p.x * 6.0 + vShape.z)) * 1.3;
    } else {
      float ratio = abs(vShape.y);
      p.y /= vShape.y;
      float r = length(p);
      if (r > 1.0) discard;
      if (vShape.w < 0.5) I = exp(-6.0 * sqrt(r)) * 2.0;
      else if (vShape.w < 1.5) {
        // Two logarithmic arms on an exponential disc, which fade edge-on; a warm bulge.
        float arms = 0.5 + 0.5 * cos(2.0 * atan(p.y, p.x) - 6.0 * log(r + 0.08));
        float bulge = 1.3 * exp(-50.0 * r * r);
        I = exp(-4.0 * r) * mix(1.0, 0.25 + 1.2 * arms * arms, smoothstep(0.3, 0.55, ratio)) + bulge;
        col = mix(col, vec3(1.0, 0.8, 0.52) * dot(col, vec3(0.3333)), bulge / I);
      }
      else {
        // Clumpy star-forming galaxy: a few bright knots in a faint, lopsided glow.
        I = 0.6 * exp(-5.0 * length(p - 0.25 * vec2(sin(vShape.z * 5.0), cos(vShape.z * 3.0))));
        for (int i = 1; i <= 4; i++) {
          float f = float(i) * vShape.z;
          vec2 d = p - 0.6 * vec2(sin(f * 2.3), cos(f * 3.7)) * fract(f * 0.618);
          I += exp(-dot(d, d) * 90.0) / float(i);
        }
      }
      // Unresolved galaxies are just a soft smudge.
      I = mix(exp(-3.0 * r * r), I, smoothstep(2.5, 7.0, vShape.x)) * smoothstep(1.0, 0.7, r);
    }
    gl_FragColor = vec4(col * I * uGain, 1.0);
    #include <colorspace_fragment>
  }
`;

const foregroundVertex = /* glsl */ `
  ${skyVertex}
  attribute vec4 tint; // rgb, brightness 0..1
  attribute float phase;
  uniform float uDpr;
  uniform float uTime;
  varying vec3 vColor;
  varying float vPx;
  varying float vReach;
  void main() {
    gl_Position = skyPosition(position);
    // A faint shimmer in brightness only; the PSF itself is fixed.
    float tw = 1.0 + 0.06 * sin(uTime * (0.7 + phase) + phase * 40.0) + 0.03 * sin(uTime * (2.3 - phase) + phase * 17.0);
    float px = (14.0 + 110.0 * tint.a * tint.a) * uDpr * zoom();
    gl_PointSize = px;
    vPx = px * 0.5;
    vReach = 0.6 + 0.4 * tint.a;
    // Faint stars stay below bloom so their spikes still read; only the brightest saturate.
    vColor = tint.rgb * (0.25 + 0.75 * tint.a * tint.a) * tw;
  }
`;
const foregroundFragment = /* glsl */ `
  ${SPIKES}
  uniform float uGain;
  varying vec3 vColor;
  varying float vPx;
  varying float vReach;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    vec3 core, spike;
    spikesRGB(p, vPx, vReach, core, spike);
    vec3 white = vec3(max(vColor.r, max(vColor.g, vColor.b)));
    vec3 c = mix(vColor, white, 0.55) * core * 1.4 + mix(vColor, white, 0.25) * spike * 0.8;
    gl_FragColor = vec4(c * uGain * smoothstep(1.0, 0.9, max(abs(p.x), abs(p.y))), 1.0);
    #include <colorspace_fragment>
  }
`;

// Instrument false colour, as in a NIRCam deep field: distant galaxies small and red (redshifted),
// ellipticals yellow-white, star-forming spirals and clumps blue-white.
const RED = [1.0, 0.3, 0.16], ORANGE = [1.0, 0.5, 0.26], AMBER = [1.0, 0.7, 0.42], CREAM = [1.0, 0.86, 0.68];
const WHITE = [0.92, 0.94, 1.0], BLUE = [0.66, 0.8, 1.0], PINK = [1.0, 0.5, 0.68];
/** css px per radian at the tiers' 50° lens on a 1080 px viewport: sky sizes and separations share it. */
const PX_PER_RAD = 540 / Math.tan(THREE.MathUtils.degToRad(25));

function direction(rand: () => number, out: number[], i: number) {
  const z = rand() * 2 - 1;
  const a = rand() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  out[i] = s * Math.cos(a);
  out[i + 1] = z;
  out[i + 2] = s * Math.sin(a);
}

export interface Sky {
  group: THREE.Group;
  /** Brightness of the whole sky: the deep field is faint behind a bright disc. */
  gain(field: number, foreground: number): void;
  update(dt: number): void;
  dispose(): void;
}

// Every tier sees the same sky, so they share its geometry: the second tier to load only adds its own
// materials. A tier that disposes its sky frees the buffers under the other, which three re-uploads.
let shared: { key: string; fieldGeometry: THREE.BufferGeometry; fgGeometry: THREE.BufferGeometry } | undefined;

function skyGeometry(fieldCount: number, foregroundCount: number, colour: (token: string) => THREE.Color) {
  const key = `${fieldCount}/${foregroundCount}`;
  if (shared?.key === key) return shared;
  const rand = prng(SEED ^ 0x5eed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

  const fieldPos: number[] = [], shape: number[] = [], fieldTint: number[] = [], lens: number[] = [];
  const add = (dir: THREE.Vector3, s: number[], c: number[], brightness: number, centre?: THREE.Vector3) => {
    fieldPos.push(dir.x, dir.y, dir.z);
    shape.push(...s);
    fieldTint.push(...c, brightness);
    lens.push(...(centre ? [centre.x, centre.y, centre.z] : [0, 0, 0]));
  };
  const dir = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3(), d: number[] = [];

  // A few rich clusters: a knot of yellow-white ellipticals round a bright central one in a faint
  // intracluster glow, with background galaxies lensed into arcs around them, as in SMACS 0723.
  const clusters = Math.round(fieldCount / 900);
  for (let k = 0; k < clusters; k++) {
    direction(rand, d, 0);
    const centre = new THREE.Vector3(...d);
    u.set(0, 1, 0).cross(centre).normalize();
    v.crossVectors(centre, u);
    const at = (r: number, a: number) => dir.copy(centre).addScaledVector(u, (r * Math.cos(a)) / PX_PER_RAD).addScaledVector(v, (r * Math.sin(a)) / PX_PER_RAD).normalize();
    add(centre, [80 + 30 * rand(), 0.6 + 0.3 * rand(), rand() * Math.PI, 0], CREAM, 0.1);
    add(centre, [16 + 8 * rand(), 0.7 + 0.3 * rand(), rand() * Math.PI, 0], CREAM, 0.9);
    const members = 12 + Math.floor(14 * rand());
    for (let i = 0; i < members; i++) {
      add(at(55 * Math.pow(rand(), 1.3), rand() * Math.PI * 2), [5 + 10 * Math.pow(rand(), 2), 0.55 + 0.45 * rand(), rand() * Math.PI, 0], rand() < 0.7 ? CREAM : AMBER, 0.35 + 0.5 * rand());
    }
    const arcs = 2 + Math.floor(3 * rand());
    for (let i = 0; i < arcs; i++) {
      const r = 30 + 30 * rand(), size = 10 + 16 * rand();
      add(at(r, rand() * Math.PI * 2), [size, size / (4 * r), rand() * 6.28, 4], rand() < 0.6 ? pick([ORANGE, RED]) : BLUE, 0.35 + 0.35 * rand(), centre);
    }
  }

  // The field: mostly small red smudges, some ellipticals, a few resolved spirals and edge-on discs.
  while (fieldPos.length < fieldCount * 3) {
    direction(rand, d, 0);
    dir.set(d[0], d[1], d[2]);
    const roll = rand();
    const edgeOn = rand() < 0.16;
    const ratio = edgeOn ? 0.12 + 0.16 * rand() : 0.4 + 0.6 * rand();
    if (roll < 60 / fieldCount) {
      const kind = rand() < 0.55 ? 1 : rand() < 0.65 ? 0 : 2;
      add(dir, [12 + 18 * rand(), kind === 1 && rand() < 0.5 ? -ratio : ratio, rand() * Math.PI, kind], kind === 0 ? CREAM : kind === 1 ? pick([WHITE, BLUE]) : pick([BLUE, PINK]), 0.5 + 0.4 * rand());
    } else if (roll < 0.07) {
      const kind = rand() < 0.4 ? 1 : rand() < 0.6 ? 0 : 2;
      add(dir, [5 + 7 * rand(), ratio, rand() * Math.PI, kind], kind === 0 ? pick([CREAM, AMBER]) : pick([WHITE, BLUE, AMBER, PINK]), 0.35 + 0.5 * rand());
    } else {
      add(dir, [2.6 + 3.4 * Math.pow(rand(), 2), ratio, rand() * Math.PI, 0], rand() < 0.8 ? pick([RED, RED, ORANGE, AMBER]) : pick([WHITE, BLUE]), 0.3 + 0.7 * Math.pow(rand(), 1.5));
    }
  }
  const fieldGeometry = new THREE.BufferGeometry();
  fieldGeometry.setAttribute('position', new THREE.Float32BufferAttribute(fieldPos, 3));
  fieldGeometry.setAttribute('shape', new THREE.Float32BufferAttribute(shape, 4));
  fieldGeometry.setAttribute('tint', new THREE.Float32BufferAttribute(fieldTint, 4));
  fieldGeometry.setAttribute('lens', new THREE.Float32BufferAttribute(lens, 3));

  // Foreground stars: the brightest things in any frame, blackbody-tinted from the tokens. Mostly
  // hot: beside the redshifted galaxies a Milky Way star reads blue-white in NIRCam colour.
  const kelvins = [4300, 5600, 8500, 12000, 12000, 30000];
  const starRand = prng(SEED ^ 0x57a5);
  const fgPos: number[] = [], fgTint: number[] = [], phase: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i < foregroundCount; i++) {
    direction(starRand, fgPos, i * 3);
    vivid(c.copy(colour(`--star-${kelvins[Math.floor(starRand() * kelvins.length)]}`)), 1.8);
    fgTint.push(c.r, c.g, c.b, 0.25 + 0.75 * Math.pow(starRand(), 1.5));
    phase.push(starRand());
  }
  const fgGeometry = new THREE.BufferGeometry();
  fgGeometry.setAttribute('position', new THREE.Float32BufferAttribute(fgPos, 3));
  fgGeometry.setAttribute('tint', new THREE.Float32BufferAttribute(fgTint, 4));
  fgGeometry.setAttribute('phase', new THREE.Float32BufferAttribute(phase, 1));
  return (shared = { key, fieldGeometry, fgGeometry });
}

/** Deep field and foreground stars, seeded from the one galaxy SEED so every tier sees the same sky. */
export function createSky(fieldCount: number, foregroundCount: number, dpr: number, colour: (token: string) => THREE.Color): Sky {
  const { fieldGeometry, fgGeometry } = skyGeometry(fieldCount, foregroundCount, colour);
  const fieldUniforms = { uDpr: { value: dpr }, uGain: { value: 1 } };
  const fieldMaterial = new THREE.ShaderMaterial({ vertexShader: fieldVertex, fragmentShader: fieldFragment, uniforms: fieldUniforms, ...additive , depthTest: true });
  const field = new THREE.Points(fieldGeometry, fieldMaterial);
  const fgUniforms = { uDpr: { value: dpr }, uGain: { value: 1 }, uTime: { value: 0 } };
  const fgMaterial = new THREE.ShaderMaterial({ vertexShader: foregroundVertex, fragmentShader: foregroundFragment, uniforms: fgUniforms, ...additive , depthTest: true });
  const foreground = new THREE.Points(fgGeometry, fgMaterial);

  const group = new THREE.Group();
  for (const p of [field, foreground]) (p.frustumCulled = false), group.add(p);
  field.renderOrder = -2;
  foreground.renderOrder = 10;

  return {
    group,
    gain(f, g) {
      fieldUniforms.uGain.value = f;
      fgUniforms.uGain.value = g;
    },
    update(dt) {
      fgUniforms.uTime.value += dt;
    },
    dispose() {
      for (const d of [fieldGeometry, fieldMaterial, fgGeometry, fgMaterial]) d.dispose();
    },
  };
}
