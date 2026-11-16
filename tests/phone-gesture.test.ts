import { describe, expect, it } from 'vitest';
// @ts-expect-error Shared browser gesture recognizer.
import { createPhoneGesture } from '../web/framework/phone-gesture.js';

const point = (x: number, y = 100, t = 0) => ({ x, y, t });

describe('portrait body gestures', () => {
  it('accepts a small click, but discards a long press or a single swipe', () => {
    const gesture = createPhoneGesture();
    gesture.start(point(100));
    expect(gesture.release(point(103, 102, 90))).toEqual({ type: 'tap', point: point(100) });
    gesture.start(point(100));
    expect(gesture.release(point(100, 100, 520))).toBeNull();
    gesture.start(point(100));
    expect(gesture.move(point(130, 100, 100))).toBe(false);
    expect(gesture.release(point(270, 100, 200))).toBeNull();
  });

  it('recognizes one shake per press after two quick changes in direction', () => {
    const gesture = createPhoneGesture();
    gesture.start(point(100));
    expect(gesture.move(point(125, 100, 40))).toBe(false);
    expect(gesture.move(point(80, 100, 100))).toBe(false);
    expect(gesture.move(point(120, 100, 165))).toBe(true);
    expect(gesture.move(point(80, 100, 210))).toBe(false);
    expect(gesture.release(point(123, 100, 240))).toBeNull();
  });

  it('ignores split or cancelled gestures', () => {
    const gesture = createPhoneGesture();
    gesture.start(point(100));
    gesture.move(point(125, 100, 100));
    gesture.move(point(80, 100, 400));
    expect(gesture.release(point(125, 100, 650))).toBeNull();
    gesture.start(point(100));
    gesture.cancel();
    expect(gesture.release(point(101, 100, 40))).toBeNull();
  });
});
