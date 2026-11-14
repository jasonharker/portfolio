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
const b = galaxyModel(7, N, [...waypoints] as never); // a copy: past the cache, so this is a second run
const c = galaxyModel(8, N, waypoints as never);
// A smaller model is the start of a larger one, cached (same waypoints) or built afresh (a copy).
const big = galaxyModel(7, N, waypoints as never);
for (const w of [waypoints, [...waypoints]]) {
  const small = galaxyModel(7, N / 4, w as never);
  assert.deepEqual(small.positions, big.positions.slice(0, (N / 4) * 3), 'a smaller model is a prefix');
  assert.deepEqual(small.temperatures, big.temperatures.slice(0, N / 4), 'a smaller model is a prefix');
}

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

// Stars actually follow the arms: within an eighth of the way to the next one, well over the quarter of them
// that uniform angles would put there. Measured in angle, so it holds whatever the pitch.
let near = 0, uniform = 0;
for (let i = 0; i < N; i++) {
  const x = a.positions[i * 3], z = a.positions[i * 3 + 2], r = Math.hypot(x, z);
  if (r < 3 || r > 12) continue;
  uniform += 0.25;
  const th = Math.atan2(z, x);
  const dmin = Math.min(...Array.from({ length: a.arms }, (_, arm) => {
    const dt = Math.abs((((th - a.armAngleAt(r, arm)) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
    return dt;
  }));
  if (dmin < Math.PI / (4 * a.arms)) near++;
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

// The arms run smooth: across the places (6–13 kpc; inward of them the arms open out on purpose) reaching them
// bends none further across itself than about its half-width from its own best-fit logarithmic spiral. The
// fit's slope m is 1/tan(pitch): an angle off it times r is a distance around the disc, and times sin(pitch)
// one across the arm.
for (let arm = 0; arm < a.arms; arm++) {
  const pts = Array.from({ length: 60 }, (_, i) => {
    const r = 6 * Math.pow(13 / 6, i / 59);
    return { x: Math.log(r), y: a.armAngleAt(r, arm), r };
  });
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length, my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const m = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / pts.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  const stray = Math.max(...pts.map((p) => (Math.abs(p.y - my - m * (p.x - mx)) * p.r) / Math.hypot(1, m)));
  assert.ok(stray < 0.3, `arm ${arm} strays ${stray.toFixed(2)} kpc across itself from a log spiral`);
}

// A grand design: the arms that carry the places hold well over the stars of the minor arms between them.
const gap = (x: number, z: number, arm: number) =>
  Math.abs(((((Math.atan2(z, x) - a.armAngleAt(Math.hypot(x, z), arm)) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
const armOf = (x: number, z: number) => [...Array(a.arms).keys()].reduce((b, arm) => (gap(x, z, arm) < gap(x, z, b) ? arm : b));
const held = Array<number>(a.arms).fill(0);
for (let i = 0; i < N; i++) {
  const x = a.positions[i * 3], z = a.positions[i * 3 + 2], r = Math.hypot(x, z);
  if (r > 3 && r < 12) held[armOf(x, z)]++;
}
const carrying = new Set(places.map((w) => armOf(w.pos[0], w.pos[2])));
const perArm = (major: boolean) => {
  const v = held.filter((_, arm) => carrying.has(arm) === major);
  return v.reduce((s, n) => s + n, 0) / v.length;
};
assert.ok(perArm(true) > 1.5 * perArm(false), `stars per major arm ${perArm(true).toFixed(0)}, per minor ${perArm(false).toFixed(0)}`);

console.log(`galaxy-model ok: ${a.arms} arms, ${places.length} places on arms, ${near} stars near a spine (uniform: ${uniform.toFixed(0)})`);
