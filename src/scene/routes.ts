import type { PlaceId } from './types';

// '/incidents/<slug>' -> 'incidents'. Anything that isn't a place (/, /tokens/) is the constellation.
export function placeFor(path: string): PlaceId {
  const section = path.split('/')[1];
  return section === 'incidents' || section === 'gitops' || section === 'documentation' || section === 'resume' ? section : 'constellation';
}
