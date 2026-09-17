import type { Quality } from './types';

// Two quality tiers, chosen once at startup (spec §5). This is not the 3D gate: whether the scene
// runs at all is decided in Base.astro by WebGL2, saveData and reduced motion, never by device
// class. This only decides how much of it to draw, and both tiers get the same world — same zoom
// tiers, same flights, same places, nothing structurally lesser.
//
// Screen size *and* pointer, because neither alone is the question being asked: a phone is a small
// coarse-pointer screen, while a touchscreen laptop is a large one and can afford the full tier.
const small = matchMedia('(max-width: 48rem)').matches && matchMedia('(pointer: coarse)').matches;

export const quality: Quality = small
  ? {
      dpr: 1,
      stars: 30000,
      regionStars: 70000,
      deepField: 10000,
      foreground: 24,
      brightStars: 600,
      dustScale: 0.4,
      lensScale: 0.35,
      // Bloom is a chain of full-screen passes; on a phone GPU the emissive materials carry the
      // glow on their own well enough to be worth the trade.
      bloom: false,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    }
  : {
      dpr: Math.min(devicePixelRatio, 1.5),
      stars: 60000,
      regionStars: 150000,
      deepField: 24000,
      foreground: 40,
      brightStars: 1200,
      dustScale: 0.5,
      lensScale: 0.5,
      bloom: true,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
