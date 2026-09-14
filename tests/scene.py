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


def fly(page, click, path, start_timeout=1.0, max_flight=10.0):
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
    wait(page, '!__scene.flying && __scene.idle', 10)


# --- dist scan (spec §4 disclosure) -----------------------------------------------------

IPV4 = re.compile(r'(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:/\d{1,2})?(?![\d.])')
# host:port with a hostname, address or IPv6 bracket in front. Safe on minified JS and CSS.
HOST_PORT = re.compile(r'(?i)(?:\blocalhost|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local|lan|internal|home|arpa|com|net|org|io|dev|app)|(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}|\])\:\d{1,5}\b')
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


# --- add-a-node -------------------------------------------------------------------------

PROBE = 'w4-probe'


def build_with_extra_node(tmp):
    copy = Path(tmp) / 'repo'
    shutil.copytree(ROOT, copy, ignore=shutil.ignore_patterns('node_modules', 'dist', '.git', '.astro'))
    # A real copy: Astro resolves a symlinked node_modules to its real path and breaks.
    subprocess.run(['cp', '-a', str(ROOT / 'node_modules'), str(copy / 'node_modules')], check=True)
    topo = copy / 'src/data/topology.yaml'
    text = topo.read_text()
    text, n = re.subn(r'^nodes:\n', f'nodes:\n  - {{ id: {PROBE}, role: Probe, layer: services }}\n', text, count=1, flags=re.M)
    assert n == 1, 'no nodes: key in topology.yaml'
    topo.write_text(text)
    subprocess.run([str(copy / 'node_modules/.bin/astro'), 'build'], cwd=copy, check=True, capture_output=True)
    return copy / 'dist'


def labels(page):
    return page.evaluate('''({labels: [...document.querySelectorAll('.scene-labels [data-node]')].map(e => e.dataset.node),
                              nodes: JSON.parse(document.getElementById('topology').textContent).nodes.map(n => n.id)})''')


def wait_labels(page, seconds=4.0):
    end = time.time() + seconds
    while time.time() < end:
        got = labels(page)
        if got['labels']:
            return got
        time.sleep(0.1)
    return labels(page)


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
        check('home load opens at its place, no flight', s0['instantAt'] == '/' and s0['flights'] == 0, str(s0))
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
        fa = pg.evaluate('__scene.frames')
        pg.wait_for_timeout(1000)
        fb = pg.evaluate('__scene.frames')
        check('loop idles when nothing moves', fa == fb and pg.evaluate('__scene.idle'), f'frames {fa}->{fb}')

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
            check('flight: gitops -> incidents flies, then idles', pg.evaluate("__scene.place === 'incidents' && __scene.idle"), f'{baseline:.2f}s')

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
        mb.evaluate('window.scrollTo(0, document.body.scrollHeight)')
        mb.wait_for_timeout(300)
        check('mobile: pauses when the sheet covers the scene', mb.evaluate('__scene.paused'))
        mb.evaluate('window.scrollTo(0, 0)')
        mb.wait_for_timeout(300)
        check('mobile: resumes when uncovered', not mb.evaluate('__scene.paused'))
        drain_csp(mb, 'mobile')
        mb.close()

        # Labels (W2): one [data-node] per topology node, and a node added to the YAML gets one.
        lb = watch(br.new_page(), 'labels')
        lb.goto(B + '/')
        scene_up(lb)
        got = wait_labels(lb)
        drain_csp(lb, 'labels')
        lb.close()
        if not got['labels']:
            skip('labels: one [data-node] per topology node', 'no [data-node] elements (W2 not merged)')
            skip('add a node to topology.yaml: new labelled star, no code change', 'no [data-node] elements (W2 not merged)')
        else:
            check('labels: one [data-node] per topology node', sorted(got['labels']) == sorted(got['nodes']),
                  f"{len(got['labels'])} labels, {len(got['nodes'])} nodes")
            with tempfile.TemporaryDirectory(prefix='scene-add-node-') as tmp:
                srv2, B2 = serve(build_with_extra_node(tmp))
                an = watch(br.new_page(), 'add-node')
                an.goto(B2 + '/')
                scene_up(an)
                got2 = wait_labels(an)
                drain_csp(an, 'add-node')
                an.close()
                srv2.shutdown()
            check('add a node to topology.yaml: new labelled star, no code change',
                  PROBE in got2['nodes'] and PROBE in got2['labels'] and len(got2['labels']) == len(got2['nodes']) == len(got['nodes']) + 1,
                  f"{len(got2['labels'])} labels, {len(got2['nodes'])} nodes")

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
