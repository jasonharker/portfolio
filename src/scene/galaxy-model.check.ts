// node src/scene/galaxy-model.check.ts — asserts on the pure galaxy model, against the real waypoints.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { DISC_RADIUS, galaxyModel } from './galaxy-model.ts';

const { waypoints } = yaml.load(readFileSync(new URL('../data/topology.yaml', import.meta.url), 'utf8')) as {
  waypoints: { id: string; pos: [number, number, number] }[];
};
const N = 20000;
const a = galaxyModel(7, N, waypoints as never);
const b = galaxyModel(7, N, waypoints as never);
const c = galaxyModel(8, N, waypoints as never);

assert.equal(a.positions.length, N * 3);
assert.equal(a.temperatures.length, N);
assert.deepEqual(a.positions, b.positions, 'same seed, same positions');
assert.deepEqual(a.temperatures, b.temperatures, 'same seed, same temperatures');
assert.notDeepEqual(a.positions, c.positions, 'different seed, different positions');

for (let i = 0; i < N; i++) {
  const [x, y, z] = a.positions.subarray(i * 3, i * 3 + 3);
  assert.ok(Number.isFinite(x + y + z) && Math.hypot(x, z) <= DISC_RADIUS + 5, `star ${i} in the disc`);
  assert.ok(a.temperatures[i] >= 2500 && a.temperatures[i] <= 32000, `star ${i} temperature`);
}

// Every non-core waypoint lies on some arm: distance from the place to the arm point at its radius.
const places = waypoints.filter((w) => Math.hypot(w.pos[0], w.pos[2]) >= 1);
assert.ok(a.arms >= 2);
for (const w of places) {
  const r = Math.hypot(w.pos[0], w.pos[2]);
  const d = Math.min(...Array.from({ length: a.arms }, (_, arm) => {
    const t = a.armAngleAt(r, arm);
    return Math.hypot(w.pos[0] - r * Math.cos(t), w.pos[2] - r * Math.sin(t));
  }));
  assert.ok(d < 0.05, `${w.id} is ${d.toFixed(3)} from the nearest arm`);
}

// Stars actually follow the arms: most arm-band stars near a spine, not uniform.
let near = 0;
for (let i = 0; i < N; i++) {
  const x = a.positions[i * 3], z = a.positions[i * 3 + 2], r = Math.hypot(x, z);
  if (r < 3 || r > 12) continue;
  const th = Math.atan2(z, x);
  const dmin = Math.min(...Array.from({ length: a.arms }, (_, arm) => {
    const dt = Math.abs((((th - a.armAngleAt(r, arm)) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
    return dt * r;
  }));
  if (dmin < 1) near++;
}
assert.ok(near > N * 0.3, `arm-hugging stars: ${near}`);

console.log(`galaxy-model ok: ${a.arms} arms, ${places.length} places on arms, ${near}/${N} stars within 1 kpc of a spine`);
