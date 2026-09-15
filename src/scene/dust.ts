// The disc's interstellar medium, one shader for both tiers: diffuse starlight, dust and HII regions,
// evaluated in galaxy units on the disc plane. Because the field lives in kpc, not screen space, the
// Region tier sees the same filaments the Galaxy tier does, only closer; finer octaves fade in with
// fwidth, so each tier resolves what its scale allows and the average brightness stays put.
//
// Look (a false-colour composite, so constants, not tokens): at `look` 0 (Galaxy, the MIRI view of
// M74) the dust glows orange-red along the arms and hollow bubbles open around star-forming knots;
// at `look` 1 (Region, a PHANGS crop) the same dust mostly absorbs, as dark lanes over the
// starlight, and the knots show as pink HII regions with teal fringes.
//
// Cost: full-screen noise, so it renders into its own target at quality.dustScale of CSS pixels and
// is composited with one full-screen triangle: rgb adds, alpha absorbs whatever was drawn before it.
import * as THREE from 'three';
import { DISC_RADIUS, type GalaxyModel } from './galaxy-model';

const SAMPLES = 48; // arm-angle samples, log-spaced in r; one vec4 per sample, one arm per component
const R_MIN = 0.5;
const R_MAX = DISC_RADIUS + 1;

const vertex = /* glsl */ `
  varying vec2 vXZ;
  void main() {
    vXZ = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragment = /* glsl */ `
  #define PI 3.141592653589793
  uniform vec4 uAngles[SAMPLES];
  uniform float uAlong; // arc length along an arm per unit radius, sqrt(1 + 1/b²)
  uniform float uLook;
  uniform float uGain;
  varying vec2 vXZ;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }
  // Gradient noise, -1..1.
  float gnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = dot(hash22(i) * 2.0 - 1.0, f);
    float b = dot(hash22(i + vec2(1, 0)) * 2.0 - 1.0, f - vec2(1, 0));
    float c = dot(hash22(i + vec2(0, 1)) * 2.0 - 1.0, f - vec2(0, 1));
    float d = dot(hash22(i + vec2(1, 1)) * 2.0 - 1.0, f - vec2(1, 1));
    return 1.4 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  // Ridged fbm: thin bright filaments where the noise crosses zero. p in kpc·freq, px the pixel size
  // in the same units. An octave too fine for the pixel is replaced by its mean, so detail fades in
  // and out with scale without the average changing.
  float ridged(vec2 p, float px, int octaves) {
    float sum = 0.0, amp = 0.5, norm = 0.0;
    mat2 turn = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < octaves; i++) {
      float lod = 1.0 - smoothstep(0.18, 0.45, px);
      float n = 0.36;
      if (lod > 0.0) {
        n = 1.0 - abs(gnoise(p));
        n = mix(0.36, n * n, lod);
      }
      sum += amp * n;
      norm += amp;
      p = turn * p * 2.03 + 17.3;
      px *= 2.03;
      amp *= 0.56;
    }
    return sum / norm;
  }

  float armAngle(int arm, float r) {
    float f = clamp((log(max(r, R_MIN)) - log(R_MIN)) / (log(R_MAX) - log(R_MIN)), 0.0, 1.0) * float(SAMPLES - 1);
    int i = int(f);
    int j = min(i + 1, SAMPLES - 1);
    return mix(uAngles[i][arm], uAngles[j][arm], fract(f));
  }

  // Bubbles on a jittered grid of cell size \`cell\` kpc. Returns (distance to the nearest centre in
  // radii, its strength 0..1, a per-bubble hue 0..1). \`sf\`, the local star formation, decides how many
  // cells hold one.
  vec3 bubbles(vec2 p, float cell, float sf) {
    vec2 g = floor(p / cell), f = p / cell - g;
    vec3 best = vec3(9.0, 0.0, 0.0);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(i, j);
      vec2 h = hash22(g + o);
      float keep = hash12(g + o + 7.7);
      float s = smoothstep(keep, keep + 0.2, sf);
      if (s <= 0.0) continue;
      float radius = mix(0.16, 0.42, hash12(g + o + 3.1));
      float q = length(o + 0.2 + 0.6 * h - f) / radius;
      if (q < best.x) best = vec3(q, s, hash12(g + o + 11.9));
    }
    return best;
  }

  float disc0(float r) { return exp(-r / 7.0); }

  void main() {
    vec2 xz = vXZ;
    float px = length(fwidth(xz)); // kpc per target pixel
    float r = length(xz);
    float theta = atan(xz.y, xz.x);
    float edge = smoothstep(R_MAX, R_MAX - 4.5, r);

    // Arms: stars on the spine, the dust lane offset to its inner edge, meandering.
    float stars = 0.0, lanes = 0.0, sf = 0.0;
    for (int k = 0; k < ARMS; k++) {
      float d = (mod(theta - armAngle(k, r) + PI, 2.0 * PI) - PI) * r; // kpc across the arm
      float w = 0.32 + 0.055 * r;
      float g = exp(-0.5 * d * d / (w * w * 1.8));
      stars += g;
      if (g < 0.004) continue;
      float s = r * uAlong + float(k) * 41.0; // kpc along the arm
      float dw = d + 0.35 * w + 0.4 * w * gnoise(vec2(s * 0.35, float(k) * 9.1));
      // Ragged: the lane's width breathes along the arm and it breaks into clumps.
      float breathe = 0.55 + 0.9 * (0.5 + 0.5 * gnoise(vec2(s * 0.8, float(k) * 3.3 + dw * 0.6)));
      float lane = exp(-0.5 * dw * dw / (w * w * 1.1 * breathe * breathe));
      lane *= 0.3 + 1.4 * smoothstep(-0.35, 0.55, gnoise(vec2(s * 0.55 + dw * 0.9, dw * 1.6 + float(k) * 5.0)));
      // Strands run along the arm: the noise is stretched 3x along it. Squared for contrast: thin
      // bright filaments with dark gaps, not a smooth ribbon.
      float strands = ridged(vec2(s * 0.9, dw * 2.7), px * 2.7, OCTAVES);
      lanes += lane * strands * strands * 2.2;
      sf += exp(-0.5 * d * d / (w * w * 0.7));
    }
    float inner = smoothstep(0.3, 2.0, r);
    lanes *= inner;
    sf *= inner;

    // The inter-arm web: fainter, isotropic filaments, warped so they don't look like noise.
    vec2 warp = vec2(gnoise(xz * 0.45), gnoise(xz * 0.45 + 5.2));
    float web = ridged(xz * 1.3 + warp * 1.2, px * 1.3, OCTAVES);
    float spurs = ridged(xz * 0.5 + warp * 0.8 + 9.1, px * 0.5, OCTAVES);
    float threads = web * web * web * 3.2 + spurs * spurs * spurs * 1.8;
    float dust = (lanes * 1.1 + threads * (0.35 + 0.65 * min(stars, 1.0)) * disc0(r)) * edge * inner;

    // Star formation carves bubbles: two scales, the small ones only resolved in the Region tier.
    // Warped, so the bubbles are ragged rather than drawn with a compass.
    vec2 bw = warp * 0.12;
    vec3 big = bubbles(xz + bw, 0.9, sf * 0.8 - 0.05);
    vec3 small = bubbles(xz + 3.7 + bw * 0.5, 0.24, sf * 0.7 - 0.1);
    big.y *= edge;
    float smallLod = 1.0 - smoothstep(0.03, 0.06, px);
    small.y *= smallLod * edge;
    float hole = mix(1.0, smoothstep(0.45, 1.05, big.x), big.y) * mix(1.0, smoothstep(0.4, 1.0, small.x), small.y);
    float rim = big.y * exp(-pow((big.x - 1.0) / 0.2, 2.0)) + small.y * exp(-pow((small.x - 1.0) / 0.25, 2.0));
    dust = dust * hole + rim * 0.7 * (0.08 + dust);

    // Diffuse starlight: an exponential disc, arms, and the bulge.
    float disc = exp(-r / 4.2) * edge;
    float bulge = exp(-r * r / 0.5) * 1.1 + exp(-r / 1.1) * 0.25;
    float light = disc * (0.22 + 0.6 * stars) + bulge;

    // Galaxy (MIRI): dust glows. Region: dust absorbs.
    float glow = dust * mix(1.0, 0.3, uLook);
    vec3 dustColour = mix(vec3(0.45, 0.05, 0.02), vec3(1.0, 0.33, 0.07), smoothstep(0.05, 0.5, glow));
    dustColour = mix(dustColour, vec3(1.0, 0.72, 0.45), smoothstep(0.6, 1.3, glow));
    float absorb = clamp(dust * mix(0.25, 1.1, uLook), 0.0, 0.93);

    vec3 starColour = mix(vec3(0.55, 0.66, 1.0), vec3(0.9, 0.93, 1.0), clamp(bulge, 0.0, 1.0));
    vec3 rgb = starColour * light * mix(0.4, 0.85, uLook) * (1.0 - absorb) + dustColour * glow * 0.6;

    // HII: pink cores and teal fringes inside the bubbles, where stars formed.
    float hiiBig = big.y * (exp(-big.x * big.x * 5.0) * 0.8);
    float hiiSmall = small.y * exp(-small.x * small.x * 4.0);
    float fringe = big.y * exp(-pow((big.x - 0.7) / 0.18, 2.0)) * 0.35 + small.y * exp(-pow((small.x - 0.7) / 0.2, 2.0)) * 0.5;
    vec3 pink = mix(vec3(1.0, 0.22, 0.62), vec3(1.0, 0.35, 0.4), big.z);
    vec3 teal = vec3(0.15, 0.85, 0.8);
    float hii = mix(0.08, 1.0, uLook) * edge;
    rgb += (pink * (hiiBig + hiiSmall) + teal * fringe * mix(0.3, 1.0, uLook) * (0.5 + 0.5 * small.z)) * hii;

    rgb *= uGain;
    // Dither: the target is 8-bit.
    rgb += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
    gl_FragColor = vec4(max(rgb, 0.0), absorb * edge);
  }
