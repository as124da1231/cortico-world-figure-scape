import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error These ports are shared with the desktop renderer.
import { createDesktopSpace } from '../web/framework/desktop-space.js';
// @ts-expect-error These ports are shared with the desktop renderer.
import { createDisplayDrag } from '../web/framework/display-drag.js';

describe('cross-display drag', () => {
  const scene = createDesktopSpace({ viewport: () => ({ width: 1200, height: 800 }), floorInset: () => 20 });
  const port = { scene, refresh: vi.fn(), now: () => 0, frame: async () => {} };
  it('applies the host offset in the new display and releases that drag', async () => {
    const body = { layout: { mode: 'drag' }, shift: vi.fn(), drop: vi.fn() };
    const followCursor = vi.fn(async () => ({ x: 900, y: 600, w: 1200, h: 800, dx: -1200, dy: -250 }));
    const drag = createDisplayDrag({ ...port, currentBody: () => body, followCursor });
    drag.follow({ x: 1205, y: 600 });
    const ordinary = vi.fn();
    await drag.release({ x: 1205, y: 600 }, ordinary, vi.fn());
    expect(body.shift).toHaveBeenCalledExactlyOnceWith(-1200, -250);
    expect(ordinary).toHaveBeenCalledOnce();
    expect(body.drop).not.toHaveBeenCalled();
    expect(drag.shifting).toBe(false);
  });
  it('drops a late display result when the originating body is gone', async () => {
    const old = { layout: { mode: 'drag' }, shift: vi.fn(), drop: vi.fn() };
    const next = { layout: { mode: 'drag' }, shift: vi.fn(), drop: vi.fn() };
    let body = old;
    let finish!: (value: unknown) => void;
    const drag = createDisplayDrag({ ...port, currentBody: () => body,
      followCursor: () => new Promise(resolve => { finish = resolve; }),
    });
    const ordinary = vi.fn();
    const release = drag.release({ x: -5, y: 600 }, ordinary, vi.fn());
    body = next;
    finish({ x: 1195, y: 600, w: 1200, h: 800, dx: 1200, dy: 0 });
    await release;
    expect(ordinary).not.toHaveBeenCalled();
    expect(old.drop).not.toHaveBeenCalled();
    expect(next.drop).not.toHaveBeenCalled();
  });
});
