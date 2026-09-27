// Flights (M4). A flight is one continuous dolly, not a sequence of beats: the camera arcs out from
// the place it is reading, across the disc, and back down into the next one, in a single move with
// nothing cut and nothing blurred. What makes that possible is one space — every pose here is in
// galaxy units (kpc), and a place's own scale lives in its group, not in the camera (tiers/region.ts).
//
// The path: the target slides from one waypoint to the other, the view direction slerps, and the
// *logarithm* of the view distance runs along a quadratic through a cruise altitude. Constant
// d(log r)/dt is what a zoom across scales has to be to read as one speed rather than a lunge —
// a metre per second means nothing when the frame is 30,000 light years wide, and everything when
// it is 30 wide. The ease then spends the time at the two ends, where there is something to look at.
//
// The tier follows from the distance rather than from a beat: above CROSSOVER the Galaxy tier draws,
// below it Region does, and both draw the same seeded galaxy from the same pose, so the swap is a
// change of level of detail rather than a change of place.
import type { CameraPose, Director, PlaceId, Stage, Tier, TierId, Vec3 } from './types';

export const CROSSOVER = 8; // kpc: Galaxy above, Region below
const DUR = 2.4; // seconds, place to place
const NEAR_DUR = 0.6; // seconds for a reframe that never leaves the place
const OPEN_DUR = 2.6; // seconds for the push-in the site opens with
const OPEN_BACK = 3; // how far out that push-in starts, as a multiple of the reading distance
const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const mix = (a: Vec3, b: Vec3, k: number) => a.map((v, i) => v + (b[i] - v) * k) as Vec3;
const sub = (a: Vec3, b: Vec3) => a.map((v, i) => v - b[i]) as Vec3;
const len = (a: Vec3) => Math.hypot(...a);
const scale = (a: Vec3, k: number) => a.map((v) => v * k) as Vec3;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3) => scale(a, 1 / len(a));
/** `u` made square to the unit view axis `d`: the screen up a camera looking along `d` can have. */
const square = (u: Vec3, d: Vec3) => unit(sub(u, scale(d, dot(u, d))));
/** A pose's screen up, given its unit axis from target to camera: its own, or world Y as lookAt makes it. */
const upOf = (p: CameraPose, d: Vec3) => p.up ?? square([0, 1, 0], d);
const same = (a: CameraPose, b: CameraPose) => [...a.position, ...a.target].every((v, i) => Math.abs(v - [...b.position, ...b.target][i]) < 1e-9);

/** Shortest-arc interpolation between two unit vectors; falls back to a lerp when they're close. */
function slerp(a: Vec3, b: Vec3, k: number): Vec3 {
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-3) return a.map((v, i) => v + (b[i] - v) * k) as Vec3;
  const s = Math.sin(omega);
  const [wa, wb] = [Math.sin((1 - k) * omega) / s, Math.sin(k * omega) / s];
  return a.map((v, i) => v * wa + b[i] * wb) as Vec3;
}