`;

const compositeVertex = /* glsl */ `
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const compositeFragment = /* glsl */ `
  uniform sampler2D uDust;
  uniform vec2 uSize; // drawing-buffer pixels of the target being composited into
  void main() {
    vec4 d = texture2D(uDust, gl_FragCoord.xy / uSize);
    gl_FragColor = vec4(d.rgb, d.a);
    #include <colorspace_fragment>
  }
`;

export interface Dust {
  /** Add to the tier's scene: a full-screen triangle that composites the dust target. */
  composite: THREE.Mesh;
  /** Render the disc into the dust target; call before rendering the tier's scene. */
  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void;
  resize(width: number, height: number): void; // CSS pixels
  /** Dust target size in pixels, for reporting. */
  size: THREE.Vector2;
  dispose(): void;
}

export function createDust(model: GalaxyModel, look: number, gain: number, scale: number, octaves: number): Dust {
  if (model.arms > 4) throw new Error('dust: the shader packs at most four arms');
  const angles = new Float32Array(4 * SAMPLES);
  for (let s = 0; s < SAMPLES; s++) {
    const r = R_MIN * Math.pow(R_MAX / R_MIN, s / (SAMPLES - 1));
    for (let arm = 0; arm < model.arms; arm++) angles[s * 4 + arm] = model.armAngleAt(r, arm);
  }
  // Arc length along an arm per unit radius, from the spiral's mean winding (bends are local).
  const b = Math.log(12 / 4) / (model.armAngleAt(12, 0) - model.armAngleAt(4, 0));
  const along = Math.sqrt(1 + 1 / (b * b));

  const target = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  const scene = new THREE.Scene();
  const geometry = new THREE.PlaneGeometry(R_MAX * 2, R_MAX * 2).rotateX(-Math.PI / 2);
  const material = new THREE.ShaderMaterial({
    vertexShader: vertex, fragmentShader: fragment,
    defines: { ARMS: model.arms, SAMPLES, OCTAVES: octaves, R_MIN: R_MIN.toFixed(3), R_MAX: R_MAX.toFixed(3) },
    uniforms: { uAngles: { value: angles }, uAlong: { value: along }, uLook: { value: look }, uGain: { value: gain } },
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });
  const plane = new THREE.Mesh(geometry, material);
  plane.frustumCulled = false;
  scene.add(plane);

  const triangle = new THREE.BufferGeometry();
  triangle.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const compositeUniforms = { uDust: { value: target.texture }, uSize: { value: new THREE.Vector2(1, 1) } };
  const compositeMaterial = new THREE.ShaderMaterial({
    vertexShader: compositeVertex, fragmentShader: compositeFragment, uniforms: compositeUniforms,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    depthTest: false, depthWrite: false, transparent: true,
  });
  const composite = new THREE.Mesh(triangle, compositeMaterial);
  composite.frustumCulled = false;
  // uSize follows whatever target the composite is drawn into (the screen, or bloom's buffer).
  composite.onBeforeRender = (renderer) => {
    const t = renderer.getRenderTarget();
    if (t) compositeUniforms.uSize.value.set(t.width, t.height);
    else renderer.getDrawingBufferSize(compositeUniforms.uSize.value);
  };

  const clear = new THREE.Color();
  return {
    composite,
    size: new THREE.Vector2(),
    render(renderer, camera) {
      const previous = renderer.getRenderTarget();
      const alpha = renderer.getClearAlpha();
      renderer.getClearColor(clear);
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.render(scene, camera);
      renderer.setClearColor(clear, alpha);
      renderer.setRenderTarget(previous);
    },
    resize(width, height) {
      target.setSize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
      this.size.set(target.width, target.height);
    },
    dispose() {
      for (const d of [target, geometry, material, triangle, compositeMaterial]) d.dispose();
    },
  };
}
