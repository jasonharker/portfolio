// The 3D scene. Loaded by Base.astro with a dynamic import() after first paint, and only
// once the gates there have passed, so everything three.js pulls in stays in this chunk.
import * as THREE from 'three';
import { topology } from './data';
import { createFlight } from './flight';
import { createLoop } from './loop';
import { quality } from './quality';
import { createStill } from './reduced-motion';
import { placeFor } from './routes';
import { galaxy } from './tiers/galaxy';
import { region } from './tiers/region';
import type { CameraPose, Scene, SceneContext, SceneDebug, Tier, TierId } from './types';

export function start(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, labels: HTMLElement): Scene {
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  renderer.setPixelRatio(quality.dpr);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  const css = getComputedStyle(document.documentElement);

  const ctx: SceneContext = {
    renderer, camera, topology, quality, labels,
    colour: (token) => new THREE.Color(css.getPropertyValue(token).trim()),
    invalidate: () => loop.invalidate(),
  };

  const tiers: Record<TierId, Tier> = { galaxy, region };
  const loading = new Map<TierId, Promise<Tier>>();
  let active: Tier | null = null;
  let pose: CameraPose = { position: [0, 0, 1], target: [0, 0, 0], fov: 50 };

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
    },
    current: () => ({ tier: active?.id ?? null, pose }),
    pose(p) {
      pose = p;
      camera.position.set(...p.position);
      camera.lookAt(...p.target);
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
    get paused() { return loop.paused; },
  };
  canvas.dataset.born = debug.born;
  (window as unknown as { __scene: SceneDebug }).__scene = debug;

  const loop = createLoop((dt) => {
    const flying = (debug.flying = director.update(dt));
    const moving = active?.update(dt) ?? false;
    active?.render(renderer, camera);
    debug.frames++;
    return flying || moving;
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

  // Mouse only: touch has no hover, and a drag is a scroll.
  const hover = (e: PointerEvent) => e.pointerType === 'mouse' && active?.hover?.(e.clientX, e.clientY);
  addEventListener('pointermove', hover, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => active?.hover?.(NaN, NaN));

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
    skip: () => (director.skip(), loop.invalidate()),
    invalidate: () => loop.invalidate(),
  };

  // Every navigation, including the back button. A second click on the active nav link, or Esc, skips.
  document.addEventListener('astro:after-swap', () => scene.goTo(location.pathname));
  document.addEventListener('click', (e) => (e.target as Element).closest?.('.masthead a[aria-current="page"]') && scene.skip());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && scene.skip());

  scene.goTo(location.pathname, { instant: true });
  return scene;
}
