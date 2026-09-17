// Documentation (/documentation): the supermassive black hole at the galactic core, with a lensed
// accretion disk (spec §3, decided 2026-09-16).
//
// The treatment is Gargantua's geometry and Gargantua's licence: computed lensing, the disk arcing
// over and under the shadow, the photon ring kept — but Doppler beaming damped, exactly as
// Interstellar shipped it, because the physically correct lopsidedness reads as a rendering error.
// Disk colour follows the scene's JWST false colour rather than blackbody: the whole site is an
// instrument's interpretation already, so mapping the disk the same way is consistent, not a cheat.
//
// Budget: the lens is the most expensive shader on the site and the reference machine is an Intel
// UHD 620. Ray-march into a half-resolution target at quality.lensScale and composite, exactly as
// dust.ts does — including its view-change memoisation, which is what makes ambient frames cheap.
//
// How the lensing is computed. Schwarzschild is spherically symmetric, so a photon stays in the
// plane through the hole spanned by the camera position and the ray. In that plane the orbit obeys
// one ODE, u'' = -u + 1.5 rs u² with u = 1/r and ' = d/dφ, which reproduces straight lines exactly
// when the rs term is dropped — so there is no separate near-field case to blend. It integrates
// with Verlet (one force evaluation a step, and it conserves the orbit rather than spiralling), and
// because the plane's two basis vectors are fixed the whole march is scalar: the step is a 2×2
// rotation, and the height above the disk is r·(c·e1.y + s·e2.y). Nothing is a vec3 until a step
// straddles the disk plane, which is where the shading happens.
//
// Everything the frame shows falls out of that one march. The shadow is the set of rays that reach
// the horizon. The disk arcs over and under it because rays launched past the hole are bent back
// across it and strike the far side of the disk from below and from above. The photon ring is where
// rays wind repeatedly and cross the bright inner disk again and again. None of the three is drawn.
import * as THREE from 'three';
import { palette } from '../jwst';

import type { CameraPose, LocalPlace, SceneContext } from '../types';

// The place's unit is the Schwarzschild radius, so every constant below is the textbook one: the
// shadow is √27/2 across, the disk starts at the innermost stable orbit, 3.
const R_IN = 3;
const R_OUT = 10;
const B_CRIT = Math.sqrt(27) / 2; // impact parameter of the last ray that escapes: the shadow's edge
const TILT = 0.16; // camera elevation above the disk, rad — near enough edge-on for the disk to arch over
const DISTANCE = 27;
const FOV = 40;
const SPIN = 0.34; // rad/s at the inner edge; outward it falls off as Kepler says, and that shear is the life of it
const RAMP = 6;
const STEPS = 72;
const DPHI = Math.PI / 24; // 3π of orbit at most: past that the order term below has faded it out

