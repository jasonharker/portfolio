// Flights (spec §3): Region at the origin, cut to Galaxy, pan, cut to Region at the destination.
// A flight is an array of beats, so M3 can put a Local beat at either end without a rewrite.
import type { CameraPose, Director, PlaceId, Stage, Tier, TierId, Vec3 } from './types';

interface Beat {
  tier: TierId;
  place?: PlaceId; // the place a region beat frames
  dur: number; // seconds
  ease: (k: number) => number;
  // Read when the beat starts, never earlier: a tier's frame() may switch what it shows.
  // No `from` means start where the camera already is.
  enter(): { from?: CameraPose; to: CameraPose };
}

const BLUR_PX = 6; // peak canvas blur at a cut
const BLUR_S = 0.16; // ramp into a cut and decay out of it
const easeIn = (k: number) => k * k * k;
const easeOut = (k: number) => 1 - (1 - k) ** 3;
const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const mix = (a: Vec3, b: Vec3, k: number) => a.map((v, i) => v + (b[i] - v) * k) as Vec3;
const lerp = (a: CameraPose, b: CameraPose, k: number): CameraPose => ({
  position: mix(a.position, b.position, k), target: mix(a.target, b.target, k), fov: a.fov + (b.fov - a.fov) * k,
});
// Pulled back along the view line with a wider lens: the whoosh either side of a cut. Unit-free.
const back = (p: CameraPose): CameraPose => ({ position: mix(p.target, p.position, 2.2), target: p.target, fov: p.fov + 20 });
const same = (a: CameraPose, b: CameraPose) => [...a.position, ...a.target, a.fov].every((v, i) => Math.abs(v - [...b.position, ...b.target, b.fov][i]) < 1e-6);

export function createFlight(stage: Stage): Director {
  const canvas = stage.ctx.renderer.domElement;
  const tiers = {} as Record<TierId, Tier>;
  // Warm both tiers now so the first flight doesn't wait on a load.
  const ready = Promise.all((['region', 'galaxy'] as const).map((id) => stage.tier(id).then((t) => (tiers[id] = t))));

  let beats: Beat[] = [];
  let t = 0; // seconds into beats[0]
  let started = false; // beats[0] has cut and read its poses
  let from: CameraPose;
  let to: CameraPose;
  let shown: PlaceId | null = null; // what the region tier frames, or last framed before the galaxy cut
  let dest: PlaceId | null = null;
  let kick = 0; // post-cut blur, 1 -> 0
  let gen = 0; // bumps on every request, so a load that resolves late can't act on a stale one
  let pending = false;

  const blur = (k: number) => (canvas.style.filter = k > 0.01 ? `blur(${(k * BLUR_PX).toFixed(2)}px)` : '');
  const stop = () => ((beats = []), (started = false), (t = 0), (kick = 0), blur(0));
  const when = (fn: () => void) => {
    const g = ++gen;
    pending = true;
    ready.then(() => g === gen && ((pending = false), fn(), stage.ctx.invalidate()));
  };
  const land = (place: PlaceId) => {
    stop();
    stage.cut('region');
    stage.pose(tiers.region.frame(place));
    shown = dest = place;
  };

  const plan = (place: PlaceId) => {
    const { tier, pose } = stage.current();
    if (!tier) return land(place);
    const s = place === 'constellation' || shown === 'constellation' ? 0.72 : 1; // Landing starts at Region
    const origin = shown!;
    stop();
    dest = place;
    if (tier === 'region' && origin === place) {
      const f = tiers.region.frame(place);
      if (same(pose, f)) return land(place);
      beats = [{ tier: 'region', place, dur: 0.5 * s, ease: easeInOut, enter: () => ({ to: f }) }];
      return;
    }
    if (tier === 'region') beats.push({ tier: 'region', place: origin, dur: 0.5 * s, ease: easeIn, enter: () => ({ to: back(tiers.region.frame(origin)) }) });
    beats.push({
      tier: 'galaxy', dur: 1.4 * s, ease: easeInOut,
      enter: () => ({ from: tier === 'galaxy' ? undefined : tiers.galaxy.frame(origin), to: tiers.galaxy.frame(place) }),
    });
    beats.push({
      tier: 'region', place, dur: 0.6 * s, ease: easeOut,
      enter: () => { const f = tiers.region.frame(place); return { from: back(f), to: f }; },
    });
  };

  return {
    to(place, { instant }) {
      if (place === 'resume') {
        // Not a place: freeze wherever we are. With nothing shown yet, a pending request still lands.
        if (stage.current().tier) return (gen++, (pending = false), stop());
        if (!pending) when(() => land('constellation'));
        return;
      }
      if (!instant && beats.length && dest === place) return; // already flying there
      dest = place;
      when(() => (instant ? land(place) : plan(place)));
    },
    skip() {
      if (beats.length) land(dest!);
      else if (pending && dest) when(() => land(dest!));
    },
    update(dt) {
      if (!beats.length) return false;
      t += dt;
      let b: Beat;
      for (;;) {
        b = beats[0];
        if (!started) {
          started = true;
          if (stage.current().tier !== b.tier) kick = 1;
          stage.cut(b.tier);
          if (b.place) shown = b.place;
          const p = b.enter();
          from = p.from ?? stage.current().pose;
          to = p.to;
        }
        if (t < b.dur) break;
        t -= b.dur;
        stage.pose(to);
        beats.shift();
        started = false;
        if (!beats.length) return (stop(), false);
      }
      const next = beats[1];
      const ramp = next && next.tier !== b.tier ? 1 - (b.dur - t) / BLUR_S : 0;
      blur(Math.max(kick, ramp));
      kick = Math.max(0, kick - dt / BLUR_S);
      stage.pose(lerp(from, to, b.ease(t / b.dur)));
      return true;
    },
  };
}
