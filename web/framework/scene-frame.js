/** Keep movable, proportional scene frames inside the current display. */
export function createSceneFrame(viewport, defaultRect, placement, { inset = 10, minWidth = 1 } = {}) {
  function constrain(width, maximum) {
    const max = Math.max(1, maximum);
    const min = Math.min(minWidth, max);
    return Math.min(max, Math.max(min, width));
  }

  function rect() {
    const view = viewport();
    const base = defaultRect(view);
    const ratio = base.w / base.h;
    const maxWidth = Math.min(view.width - 2 * inset, (view.height - 2 * inset) * ratio);
    const w = constrain(placement.width ?? base.w, maxWidth);
    const h = w / ratio;
    const clamp = (value, size, extent) => {
      const margin = Math.max(0, Math.min(inset, (extent - size) / 2));
      return Math.max(margin, Math.min(extent - margin - size, value));
    };
    return {
      x: clamp(placement.x ?? base.x + (base.w - w) / 2, w, view.width),
      y: clamp(placement.y ?? base.y + (base.h - h) / 2, h, view.height),
      w, h,
    };
  }

  return {
    rect,
    move({ x: left, y: top }) {
      if (Number.isFinite(left)) placement.x = left;
      if (Number.isFinite(top)) placement.y = top;
      const { x, y } = rect();
      Object.assign(placement, { x, y });
      return { x, y };
    },
    resize(width) {
      const current = rect();
      if (!Number.isFinite(width)) return current;
      const view = viewport(), ratio = current.w / current.h;
      const maxWidth = Math.min(view.width - inset - current.x, (view.height - inset - current.y) * ratio);
      Object.assign(placement, { x: current.x, y: current.y, width: constrain(width, maxWidth) });
      return rect();
    },
  };
}
