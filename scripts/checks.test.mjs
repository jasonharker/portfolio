// Unit tests for the two build gates. Each test copies the script into a temp dir next to a
// fixture dist/, since both scripts read ../dist/ relative to themselves.
//
//   node --test scripts/checks.test.mjs     (runs first in `npm run build`)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function run(script, files, { args = [], env = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'checks-'));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(here, script), join(root, 'scripts', script));
  mkdirSync(join(root, 'dist'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, 'dist', path)), { recursive: true });
    writeFileSync(join(root, 'dist', path), body);
  }
  return spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

test('disclosure: a clean page passes', () => {
  const r = run('check-disclosure.mjs', { 'index.html': '<p>Jason Harker, cloud engineer</p>' });
  assert.equal(r.status, 0, r.stderr);
});

for (const [rule, text] of [
  ['IPv4 address', 'reach it at 10.1.2.3'],
  ['internal domain', 'see grafana.thales.local'],
  ['internal domain', 'host.tail1234.ts.net'],
  ['exact version', 'running v1.12.4'],
  ['exact version', 'chart 41.2.0'],
  ['VLAN ID', 'on VLAN 30'],
  ['MAC address', 'aa:bb:cc:dd:ee:ff'],
  ['key material', 'AGE-SECRET-KEY-1ABC'],
  ['Circa cluster name', 'prd-cs-inf'],
]) {
  test(`disclosure: ${rule} fails the build (${text})`, () => {
    const r = run('check-disclosure.mjs', { 'a/index.html': `<p>${text}</p>` });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`a/index\\.html:1 +${rule}:`));
  });
}

test('disclosure: an SVG is scanned too', () => {
  const r = run('check-disclosure.mjs', { 'index.html': '<p>ok</p>', 'map.svg': '<text>10.0.0.1</text>' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /map\.svg:1 +IPv4 address/);
});

test('disclosure: an empty dist fails rather than passing vacuously', () => {
  const r = run('check-disclosure.mjs', {});
  assert.notEqual(r.status, 0);
});

const page = '<script type="module" src="/_astro/entry.js"></script>';
const entry = 'import("./scene.js").then((m) => m.start());';

test('bundle: a lazy scene under budget passes', () => {
  const r = run('check-bundle.mjs', { 'index.html': page, '_astro/entry.js': entry, '_astro/scene.js': 'export const start = () => {};' }, { args: ['--json'] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.chunks.map((c) => c.url), ['/_astro/scene.js']);
  assert.deepEqual(out.eager.map((c) => c.url), ['/_astro/entry.js']);
});

test('bundle: over budget fails', () => {
  const r = run('check-bundle.mjs', { 'index.html': page, '_astro/entry.js': entry, '_astro/scene.js': 'export const start = () => {};' }, { args: ['--json'], env: { BUNDLE_LIMIT_KB: '0.001' } });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).problems.length, 0);
});

test('bundle: a scene imported statically fails (it must be lazy)', () => {
  const r = run('check-bundle.mjs', { 'index.html': page, '_astro/entry.js': 'import "./scene.js";', '_astro/scene.js': 'export {};' }, { args: ['--json'] });
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).problems.join('\n'), /no dynamically imported chunk/);
});

test('bundle: an unreachable script fails (the import-graph parse missed an edge)', () => {
  const r = run('check-bundle.mjs', { 'index.html': page, '_astro/entry.js': entry, '_astro/scene.js': 'export {};', '_astro/orphan.js': 'export {};' }, { args: ['--json'] });
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).problems.join('\n'), /orphan\.js is not reachable/);
});
