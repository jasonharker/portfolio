// The 3D scene. Loaded by Base.astro with a dynamic import() after first paint, and only
// once the gates there have passed, so everything three.js pulls in stays in this chunk.
import { navigate } from 'astro:transitions/client';
import * as THREE from 'three';
import { incidents, topology } from './data';
import { createFlight } from './flight';
import { createLoop } from './loop';
import { quality } from './quality';
import { createStill } from './reduced-motion';
import { placeFor } from './routes';
import { galaxy } from './tiers/galaxy';
import { region } from './tiers/region';
import type { CameraPose, Scene, SceneContext, SceneDebug, Tier, TierId } from './types';

// Camera sway on top of the director's pose, both unit-free (fractions of the view distance),
// so Galaxy (~40 kpc away) and Region (~2) sway alike on screen. Neither touches the stage's
// pose, so flights, current() and resume never see it. Absent under reduced motion.
const PARALLAX = 0.03; // camera shift at the viewport edge; the target shifts a third of it, so near moves more than far
const PARALLAX_W = 10; // critically damped spring, rad/s: settles in ~0.6 s
// Idle drift: a slow breathing orbit about the target. Any camera motion re-renders the dust
// pass on every ambient frame (30/s) where a still camera could skip it; 0 turns it off.
const DRIFT = 0.01;
const DRIFT_S: [number, number] = [31, 23]; // periods of the lateral and vertical swing