export function createFlight(stage: Stage): Director {
  const tiers = {} as Record<TierId, Tier>;
  // Warm both tiers now so the first flight doesn't wait on a load.
  const ready = Promise.all((['region', 'galaxy'] as const).map((id) => stage.tier(id).then((t) => (tiers[id] = t))));

  let flying = false;
  let t = 0; // seconds into the flight
  let dur = DUR;
  let from: CameraPose;
  let to: CameraPose;
  // The dolly, precomputed at the start: view direction and log-distance at each end, and the middle
  // control point of the quadratic through them.
  let dir0: Vec3, dir1: Vec3, l0 = 0, l1 = 0, lc = 0;
  // Screen up at each end, when either end sets its own (resume's overhead). The roll turns across
  // the whole flight; left to lookAt it held still and then swung ~40° in the last few frames.
  let turn: [Vec3, Vec3] | null = null;
  let dest: PlaceId | null = null;
  let opened = false; // the push-in the site opens with has been spent
  let gen = 0; // bumps on every request, so a load that resolves late can't act on a stale one
  let pending = false;

  const frame = (place: PlaceId) => tiers.region.frame!(place);
  /** The tier that draws at this view distance. Called every frame: a flight crosses it twice. */
  const level = (r: number) => stage.cut(r > CROSSOVER ? 'galaxy' : 'region');
  const stop = () => ((flying = false), (t = 0));
  const when = (fn: () => void) => {
    const g = ++gen;
    pending = true;
    ready.then(() => g === gen && ((pending = false), fn(), stage.ctx.invalidate()));
  };
  const land = (place: PlaceId) => {
    stop();
    const pose = frame(place);
    level(len(sub(pose.position, pose.target)));
    stage.pose(pose);
    dest = place;
  };

  // The site opens by pushing in, not by cutting to its mark: the camera starts three times the
  // reading distance out along the same sightline and comes down the log ramp to it. It is the
  // ordinary dolly with a synthesised start, so nothing here is a second kind of move — and it stays
  // inside the Region tier (3 × 2.2 kpc is under CROSSOVER), so the open never swaps a tier.
  //
  // Only for the landing page. A deep link to a place is an arrival, and lands instantly.
  const approach = (place: PlaceId) => {
    to = frame(place);
    const r = len(sub(to.position, to.target));
    dir0 = dir1 = scale(sub(to.position, to.target), 1 / r);
    from = { position: to.target.map((v, i) => v + dir0[i] * r * OPEN_BACK) as Vec3, target: to.target, fov: to.fov };
    [l0, l1, lc] = [Math.log(r * OPEN_BACK), Math.log(r), Math.log(r * (OPEN_BACK + 1)) - Math.log(2)];
    turn = to.up ? [to.up, to.up] : null; // a push-in along one axis doesn't roll
    from.up = to.up;
    dest = place;
    dur = OPEN_DUR;
    t = 0;
    flying = true;
    // Put the camera at the far end before the first frame draws, or the open starts from wherever
    // the default camera happened to be pointing.
    level(r * OPEN_BACK);
    stage.pose(from);
  };

  const plan = (place: PlaceId) => {
    const { tier, pose } = stage.current();
    if (!tier) return land(place);
    const target = frame(place);
    if (same(pose, target)) return land(place);
    from = pose;
    to = target;
    dest = place;
    dir0 = scale(sub(from.position, from.target), 1 / (l0 = len(sub(from.position, from.target))));
    dir1 = scale(sub(to.position, to.target), 1 / (l1 = len(sub(to.position, to.target))));
    [l0, l1] = [Math.log(l0), Math.log(l1)];
    turn = from.up || to.up ? [upOf(from, dir0), upOf(to, dir1)] : null;
    // A move that stays inside the place — a second click on the same page, a resize — has nowhere
    // to climb to: run it straight and short. Otherwise arc out so that at the halfway point the
    // whole disc is in frame, which is what a quadratic through log(CRUISE) at k = 0.5 gives.
    const near = len(sub(from.target, to.target)) < 1;
    dur = near ? NEAR_DUR : DUR;
    // The Galaxy tier already knows the distance at which the whole disc fits this viewport; that
    // is the altitude to arc over, rather than a constant that would clip the disc on a phone.
    const over = tiers.galaxy.frame!(place);
    const cruise = Math.max(len(sub(over.position, over.target)), Math.exp(l0), Math.exp(l1));
    lc = near ? (l0 + l1) / 2 : 2 * Math.log(cruise) - (l0 + l1) / 2;
    t = 0;
    flying = true;
  };

  return {
    to(place, { instant }) {
      if (!instant && flying && dest === place) return; // already flying there
      dest = place;
      const open = instant && !opened && place === 'constellation';
      opened = true;
      when(() => (instant ? (open ? approach(place) : land(place)) : plan(place)));
    },
    skip() {
      if (flying) land(dest!);
      else if (pending && dest) when(() => land(dest!));
    },
    update(dt) {
      if (!flying) return false;
      t += dt;
      if (t >= dur) return (land(dest!), false);
      const k = easeInOut(t / dur);
      const target = mix(from.target, to.target, k);
      const r = Math.exp((1 - k) * (1 - k) * l0 + 2 * (1 - k) * k * lc + k * k * l1);
      const dir = slerp(dir0, dir1, k);
      level(r);
      const up = turn ? square(slerp(turn[0], turn[1], k), dir) : undefined;
      stage.pose({ position: target.map((v, i) => v + dir[i] * r) as Vec3, target, fov: from.fov + (to.fov - from.fov) * k, up });
      return true;
    },
  };
}
