// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Browser JS has no declaration file.
import { createBody } from '../web/kit/body.js';
// @ts-expect-error Browser JS has no declaration file.
import { createPetSystem, definePetSystem } from '../web/system.js';

describe('system policy to the real kit body', () => {
  it('applies through the body contract, keeps cue expressions and releases its DOM', async () => {
    const root = document.createElement('div'); document.body.append(root);
    const draw = vi.fn();
    const runtime = createPetSystem(definePetSystem({ createBody: () => createBody({
      root, bounds: () => ({ W: 1000, H: 800, floorY: 700, S: 1 }), emit: vi.fn(), sound: vi.fn(),
    }, { figure: { draw }, roam: 'off' }) }));
    const body = await runtime.prepareBody({}); runtime.commitBody(body);
    runtime.setUserBodyEffects({ squash: false, dragStretch: false, breathing: false });
    body.cue('perk'); body.step(1 / 60);
    expect(body.bodyEffects).toEqual({ squash: false, dragStretch: false, breathing: false });
    expect(root.querySelector('svg > g')?.getAttribute('transform')).toContain('scale(1.0000 1.0000)');
    expect(root.querySelector('ellipse')?.getAttribute('rx')).toBe('72');
    expect(draw.mock.calls.at(-1)?.[2].face).toBe('surprised');
    body.dispose(); expect(root.children).toHaveLength(0); root.remove();
  });
});
