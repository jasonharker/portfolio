// Disclosure gate: the published pages must not map the lab. Addresses, internal names, exact
// versions and VLAN IDs are what an attacker would want from a homelab write-up, and the copy is
// drafted from the THALES docs, which are full of them. Runs on dist/ so it sees what ships.
//
//   node scripts/check-disclosure.mjs        list every hit, exit 1 if any
//
// ponytail: HTML and SVG only. The JS bundles are skipped because minified three.js is dense with
// dotted number runs; if prose ever moves into a script, scan its string literals too.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));

// One line per rule, so dropping one is a one-line diff.
const RULES = [
  ['IPv4 address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ['internal domain', /\bthales\.local\b|\.ts\.net\b/gi],
  ['exact version', /\bv?\d+\.\d+\.\d+\b|\bv\d+\.\d+\b/g],
  ['VLAN ID', /\bVLAN\s*\d+/gi],
  ['MAC address', /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi],
  ['key material', /AGE-SECRET-KEY-|-----BEGIN [A-Z ]*PRIVATE KEY/g],
  ['Circa cluster name', /\b(?:prd|stg)-cs-/gi],
];

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const pages = walk(dist).filter((f) => /\.(?:html|svg)$/.test(f));
if (!pages.length) throw new Error('check-disclosure: no HTML in dist/; run astro build first');

const hits = [];
for (const file of pages) {
  readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
    for (const [rule, re] of RULES) {
      for (const m of line.matchAll(re)) hits.push(`${relative(dist, file)}:${i + 1}  ${rule}: ${m[0]}`);
    }
  });
}

for (const h of hits) console.error(`check-disclosure: ${h}`);
console.log(`disclosure: ${pages.length} pages scanned, ${hits.length} hit${hits.length === 1 ? '' : 's'}`);
process.exit(hits.length ? 1 : 0);
