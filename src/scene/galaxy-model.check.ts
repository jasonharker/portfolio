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

// Stars actually follow the arms: well above what the same radii with uniform angles would give.
let near = 0, uniform = 0;
for (let i = 0; i < N; i++) {
  const x = a.positions[i * 3], z = a.positions[i * 3 + 2], r = Math.hypot(x, z);
  if (r < 3 || r > 12) continue;
  uniform += Math.min(1, (a.arms * 2) / (2 * Math.PI * r));
  const th = Math.atan2(z, x);
  const dmin = Math.min(...Array.from({ length: a.arms }, (_, arm) => {
    const dt = Math.abs((((th - a.armAngleAt(r, arm)) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
    return dt * r;
  }));
  if (dmin < 1) near++;
}
assert.ok(near > uniform * 1.5, `arm-hugging stars: ${near}, uniform would give ${uniform.toFixed(0)}`);

// Young stars are born in associations: beyond 6 kpc, where the arms are sparse, some 0.2 kpc cell holds a dozen.
const crowds = new Map<string, number>();
for (let i = 0; i < N; i++) {
  const [x, , z] = a.positions.subarray(i * 3, i * 3 + 3);
  if (a.temperatures[i] < 8500 || Math.hypot(x, z) < 6) continue;
  const key = `${Math.floor(x / 0.2)},${Math.floor(z / 0.2)}`;
  crowds.set(key, (crowds.get(key) ?? 0) + 1);
}
const crowd = Math.max(0, ...crowds.values());
assert.ok(crowd >= 12, `densest 0.2 kpc cell of young stars beyond 6 kpc holds ${crowd}`);

console.log(`galaxy-model ok: ${a.arms} arms, ${places.length} places on arms, ${near} stars within 1 kpc of a spine (uniform: ${uniform.toFixed(0)})`);
