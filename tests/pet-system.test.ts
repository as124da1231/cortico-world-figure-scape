import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Browser JS has no declaration file.
import { definePetSystem, createPetSystem } from '../web/system.js';

describe('pet system assembly slice', () => {
  it('requires an injected loader and defined default presentation', () => {
    expect(() => definePetSystem({})).toThrow('factory');
    expect(() => definePetSystem({ createBody() {}, presentations: {} })).toThrow('presentation');
  });
  it('keeps static definition isolated from caller mutation and runtime state', () => {
    const input = { desktop: { bodyEffects: { squash: false } }, room: { bodyEffects: {} } };
    const definition = definePetSystem({ createBody: vi.fn(), presentations: input });
    input.desktop.bodyEffects.squash = true;
    expect(Object.isFrozen(definition)).toBe(true);
    const first = createPetSystem(definition), second = createPetSystem(definition);
    first.setUserBodyEffects({ squash: true });
    expect(first.snapshot().bodyEffects.squash).toBe(true);
    expect(second.snapshot().bodyEffects.squash).toBe(false);
  });
  it('preserves loader arguments and does not commit a merely prepared body', async () => {
    const body = { set: vi.fn() }, createBody = vi.fn().mockResolvedValue(body);
    const runtime = createPetSystem(definePetSystem({ createBody }));
    const options = { layer: {}, signal: new AbortController().signal, staged: true };
    expect(await runtime.prepareBody(options)).toBe(body);
    expect(createBody).toHaveBeenCalledWith(options);
    expect(runtime.snapshot().hasBody).toBe(false);
    expect(body.set).not.toHaveBeenCalled();
    runtime.commitBody(body);
    expect(runtime.snapshot().hasBody).toBe(true);
    expect(body.set).toHaveBeenCalledWith({ bodyEffects: { squash: true, dragStretch: true, breathing: true } });
  });
  it('preserves user overrides across committed body replacements', () => {
    const runtime = createPetSystem(definePetSystem({ createBody: vi.fn() }));
    const old = { set: vi.fn() }, next = { set: vi.fn() };
    runtime.commitBody(old);
    runtime.setUserBodyEffects({ squash: false });
    runtime.commitBody(next);
    old.set.mockClear();
    runtime.setUserBodyEffects({ breathing: false });
    expect(old.set).not.toHaveBeenCalled();
    expect(next.set).toHaveBeenLastCalledWith({ bodyEffects: { squash: false, dragStretch: true, breathing: false } });
    const snapshot = runtime.snapshot(); snapshot.bodyEffects.squash = true;
    expect(runtime.snapshot().bodyEffects.squash).toBe(false);
  });
  it('retains the committed target after rejected preparation or failed admission', async () => {
    const runtime = createPetSystem(definePetSystem({ createBody: vi.fn().mockRejectedValue(new Error('load failed')) }));
    const old = { set: vi.fn() }; runtime.commitBody(old);
    await expect(runtime.prepareBody({})).rejects.toThrow('load failed');
    expect(() => runtime.commitBody({})).toThrow('implement set');
    runtime.setUserBodyEffects({ squash: false });
    expect(old.set).toHaveBeenLastCalledWith({ bodyEffects: { squash: false, dragStretch: true, breathing: true } });
  });
});
