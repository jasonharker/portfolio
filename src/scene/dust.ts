// The disc's interstellar medium, one shader for both tiers: diffuse starlight, dust and HII regions,
// evaluated in galaxy units on the disc plane. Because the field lives in kpc, not screen space, the
// Region tier sees the same filaments the Galaxy tier does, only closer; finer octaves fade in with
// fwidth, so each tier resolves what its scale allows and the average brightness stays put.
//
// Look (a false-colour composite, so constants, not tokens): at `look` 0 (Galaxy, the MIRI view of
// M74) the dust glows in thin braided lanes along the arms that fray into spurs, over a fainter lacy
// web between them, deep red where thin through amber to pale gold, holed by cavities, with pink and
// white star-forming knots; at `look` 1 (Region, a PHANGS crop) the same dust mostly absorbs, as dark
// lanes over the starlight, and the knots show as pink HII regions with teal fringes.
//
// Cost: full-screen noise, so it renders into its own target at quality.dustScale of CSS pixels and
// is composited with one full-screen triangle: rgb adds, alpha absorbs whatever was drawn before it.
// Per pixel: 5 noise samples, plus two filament fbms of up to `octaves` samples each (octaves finer
// than the pixel are skipped, so ~3 each at Galaxy scale), plus 18 hashed cell probes (36 once the
// small cavities and knots resolve, Region only). The target re-renders only when the view changes.
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
  // Gradient noise, -1..1, |n| averaging 0.2.
  float gnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = dot(hash22(i) * 2.0 - 1.0, f);
    float b = dot(hash22(i + vec2(1, 0)) * 2.0 - 1.0, f - vec2(1, 0));
    float c = dot(hash22(i + vec2(0, 1)) * 2.0 - 1.0, f - vec2(0, 1));
    float d = dot(hash22(i + vec2(1, 1)) * 2.0 - 1.0, f - vec2(1, 1));
    return 1.4 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  // Filaments: exp(-|n|/w) is a thin line where the noise crosses zero, w its width. The line is never
  // drawn thinner than the pixel (px, in noise units), and each octave is divided by its mean (fitted
  // numerically), so every octave averages 1 at any w. An octave too fine for the pixel drops out of the
  // weighted sum rather than flattening it, so detail comes and goes with scale, contrast holds, and the
  // average brightness stays put.
  float filaments(vec2 p, float px, float w0) {
    float sum = 0.0, amp = 1.0, norm = 0.0;
    mat2 turn = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < OCTAVES; i++) {
      float w = max(w0, px);
      float lod = i == 0 ? 1.0 : 1.0 - smoothstep(0.2, 0.4, w);
      if (lod <= 0.0) break; // finer octaves only get finer
      sum += amp * lod * exp(-abs(gnoise(p)) / w) / (w / (w + 0.2) * (1.0 - 0.35 * exp(-20.0 * w)));
      norm += amp * lod;
      p = turn * p * 2.03 + 17.3;
      px *= 2.03;
      amp *= 0.65;
    }
    return sum / norm;
  }

  float armAngle(int arm, float r) {
    float f = clamp((log(max(r, R_MIN)) - log(R_MIN)) / (log(R_MAX) - log(R_MIN)), 0.0, 1.0) * float(SAMPLES - 1);
    int i = int(f);
    int j = min(i + 1, SAMPLES - 1);
    return mix(uAngles[i][arm], uAngles[j][arm], fract(f));
  }

  // Cavities on a jittered grid of cell size \`cell\` kpc: (distance to the nearest centre in radii, its
  // strength 0..1). \`p\` decides how many cells hold one; radii vary by 3x.
  vec2 cavities(vec2 p, float cell, float prob) {
    vec2 g = floor(p / cell), f = p / cell - g;
    vec2 best = vec2(9.0, 0.0);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(i, j);
      float keep = hash12(g + o + 7.7);
      float s = smoothstep(keep, keep + 0.15, prob);
      if (s <= 0.0) continue;
      float h = hash12(g + o + 3.1);
      float q = length(o + 0.15 + 0.7 * hash22(g + o) - f) / (0.16 + 0.34 * h * h);
      if (q < best.x) best = vec2(q, s);
    }
    return best;
  }

  // Star-forming knots on a jittered grid: sizes log-spread over 10x, stretched and turned at random, so
  // they don't bead evenly along the arm. Returns (summed core light, summed fringe ring, hue 0..1 of the
  // brightest). px keeps a knot at least a pixel wide, its light spread rather than lost.
  vec3 knots(vec2 p, float cell, float prob, float rMin, float px) {
    vec2 g = floor(p / cell), f = p / cell - g;
    vec3 sum = vec3(0.0);
    float top = 0.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(i, j);
      vec2 h = hash22(g + o + 1.3);
      float keep = smoothstep(h.x, h.x + 0.2, prob); // soft: prob varies across a knot's footprint
      if (keep <= 0.0) continue;
      vec2 k = hash22(g + o + 5.9);
      float rad = min(rMin * exp(2.3 * k.x * k.x), 0.3 * cell);
      float eff = clamp(px, rad, 0.3 * cell);
      vec2 d = (o + hash22(g + o) - f) * cell;
      float c = cos(k.y * 6.3), s = sin(k.y * 6.3);
      d = mat2(c, s, -s, c) * d;
      d.y *= 1.0 + 0.8 * h.y;
      float q = length(d) / eff;
      float lum = (rad * rad) / (eff * eff) * keep * (0.25 + 0.75 * fract(h.y * 7.3) * fract(h.y * 7.3));
      float core = exp(-q * q * 2.0) * lum;
      sum.x += core;
      sum.y += exp(-(q - 1.5) * (q - 1.5) / 0.2) * lum;
      if (core > top) {
        top = core;
        sum.z = k.y;
      }
    }
    return sum;
  }

  void main() {
    vec2 xz = vXZ;
    float px = length(fwidth(xz)); // kpc per target pixel
    float r = length(xz);
    if (r > R_MAX) {
      gl_FragColor = vec4(0.0);
      return;
    }
    float theta = atan(xz.y, xz.x);
    float edge = smoothstep(R_MAX, R_MAX - 4.5, r);
    float inner = smoothstep(0.1, 1.0, r);
    float w = 0.3 + 0.05 * r; // arm half-width, kpc

    // Arms: starlight summed over all of them; the dust follows the nearest (d across it, s along it).
    float stars = 0.0, d = 1e3, s = 0.0;
    for (int k = 0; k < ARMS; k++) {
      float dk = (mod(theta - armAngle(k, r) + PI, 2.0 * PI) - PI) * r;
      stars += exp(-0.5 * dk * dk / (w * w * 1.8));
      if (abs(dk) < abs(d)) {
        d = dk;
        s = r * uAlong + float(k) * 41.0;
      }
    }

    // Everything meanders: a slow warp shifts lanes, web and cavities alike.
    vec2 warp = vec2(gnoise(xz * 0.4), gnoise(xz * 0.4 + 5.2));

    // The lane sits on the arm's inner edge. Outward of it the arm frays: its strands fan out and wander
    // off as spurs, further where the along-arm noise says so.
    float dl = d + 0.35 * w + 0.5 * w * warp.x;
    float fray = 0.5 + 0.5 * gnoise(vec2(s * 0.3, float(ARMS) + d * 0.2));
    float outer = max(dl, 0.0);
    float envelope = exp(-0.5 * dl * dl / (w * w * 1.2)) + smoothstep(0.2, 0.8, fray) * exp(-outer / (w * 2.2)) * step(0.0, dl) * 0.7;
    vec2 q = vec2(s * 0.3, (dl - 0.55 * outer) * 1.3 + warp.y * 1.2 * smoothstep(0.0, 2.5 * w, outer));
    float strands = filaments(q, px * 1.3, 0.06);
    float lanes = envelope * strands * (0.35 + 0.9 * fray);

    // The inter-arm web: fainter, isotropic, warped so it reads as gas rather than noise.
    float web = filaments(xz * 1.3 + warp * 0.9, px * 1.3, 0.04);
    float disc0 = exp(-r / 9.0);
    float dust = (lanes * 0.8 + web * 1.1 * disc0 * (0.3 + 0.7 * min(stars, 1.0)) * smoothstep(-0.6, 0.4, warp.x)) * edge * inner;

    // Cavities: hollow bubbles blown by star formation, with broken rims where the gas piled up. Two
    // scales; the small ones are only resolved in the Region tier.
    float arm = min(stars, 1.0);
    vec2 cw = xz + warp * 0.3 + 0.12 * vec2(gnoise(xz * 2.6), gnoise(xz * 2.6 + 3.3));
    vec2 big = cavities(cw, 1.2, 0.1 + 0.4 * arm);
    float smallLod = 1.0 - smoothstep(0.02, 0.05, px);
    vec2 small = smallLod > 0.0 ? cavities(cw + 3.7, 0.3, 0.15 + 0.45 * arm) : vec2(9.0, 0.0);
    small.y *= smallLod;
    float hole = mix(1.0, 0.1 + 0.9 * smoothstep(0.4, 1.0, big.x), big.y) * mix(1.0, 0.1 + 0.9 * smoothstep(0.35, 1.0, small.x), small.y);
    float rim = big.y * exp(-(big.x - 1.0) * (big.x - 1.0) / 0.04) + small.y * exp(-(small.x - 1.0) * (small.x - 1.0) / 0.05);
    dust = dust * hole * (1.0 + 1.5 * rim);

    // Star-forming knots where the arms are, carving their own small clearings. Small ones resolve closer.
    float sfProb = 0.55 * arm * edge * inner;
    vec3 kn = knots(xz + warp * 0.2, 0.7, sfProb, 0.03, px);
    if (smallLod > 0.0) {
      vec3 ks = knots(xz + 11.3, 0.2, sfProb * 0.8, 0.008, px);
      kn.xy += ks.xy * smallLod;
    }
    float clump = 0.3 + 0.7 * min(web, 3.0) / 3.0; // irregular, not drawn with a compass
    dust *= 1.0 - 0.7 * min(kn.x + kn.y * 0.5, 1.0);

    // Diffuse starlight: an exponential disc, arms, and the bulge.
    float disc = exp(-r / 4.2) * edge;
    float bulge = exp(-r * r / 0.5) * 1.1 + exp(-r / 1.1) * 0.25;
    float light = disc * mix(0.08 + 0.35 * stars, 0.3 + 0.6 * stars, uLook) + bulge;
    vec3 starColour = mix(mix(vec3(0.4, 0.6, 1.0), vec3(1.0, 0.86, 0.74), uLook), vec3(0.85, 0.92, 1.0), clamp(bulge, 0.0, 1.0));

    // Galaxy (MIRI): the dust glows, deep red where thin, through red-orange and amber to pale gold where
    // it piles up. Region: the same dust mostly absorbs, a dark lane with a faint warm edge.
    float heat = dust * (1.0 - 0.8 * uLook); // the Region tier's faint edge glow stays red-orange
    vec3 ramp = mix(vec3(0.3, 0.02, 0.01), vec3(0.9, 0.2, 0.03), smoothstep(0.0, 0.5, heat));
    ramp = mix(ramp, vec3(1.0, 0.5, 0.1), smoothstep(0.6, 1.8, heat));
    ramp = mix(ramp, vec3(1.0, 0.8, 0.5), smoothstep(2.2, 5.0, heat));
    float absorb = clamp(dust * mix(0.15, 1.0, uLook), 0.0, 0.95);
    vec3 rgb = starColour * light * mix(0.5, 0.8, uLook) * (1.0 - absorb) + ramp * mix(dust * 0.3, min(dust, 1.0) * 0.05, uLook);

    // Knots: pink to white in the Galaxy tier; in the Region tier pink HII cores with teal-cyan fringes.
    vec3 pink = mix(vec3(1.0, 0.35, 0.7), vec3(1.0, 0.85, 0.92), smoothstep(0.3, 1.0, kn.z));
    vec3 teal = vec3(0.12, 0.8, 0.85);
    rgb += (pink * kn.x * mix(3.0, 1.1, uLook) + teal * kn.y * mix(0.05, 0.35, uLook) * clump) * (0.5 + clump) * edge;

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
  // The field is static: re-render only when the view or the target changes, so ambient frames (twinkle
  // only) reuse the target. A restored context comes back with the target blank.
  const view = new THREE.Matrix4(), projection = new THREE.Matrix4(), rendered = new THREE.Vector2();
  let dirty = true;
  return {
    composite,
    size: new THREE.Vector2(),
    render(renderer, camera) {
      camera.updateMatrixWorld();
      if (!dirty && view.equals(camera.matrixWorld) && projection.equals(camera.projectionMatrix) && rendered.equals(this.size)) return;
      if (dirty) renderer.domElement.addEventListener('webglcontextrestored', () => (dirty = true), { once: true });
      dirty = false;
      view.copy(camera.matrixWorld);
      projection.copy(camera.projectionMatrix);
      rendered.copy(this.size);
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
