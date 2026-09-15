// DOM labels for the constellation: hostname over role, placed by projecting each star.
// Positions are written only from render(), so they move exactly when the canvas does, and
// only as transforms (no layout). A label is hidden when its star is behind the camera or
// off-screen.
//
// Screen readers: every label is aria-hidden. The landing page already lists every host,
// grouped by layer, in its HTML, and this layer persists across every page, so exposing it
// would read the whole lab again on /incidents, /gitops and the rest. Labels stay plain,
// selectable text for sighted pointer and touch users.
import * as THREE from 'three';
import type { TopologyNode } from './types';

export interface Labels {
  update(camera: THREE.Camera, width: number, height: number, visible: boolean): void;
  show(visible: boolean): void;
  dispose(): void;
}

export function createLabels(root: HTMLElement, nodes: TopologyNode[], star: (id: string, out: THREE.Vector3) => THREE.Vector3): Labels {
  const layer = document.createElement('div');
  layer.className = 'constellation-labels';
  const items = nodes.map((node) => {
    const el = document.createElement('div');
    el.className = 'scene-label';
    el.dataset.node = node.id;
    el.dataset.layer = node.layer;
    el.setAttribute('aria-hidden', 'true');
    const host = document.createElement('span');
    host.className = 'host';
    host.textContent = node.id;
    const role = document.createElement('span');
    role.className = 'role';
    role.textContent = node.role;
    el.append(host, role);
    layer.append(el);
    return { id: node.id, el, x: NaN, y: NaN, on: true };
  });
  root.append(layer);

  const v = new THREE.Vector3();
  const setOn = (item: (typeof items)[number], on: boolean) => {
    if (item.on === on) return;
    item.on = on;
    item.el.style.visibility = on ? '' : 'hidden';
  };

  return {
    update(camera, width, height, visible) {
      for (const item of items) {
        star(item.id, v).project(camera);
        // project() puts points behind the camera at z > 1; allow a margin past the edges.
        const on = visible && v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
        setOn(item, on);
        if (!on) continue;
        const x = Math.round((v.x + 1) * 0.5 * width);
        const y = Math.round((1 - v.y) * 0.5 * height);
        if (x === item.x && y === item.y) continue;
        item.x = x;
        item.y = y;
        item.el.style.transform = `translate3d(${x}px,${y}px,0)`;
      }
    },
    show(visible) {
      layer.hidden = !visible;
    },
    dispose() {
      layer.remove();
    },
  };
}
