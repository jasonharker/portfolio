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

/** Screen-like blending: light accumulates but tops out, so dense regions don't run away into bloom. */
export const additive = {
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcColorFactor,
  blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  depthTest: false, depthWrite: false, transparent: true,
} as const;

/**
 * JWST's point-spread function, in a point sprite: six long spikes from the hexagonal primary
 * (one vertical pair, two pairs at ±30° from horizontal) and two short horizontal ones from the
 * secondary's struts, over a core and a faint halo. Screen-aligned, as the instrument's are.
 * spikes(p, px, reach): p in [-1, 1] across the sprite, px its half-size in drawing-buffer pixels,
 * reach 0..1 how far the spikes extend. Returns (core, spikes).
 */
export const SPIKES = /* glsl */ `
  float spikeArm(vec2 p, vec2 d, float len, float w) {
    float along = abs(dot(p, d));
    float across = abs(p.x * d.y - p.y * d.x);
    float fall = pow(max(0.0, 1.0 - along / len), 2.0) / (1.0 + 14.0 * along / len);
    return exp(-across * across / (w * w)) * fall;
  }
  vec2 spikes(vec2 p, float px, float reach) {
    float w = 1.0 / px; // ~1 px either side of the spike's axis
    float len = max(reach, 0.001);
    float s = spikeArm(p, vec2(0.0, 1.0), len, w)
            + spikeArm(p, vec2(0.8660254, 0.5), len, w)
            + spikeArm(p, vec2(0.8660254, -0.5), len, w)
            + 0.55 * spikeArm(p, vec2(1.0, 0.0), 0.4 * len, w * 0.8);
    float r = length(p) * px; // pixels
    s *= 0.82 + 0.18 * cos(r * 0.8); // the beading along real spikes
    float core = exp(-r * r / 5.0) + 0.1 * exp(-r / 5.0);
    return vec2(core, s);
  }
`;

const skyVertex = /* glsl */ `
  // Direction-only: the point sits at infinity, pinned to the far plane.
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
  attribute vec4 shape; // css px, axis ratio, angle, kind (0 elliptical, 1 spiral, 2 clumpy)
  attribute vec4 tint; // rgb, brightness
  uniform float uDpr;
  varying vec4 vShape;
  varying vec3 vColor;
  void main() {
    gl_Position = skyPosition(position);
    float px = shape.x * uDpr * zoom();
    gl_PointSize = max(px, 1.5);
    vShape = vec4(px, shape.yzw);
    vColor = tint.rgb * tint.a * min(1.0, px * px / 2.25);
  }
`;
const fieldFragment = /* glsl */ `
  uniform float uGain;
  varying vec4 vShape;
  varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float c = cos(vShape.z), s = sin(vShape.z);
    p = mat2(c, -s, s, c) * p;
    p.y /= vShape.y;
    float r = length(p);
    if (r > 1.0) discard;
    float I;
    if (vShape.w < 0.5) I = exp(-6.0 * sqrt(r)) * 2.0;
    else if (vShape.w < 1.5) I = exp(-4.5 * r) * (0.6 + 0.4 * cos(2.0 * atan(p.y, p.x) - 9.0 * r)) + 1.5 * exp(-80.0 * r * r);
    else I = exp(-3.5 * r) * (0.55 + 0.45 * sin(p.x * 11.0 + vShape.z * 7.0) * sin(p.y * 9.0));
    // Unresolved galaxies are just a soft dot.
    I = mix(exp(-3.0 * r * r), I, smoothstep(2.5, 7.0, vShape.x));
    gl_FragColor = vec4(vColor * I * smoothstep(1.0, 0.7, r) * uGain, 1.0);
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
    float tw = 1.0 + 0.1 * sin(uTime * (0.7 + phase) + phase * 40.0);
    float px = (14.0 + 110.0 * tint.a * tint.a) * uDpr * tw;
    gl_PointSize = px;
    vPx = px * 0.5;
    vReach = 0.6 + 0.4 * tint.a;
    vColor = tint.rgb * (0.5 + 0.5 * tint.a) * tw;
  }
`;
const foregroundFragment = /* glsl */ `
  ${SPIKES}
  uniform float uGain;
  varying vec3 vColor;
  varying float vPx;
  varying float vReach;
  void main() {
    vec2 k = spikes(gl_PointCoord * 2.0 - 1.0, vPx, vReach);
    vec3 c = mix(vColor, vec3(1.0), 0.55) * k.x * 1.4 + vColor * k.y * 0.8;
    gl_FragColor = vec4(c * uGain, 1.0);
    #include <colorspace_fragment>
  }
`;

