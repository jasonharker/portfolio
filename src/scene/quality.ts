import type { Quality } from './types';

// ponytail: desktop tier only. The mobile tier (DPR 1, ~half counts, no bloom) is M3.
export const quality: Quality = {
  dpr: Math.min(devicePixelRatio, 1.5),
  stars: 60000,
  bloom: true,
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
};
