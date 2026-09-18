"""Scene test harness (M2 handoff, W4). Local-run only: Jenkins has no browser.

    npm run build
    uv run --no-project --with playwright python tests/scene.py

Serves dist/ with the production headers read from nginx.conf and drives Chromium
(SwiftShader) through window.__scene (src/scene/types.ts SceneDebug). Waits poll with
page.evaluate: wait_for_function uses eval, which the production CSP blocks. Checks
whose feature hasn't landed yet report SKIP; any FAIL exits non-zero. No fps assertions
(spec §5).
"""

import functools
import http.server
import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'
CHROMIUM = dict(executable_path='/usr/bin/chromium', args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])

results = []


def check(name, ok, detail=''):
    status = 'SKIP' if ok is None else 'PASS' if ok else 'FAIL'
    results.append(status)
    print(f'{status} {name}' + (f'  [{detail}]' if detail else ''), flush=True)


def skip(name, why):
    check(name, None, why)


# --- server -----------------------------------------------------------------------------

def nginx_headers():
    """Server-level add_header directives from nginx.conf (location blocks stripped)."""
    conf = re.sub(r'#.*', '', (ROOT / 'nginx.conf').read_text())
    conf = re.sub(r'location\b[^{]*\{[^}]*\}', '', conf)
    headers = re.findall(r'add_header\s+(\S+)\s+"([^"]*)"', conf)
    if not any(k == 'Content-Security-Policy' for k, _ in headers):
        sys.exit('nginx.conf has no server-level Content-Security-Policy add_header')
    return headers


def serve(root):
    headers = nginx_headers()

    class Handler(http.server.SimpleHTTPRequestHandler):
        def end_headers(self):
            for k, v in headers:
                self.send_header(k, v)
            super().end_headers()

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(root)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f'http://127.0.0.1:{srv.server_address[1]}'


# --- page helpers -----------------------------------------------------------------------

csp_hits, page_errors = [], []


def watch(page, label):
    page.on('console', lambda m: ('Content Security Policy' in m.text) and csp_hits.append(f'{label}: {m.text}'))
    page.on('pageerror', lambda e: page_errors.append(f'{label}: {e}'))
    page.add_init_script("addEventListener('securitypolicyviolation', e => (window.__csp = window.__csp || []).push(e.violatedDirective + ' ' + e.blockedURI))")
    return page


def drain_csp(page, label):
    try:
        csp_hits.extend(f'{label}: {v}' for v in page.evaluate('window.__csp || []'))
    except Exception:
        pass


def wait(page, js, timeout=8.0, fail=True):
    end = time.time() + timeout
    while time.time() < end:
        if page.evaluate(js):
            return True
        time.sleep(0.03)
    if fail:
        raise TimeoutError(f'{js} | path={page.evaluate("location.pathname")}')
    return False


def scene_up(page):
    wait(page, 'window.__scene && __scene.frames >= 1')


def sample_flying(page, seconds):
    """True if __scene.flying was seen during the window."""
    end = time.time() + seconds
    seen = False
    while time.time() < end:
        seen = seen or page.evaluate('__scene.flying')
        time.sleep(0.025)
    return seen


def fly(page, click, path, start_timeout=10.0, max_flight=60.0):  # SwiftShader under load: seconds per frame
    """Click, wait for the swap, then watch the flight. Returns (flew, seconds from click to landing)."""
    t0 = time.time()
    page.click(click)
    wait(page, f'location.pathname === {path!r} && __scene.path === {path!r}')
    end = time.time() + start_timeout
    while time.time() < end and not page.evaluate('__scene.flying'):
        time.sleep(0.02)
    if not page.evaluate('__scene.flying'):
        return False, 0.0
    wait(page, '!__scene.flying', max_flight)
    return True, time.time() - t0


def settle(page):
    wait(page, "!__scene.flying && __scene.rate !== 'full'", 45)  # SwiftShader: ~1-3 fps, and every click eases the parallax


def frames_over(page, ms=600):
    """Frames rendered during a window."""
    a = page.evaluate('__scene.frames')
    page.wait_for_timeout(ms)
    return page.evaluate('__scene.frames') - a


