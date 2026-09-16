import type { Incident, Topology } from './types';

// Base.astro emits the validated topology as a JSON data block. Parsed once; never fetched.
export const topology: Topology = JSON.parse(document.getElementById('topology')!.textContent!);
// The same trick for the incidents collection: one planet per entry in the Local tier's orrery.
export const incidents: Incident[] = JSON.parse(document.getElementById('incidents')!.textContent!);
