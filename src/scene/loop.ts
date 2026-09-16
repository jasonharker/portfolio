// Full rate while something moves: step() returns true to keep going, invalidate() wakes it.
// With `ambient` on (not under reduced motion), a still scene keeps its idle animation (twinkle,
// drift) at no more than 30 fps; without it, the loop idles fully. Paused reasons stop both.
const AMBIENT_MS = 1000 / 30;

export type Rate = 'full' | 'ambient' | 'idle';

export function createLoop(step: (dt: number) => boolean, ambient: boolean) {
  let raf = 0;
  let last = 0;
  let full = true; // the next frame renders as soon as it comes
  let due = 0; // earliest rAF time for the next ambient frame
  const paused = new Set<string>();
  const schedule = () => void (raf ||= requestAnimationFrame(tick));

  function tick(t: number) {
    raf = 0;
    // Ambient frames keep a 30 fps grid: `due` advances by a whole interval per frame, so the
    // average rate can't exceed it however rAF jitters. 1 ms slack absorbs timestamp rounding.
    if (!full && t < due - 1) return schedule();
    const dt = last ? Math.min((t - last) / 1000, 0.1) : 0;
    last = t;
    const wasFull = full;
    // An invalidate() from inside step() (a tier, say) sets `full` again and must survive it.
    full = false;
    full = step(dt) || full;
    if (paused.size) return void (last = 0);
    if (full || ambient) {
      due = wasFull || t > due + AMBIENT_MS ? t + AMBIENT_MS : due + AMBIENT_MS;
      schedule();
    } else last = 0;
  }
  const invalidate = () => {
    full = true;
    if (!paused.size) schedule();
  };

  return {
    invalidate,
    /** Pause for a named reason ('hidden', 'covered'); runs again once no reason remains. */
    pause(reason: string, on: boolean) {
      const was = paused.size > 0;
      if (on) paused.add(reason);
      else paused.delete(reason);
      if (paused.size) (raf && cancelAnimationFrame(raf), (raf = 0), (last = 0));
      else if (was) invalidate(); // only on the transition: scroll calls this on every event
    },
    get idle() { return !raf; },
    get rate(): Rate { return !raf ? 'idle' : full ? 'full' : 'ambient'; },
    get paused() { return paused.size > 0; },
  };
}
