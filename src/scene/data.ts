import type { Topology } from './types';

// Base.astro emits the validated topology as a JSON data block. Parsed once; never fetched.
export const topology: Topology = JSON.parse(document.getElementById('topology')!.textContent!);
