export const VOICE_BUBBLE_HOLD = .65;
export const REPLY_BUBBLE_DEFAULT = 3;
export const REPLY_BUBBLE_MAX = 20;

export function replyBubbleSeconds(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(REPLY_BUBBLE_MAX, value)) : REPLY_BUBBLE_DEFAULT;
}

export function speechBubbleHold(length, speed, last, replySeconds) {
  if (!length) return .8 / speed;
  return last ? replyBubbleSeconds(replySeconds) : (.9 + length * .03) / speed;
}
