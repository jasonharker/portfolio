// Bundle budget (spec §5): the lazily loaded 3D bundle must stay <= 250 KB gzipped.
//
// The 3D set is derived from dist/, not a filename glob: entry scripts are the module
// scripts and modulepreloads every page references; their static imports are always
// loaded. Everything reachable only through a dynamic import() from there (and whatever
// that pulls in, statically or dynamically) is the 3D bundle.
//
//   node scripts/check-bundle.mjs            report, exit 1 over budget
//   BUNDLE_LIMIT_KB=100 node ...             override the budget (kB = 1000 bytes)
//   node scripts/check-bundle.mjs --json     machine-readable, for tests/scene.py
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const LIMIT_KB = Number(process.env.BUNDLE_LIMIT_KB ?? 250);
if (!(LIMIT_KB > 0)) throw new Error(`BUNDLE_LIMIT_KB must be a positive number, got ${process.env.BUNDLE_LIMIT_KB}`);
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const json = process.argv.includes('--json');

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const url = (file) => '/' + relative(dist, file).split(sep).join('/');
const files = walk(dist);
const scripts = new Set(files.filter((f) => /\.m?js$/.test(f)).map(url));
const text = (u) => readFileSync(join(dist, u), 'utf-8');

const problems = [];
const resolve = (from, spec) => {
  const u = spec.startsWith('/') ? spec : posix.join(posix.dirname(from), spec);
  if (!scripts.has(u) && !/\.css$/.test(u)) problems.push(`${from} imports ${spec}, which is not in dist`);
  return u;
};

// Specifiers are string literals in any quote style (Vite emits backticks for import()).
const STATIC = /\b(?:import|from)\s*(['"`])([^'"`\s]+?\.m?js)\1/g;
const DYNAMIC = /\bimport\s*\(\s*(['"`])([^'"`\s]+?\.m?js)\1\s*\)/g;
// Vite's preload helper lists a dynamic import's dependencies as base-relative paths.
const PRELOAD = /(['"`])(_astro\/[^'"`\s]+?\.(?:m?js|css))\1/g;

function edges(u) {
  const src = text(u);
  const dyn = [...src.matchAll(DYNAMIC)].map((m) => resolve(u, m[2]));
  const dynSpans = [...src.matchAll(DYNAMIC)].map((m) => [m.index, m.index + m[0].length]);
  const stat = [...src.matchAll(STATIC)]
    .filter((m) => !dynSpans.some(([a, b]) => m.index >= a && m.index < b))
    .map((m) => resolve(u, m[2]));
  const preload = [...src.matchAll(PRELOAD)].map((m) => '/' + m[2]);
  return { stat, dyn: [...dyn, ...preload] };
}

// Always loaded: page entry scripts and their static closure.
const entries = new Set();
for (const f of files.filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(f, 'utf-8');
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)) entries.add(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*\brel=["']modulepreload["'][^>]*\bhref=["']([^"']+)["']/g)) entries.add(m[1]);
}
const always = new Set();
const lazyRoots = new Set();
const visitStatic = (u) => {
  if (always.has(u) || !scripts.has(u)) return;
  always.add(u);
  const { stat, dyn } = edges(u);
  stat.forEach(visitStatic);
  dyn.forEach((d) => lazyRoots.add(d));
};
entries.forEach(visitStatic);

// Lazy: everything reachable from the dynamic roots that isn't already always loaded.
const lazy = new Set();
const visitLazy = (u) => {
  if (lazy.has(u) || always.has(u)) return;
  if (!scripts.has(u) && !files.includes(join(dist, u))) return;
  lazy.add(u);
  if (scripts.has(u)) {
    const { stat, dyn } = edges(u);
    [...stat, ...dyn].forEach(visitLazy);
  }
};
lazyRoots.forEach(visitLazy);

// A JS file nobody reaches means the graph parse missed an edge: fail loudly rather than
// under-count.
for (const s of scripts) if (!always.has(s) && !lazy.has(s)) problems.push(`${s} is not reachable from any page; import graph parse missed an edge`);
if (!lazy.size) problems.push('no dynamically imported chunk found; the scene must be a lazy import() (spec §5)');

const gz = (u) => gzipSync(readFileSync(join(dist, u))).length;
const chunks = [...lazy].sort().map((u) => ({ url: u, raw: statSync(join(dist, u)).size, gzip: gz(u) }));
const total = chunks.reduce((n, c) => n + c.gzip, 0);
const eager = [...always].sort().map((u) => ({ url: u, gzip: gz(u) }));
const over = total > LIMIT_KB * 1000;
const ok = !over && !problems.length;

if (json) {
  console.log(JSON.stringify({ ok, limitBytes: LIMIT_KB * 1000, total, chunks, eager, problems }));
} else {
  const kb = (n) => (n / 1000).toFixed(1).padStart(7) + ' kB';
  console.log('3D bundle (lazy, gzipped):');
  for (const c of chunks) console.log(`  ${kb(c.gzip)}  ${c.url}  (${kb(c.raw).trim()} raw)`);
  console.log(`  ${kb(total)}  total, budget ${LIMIT_KB} kB${over ? '  OVER BUDGET' : ''}`);
  console.log('Always loaded (not counted):');
  for (const c of eager) console.log(`  ${kb(c.gzip)}  ${c.url}`);
  for (const p of problems) console.error(`check-bundle: ${p}`);
}
process.exit(ok ? 0 : 1);
