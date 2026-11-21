const EDGE = 8;
const GAP = 10;
const MAX_APPROACH_GAP = 36;

function bound(value, size, limit) {
  return Math.round(Math.max(EDGE, Math.min(value, Math.max(EDGE, limit - size - EDGE))));
}

/** Place a control next to the visible body; use the space above or below when needed. */
export function nextToBody(box, anchorY, size, viewport, avoid, preferredSide = 'right') {
  const {width, height} = size;
  const {width: vw, height: vh} = viewport;
  const obstacles = Array.isArray(avoid) ? avoid : avoid ? [avoid] : [];
  const sides = {
    left: {left: box.x - width - GAP, top: anchorY - height / 2},
    right: {left: box.x + box.w + GAP, top: anchorY - height / 2},
  };
  const candidates = [
    ...[sides[preferredSide], sides[preferredSide === 'right' ? 'left' : 'right']]
      .map(point => ({ ...point, top: bound(point.top, height, vh) })),
    {left: bound(box.x + (box.w - width) / 2, width, vw), top: box.y - height - GAP},
    {left: bound(box.x + (box.w - width) / 2, width, vw), top: box.y + box.h + GAP},
  ];
  const overlap = (point, area) => area
    ? Math.max(0, Math.min(point.left + width, area.right) - Math.max(point.left, area.left))
      * Math.max(0, Math.min(point.top + height, area.bottom) - Math.max(point.top, area.top))
    : 0;
  const fits = point => point.left >= EDGE && point.left + width <= vw - EDGE
    && point.top >= EDGE && point.top + height <= vh - EDGE;
  const occupied = point => obstacles.reduce((sum,area) => sum + overlap(point,area),0);
  const safe = candidates.find(point => fits(point) && !occupied(point));
  if (safe) return {left: Math.round(safe.left), top: Math.round(safe.top)};
  const body = {left: box.x, top: box.y, right: box.x + box.w, bottom: box.y + box.h};
  const choices = candidates.map(point => ({left: bound(point.left, width, vw), top: bound(point.top, height, vh)}));
  const score = point => overlap(point, body) + 2 * occupied(point);
  return choices.reduce((best, point) => score(point) < score(best) ? point : best);
}

/** The gap keeps the bar visible but does not take native clicks. */
export function inApproach(point, box, bar, margin = 8) {
  if (!point || !box || !bar) return false;
  const verticalStart = Math.max(box.y, bar.top) - margin;
  const verticalEnd = Math.min(box.y + box.h, bar.bottom) + margin;
  if (point.y >= verticalStart && point.y <= verticalEnd) {
    if (bar.left >= box.x + box.w && bar.left - (box.x + box.w) <= MAX_APPROACH_GAP
      && point.x >= box.x + box.w && point.x <= bar.left) return true;
    if (bar.right <= box.x && box.x - bar.right <= MAX_APPROACH_GAP && point.x >= bar.right && point.x <= box.x) return true;
  }
  const horizontalStart = Math.max(box.x, bar.left) - margin;
  const horizontalEnd = Math.min(box.x + box.w, bar.right) + margin;
  return point.x >= horizontalStart && point.x <= horizontalEnd && (
    bar.bottom <= box.y && box.y - bar.bottom <= MAX_APPROACH_GAP && point.y >= bar.bottom && point.y <= box.y
    || bar.top >= box.y + box.h && bar.top - (box.y + box.h) <= MAX_APPROACH_GAP && point.y >= box.y + box.h && point.y <= bar.top
  );
}
