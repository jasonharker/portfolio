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

  const tick = (t: number) => {
    raf = 0;
    // Ambient frames keep a 30 fps grid: `due` advances by a whole interval per frame, so the
    // average rate can't exceed it however rAF jitters. 1 ms slack absorbs timestamp rounding.
    if (!full && t < due - 1) return void (raf = requestAnimationFrame(tick));
    const dt = last ? Math.min((t - last) / 1000, 0.1) : 0;
    last = t;
    const wasFull = full;
    full = step(dt);
    if (paused.size) return void (last = 0);
    if (full || ambient) {
      due = wasFull || t > due + AMBIENT_MS ? t + AMBIENT_MS : due + AMBIENT_MS;
      raf = requestAnimationFrame(tick);
    } else last = 0;
  };
  const invalidate = () => {
    full = true;
    if (!raf && !paused.size) raf = requestAnimationFrame(tick);
  };

  return {
    invalidate,
    /** Pause for a named reason ('hidden', 'covered'); runs again once no reason remains. */
    pause(reason: string, on: boolean) {
      if (on) paused.add(reason);
      else paused.delete(reason);
      if (paused.size && raf) (cancelAnimationFrame(raf), (raf = 0), (last = 0));
      else if (!paused.size) invalidate();
    },
    get idle() { return !raf; },
    get rate(): Rate { return !raf ? 'idle' : full ? 'full' : 'ambient'; },
    get paused() { return paused.size > 0; },
  };
}