export function start(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, labels: HTMLElement): Scene {
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  renderer.setPixelRatio(quality.dpr);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  const sway = !quality.reducedMotion;
  const css = getComputedStyle(document.documentElement);

  const ctx: SceneContext = {
    renderer, camera, topology, incidents, quality, labels,
    colour: (token) => new THREE.Color(css.getPropertyValue(token).trim()),
    invalidate: () => loop.invalidate(),
  };

  const tiers: Record<TierId, Tier> = { galaxy, region };
  const loading = new Map<TierId, Promise<Tier>>();
  let active: Tier | null = null;
  let pose: CameraPose = { position: [0, 0, 1], target: [0, 0, 0], fov: 50 };

  // Mouse parallax: `goal` is the pointer in [-1, 1] (y up), `at`/`vel` the eased value per axis.
  const goal = [0, 0], at = [0, 0], vel = [0, 0];
  let drift = 0; // seconds of rendered frames
  let swayed = 0; // camera offset from the pose position / view distance, for __scene
  const [eye, look, right, up] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const ease = (dt: number) => {
    let moving = false;
    const e = Math.exp(-PARALLAX_W * dt);
    for (let i = 0; i < 2; i++) {
      const d = at[i] - goal[i], k = (vel[i] + PARALLAX_W * d) * dt;
      at[i] = goal[i] + (d + k) * e;
      vel[i] = (vel[i] - PARALLAX_W * k) * e;
      if (Math.abs(at[i] - goal[i]) < 1e-3 && Math.abs(vel[i]) < 1e-2) (at[i] = goal[i]), (vel[i] = 0);
      else moving = true;
    }
    return moving;
  };
  // Pose plus sway into the camera. Called on every rendered frame, and whenever the pose changes.
  function aim() {
    eye.set(...pose.position);
    look.set(...pose.target);
    const dist = eye.distanceTo(look);
    const [sx, sy] = [
      PARALLAX * at[0] + DRIFT * Math.sin((2 * Math.PI * drift) / DRIFT_S[0]),
      PARALLAX * at[1] + DRIFT * 0.6 * Math.sin((2 * Math.PI * drift) / DRIFT_S[1]),
    ];
    swayed = Math.hypot(sx, sy);
    if (swayed) {
      camera.position.copy(eye);
      camera.lookAt(look); // the view basis to shift along
      right.set(1, 0, 0).applyQuaternion(camera.quaternion);
      up.set(0, 1, 0).applyQuaternion(camera.quaternion);
      eye.addScaledVector(right, sx * dist).addScaledVector(up, sy * dist);
      // Parallax swings the view about a point beyond the target; drift orbits the target itself.
      look.addScaledVector(right, (PARALLAX * at[0] * dist) / 3).addScaledVector(up, (PARALLAX * at[1] * dist) / 3);
    }
    camera.position.copy(eye);
    camera.lookAt(look);
  }

  const director = (quality.reducedMotion ? createStill : createFlight)({
    ctx,
    tier: (id) => {
      if (!loading.has(id)) loading.set(id, tiers[id].load(ctx).then(() => (tiers[id].resize?.(innerWidth, innerHeight), tiers[id])));
      return loading.get(id)!;
    },
    cut(id) {
      if (active === tiers[id]) return;
      active?.show?.(false);
      active = tiers[id];
      active.show?.(true);
      // A tier cut in after the essay has been scrolled still owes it the lit chapter.
      active.chapter?.(debug.chapter);
    },
    current: () => ({ tier: active?.id ?? null, pose }),
    pose(p) {
      pose = p;
      aim();
      if (camera.fov !== p.fov) {
        camera.fov = p.fov;
        camera.updateProjectionMatrix();
      }
    },
  });

  const debug: SceneDebug = {
    born: Math.random().toString(36).slice(2),
    canvas, webgl2: true, frames: 0, contextLost: 0, flying: false,
    path: location.pathname, place: placeFor(location.pathname),
    instantAt: location.pathname, flights: [],
    get idle() { return loop.idle; },
    get rate() { return loop.rate; },
    get hot() { return active?.hot?.() ?? null; },
    chapter: null,
    get reading() { return active?.reading?.() ?? null; },
    get tier() { return active?.id ?? null; },
    get paused() { return loop.paused; },
    get parallax() { return Math.hypot(at[0], at[1]); },
    get sway() { return swayed; },
    get hoverable() { return !!active?.hot; },
  };
  canvas.dataset.born = debug.born;
  (window as unknown as { __scene: SceneDebug }).__scene = debug;

  const loop = createLoop((dt) => {
    const flying = (debug.flying = director.update(dt));
    const moving = active?.update(dt) ?? false;
    const easing = sway && ease(dt);
    if (sway && DRIFT) drift += dt;
    aim();
    active?.render(renderer, camera);
    debug.frames++;
    return flying || moving || easing;
  }, !quality.reducedMotion);

  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    for (const id of loading.keys()) tiers[id].resize?.(innerWidth, innerHeight);
    loop.invalidate();
  };
  resize();
  addEventListener('resize', resize);

  // Pause when the tab is hidden, and on mobile when the bottom sheet covers the scene.
  const narrow = matchMedia('(max-width: 48rem)');
  const covered = () => loop.pause('covered', narrow.matches && (document.querySelector('.column')?.getBoundingClientRect().top ?? 1) <= 0);
  document.addEventListener('visibilitychange', () => loop.pause('hidden', document.hidden));
  addEventListener('scroll', covered, { passive: true });
  document.addEventListener('astro:page-load', covered);
  loop.pause('hidden', document.hidden);
  covered();

  // Mouse only: touch has no hover, and a drag is a scroll. The same pointer drives the parallax.
  const point = (x: number, y: number) => {
    if (!sway || (goal[0] === x && goal[1] === y)) return;
    (goal[0] = x), (goal[1] = y);
    loop.invalidate();
  };
  const hover = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    active?.hover?.(e.clientX, e.clientY);
    point((2 * e.clientX) / innerWidth - 1, 1 - (2 * e.clientY) / innerHeight);
  };
  addEventListener('pointermove', hover, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => (active?.hover?.(NaN, NaN), point(0, 0)));

  canvas.addEventListener('webglcontextlost', () => debug.contextLost++);
  canvas.addEventListener('webglcontextrestored', () => loop.invalidate());

  const scene: Scene = {
    goTo(path, opts = {}) {
      const instant = opts.instant ?? false;
      const place = placeFor(path);
      if (path === debug.path && !instant) return;
      debug.path = path;
      debug.place = place;
      if (!instant) {
        debug.instantAt = null;
        debug.flights.push(path);
      }
      director.to(place, { instant });
      loop.invalidate();
    },
    chapter(id) {
      if (debug.chapter === id) return;
      debug.chapter = id;
      active?.chapter?.(id);
      loop.invalidate();
    },
    skip: () => (director.skip(), loop.invalidate()),
    invalidate: () => loop.invalidate(),
  };

  // The landing essay drives the sky: whichever chapter is under the reader's eye lights its
  // asterism. It lives here because the CSP forbids inline script and this module is already the
  // only one that runs; on every other page there is nothing to observe and the sky stays even.
  //
  // Nearest to a reading line, not a band: a band across the middle of the viewport leaves the
  // first and last chapters unable to reach it — a short last section sits at the bottom of the
  // scroll and never crosses the middle — and those two are a half of a four-chapter essay.
  const READING_LINE = 0.38; // of the viewport, from the top
  let sections: HTMLElement[] = [];
  const pick = () => {
    if (!sections.length) return;
    const line = innerHeight * READING_LINE;
    let best: HTMLElement | null = null;
    let nearest = Infinity;
    for (const section of sections) {
      const box = section.getBoundingClientRect();
      // Distance from the line to the section's own span, which is zero while it holds the line.
      const d = Math.abs(Math.min(Math.max(line, box.top), box.bottom) - line);
      if (d < nearest) (nearest = d), (best = section);
    }
    scene.chapter(best?.dataset.chapter ?? null);
  };
  let queued = false;
  const repick = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => ((queued = false), pick()));
  };
  // The reading column is its own scroller on wide screens and the page is the scroller on narrow
  // ones. A scroll event does not bubble, but it does reach the document in the capture phase.
  const crossings = new IntersectionObserver(repick, { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });
  const watch = () => {
    crossings.disconnect();
    sections = [...document.querySelectorAll<HTMLElement>('[data-chapter]')];
    for (const section of sections) crossings.observe(section);
    pick();
  };
  watch();
  addEventListener('scroll', repick, { passive: true, capture: true });
  addEventListener('resize', repick, { passive: true });
  document.addEventListener('astro:page-load', watch);

  // Every navigation, including the back button. A second click on the active nav link, or Esc, skips.
  document.addEventListener('astro:after-swap', () => scene.goTo(location.pathname));
  document.addEventListener('click', (e) => (e.target as Element).closest?.('.masthead a[aria-current="page"]') && scene.skip());
  // Clicking what the scene says the pointer is over (a planet in the orrery). The canvas is
  // aria-hidden, so this is a mouse shortcut for a link that also exists in the prose, never the
  // only way to reach the page.
  canvas.addEventListener('click', () => {
    const href = active?.href?.();
    if (href) navigate(href);
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && scene.skip());

  scene.goTo(location.pathname, { instant: true });
  return scene;
}
