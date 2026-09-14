// Render only while something moves. step() returns true to keep going; invalidate() wakes it.
export function createLoop(step: (dt: number) => boolean) {
  let raf = 0;
  let last = 0;
  const paused = new Set<string>();

  const tick = (t: number) => {
    raf = 0;
    const dt = last ? Math.min((t - last) / 1000, 0.1) : 0;
    last = t;
    if (step(dt) && !paused.size) raf = requestAnimationFrame(tick);
    else last = 0;
  };
  const invalidate = () => {
    if (!raf && !paused.size) raf = requestAnimationFrame(tick);
  };

  return {
    invalidate,
    /** Pause for a named reason ('hidden', 'covered'); runs again once no reason remains. */
    pause(reason: string, on: boolean) {
      if (on) paused.add(reason);
      else paused.delete(reason);
      if (paused.size && raf) (cancelAnimationFrame(raf), (raf = 0), (last = 0));
      else invalidate();
    },
    get idle() { return !raf; },
    get paused() { return paused.size > 0; },
  };
}