// Background galaxies: mostly small and red (distant, redshifted), some yellow-white ellipticals,
// a few larger blue-white spirals. False colour, as in a NIRCam deep field.
const FIELD_COLOURS: [number, number, number][] = [
  [1.0, 0.36, 0.2], [1.0, 0.55, 0.3], [1.0, 0.78, 0.5], [1.0, 0.92, 0.8], [0.72, 0.82, 1.0], [1.0, 0.55, 0.72],
];

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

/** Deep field and foreground stars, seeded from the one galaxy SEED so every tier sees the same sky. */
export function createSky(fieldCount: number, foregroundCount: number, dpr: number, colour: (token: string) => THREE.Color): Sky {
  const rand = prng(SEED ^ 0x5eed);

  const fieldPos: number[] = [], shape: number[] = [], fieldTint: number[] = [];
  for (let i = 0; i < fieldCount; i++) {
    direction(rand, fieldPos, i * 3);
    const big = rand() < 0.006;
    const size = big ? 12 + 16 * rand() : 1.6 + 8 * Math.pow(rand(), 4);
    const edgeOn = rand() < 0.18;
    const kind = size < 5 ? 0 : rand() < 0.6 ? 1 : rand() < 0.7 ? 0 : 2;
    shape.push(size, edgeOn ? 0.15 + 0.15 * rand() : 0.45 + 0.55 * rand(), rand() * Math.PI, kind);
    // Small ones redder; big ones whiter and bluer.
    const pick = size < 4 ? Math.floor(rand() * rand() * 4) : 2 + Math.floor(rand() * 4);
    const c = FIELD_COLOURS[Math.min(pick, FIELD_COLOURS.length - 1)];
    fieldTint.push(...c, 0.3 + 0.7 * Math.pow(rand(), 2));
  }
  const fieldGeometry = new THREE.BufferGeometry();
  fieldGeometry.setAttribute('position', new THREE.Float32BufferAttribute(fieldPos, 3));
  fieldGeometry.setAttribute('shape', new THREE.Float32BufferAttribute(shape, 4));
  fieldGeometry.setAttribute('tint', new THREE.Float32BufferAttribute(fieldTint, 4));
  const fieldUniforms = { uDpr: { value: dpr }, uGain: { value: 1 } };
  const fieldMaterial = new THREE.ShaderMaterial({ vertexShader: fieldVertex, fragmentShader: fieldFragment, uniforms: fieldUniforms, ...additive });
  const field = new THREE.Points(fieldGeometry, fieldMaterial);

  // Foreground stars: the brightest things in any frame, blackbody-tinted from the tokens.
  const kelvins = [3000, 4300, 5600, 8500, 12000, 30000];
  const fgPos: number[] = [], fgTint: number[] = [], phase: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i < foregroundCount; i++) {
    direction(rand, fgPos, i * 3);
    vivid(c.copy(colour(`--star-${kelvins[Math.floor(rand() * kelvins.length)]}`)), 1.8);
    fgTint.push(c.r, c.g, c.b, 0.25 + 0.75 * Math.pow(rand(), 1.5));
    phase.push(rand());
  }
  const fgGeometry = new THREE.BufferGeometry();
  fgGeometry.setAttribute('position', new THREE.Float32BufferAttribute(fgPos, 3));
  fgGeometry.setAttribute('tint', new THREE.Float32BufferAttribute(fgTint, 4));
  fgGeometry.setAttribute('phase', new THREE.Float32BufferAttribute(phase, 1));
  const fgUniforms = { uDpr: { value: dpr }, uGain: { value: 1 }, uTime: { value: 0 } };
  const fgMaterial = new THREE.ShaderMaterial({ vertexShader: foregroundVertex, fragmentShader: foregroundFragment, uniforms: fgUniforms, ...additive });
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
