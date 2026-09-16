"""Look-dev screenshots of dist/. usage: SHOTS_DIR=<dir> ONLY=landing,gitops,galaxy,region,hover shots.py <prefix>"""
import sys, time
sys.path.insert(0, __import__('os').path.dirname(__file__))
import scene as S
from playwright.sync_api import sync_playwright

prefix = sys.argv[1]
import os
extra = True
ONLY = os.environ.get('ONLY', 'landing,gitops,galaxy,region,hover').split(',')
OUT = os.environ.get('SHOTS_DIR', '.').rstrip('/') + '/'
# Virtual clock: every rAF batch advances 50 ms, so flights are frame-stepped and reproducible.
# window.__holdAfter = K holds all callbacks K frames after the first flying frame.
INIT = """
(() => {
  const raf = window.requestAnimationFrame.bind(window);
  let n = 0, start = -1, queue = [], pumping = false;
  const pump = () => {
    pumping = false;
    const s = window.__scene;
    if (s && window.__holdAfter != null) {
      if (start < 0 && s.flying) start = s.frames;
      if (start >= 0 && s.frames - start >= window.__holdAfter) { window.__held = true; return; }
    }
    const q = queue; queue = [];
    n++;
    const t = n * (window.__step || 50);
    for (const [id, cb] of q) if (!cancelled.has(id)) cb(t);
  };
  const cancelled = new Set();
  let ids = 0;
  window.requestAnimationFrame = (cb) => { const id = ++ids; queue.push([id, cb]); if (!pumping) { pumping = true; raf(pump); } return id; };
  window.cancelAnimationFrame = (id) => cancelled.add(id);
})();
"""

srv, B = S.serve(S.DIST)
with sync_playwright() as p:
    br = p.chromium.launch(**S.CHROMIUM)
    ctx = br.new_context(viewport={'width': 1920, 'height': 1080}, device_scale_factor=1.5)
    ctx.add_init_script(INIT)

    def page(path):
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: print('PAGEERROR', e))
        pg.on('console', lambda m: m.type in ('error', 'warning') and print('CONSOLE', m.text))
        pg.goto(B + path)
        S.scene_up(pg)
        pg.wait_for_timeout(1500)
        return pg

    def still(pg, name, clip=None):
        pg.wait_for_timeout(800)
        pg.screenshot(path=OUT + f'{prefix}-{name}.png', clip=clip)
        print('saved', name, flush=True)

    if 'landing' in ONLY:
        pg = page('/')
        still(pg, 'landing')
        pg.close()

    if 'gitops' in ONLY or 'galaxy' in ONLY:
        pg = page('/gitops/')
        if 'gitops' in ONLY: still(pg, 'gitops')
        if 'galaxy' in ONLY:
            # Mid Galaxy beat, gitops -> incidents: region pull-back 0.5 s, galaxy pan 1.4 s; hold at 1.2 s.
            pg.evaluate('window.__holdAfter = 24')
            pg.click('nav a[href="/incidents/"]')
            S.wait(pg, 'window.__held === true', 120)
            pg.wait_for_timeout(500)
            pg.screenshot(path=OUT + f'{prefix}-galaxy-beat.png')
            print('saved galaxy-beat', flush=True)
        pg.close()

    if extra and 'region' in ONLY:
        pg = page('/incidents/')
        still(pg, 'region-incidents')
        pg.close()
    if extra and 'hover' in ONLY:
        pg = page('/')
        el = pg.locator('.scene-label[data-node="flux"]')
        box = el.bounding_box()
        pg.mouse.move(box['x'] + 10, box['y'] + box['height'] / 2)
        pg.wait_for_timeout(1500)
        cx, cy = box['x'], box['y'] + box['height'] / 2
        still(pg, 'hover', clip={'x': max(0, cx - 360), 'y': max(0, cy - 200), 'width': 720, 'height': 400})
        pg.close()
    br.close()
srv.shutdown()