def stopped_then_resumed(page, stop, resume):
    """(stopped, resumed, detail): ambient frames stop while `stop` holds and come back after `resume`.
    A SwiftShader frame can take seconds, and events queue behind it, so every step polls."""
    f0 = page.evaluate('__scene.frames')
    running = wait(page, f'__scene.frames > {f0}', 15, fail=False)
    stop()
    paused = wait(page, "__scene.paused && __scene.rate === 'idle'", 15, fail=False)
    page.wait_for_timeout(300)  # a frame already under way when the pause landed
    held = frames_over(page, 1500)
    f1 = page.evaluate('__scene.frames')
    resume()
    resumed = wait(page, f"!__scene.paused && __scene.frames > {f1}", 15, fail=False)
    ambient = wait(page, "__scene.rate === 'ambient'", 15, fail=False)
    st = page.evaluate('({paused: __scene.paused, rate: __scene.rate, frames: __scene.frames})')
    return (running and paused and held == 0, resumed and ambient,
            f'running={running} paused={paused} frames while paused={held} resumed={resumed} ambient={ambient} {st}')


# --- dist scan (spec §4 disclosure) -----------------------------------------------------

IPV4 = re.compile(r'(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:/\d{1,2})?(?![\d.])')
# host:port with a hostname, address or IPv6 bracket in front. Safe on minified JS and CSS.
HOST_PORT = re.compile(r'(?i)(?:\blocalhost|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local|lan|internal|home|arpa|com|net|org|io|dev|app)|(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f]*:[0-9a-f:]*\])\:\d{1,5}\b')
PORT_WORD = re.compile(r'(?i)\bports?[\s:=#]+\d{2,5}\b')
# Any word:digits. Too noisy for minified JS ({aqua:65535}) and CSS (font-weight:600).
BARE_PORT = re.compile(r'(?i)(?<=[a-z0-9\]_-])\:\d{2,5}\b')


def scan_dist(dist):
    hits = []
    for f in sorted(p for p in dist.rglob('*') if p.is_file()):
        text = f.read_text(encoding='utf-8', errors='replace')
        patterns = [IPV4, HOST_PORT, PORT_WORD] + ([] if f.suffix in ('.js', '.mjs', '.css') else [BARE_PORT])
        for rx in patterns:
            for m in rx.finditer(text):
                hits.append(f'{f.relative_to(dist)}: {text[max(0, m.start() - 25):m.end() + 10]!r}')
    return hits


# --- add-a-chapter ----------------------------------------------------------------------

PROBE = 'probe-chapter'


def build_with_extra_chapter(tmp):
    copy = Path(tmp) / 'repo'
    shutil.copytree(ROOT, copy, ignore=shutil.ignore_patterns('node_modules', 'dist', '.git', '.astro'))
    # A real copy: Astro resolves a symlinked node_modules to its real path and breaks.
    subprocess.run(['cp', '-a', str(ROOT / 'node_modules'), str(copy / 'node_modules')], check=True)
    topo = copy / 'src/data/topology.yaml'
    text = topo.read_text()
    chapter = (f'chapters:\n  - id: {PROBE}\n    name: Probe chapter\n    at: [0.2, -0.2]\n'
               '    stars: [[0, 0], [0.2, 0.1], [0.1, 0.24]]\n    lines: [[0, 1], [1, 2], [2, 0]]\n')
    text, n = re.subn(r'^chapters:\n', chapter, text, count=1, flags=re.M)
    assert n == 1, 'no chapters: key in topology.yaml'
    topo.write_text(text)
    subprocess.run([str(copy / 'node_modules/.bin/astro'), 'build'], cwd=copy, check=True, capture_output=True)
    return copy / 'dist'


def chapters(page):
    """The essay's sections and the sky's chapters: the same list, or the page is lying."""
    return page.evaluate('''({sections: [...document.querySelectorAll('[data-chapter]')].map(e => e.dataset.chapter),
                              data: JSON.parse(document.getElementById('topology').textContent).chapters.map(c => c.id)})''')


# --- run --------------------------------------------------------------------------------

