import { describe, expect, it } from 'vitest';
import { readWindowCompatibility } from '../src/framework/window-compatibility.ts';
// @ts-expect-error Browser module.
import { createBubbleHover } from '../web/framework/bubble-hover.js';

describe('Windows capture policy', () => {
  const report = { hideFromCapture: true, capture: 'excluded', overTaskbar: false };
  it('uses the actual window report and preserves feature support independently', () => {
    expect(readWindowCompatibility(report, true, false)).toEqual(report);
    expect(readWindowCompatibility({ ...report, capture: 'limited' }, true, false)?.capture).toBe('limited');
    expect(readWindowCompatibility({ ...report, capture: 'unsupported', overTaskbar: null }, true, false)?.overTaskbar).toBeNull();
  });
  it('ignores mismatched receipts and does not accept contradictory system states', () => {
    expect(readWindowCompatibility(report, false, false)).toBeNull();
    expect(readWindowCompatibility(report, true, true)).toBeNull();
    expect(readWindowCompatibility({ ...report, capture: 'allowed' }, true, false)).toBeNull();
  });
});

it('holds a bubble only after the pointer is observed outside it', () => {
  const hover = createBubbleHover();
  const point = (x: number) => ({x, y: 60});
  hover.open();
  expect(hover.sample(true, point(10))).toBe(false);
  expect(hover.sample(true, point(11))).toBe(false);
  expect(hover.sample(false, point(30))).toBe(false);
  expect(hover.sample(true, point(20))).toBe(true);
  expect(hover.sample(true, point(20))).toBe(true);
  hover.open();
  expect(hover.sample(false, point(20))).toBe(false);
  expect(hover.sample(true, point(20))).toBe(false);
});
