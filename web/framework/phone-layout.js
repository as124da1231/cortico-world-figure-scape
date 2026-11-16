import { CONTROL_PANEL_LIMITS, controlPanelSize } from './control-layout.js';

const EDGE = 10;
const GAP = 14;

export function phoneRect({ width, height }) {
  const h = Math.max(1, Math.min(height * .88, height - EDGE * 2, (width - EDGE * 2) * 16 / 9, 720));
  const w = h * 9 / 16;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

/** Target the right side first and keep the chat composer accessible on small displays. */
export function controlPhoneRect(anchor, { width, height }, chat, chrome, preferredSide, size, dock) {
  const preferred = controlPanelSize(size);
  const maxW = Math.min(preferred.width, Math.max(1, width - EDGE * 2));
  const maxH = Math.max(1, height - EDGE * 2);
  const right = width - EDGE - (anchor.x + anchor.w + GAP);
  const left = anchor.x - GAP - EDGE;
  const minimum = Math.min(CONTROL_PANEL_LIMITS.minWidth, maxW);
  const side = preferredSide === 'left' && left >= minimum ? 'left'
    : right >= maxW ? 'right' : left >= maxW ? 'left'
    : right >= left && right >= minimum ? 'right' : left >= minimum ? 'left' : null;
  const w = side ? Math.min(maxW, side === 'right' ? right : left) : maxW;
  const floatingTop = chat ? (chrome?.top ?? chat.y + 54) : anchor.y - 24;
  const usable = chat && !side ? Math.max(1, (chrome?.bottom ?? chat.y + chat.h - 65) - floatingTop - GAP) : maxH;
  const h = Math.min(maxH, preferred.height, usable, chat?.h ?? maxH);
  const x = side === 'right' ? anchor.x + anchor.w + GAP : side === 'left' ? anchor.x - GAP - w
    : Math.max(EDGE, Math.min(width - EDGE - w, anchor.x + anchor.w - w));
  const y = chat ? side ? chat.y : floatingTop : side ? anchor.y + (anchor.h - h) / 2 : anchor.y - h + 24;
  const top = Math.max(EDGE, Math.min(height - EDGE - h, y));
  const crossesDock = dock && x < dock.right + EDGE && x + w > dock.left - EDGE
    && top < dock.bottom + EDGE && top + h > dock.top - EDGE;
  if (crossesDock) {
    const above = dock.top - EDGE, below = height - dock.bottom - EDGE * 2;
    if (below > above - EDGE) {
      return {x,y:dock.bottom + EDGE,w,h:Math.min(h,below),placement:side ?? 'floating'};
    }
    return {x,y:Math.max(EDGE,above-h),w,h:Math.min(h,Math.max(1,above-EDGE)),placement:side ?? 'floating'};
  }
  return {x,y:top,w,h,placement:side ?? 'floating'};
}

export function positionPhone(element, { x, y, w, h }) {
  Object.assign(element.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
}
