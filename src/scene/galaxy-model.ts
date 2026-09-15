// Galaxy model (M2 handoff §4): pure and seeded, shared by the Galaxy tier and the Region backdrops.
// Units ≈ kpc, disc in the XZ plane, core at the origin. No three.js, no Math.random.
import type { Waypoint } from './types';

export interface GalaxyModel {
  /** xyz per star. */
  positions: Float32Array;
  /** Colour temperature per star, kelvin. */
  temperatures: Float32Array;
  /** Angle (radians, atan2(z, x)) of arm `arm` (0 ≤ arm < arms) at radius r. Every non-core waypoint lies on an arm. */
  armAngleAt(r: number, arm: number): number;
  /** Number of arms, for armAngleAt. */
  arms: number;
}

export const DISC_RADIUS = 15;
/** The one galaxy: both tiers pass this so the Region backdrop matches the Galaxy tier. */
export const SEED = 20260914;
const CORE = 1; // waypoints closer than this to the axis are the core, not an arm
const TAU = Math.PI * 2;

/** mulberry32: small, fast, good enough for star fields. */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrap = (a: number) => ((a % TAU) + TAU) % TAU;

const ARMS = 4;
const BEND = 0.25; // width of an arm's bend around a place, in ln(r)

/**
 * A four-armed logarithmic spiral, θ = φ + k·π/2 + ln(r)/b + bend(r), b = tan(pitch). Pitch (12°–25°, an open
 * Sb–Sc spiral) and φ are searched so the places sit as close to the arms as they can; then each arm is bent by a
 * sum of gaussians in ln(r), solved so it passes exactly through every place assigned to it.
 */
function spiral(waypoints: Waypoint[]) {
  const places = waypoints
    .map((w) => ({ r: Math.hypot(w.pos[0], w.pos[2]), a: Math.atan2(w.pos[2], w.pos[0]) }))
    .filter((p) => p.r >= CORE)
    .map((p) => ({ ...p, lr: Math.log(p.r) }));
  const step = TAU / ARMS;
  /** Signed angle to the nearest arm, and which arm. */
  const nearest = (a: number) => {
    const k = Math.round(wrap(a) / step);
    return { e: wrap(a) - k * step, arm: k % ARMS };
  };
  const residuals = (b: number, phi: number) => places.map((p) => nearest(p.a - p.lr / b - phi));

  let pitch = 12, phi = 0, worst = Infinity;
  for (let deg = 12; places.length && deg <= 25; deg += 0.05) {
    const b = Math.tan((deg * Math.PI) / 180);
    for (let f = 0; f < step; f += 0.004) {
      let w = 0;
      residuals(b, f).forEach(({ e }, i) => (w = Math.max(w, Math.abs(e) * places[i].r)));
      if (w < worst - 1e-9) (worst = w), (pitch = deg), (phi = f);
    }
  }
  const b = Math.tan((pitch * Math.PI) / 180);
  const res = residuals(b, phi);
  const g = (d: number) => Math.exp((-d * d) / (2 * BEND * BEND));

  // Solve Σⱼ wⱼ·g(lrᵢ − lrⱼ) = eᵢ over places on the same arm (Gauss-Jordan; n is tiny).
  const n = places.length;
  const m = places.map((p, i) => [
    ...places.map((q, j) => (res[i].arm === res[j].arm ? g(p.lr - q.lr) : 0) + (i === j ? 1e-9 : 0)),
    res[i].e,
  ]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    [m[c], m[piv]] = [m[piv], m[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  const weights = m.map((row, i) => row[n] / row[i]);

  return (r: number, arm: number) => {
    const lr = Math.log(Math.max(r, 1e-3));
    let bend = 0;
    for (let i = 0; i < n; i++) if (res[i].arm === arm) bend += weights[i] * g(lr - places[i].lr);
    return phi + arm * step + lr / b + bend;
  };
}

export function galaxyModel(seed: number, count: number, waypoints: Waypoint[]): GalaxyModel {
  const armAngleAt = spiral(waypoints);

  const rand = prng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(TAU * rand());
  const between = (lo: number, hi: number) => lo + (hi - lo) * rand();
  const logBetween = (lo: number, hi: number) => lo * Math.pow(hi / lo, rand());
  /** Exponential disc radius with scale h, from r0, rejected past the disc edge. */
  const discRadius = (r0: number, h: number) => {
    for (;;) {
      const r = r0 - h * Math.log(1 - rand());
      if (r <= DISC_RADIUS) return r;
    }
  };

  const positions = new Float32Array(count * 3);
  const temperatures = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const kind = rand();
    let x: number, y: number, z: number, t: number;
    if (kind < 0.24) {
      // Bulge: old, cool, centrally concentrated, slightly flattened.
      const s = 1.15 * Math.pow(rand(), 0.8);
      x = gauss() * s;
      y = gauss() * s * 0.6;
      z = gauss() * s;
      t = between(3000, 5400);
    } else if (kind < 0.8) {
      // Arm: an exponential disc wrapped along one arm, with a gaussian cross-section.
      const r = discRadius(1.4, 4.2);
      const width = 0.45 + 0.07 * r;
      const off = gauss() * width;
      const a = armAngleAt(r, Math.floor(rand() * ARMS)) + off / r;
      x = r * Math.cos(a);
      z = r * Math.sin(a);
      y = gauss() * 0.1;
      // Young, hot stars trace the arm's spine; the rest of the arm is ordinary.
      t = Math.abs(off) < width * 0.6 && rand() < 0.35 ? logBetween(8500, 30000) : between(3600, 7000);
    } else {
      // Inter-arm disc.
      const r = discRadius(0.8, 5);
      const a = TAU * rand();
      x = r * Math.cos(a);
      z = r * Math.sin(a);
      y = gauss() * 0.2;
      t = between(3000, 6800);
    }
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    temperatures[i] = t;
  }

  return { positions, temperatures, armAngleAt, arms: ARMS };
}
