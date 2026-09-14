// W0 stub director: cuts straight to the destination. Replaced by flight.ts and reduced-motion.ts.
import type { Director, Stage } from './types';

export function createDirector(stage: Stage): Director {
  return {
    to(place) {
      // Resume freezes wherever we are (.resume .scene dims it); a deep link to it shows the constellation.
      if (place === 'resume' && stage.current().tier) return;
      const at = place === 'resume' ? 'constellation' : place;
      stage.tier('region').then((t) => (stage.cut('region'), stage.pose(t.frame(at)), stage.ctx.invalidate()));
    },
    skip() {},
    update: () => false,
  };
}
