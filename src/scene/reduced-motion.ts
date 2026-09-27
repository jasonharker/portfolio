// prefers-reduced-motion (spec §3): one still frame per place, no flights. The crossfade is the
// page's own root view transition: the persisted canvas has no view-transition-name, so it sits in
// the root snapshot and fades with the prose. The still must therefore change within the swap
// (astro:after-swap runs inside the transition's update callback), never after it.
import { CROSSOVER } from './flight';
import type { Director, PlaceId, Stage } from './types';

export function createStill(stage: Stage): Director {
  // Every place is framed by Region (M4); resume's overhead frame is drawn by Galaxy, loaded on first use.
  const region = stage.tier('region');
  let gen = 0;
  let pending = false;

  const show = (place: PlaceId) => {
    const g = ++gen;
    pending = true;
    region.then(async (t) => {
      const pose = t.frame!(place);
      // The same rule as a flight's level(): the tier follows the view distance.
      const id = Math.hypot(...pose.position.map((v, i) => v - pose.target[i])) > CROSSOVER ? 'galaxy' : 'region';
      await stage.tier(id);
      if (g !== gen) return;
      pending = false;
      stage.cut(id);
      stage.pose(pose);
      stage.ctx.invalidate();
    });
  };

  return {
    to(place) {
      show(place);
    },
    skip() {},
    update: () => false,
  };
}
