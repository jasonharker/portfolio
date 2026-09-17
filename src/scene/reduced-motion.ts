// prefers-reduced-motion (spec §3): one still frame per place, no flights. The crossfade is the
// page's own root view transition: the persisted canvas has no view-transition-name, so it sits in
// the root snapshot and fades with the prose. The still must therefore change within the swap
// (astro:after-swap runs inside the transition's update callback), never after it.
import type { Director, PlaceId, Stage } from './types';

export function createStill(stage: Stage): Director {
  // Every place is read in Region (M4), so there is one tier to warm.
  const region = stage.tier('region');
  let gen = 0;
  let pending = false;

  const show = (place: PlaceId) => {
    const g = ++gen;
    pending = true;
    region.then((t) => {
      if (g !== gen) return;
      pending = false;
      stage.cut('region');
      stage.pose(t.frame!(place));
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