def main():
    if not (DIST / 'index.html').exists():
        sys.exit('dist/ missing: run npm run build first')

    bundle = subprocess.run(['node', str(ROOT / 'scripts/check-bundle.mjs'), '--json'], capture_output=True, text=True)
    scene_chunks = [c['url'] for c in json.loads(bundle.stdout)['chunks']]

    hits = scan_dist(DIST)
    check('dist/: no IPv4, CIDR or :port anywhere', not hits, '; '.join(hits[:10]))

    srv, B = serve(DIST)
    with sync_playwright() as p:
        br = p.chromium.launch(**CHROMIUM)

        # Persistence, no reload, render-then-idle across every section.
        pg = watch(br.new_page(), 'main')
        pg.goto(B + '/')
        scene_up(pg)
        s0 = pg.evaluate('({webgl2: __scene.webgl2, instantAt: __scene.instantAt, flights: __scene.flights.length})')
        check('WebGL2 context created', s0['webgl2'] is True)
        # M5: the landing page pushes in rather than cutting to its mark. It is still an arrival —
        # instantAt records it and nothing is pushed to flights — but the camera moves.
        check('home load opens at its place, as an arrival', s0['instantAt'] == '/' and s0['flights'] == 0, str(s0))
        pg.evaluate('window.__docMarker = 1')

        def nav(click, path):
            f0 = pg.evaluate('__scene.frames')
            pg.click(click)
            wait(pg, f'location.pathname === {path!r} && __scene.path === {path!r}')
            settle(pg)
            st = pg.evaluate('''({same: document.querySelector('.scene canvas') === __scene.canvas && __scene.canvas.dataset.born === __scene.born,
                                  noReload: window.__docMarker === 1, lost: __scene.contextLost, connected: __scene.canvas.isConnected,
                                  frames: __scene.frames})''')
            check(f'-> {path}: same canvas and context, no reload, rendered, then idle',
                  st['same'] and st['noReload'] and st['lost'] == 0 and st['connected'] and st['frames'] > f0, f'{st} from {f0}')

        nav('nav a[href="/incidents/"]', '/incidents/')
        nav('.list a[href="/incidents/lorem-ipsum-dolor/"]', '/incidents/lorem-ipsum-dolor/')
        nav('nav a[href="/gitops/"]', '/gitops/')
        nav('nav a[href="/documentation/"]', '/documentation/')
        nav('nav a[href="/resume/"]', '/resume/')
        nav('a.wordmark', '/')
        pg.go_back()
        wait(pg, "__scene.path === '/resume/'")
        settle(pg)
        check('back button: goTo previous place, same canvas, no reload',
              pg.evaluate("window.__docMarker === 1 && document.querySelector('.scene canvas') === __scene.canvas && __scene.contextLost === 0"))

        pg.wait_for_timeout(300)
        fa, t0 = pg.evaluate('__scene.frames'), time.time()
        pg.wait_for_timeout(1000)
        wait(pg, f'__scene.frames >= {fa + 3}', 20, fail=False)  # at least a few frames, however slow SwiftShader is
        fb, took = pg.evaluate('__scene.frames'), time.time() - t0
        check('idle life: ambient, at most 30 fps', 0 < fb - fa <= 30 * took + 3 and pg.evaluate("__scene.rate === 'ambient'"), f'frames {fa}->{fb} in {took:.1f}s')

        # --- arriving at a place (M3, rewritten M4) -------------------------------------------
        # M3 read each place in a Local tier of its own and this asserted the tier. M4 has one tier
        # below the galaxy, so the invariant is the object rather than the tier: the flight ends
        # close enough to the destination that it, and nothing else, is the thing being read.
        # Resume is in this list because it is no longer the exception that froze the camera: it has
        # a waypoint and an object like every other route, which is the whole point of the change.
        for path, place in (('/incidents/', 'incidents'), ('/gitops/', 'gitops'), ('/documentation/', 'documentation'),
                            ('/resume/', 'resume')):
            pg.click(f'.masthead a[href="{path}"]')
            wait(pg, f'__scene.path === {path!r}')
            settle(pg)
            st = pg.evaluate('({reading: __scene.reading, tier: __scene.tier, place: __scene.place})')
            check(f'place: {path} arrives at its object', st == {'reading': place, 'tier': 'region', 'place': place}, str(st))
        pg.click('a.wordmark')
        wait(pg, "__scene.path === '/'")
        settle(pg)
        st = pg.evaluate('({reading: __scene.reading, tier: __scene.tier})')
        check('place: the constellation reads no object', st == {'reading': None, 'tier': 'region'}, str(st))

        # Flights, skip, retarget (W3). Baseline: a full flight between two non-landing places.
        pg.click('nav a[href="/gitops/"]')
        wait(pg, "__scene.path === '/gitops/'")
        settle(pg)
        normal_flies, baseline = fly(pg, 'nav a[href="/incidents/"]', '/incidents/')
        if not normal_flies:
            for name in ('flight: gitops -> incidents flies, then idles', 'skip: Esc ends the flight',
                         'skip: second click on the active link ends the flight', 'retarget mid-flight: lands at the new place, no queue'):
                skip(name, 'director never flies (W3 not merged)')
        else:
            settle(pg)
            check('flight: gitops -> incidents flies, then idles', pg.evaluate("__scene.place === 'incidents' && __scene.rate !== 'full'"), f'{baseline:.2f}s')

            for how, act in (('Esc', lambda: pg.keyboard.press('Escape')),
                             ('second click on the active link', lambda: pg.click('.masthead nav a[aria-current="page"]'))):
                target = '/gitops/' if pg.evaluate('__scene.path') == '/incidents/' else '/incidents/'
                pg.click(f'nav a[href="{target}"]')
                wait(pg, f'__scene.path === {target!r} && __scene.flying')
                t = time.time()
                act()
                took = time.time() - t if wait(pg, '!__scene.flying', baseline, fail=False) else float('inf')
                settle(pg)
                check(f'skip: {how} ends the flight', took < max(0.6, baseline / 3) and pg.evaluate(f'__scene.path === {target!r}'),
                      f'{took:.2f}s after skip, flight {baseline:.2f}s')

            # A queued implementation finishes the first flight and then flies the second (~2x).
            if pg.evaluate('__scene.path') != '/gitops/':
                pg.click('nav a[href="/gitops/"]')
            wait(pg, "__scene.path === '/gitops/'")
            settle(pg)
            pg.click('nav a[href="/incidents/"]')
            wait(pg, "__scene.path === '/incidents/' && __scene.flying")
            time.sleep(min(0.3, baseline / 5))
            t = time.time()
            pg.click('nav a[href="/documentation/"]')
            wait(pg, "__scene.path === '/documentation/'")
            took = time.time() - t if wait(pg, '!__scene.flying', baseline * 3, fail=False) else float('inf')
            refly = sample_flying(pg, 0.5)
            st = pg.evaluate('({place: __scene.place, last: __scene.flights.slice(-2)})')
            check('retarget mid-flight: lands at the new place, no queue',
                  st['place'] == 'documentation' and st['last'] == ['/incidents/', '/documentation/'] and took < baseline * 1.5 and not refly,
                  f'{took:.2f}s vs flight {baseline:.2f}s, {st}')

        # Deep link: already at the destination.
        dl = watch(br.new_page(), 'deeplink')
        dl.goto(B + '/incidents/lorem-ipsum-dolor/')
        scene_up(dl)
        flew = sample_flying(dl, 1.5)
        st = dl.evaluate('({instantAt: __scene.instantAt, flights: __scene.flights.length, place: __scene.place})')
        check('deep link opens at destination, no flight',
              st == {'instantAt': '/incidents/lorem-ipsum-dolor/', 'flights': 0, 'place': 'incidents'} and not flew, str(st))
        # The distance matters as much as the place: land() used to frame every destination from a
        # tenth of the disc away, which showed an incident as a marker rather than as the orrery.
        check('deep link lands at the object, not out in the arm', dl.evaluate("__scene.reading === 'incidents'"), dl.evaluate('__scene.reading'))
        drain_csp(dl, 'deeplink')
        dl.close()

        # Reduced motion: still frames, never flies.
        rm_ctx = br.new_context(reduced_motion='reduce')
        rm = watch(rm_ctx.new_page(), 'reduced-motion')
        rm.goto(B + '/gitops/')
        scene_up(rm)
        rm_flew = False
        for href in ('/incidents/', '/documentation/', '/', '/gitops/'):
            rm.click(f'.masthead a[href="{href}"]')
            wait(rm, f'__scene.path === {href!r}')
            rm_flew = sample_flying(rm, 1.0) or rm_flew
        rm_ok = rm.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches && __scene.flights.length === 4")
        if rm_flew:
            check('reduced motion: never flies', False, 'flying seen')
        elif not normal_flies:
            skip('reduced motion: never flies', 'director never flies in normal mode either, so this cannot discriminate (W3 not merged)')
        else:
            check('reduced motion: never flies', rm_ok)
        rm.wait_for_timeout(500)
        ra = rm.evaluate('__scene.frames')
        rm.wait_for_timeout(1000)
        rb = rm.evaluate('__scene.frames')
        check('reduced motion: no idle life, loop stops', ra == rb and rm.evaluate('__scene.idle'), f'frames {ra}->{rb}')
        # createStill() had the same framed-from-the-arm hardcode as land(): under reduced motion a
        # place was stilled from a tenth of the disc away instead of at its object.
        check('reduced motion: a place stills at its object', rm.evaluate("__scene.reading === 'gitops'"), str(rm.evaluate('__scene.reading')))
        rm.mouse.move(40, 40)
        rm.mouse.move(1200, 650, steps=8)
        rm.wait_for_timeout(1000)
        st = rm.evaluate('({parallax: __scene.parallax, sway: __scene.sway, idle: __scene.idle})')
        check('reduced motion: no parallax, no drift', st == {'parallax': 0, 'sway': 0, 'idle': True}, str(st))
        drain_csp(rm, 'reduced-motion')
        rm_ctx.close()

        # No WebGL2: prose only, no scene chunk requested, no errors.
        ng = br.new_page()
        ng_err, ng_req = [], []
        ng.on('pageerror', lambda e: ng_err.append(str(e)))
        ng.on('request', lambda r: ng_req.append(r.url))
        ng.add_init_script("const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { return t === 'webgl2' ? null : g.call(this, t, ...a) }")
        ng.goto(B + '/gitops/')
        ng.wait_for_timeout(1000)
        asked = [u for u in ng_req if any(u.endswith(c) for c in scene_chunks)]
        check('no WebGL2: prose only, no scene chunk requested, no errors',
              ng.evaluate('!window.__scene') and ng.is_visible('h1') and bool(scene_chunks) and not asked and not ng_err,
              f'chunks={scene_chunks} requested={asked} errors={ng_err}')
        ng.close()

        # JS disabled: every page reads.
        nj_ctx = br.new_context(java_script_enabled=False)
        nj = nj_ctx.new_page()
        bad = []
        for html in sorted(DIST.rglob('index.html')):
            rel = html.parent.relative_to(DIST).as_posix()
            path = '/' if rel == '.' else f'/{rel}/'
            nj.goto(B + path)
            if not (nj.is_visible('h1') and nj.locator('.masthead nav a').count() == 4):
                bad.append(path)
        check('JS disabled: every page renders prose and nav', not bad, str(bad))
        nj_ctx.close()

        # Mobile: pause while the sheet covers the scene.
        mb = watch(br.new_page(), 'mobile')
        mb.goto(B + '/')
        scene_up(mb)
        mb.set_viewport_size({'width': 390, 'height': 800})
        mb.wait_for_timeout(300)
        stopped, resumed, detail = stopped_then_resumed(mb, lambda: mb.evaluate('window.scrollTo(0, document.body.scrollHeight)'),
                                                        lambda: mb.evaluate('window.scrollTo(0, 0)'))
        check('mobile: ambient stops when the sheet covers the scene', stopped, detail)
        check('mobile: resumes when uncovered', resumed, detail)
        drain_csp(mb, 'mobile')
        mb.close()

        # Motion (L4): mouse parallax, idle drift, pause while hidden, hover.
        mo = watch(br.new_page(viewport={'width': 1280, 'height': 720}), 'motion')
        mo.goto(B + '/')
        scene_up(mo)
        settle(mo)
        s0 = mo.evaluate('__scene.sway')
        f0 = mo.evaluate('__scene.frames')
        wait(mo, f'__scene.frames > {f0} + 1', 15, fail=False)
        s1 = mo.evaluate('({sway: __scene.sway, parallax: __scene.parallax, rate: __scene.rate})')
        if s0 == 0 and s1['sway'] == 0:
            skip('idle drift: the camera breathes at rest, ambient rate', 'sway stays 0 (DRIFT off)')
        else:
            check('idle drift: the camera breathes at rest, ambient rate', s1['sway'] != s0 and s1['parallax'] == 0 and s1['rate'] == 'ambient', f'{s0} -> {s1}')

        mo.mouse.move(640, 360)
        settle(mo)
        mo.mouse.move(1240, 40, steps=6)
        end, full, st = time.time() + 30, False, {}
        while time.time() < end:
            st = mo.evaluate('({parallax: __scene.parallax, sway: __scene.sway, rate: __scene.rate})')
            full = full or st['rate'] == 'full'
            if st['parallax'] > 1.2 and st['rate'] == 'ambient':
                break
            time.sleep(0.03)
        check('parallax: the mouse moves the camera at full rate, then ambient', full and st['parallax'] > 1.2 and st['sway'] > 0.03 and st['rate'] == 'ambient', str(st))
        mo.mouse.move(-5, -5)
        rest = wait(mo, "__scene.parallax === 0 && __scene.rate === 'ambient'", 30, fail=False)
        check('parallax: eases back to rest when the pointer leaves', rest, mo.evaluate('JSON.stringify({p: __scene.parallax, s: __scene.sway, r: __scene.rate})'))

        # Headless Chromium keeps every tab visible (a background tab, a minimised window), so hidden is emulated.
        hide = "hidden => (Object.defineProperty(document, 'hidden', {configurable: true, get: () => hidden}), document.dispatchEvent(new Event('visibilitychange')))"
        stopped, resumed, detail = stopped_then_resumed(mo, lambda: mo.evaluate(hide, True), lambda: mo.evaluate(hide, False))
        check('hidden tab: ambient stops (emulated document.hidden)', stopped, detail)
        check('hidden tab: resumes when visible', resumed, detail)

        # Nothing on the landing page answers the pointer since M5 — the sky is a backdrop, not a
        # diagram — so the hover test moved to the ship, below.
        check('hover: the landing page has no hoverable target', mo.evaluate('__scene.hot') is None, str(mo.evaluate('__scene.hot')))
        drain_csp(mo, 'motion')
        mo.close()

        # Touch never drives the parallax: real CDP touch input, checked to reach the page.
        tc_ctx = br.new_context(has_touch=True, viewport={'width': 1280, 'height': 720})
        tc = watch(tc_ctx.new_page(), 'touch')
        tc.goto(B + '/')
        scene_up(tc)
        tc.evaluate("addEventListener('pointermove', e => e.pointerType === 'touch' && (window.__touches = (window.__touches || 0) + 1), {passive: true})")
        cdp = tc_ctx.new_cdp_session(tc)
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': 1240, 'y': 60}]})
        seen = 0.0
        for i in range(10):
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': 1240 - 20 * i, 'y': 60 + 10 * i}]})
            seen = max(seen, tc.evaluate('__scene.parallax'))
            time.sleep(0.03)
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        tc.tap('body', position={'x': 1200, 'y': 600})
        tc.wait_for_timeout(700)
        st = tc.evaluate('({parallax: __scene.parallax, touches: window.__touches || 0})')
        check('touch: no parallax', st['touches'] > 0 and seen == 0 and st['parallax'] == 0, f'{st}, max seen {seen}')
        drain_csp(tc, 'touch')
        tc_ctx.close()

        # The essay and the sky are one list: a chapter with no section under it would light
        # nothing, and a section with no chapter would scroll past an unchanging sky.
        lb = watch(br.new_page(), 'chapters')
        lb.goto(B + '/')
        scene_up(lb)
        got = chapters(lb)
        check('essay: one [data-chapter] section per chapter in the data',
              got['sections'] == got['data'] and len(got['sections']) >= 2, str(got))

        # Scrolling the essay lights the chapter under the reader's eye.
        lit = []
        for chapter in got['sections']:
            # Centred, not merely visible: the lit chapter is the one at the reading line, and on a
            # tall viewport several chapters are on screen at once.
            lb.eval_on_selector(f'[data-chapter="{chapter}"]', "e => e.scrollIntoView({block: 'center'})")
            lb.wait_for_timeout(250)
            lit.append(wait(lb, f'__scene.chapter === {chapter!r}', 6, fail=False))
        check('essay: scrolling to a chapter lights its asterism', all(lit),
              f"{sum(bool(x) for x in lit)}/{len(lit)}, last chapter={lb.evaluate('__scene.chapter')}")
        drain_csp(lb, 'chapters')
        lb.close()

        with tempfile.TemporaryDirectory(prefix='scene-add-chapter-') as tmp:
            srv2, B2 = serve(build_with_extra_chapter(tmp))
            an = watch(br.new_page(), 'add-chapter')
            an.goto(B2 + '/')
            scene_up(an)
            got2 = chapters(an)
            drain_csp(an, 'add-chapter')
            an.close()
            srv2.shutdown()
        check('add a chapter to topology.yaml: new section and asterism, no code change',
              got2['sections'] == got2['data'] and PROBE in got2['sections'] and len(got2['sections']) == len(got['sections']) + 1,
              f"{len(got2['sections'])} sections, {len(got2['data'])} chapters")

        # Hover: the ship's modules are the only thing in the scene that answers the pointer now.
        sh = watch(br.new_page(), 'ship')
        sh.goto(B + '/gitops/')
        scene_up(sh)
        settle(sh)
        box = sh.viewport_size
        found = None
        for x in range(int(box['width'] * 0.55), int(box['width'] * 0.95), 16):
            for y in range(int(box['height'] * 0.3), int(box['height'] * 0.75), 16):
                sh.mouse.move(x, y)
                sh.wait_for_timeout(25)
                if sh.evaluate('__scene.hot'):
                    found = sh.evaluate('__scene.hot')
                    break
            if found:
                break
        shown = sh.evaluate("[...document.querySelectorAll('.scene-label')].filter(e => getComputedStyle(e).visibility !== 'hidden').map(e => e.dataset.node)")
        check('hover: a ship module sets __scene.hot and shows its label alone',
              found is not None and shown == [found], f'hot={found}, shown={shown}')
        # The names in the scene and the names in the prose are the same six, or one of them exists
        # only on a canvas that is aria-hidden.
        stages = sh.evaluate("[...document.querySelectorAll('.stages li')].map(e => e.firstChild.textContent.trim())")
        check('gitops: every stage the ship names is in the prose', len(stages) == 6 and found in [t.lower() for t in stages],
              f'{stages}, hot={found}')
        drain_csp(sh, 'ship')
        sh.close()

        # The comet is not a still life: its grains stream and its body drifts, on ambient frames.
        cm = watch(br.new_page(), 'comet')
        cm.goto(B + '/resume/')
        scene_up(cm)
        settle(cm)
        first = cm.screenshot()
        cm.wait_for_timeout(1500)
        check('comet: the tail is moving', cm.screenshot() != first, 'two frames 1.5 s apart are identical')
        drain_csp(cm, 'comet')
        cm.close()

        drain_csp(pg, 'main')
        check('no CSP violations', not csp_hits, '; '.join(csp_hits[:5]))
        check('no page errors', not page_errors, '; '.join(page_errors[:5]))
        br.close()
    srv.shutdown()

    fails, skips = results.count('FAIL'), results.count('SKIP')
    print(f'\n{results.count("PASS")} passed, {fails} failed, {skips} skipped')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
