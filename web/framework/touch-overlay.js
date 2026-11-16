import { assertTouchOutline, resolvedTouchAreas, TOUCH_REGIONS, readTouchRegion, touchAreaConflict, touchLocal, touchScreen, touchShapeVertices } from './touch-geometry.js';

const SVG = 'http://www.w3.org/2000/svg';
let overlayCount = 0;

export function createTouchOverlay(layer) {
  const doc = layer.ownerDocument;
  const id = 'touch-overlay-' + ++overlayCount;
  function svg(tag, attributes = {}) {
    const element = doc.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }

  const overlay = svg('svg', { class: 'touch-region-overlay', hidden: '', 'aria-hidden': 'true' });
  const clip = svg('clipPath', { id: id + '-box' });
  const hitClip = svg('clipPath', { id: id + '-hit' });
  const defaultsMask = svg('mask', { id: id + '-defaults', maskUnits: 'userSpaceOnUse' });
  const defs = svg('defs');
  defs.append(clip, hitClip, defaultsMask);
  const content = svg('g', { 'clip-path': 'url(#' + id + '-box)' });
  const automatic = svg('g', { 'clip-path': 'url(#' + id + '-hit)', mask: 'url(#' + id + '-defaults)' });
  const drawn = svg('g', { class: 'touch-region-authored' });
  const labels = svg('g', { class: 'touch-region-labels' });
  content.append(automatic, drawn);
  overlay.append(defs, content, labels);
  layer.append(overlay);

  let geometry = '';
  return {
    render(layout, english, frame, candidate, replacing, selected) {
      const box = layout?.box, projection = layout?.touchFrame;
      if (!box || box.w <= 0 || box.h <= 0 || !projection) {
        overlay.setAttribute('hidden', '');
        geometry = '';
        return;
      }
      const areas = candidate ?? layout.touchAreas ?? [];
      const viewLeft = frame?.x ?? 0;
      const viewRight = frame ? frame.x + frame.w : doc.defaultView.innerWidth;
      const key = JSON.stringify([english, box, projection, layout.hit, areas, replacing, selected, viewLeft, viewRight]);
      if (key === geometry) return;
      geometry = key;
      const rect = { x: box.x, y: box.y, width: box.w, height: box.h };
      clip.replaceChildren(svg('rect', rect));
      hitClip.replaceChildren(...layout.hit.map(({ x, y, r }) => svg('circle', { cx: x, cy: y, r })));
      defaultsMask.replaceChildren(svg('rect', { ...rect, fill: 'white' }));
      automatic.replaceChildren();
      drawn.replaceChildren();
      labels.replaceChildren();

      const vertices = area => touchShapeVertices(area.shape).map(point => touchScreen(projection, point));
      const points = vertices => vertices.map(({ x, y }) => x + ',' + y).join(' ');
      // Previously saved custom areas keep their hit priority. Keep the automatic band out of the same pixels.
      for (const area of areas) {
        if (!area.id || area.id === replacing) continue;
        defaultsMask.append(svg('polygon', { points: points(vertices(area)), fill: 'black' }));
      }
      const committed = areas.filter(area => !area.draft);
      const drafts = areas.filter(area => area.draft);
      for (const area of [...resolvedTouchAreas(committed).reverse(), ...drafts]) {
        if (area.id && area.id === replacing) continue;
        const region = readTouchRegion(area.id);
        const auto = !!region && !areas.includes(area);
        const outline = vertices(area);
        if (!outline.length) continue;
        const path = svg(outline.length >= 3 ? 'polygon' : 'polyline', {
          points: points(outline), class: area.draft ? 'touch-draft-outline' : 'touch-region-shape',
        });
        if (region) path.dataset.region = region;
        path.classList.toggle('touch-region-selected', !!selected && area.id === selected);
        if (area.draft && (area.shape.kind === 'ellipse' ? area.shape.radius.x >= .005 && area.shape.radius.y >= .005 : outline.length >= 3)) {
          const draftId = replacing ?? '__draft';
          const proposed = [...committed.filter(item => item.id !== draftId), { ...area, id: draftId }];
          let invalid = !!touchAreaConflict(proposed, committed, draftId);
          try { assertTouchOutline(area.shape); } catch { invalid = true; }
          path.classList.toggle('touch-draft-invalid', invalid);
        }
        (auto ? automatic : drawn).append(path);
        if (area.vertices) outline.forEach((point, i) => {
          drawn.append(svg('circle', { cx: point.x, cy: point.y, r: 3.5, class: 'touch-draft-vertex' }));
          const number = svg('text', { x: point.x + 7, y: point.y - 5, class: 'touch-draft-index' });
          number.textContent = String(i + 1);
          drawn.append(number);
        });
        if (!area.name) continue;
        const name = auto ? TOUCH_REGIONS[region][english ? 1 : 0] : area.name;
        let point = outline.reduce((sum, p) => ({ x: sum.x + p.x / outline.length, y: sum.y + p.y / outline.length }), { x: 0, y: 0 });
        if (auto) {
          const [top, bottom] = [area.shape.points[0].y, area.shape.points[2].y];
          const centers = layout.hit.filter(circle => {
            const p = touchLocal(projection, circle);
            return p && p.y >= top && p.y <= bottom;
          });
          if (centers.length) point = centers.reduce((a, b) => a.r >= b.r ? a : b);
        }
        if (point.x < box.x || point.x > box.x + box.w || point.y < box.y || point.y > box.y + box.h) continue;
        const width = name.length * (english ? 8 : 13), right = box.x + box.w + 14, left = box.x - 14;
        const anchor = auto && right + width <= viewRight ? 'start' : auto && left - width >= viewLeft ? 'end' : 'middle';
        const x = anchor === 'start' ? right : anchor === 'end' ? left : point.x;
        if (anchor !== 'middle') {
          labels.append(svg('line', { x1: point.x, y1: point.y, x2: x + (anchor === 'start' ? -4 : 4), y2: point.y, 'data-region': region }));
        }
        const label = svg('text', { x, y: point.y, 'text-anchor': anchor, 'dominant-baseline': 'central' });
        if (area.id === selected) label.setAttribute('class','touch-region-selected-label');
        label.textContent = name;
        labels.append(label);
      }
      overlay.removeAttribute('hidden');
    },
  };
}
