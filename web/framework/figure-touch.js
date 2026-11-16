import { touchArea, touchRegionAt, touchRule } from './touch-geometry.js';

export function createFigureTouch(profile, words, body) {
  const known = new Set(words);
  let pressed, pointer, count = 0, shakeCount = 0;
  function layout() {
    const current = body.layout();
    const box = current?.box;
    if (!box || !(box.w > 0 && box.h > 0)) return current;
    const touchFrame = current.touchFrame ?? {
      origin: { x: box.x, y: box.y }, x: { x: box.w, y: 0 }, y: { x: 0, y: box.h },
    };
    return { ...current, touchBounds: current.touchBounds ?? box, touchFrame, touchAreas: profile?.areas ?? current.touchAreas };
  }

  function region(point, current) {
    const box = current?.box;
    if (!box || !Number.isFinite(point?.x) || !Number.isFinite(point?.y) ||
      point.x < box.x || point.x > box.x + box.w || point.y < box.y || point.y > box.y + box.h) return undefined;
    const custom = touchArea(profile, current.touchFrame, point)?.id;
    if (custom) return custom;
    const visible = current.hit;
    if (visible?.length && !visible.some(circle => Math.hypot(point.x - circle.x, point.y - circle.y) <= circle.r)) return undefined;
    return touchRegionAt(profile, current.touchFrame, current.touchBounds, point);
  }

  function event(kind, detail) {
    if (!profile || kind !== 'touch' || !detail) return detail;
    const gesture = detail.kind;
    if (!['poke', 'pet', 'drop', 'shake'].includes(gesture)) return detail;
    if (gesture === 'poke') count++;
    if (gesture === 'shake') shakeCount++;
    const frame = layout();
    const area = gesture === 'poke' || gesture === 'pet'
      ? (pointer ? region(pointer, frame) : detail.region) : undefined;
    const rule = touchRule(profile, gesture, area ?? 'all');
    const { region: _original, ...result } = detail;
    if (area) result.region = area;
    const word = rule?.action?.word ?? (rule?.reaction === 'default' ? ({ poke:'surprised', pet:'love', drop:'happy', shake:'shake' })[gesture] : undefined);
    if (word) {
      if (frame?.busy || frame?.moving) result.reaction = 'busy';
      else if (!known.has(word)) result.reaction = 'unavailable';
      else {
        try { result.reaction = body.do(word) === false ? 'unavailable' : 'played'; }
        catch { result.reaction = 'unavailable'; }
      }
    }
    return result;
  }

  function input(type, point, emit) {
    pointer = point;
    if (!profile) return body.pointer?.(type, point);
    if (type === 'down') pressed = point && region(point, layout()) ? point : undefined;
    const before = count, beforeShake = shakeCount;
    const dropped = body.pointer?.(type, point);
    if (type === 'shake' && shakeCount === beforeShake && touchRule(profile, 'shake', 'all')) emit('touch', { kind:'shake' });
    if (type === 'up') {
      const start = pressed;
      pressed = undefined;
      const area = region(point, layout());
      if (area && start && count === before && !dropped && Math.hypot(point.x - start.x, point.y - start.y) < 8
        && touchRule(profile, 'poke', area)) emit('touch', { kind: 'poke', region: area });
    } else if (type === 'leave' || type === 'cancel') pressed = undefined;
    return dropped;
  }
  return { layout, event, input };
}
