// Galaxy model (M2 handoff §4): pure and seeded, shared by the Galaxy tier and the Region backdrops.
// Units ≈ kpc, disc in the XZ plane, core at the origin. No three.js, no Math.random.
import type { Waypoint } from './types';

export interface GalaxyModel {
  /** xyz per star. */
  positions: Float32Array;
  /** Colour temperature per star, kelvin. */
  temperatures: Float32Array;
  /** Angle (radians, atan2(z, x)) of arm `arm` (0 ≤ arm < arms) at radius r. Every non-core waypoint lies on a major arm. */
  armAngleAt(r: number, arm: number): number;
  /** How strong arm `arm` is at radius r, 0..1. */
  armWeightAt(r: number, arm: number): number;
  /** Arc length along an arm per unit radius, 1/sin(pitch): a distance across an arm times this is one around the disc. */
  along: number;
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

const ARMS = 4; // the even ones are major and carry the places; the odd ones, between them, are minor
const BEND = 0.25; // width of an arm's bend around a place, in ln(r)
const ARM_END = [16, 14.2, 15.3, 14.8]; // kpc where each arm has faded out; places reach 11
const MINOR = 0.3; // a minor arm's strength, once it has emerged
const OPEN = 1 / Math.tan((18 * Math.PI) / 180); // winding per unit ln(r) inward of the places, where nothing pins it

const smooth = (lo: number, hi: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};
/** Each arm fades out over its own last 3 kpc, rather than all of them on one circle; a minor one emerges mid-disc. */
const armWeightAt = (r: number, arm: number) => smooth(ARM_END[arm], ARM_END[arm] - 3, r) * (arm % 2 ? MINOR * smooth(3, 6, r) : 1);

/**
 * A grand design: two major logarithmic arms and two minor ones between them, θ = φ + k·π/2 + wind(ln r) + bend(r).
 * Across the places wind is ln(r)/b, b = tan(pitch); pitch (8°–25°) and φ are searched so the places sit as close to
 * the major arms as they can, then each is bent by a sum of gaussians in ln(r), solved so it passes exactly through
 * every place assigned to it. Two arms through these places wind tight (~9°), so inward of them, where nothing pins
 * the arms, they open out to OPEN as they leave the bulge: a coil of rings round the core reads as a target.
 */
function spiral(waypoints: Waypoint[]) {
  const places = waypoints
    .map((w) => ({ r: Math.hypot(w.pos[0], w.pos[2]), a: Math.atan2(w.pos[2], w.pos[0]) }))
    .filter((p) => p.r >= CORE)
    .map((p) => ({ ...p, lr: Math.log(p.r) }));
  const step = TAU / ARMS;
  const lo = places.length ? Math.min(...places.map((p) => p.lr)) - 0.15 : -Infinity;
  const soft = (x: number) => 0.15 * Math.log1p(Math.exp(x / 0.15)); // max(x, 0), rounded over ~0.3 in ln(r)
  const wind = (lr: number, b: number) => lr / b - (OPEN - 1 / b) * soft(lo - lr);
  /** Signed angle to the nearest major arm, and which arm. */
  const nearest = (a: number) => {
    const k = Math.round(wrap(a) / (2 * step));
    return { e: wrap(a) - 2 * k * step, arm: (2 * k) % ARMS };
  };
  const residuals = (b: number, phi: number) => places.map((p) => nearest(p.a - wind(p.lr, b) - phi));

  let pitch = 8, phi = 0, worst = Infinity;
  for (let deg = 8; places.length && deg <= 25; deg += 0.05) {
    const b = Math.tan((deg * Math.PI) / 180);
    const wound = places.map((p) => p.a - wind(p.lr, b)); // the phase doesn't change it
    for (let f = 0; f < 2 * step; f += 0.008) {
      let w = 0;
      wound.forEach((a, i) => (w = Math.max(w, Math.abs(nearest(a - f).e) * places[i].r)));
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

  const armAngleAt = (r: number, arm: number) => {
    const lr = Math.log(Math.max(r, 1e-3));
    let bend = 0;
    for (let i = 0; i < n; i++) if (res[i].arm === arm) bend += weights[i] * g(lr - places[i].lr);
    return phi + arm * step + wind(lr, b) + bend;
  };
  // ponytail: one along, the places' pitch; inward of them the arms open out and read up to ~2x broader across.
  // Per-radius along (from wind's slope) if that shows.
  return { armAngleAt, along: 1 / Math.sin((pitch * Math.PI) / 180) };
}

export function galaxyModel(seed: number, count: number, waypoints: Waypoint[]): GalaxyModel {
  const { armAngleAt, along } = spiral(waypoints);

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

  let cx = 0, cz = 0, left = 0; // the open association
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
      // Arm: an exponential disc wrapped along the arms, each as strong as it is there, with a gaussian cross-section.
      let r: number, arm: number;
      do {
        r = discRadius(1.4, 4.2);
        arm = Math.floor(rand() * ARMS);
      } while (rand() > armWeightAt(r, arm));
      const width = 0.12 + 0.018 * r; // across the arm, kpc
      const off = gauss() * width;
      const a = armAngleAt(r, arm) + (off * along) / r;
      x = r * Math.cos(a);
      z = r * Math.sin(a);
      y = gauss() * 0.1;
      // Young, hot stars trace the arm's spine, born together within ~80 pc: the first of each association
      // sets where the rest gather. Mostly sparse ones, a few rich: equal knots would read as a string of
      // pearls. The rest of the arm is ordinary.
      if (Math.abs(off) < width * 0.6 && rand() < 0.35) {
        if (left > 0) {
          left--;
          x = cx + gauss() * 0.08;
          z = cz + gauss() * 0.08;
        } else {
          cx = x;
          cz = z;
          left = 2 + Math.floor(45 * Math.pow(rand(), 4));
        }
        t = logBetween(8500, 30000);
      } else t = between(3600, 7000);
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

  return { positions, temperatures, armAngleAt, armWeightAt, along, arms: ARMS };
}
