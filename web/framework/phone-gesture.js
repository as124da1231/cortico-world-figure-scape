const TAP_RADIUS = 8;
const TAP_MS = 400;
const SWING_DISTANCE = 15;
const SHAKE_MS = 550;

/** Recognizes a portrait interaction before any press is forwarded to the body. */
export function createPhoneGesture() {
  let press = null;
  function move(point) {
    if (!press) return false;
    if (Math.hypot(point.x - press.start.x, point.y - press.start.y) > TAP_RADIUS) press.moved = true;
    if (press.shaken) return false;
    if (point.t - press.sequenceStart > SHAKE_MS) {
      press.origin = point;
      press.direction = press.swings = 0;
      press.sequenceStart = point.t;
      return false;
    }
    const dx = point.x - press.origin.x;
    if (Math.abs(dx) < SWING_DISTANCE || Math.abs(dx) < Math.abs(point.y - press.origin.y)) return false;
    const direction = Math.sign(dx);
    if (direction !== press.direction) press.swings++;
    press.origin = point;
    press.direction = direction;

    press.shaken = press.swings >= 3;
    return press.shaken;
  }
  return {
    start(point) {
      press = { start: point, origin: point, sequenceStart: point.t, direction: 0, swings: 0, moved: false, shaken: false };
    },
    move,
    release(point) {
      const shake = move(point);
      const tap = press && !press.moved && !press.shaken && point.t - press.start.t < TAP_MS;
      const result = shake ? { type: 'shake' } : tap ? { type: 'tap', point: press.start } : null;
      press = null;
      return result;
    },
    cancel() { press = null; },
  };
}
