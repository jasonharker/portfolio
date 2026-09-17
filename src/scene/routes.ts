import type { PlaceId, TierId } from './types';

// '/incidents/<slug>' -> 'incidents'. Anything that isn't a place (/, /tokens/) is the constellation.
export function placeFor(path: string): PlaceId | 'resume' {
  const section = path.split('/')[1];
  return section === 'incidents' || section === 'gitops' || section === 'documentation' || section === 'resume' ? section : 'constellation';
}

// The tier a place is read in: the near end of every flight, and the whole of an instant arrival.
// Galaxy is never a destination — nothing is read there, it is only panned across (spec §3).
export function tierFor(place: PlaceId): Exclude<TierId, 'galaxy'> {
  return place === 'constellation' ? 'region' : 'local';
}