const lensVertex = /* glsl */ `
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const lensFragment = /* glsl */ `
  uniform vec3 uCam; // camera in the hole's frame
  uniform mat3 uBasis; // camera right, up, back, in the hole's frame
  uniform vec2 uTan; // tan of the half field of view, x and y
  uniform vec2 uRes; // lens target, pixels
  uniform float uSpin; // radians the inner edge has turned
  uniform float uPx; // place units per lens pixel out at the hole
  uniform vec3 uRamp[RAMP]; // disk colour, inner to outer, from palette()

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
  // Gradient noise, -1..1. Its level sets wander; a value noise's follow the lattice, and the lens
  // magnifies one cell until the whole screen is inside it.
  float gnoise(vec2 p) {
    vec2 i = floor(p), f = p - i;
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = dot(hash22(i) * 2.0 - 1.0, f);
    float b = dot(hash22(i + vec2(1, 0)) * 2.0 - 1.0, f - vec2(1, 0));
    float c = dot(hash22(i + vec2(0, 1)) * 2.0 - 1.0, f - vec2(0, 1));
    float d = dot(hash22(i + vec2(1, 1)) * 2.0 - 1.0, f - vec2(1, 1));
    return 1.4 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  // The deep field the lens bends. Its own, not the tier's: the sky is drawn as points and a march
  // cannot sample them. Deliberately soft — a smudge a degree across survives being compressed into
  // an arc where a star-sized point would only alias — and it is weighted by the magnification
  // below, so it reads as arcs around the ring and is not there at all where the lens is idle.
  // Instrument false colour, as in jwst.ts's deep field: small things are red, brighter ones amber.
  // The azimuth scale is 3/π so the grid closes on itself and there is no seam behind the hole.
  vec3 field(vec3 d) {
    vec2 uv = vec2(atan(d.z, d.x) * 0.9549297, d.y * 3.0);
    float a = gnoise(uv * 6.0) * 0.62 + gnoise(uv * 13.0 + 5.1) * 0.38;
    float b = gnoise(uv * 27.0 + 2.7) * 0.5 + 0.5;
    vec3 warm = mix(vec3(1.0, 0.30, 0.16), vec3(1.0, 0.70, 0.42), b);
    return warm * smoothstep(0.02, 0.62, a) * (0.35 + 0.65 * b);
  }

  // A chain of clamped mixes, not uRamp[i]: a uniform array indexed by anything but a loop counter
  // is not portable in GLSL ES 1.0, and this is branch-free anyway.
  vec3 ramp(float f) {
    float x = f * float(RAMP - 1);
    vec3 c = uRamp[0];
    for (int i = 1; i < RAMP; i++) c = mix(c, uRamp[i], clamp(x - float(i) + 1.0, 0.0, 1.0));
    return c;
  }

  void main() {
    vec2 ndc = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
    vec3 D = normalize(uBasis * vec3(ndc * uTan, -1.0));

    // The orbital plane: e1 toward the camera, e2 the way the ray leans, φ measured from e1 to e2.
    float r0 = length(uCam);
    vec3 e1 = uCam / r0;
    float vr = dot(D, e1);
    vec3 perp = D - e1 * vr;
    float vt = length(perp);
    vec3 e2 = perp / max(vt, 1e-7);

    float u = 1.0 / r0;
    float du = -u * vr / max(vt, 1e-7); // du/dφ = -u·(dr/dλ)/(r dφ/dλ)
    float acc2 = -u + 1.5 * u * u;
    float C = cos(DPHI), S = sin(DPHI);
    float c = 1.0, s = 0.0;
    float rEsc = max(r0 * 1.15, R_OUT * 1.6);

    float pr = r0, pc = 1.0, ps = 0.0, py = uCam.y, pdu = du;
    vec3 light = vec3(0.0);
    float T = 1.0; // what is still visible through the disk
    bool escaped = false;
    vec3 out3 = vec3(0.0);

    for (int i = 0; i < STEPS; i++) {
      u += du * DPHI + 0.5 * acc2 * DPHI * DPHI;
      float a2 = -u + 1.5 * u * u;
      du += 0.5 * (acc2 + a2) * DPHI;
      acc2 = a2;
      if (u > 1.0) break; // through the horizon: nothing comes back
      float r = 1.0 / u;
      float nc = c * C - s * S;
      s = s * C + c * S;
      c = nc;
      float y = r * (c * e1.y + s * e2.y);

      if (y * py < 0.0) {
        // The step straddles the disk plane. Interpolate to the crossing; there, and only there,
        // is any of this three-dimensional.
        float t = py / (py - y);
        float rx = mix(pr, r, t);
        if (rx > R_IN && rx < R_OUT && T > 0.02) {
          vec2 cs = normalize(vec2(mix(pc, c, t), mix(ps, s, t)));
          vec3 rad = cs.x * e1 + cs.y * e2; // unit, along the radius at the crossing
          // d(position)/dφ at the crossing, from dr/dφ = -u'/u². Everything below reads this rather
          // than the step's own endpoints: a step-quantised quantity seams on every step boundary,
          // and two crossings' worth of those seams cross into a lattice over the whole disk.
          vec3 vel = (-mix(pdu, du, t) * rx * rx) * rad + rx * (cs.x * e2 - cs.y * e1);
          float ang = atan(rad.z, rad.x);

          // Novikov-Thorne in spirit: nothing at the inner edge, a peak just outside it, a long
          // cool tail, and the outer edge feathered rather than cut.
          float x = rx / R_IN;
          float prof = (1.0 - inversesqrt(x)) * pow(x, -1.2) * 7.84 * smoothstep(R_OUT, R_OUT * 0.78, rx);

          // Grazing rays cross more of the disk's thickness, so the rim lights up edge-on. The
          // slab is never resolved; this is the path through it, which is all that is visible.
          float iv = inversesqrt(dot(vel, vel));
          float graze = clamp(1.0 / max(abs(vel.y) * iv, 1e-3), 1.0, 2.5);

          // Keplerian shear. The bands are axisymmetric and so never wind; the wisps are not, and
          // they do — LOD fades them out once the shear has wound them below a lens pixel, which
          // is both what stops the aliasing and what sheared gas actually does.
          float om = R_IN / rx;
          om *= sqrt(om);
          float ph = ang - uSpin * om;
          float lod = 1.0 / (1.0 + 6.0 * uSpin * om * uPx / rx);
          float weave = (0.84 + 0.16 * sin(rx * 6.1 + 1.7) * sin(rx * 2.3))
            * (1.0 + lod * (0.20 * sin(6.0 * ph + 2.4 * rx) + 0.12 * sin(11.0 * ph - 1.3 * rx)));

          // Doppler, heavily damped. The maths is the real one — the orbital velocity projected on
          // the line of sight — but it drives a linear term, not the physical fourth power, which
          // would put a 20:1 swing across the disk and read as a broken render.
          float beta = sqrt(0.5 / rx);
          float toward = -dot(vec3(rad.z, 0.0, -rad.x), vel) * iv;
          float beam = 1.0 + 0.95 * beta * toward;

          float f = clamp((log(rx) - LOG_R_IN) / (LOG_R_OUT - LOG_R_IN) - 0.30 * beta * toward, 0.0, 1.0);
          vec3 col = mix(ramp(f), vec3(1.0, 0.70, 0.42), 0.46 + 0.40 * f); // pulled toward the dust amber
          // Past the arcs, each further half turn squeezes the image radially by about e^-π, so
          // there is far more structure there than a lens texel can hold. Fading it is the filtered
          // answer, not a cover-up: point-sampling it is what speckled the ring.
          light += T * col * prof * graze * weave * beam * 0.34 * exp(-0.5 * max(float(i) * DPHI - 5.0, 0.0));
          T *= 1.0 - clamp(prof * graze * 2.4, 0.0, 0.95); // the column is opaque whatever the beaming says
        }
      }
      py = y;
      pr = r;
      pc = c;
      ps = s;
      pdu = du;

      if (T < 0.02) break; // the disk in front is opaque: nothing behind it can be seen
      if (u < 1.0 / rEsc && du < 0.0) {
        // Out for good. dr/dφ = -u'/u², so the escape direction is that much radial and r tangential.
        out3 = normalize((-du * r * r) * (c * e1 + s * e2) + r * (c * e2 - s * e1));
        escaped = true;
        break;
      }
    }

    // Magnification. Near the critical impact parameter the lens compresses the whole sky into a
    // thin annulus, and brightness goes up by exactly as much as the solid angle comes down; the
    // 1/(b - b_crit) is the leading term of that. Away from the hole it goes to nothing, which is
    // right: out there the tier's own sky is the sky, and this pass must not double it.
    if (escaped) {
      float t = (r0 * vt - B_CRIT) / B_CRIT;
      float mag = min(1.6 / (max(t, 0.0) + 0.09) / (1.0 + 0.8 * t * t), 8.0);
      light += T * mix(field(out3), vec3(0.175, 0.088, 0.051), smoothstep(1.05, 2.4, mag)) * mag * 0.05;
    }

    light = light / (1.0 + light); // nothing in this tier blooms, so roll the inner edge to white
    light += (hash12(gl_FragCoord.xy) - 0.5) / 255.0; // the target is 8-bit
    gl_FragColor = vec4(max(light, 0.0), 1.0 - T);
  }
`;

const compositeVertex = /* glsl */ `
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
// rgb adds, alpha absorbs — the same composite dust.ts uses. The alpha is what makes the shadow
// genuinely black: it eats the sky the tier drew behind it rather than darkening it.
const compositeFragment = /* glsl */ `
  uniform sampler2D uLens;
  uniform vec2 uSize;
  void main() {
    vec4 l = texture2D(uLens, gl_FragCoord.xy / uSize);
    gl_FragColor = vec4(l.rgb, l.a);
    #include <colorspace_fragment>
  }
`;

export function createBlackHole(ctx: SceneContext): LocalPlace {
  const group = new THREE.Group();
  const kept: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => (kept.push(x), x);

  // Disk colour: palette() maps a temperature to the scene's own star tokens, hot inside to cool
  // out, and the shader then pulls the result toward the dust amber. No second colour system.
  const at = palette(ctx.colour);
  const stops: THREE.Color[] = [];
  for (let i = 0; i < RAMP; i++) {
    stops.push(at(Math.exp(THREE.MathUtils.lerp(Math.log(7500), Math.log(3000), i / (RAMP - 1))), new THREE.Color()));
  }

  const target = keep(new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false }));
  const lensScene = new THREE.Scene();
  const triangle = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    return keep(g);
  };
  const lensUniforms = {
    uCam: { value: new THREE.Vector3() },
    uBasis: { value: new THREE.Matrix3() },
    uTan: { value: new THREE.Vector2(1, 1) },
    uRes: { value: new THREE.Vector2(1, 1) },
    uSpin: { value: 0 },
    uPx: { value: 0.01 },
    uRamp: { value: stops },
  };
  const lensMaterial = keep(new THREE.ShaderMaterial({
    vertexShader: lensVertex, fragmentShader: lensFragment, uniforms: lensUniforms,
    defines: {
      RAMP, STEPS, DPHI: DPHI.toFixed(9), R_IN: R_IN.toFixed(1), R_OUT: R_OUT.toFixed(1),
      B_CRIT: B_CRIT.toFixed(6), LOG_R_IN: Math.log(R_IN).toFixed(6), LOG_R_OUT: Math.log(R_OUT).toFixed(6),
    },
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  }));
  const lens = new THREE.Mesh(triangle(), lensMaterial);
  lens.frustumCulled = false;
  lensScene.add(lens);

  const compositeUniforms = { uLens: { value: target.texture }, uSize: { value: new THREE.Vector2(1, 1) } };
  const composite = new THREE.Mesh(triangle(), keep(new THREE.ShaderMaterial({
    vertexShader: compositeVertex, fragmentShader: compositeFragment, uniforms: compositeUniforms,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    depthTest: false, depthWrite: false, transparent: true,
  })));
  composite.frustumCulled = false;
  composite.renderOrder = 12; // after the sky's foreground stars: they are behind the hole, and it eats them
  composite.onBeforeRender = (renderer) => renderer.getDrawingBufferSize(compositeUniforms.uSize.value);
  group.add(composite);

  // The march is far too expensive to repeat for a frame that would come out the same, so it runs
  // only when the view or the disk's phase has actually moved — dust.ts's memoisation, with the
  // phase added. Under reduced motion the disk is still, and then the pass runs exactly once.
  const view = new THREE.Matrix4(), projection = new THREE.Matrix4(), rendered = new THREE.Vector2();
  let spin = 0, drawn = -1, dirty = true;
  const size = new THREE.Vector2();
  const clear = new THREE.Color();

  return {
    group,
    pose(aspect): CameraPose {
      const d = DISTANCE / Math.min(1, aspect / 1.4);
      return { position: [0, d * Math.sin(TILT), d * Math.cos(TILT)], target: [0, 0, 0], fov: FOV };
    },
    update(dt) {
      if (!ctx.quality.reducedMotion) spin += dt * SPIN;
      return false; // orbiting is idle life: the loop is free to run it at 30 fps
    },
    prepare(renderer, camera) {
      camera.updateMatrixWorld();
      if (!dirty && spin === drawn && view.equals(camera.matrixWorld)
        && projection.equals((camera as THREE.PerspectiveCamera).projectionMatrix) && rendered.equals(size)) return;
      if (dirty) renderer.domElement.addEventListener('webglcontextrestored', () => (dirty = true), { once: true });
      dirty = false;
      view.copy(camera.matrixWorld);
      projection.copy((camera as THREE.PerspectiveCamera).projectionMatrix);
      rendered.copy(size);
      drawn = spin;

      const p = (camera as THREE.PerspectiveCamera).projectionMatrix.elements;
      lensUniforms.uCam.value.setFromMatrixPosition(camera.matrixWorld);
      lensUniforms.uBasis.value.setFromMatrix4(camera.matrixWorld);
      lensUniforms.uTan.value.set(1 / p[0], 1 / p[5]);
      lensUniforms.uSpin.value = spin;
      lensUniforms.uPx.value = (2 / p[5] / Math.max(size.y, 1)) * lensUniforms.uCam.value.length();

      const previous = renderer.getRenderTarget();
      const alpha = renderer.getClearAlpha();
      renderer.getClearColor(clear);
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.render(lensScene, camera);
      renderer.setClearColor(clear, alpha);
      renderer.setRenderTarget(previous);
    },
    resize(width, height) {
      target.setSize(Math.max(1, Math.round(width * ctx.quality.lensScale)), Math.max(1, Math.round(height * ctx.quality.lensScale)));
      size.set(target.width, target.height);
      lensUniforms.uRes.value.copy(size);
    },
    dispose() {
      for (const k of kept.splice(0)) k.dispose();
      group.clear();
    },
  };
}
