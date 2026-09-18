// DOM labels for whatever a place lets you hover: a name over a note, placed by projecting the
// thing it names. Positions are written only from the owner's frame, so they move exactly when the
// canvas does, and only as transforms (no layout). A label is hidden when its anchor is behind the
// camera or off-screen.
//
// Screen readers: every label is aria-hidden, and each page that has them lists the same names in
// its prose (a .visually-hidden list — see src/pages/gitops.astro). That list is the text
// equivalent, and it is why hiding these costs nothing. M5: since the topology left the site, the
// ship's pipeline stages are the only thing labelled.
import * as THREE from 'three';

/** One labelled thing: a name, and a line under it saying what it is. */
export interface Labelled { id: string; name: string; note: string }

export interface Labels {
  update(camera: THREE.Camera, width: number, height: number, visible: boolean): void;
  show(visible: boolean): void;
  /** The node whose star lies within `radius` CSS px of (x, y), nearest first, else whose label box holds it. */
  hit(x: number, y: number, radius: number): string | null;
  /** Mark one label as hovered (the .hot class), or none. */
  highlight(id: string | null): void;
  dispose(): void;
}

export function createLabels(root: HTMLElement, items: Labelled[], anchor: (id: string, out: THREE.Vector3) => THREE.Vector3): Labels {
  const layer = document.createElement('div');
  layer.className = 'scene-label-layer';
  const entries = items.map((item) => {
    const el = document.createElement('div');
    el.className = 'scene-label';
    el.dataset.node = item.id;
    el.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = item.note;
    el.append(name, note);
    // Hidden until something hovers it. A label is created with the place, and a place is built
    // long before it is ever looked at — left visible, all six sat in the top-left corner of every
    // other page in the site until the ship's first frame moved them.
    el.style.visibility = 'hidden';
    layer.append(el);
    // `on` = in frame, and so a candidate for the hit test. `shown` = actually drawn, which since
    // M3 means hovered. The two are separate: a star you can hover is not a label you can see.
    return { id: item.id, el, x: NaN, y: NaN, on: true, shown: false };
  });
  root.append(layer);

  let shown = true;
  let hot: (typeof entries)[number] | undefined;
  const v = new THREE.Vector3();
  const setOn = (item: (typeof entries)[number], framed: boolean) => {
    item.on = framed;
    const show = framed && item === hot;
    if (item.shown === show) return;
    item.shown = show;
    item.el.style.visibility = show ? '' : 'hidden';
  };

  return {
    update(camera, width, height, visible) {
      for (const item of entries) {
        anchor(item.id, v).project(camera);
        // project() puts points behind the camera at z > 1; allow a margin past the edges.
        const framed = visible && v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
        // Hover only (spec §6): every name at once sits on the best part of the image. The text
        // equivalent for anyone not using a mouse is the list in the page's prose.
        setOn(item, framed);
        if (!framed) continue;
        const x = Math.round((v.x + 1) * 0.5 * width);
        const y = Math.round((1 - v.y) * 0.5 * height);
        if (x === item.x && y === item.y) continue;
        item.x = x;
        item.y = y;
        item.el.style.transform = `translate3d(${x}px,${y}px,0)`;
      }
    },
    show(visible) {
      shown = visible;
      layer.hidden = !visible;
    },
    hit(x, y, radius) {
      if (!shown) return null;
      let best: string | null = null;
      let nearest = radius * radius;
      for (const item of entries) {
        const d = item.on ? (item.x - x) ** 2 + (item.y - y) ** 2 : Infinity;
        if (d <= nearest) (nearest = d), (best = item.id);
      }
      if (best) return best;
      // Labels are pointer-events: none, so the box is tested here rather than by the browser.
      // Only the visible one: an invisible label's box would hover a name out of empty space.
      for (const item of entries) {
        if (!item.shown) continue;
        const r = item.el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return item.id;
      }
      return null;
    },
    highlight(id) {
      // Visibility is settled here as well as in update(), because the last thing a place does
      // before it is flown away from is drop its hover — and nothing will call update() again to
      // hide the label, which would otherwise hang over whatever you arrived at next.
      if (hot) {
        hot.el.classList.remove('hot');
        hot.shown = false;
        hot.el.style.visibility = 'hidden';
      }
      hot = entries.find((item) => item.id === id);
      if (!hot) return;
      hot.el.classList.add('hot');
      if (!hot.on) return;
      hot.shown = true;
      hot.el.style.visibility = '';
    },
    dispose() {
      layer.remove();
    },
  };
}
