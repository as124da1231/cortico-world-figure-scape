import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error browser JS
import { createPetSystem, definePetSystem } from '../web/system.js';
const body = () => ({ set: vi.fn(), reveal: vi.fn(), dispose: vi.fn() });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe('system-owned body replacement', () => {
  it('keeps old body until prepared and configures/reveals before retiring it', async () => {
    const old = body(), next = body(), ready = deferred<typeof next>();
    const factory = vi.fn(() => ready.promise);
    const runtime = createPetSystem(definePetSystem({ createBody: factory }));
    runtime.commitBody(old);
    expect(runtime.modelGeneration).toBe(1);
    const order: string[] = [];
    next.set.mockImplementation(() => { order.push('policy'); expect(runtime.body).toBe(old); });
    next.reveal.mockImplementation(() => { order.push('reveal'); expect(runtime.body).toBe(old); });
    old.dispose.mockImplementation(() => { order.push('retire'); expect(runtime.body).toBe(next); });
    const swap = runtime.swapBody({ layer: 'same-window' }, { configure: (candidate: unknown, current: unknown) => {
      order.push('configure'); expect(candidate).toBe(next); expect(current).toBe(old);
    } });
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ staged: true, layer: 'same-window', signal: expect.any(AbortSignal) }));
    expect(runtime.body).toBe(old); expect(old.dispose).not.toHaveBeenCalled();
    ready.resolve(next); await expect(swap).resolves.toBe(next);
    expect(order).toEqual(['configure', 'policy', 'reveal', 'retire']);
    expect(runtime.body).toBe(next); expect(runtime.snapshot().swappingBody).toBe(false);
    expect(runtime.snapshot().modelGeneration).toBe(2);
  });
  it.each(['load', 'configure', 'reveal'])('preserves old body when %s fails', async phase => {
    const old = body(), next = body();
    const factory = vi.fn(() => phase === 'load' ? Promise.reject(new Error('load')) : Promise.resolve(next));
    const runtime = createPetSystem(definePetSystem({ createBody: factory })); runtime.commitBody(old);
    if (phase === 'reveal') next.reveal.mockImplementation(() => { throw new Error('reveal'); });
    await expect(runtime.swapBody({}, { configure() { if (phase === 'configure') throw new Error('configure'); } })).rejects.toThrow(phase);
    expect(runtime.body).toBe(old); expect(old.dispose).not.toHaveBeenCalled();
    expect(next.dispose).toHaveBeenCalledTimes(phase === 'load' ? 0 : 1);
  });
  it('drops a late obsolete candidate even when a loader ignores cancellation', async () => {
    const first = deferred<ReturnType<typeof body>>(), second = deferred<ReturnType<typeof body>>();
    const factory = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const runtime = createPetSystem(definePetSystem({ createBody: factory }));
    const old = body(), stale = body(), next = body(); runtime.commitBody(old);
    const a = runtime.swapBody({}); const rejected = expect(a).rejects.toMatchObject({ name: 'AbortError' });
    const b = runtime.swapBody({});
    expect(factory.mock.calls[0][0].signal.aborted).toBe(true);
    second.resolve(next); await b; first.resolve(stale); await rejected;
    expect(runtime.body).toBe(next); expect(stale.dispose).toHaveBeenCalledOnce(); expect(stale.reveal).not.toHaveBeenCalled();
  });
  it('rechecks signal and admission after preparation and configure', async () => {
    const old = body(), next = body(), controller = new AbortController();
    const runtime = createPetSystem(definePetSystem({ createBody: async () => next })); runtime.commitBody(old);
    await expect(runtime.swapBody({ signal: controller.signal }, { configure() { controller.abort(); } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.body).toBe(old); expect(next.dispose).toHaveBeenCalledOnce(); expect(next.reveal).not.toHaveBeenCalled();
    const factory = vi.fn(); const stopped = createPetSystem(definePetSystem({ createBody: factory }));
    await expect(stopped.swapBody({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(factory).not.toHaveBeenCalled();
  });
  it('does not let an already stale UI request cancel useful preparation', async () => {
    const ready = deferred<ReturnType<typeof body>>(), next = body();
    const factory = vi.fn((_options: any) => ready.promise), runtime = createPetSystem(definePetSystem({ createBody: factory }));
    const good = runtime.swapBody({});
    await expect(runtime.swapBody({}, { validate() { throw new Error('obsolete'); } })).rejects.toThrow('obsolete');
    expect(factory.mock.calls[0][0].signal.aborted).toBe(false);
    ready.resolve(next); await good; expect(runtime.body).toBe(next);
  });
  it('uses latest user policy and disposes active and late candidates exactly once at shutdown', async () => {
    const ready = deferred<ReturnType<typeof body>>(), old = body(), next = body();
    const runtime = createPetSystem(definePetSystem({ createBody: () => ready.promise })); runtime.commitBody(old);
    const work = runtime.swapBody({}); const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    runtime.setUserBodyEffects({ squash: false });
    expect(old.set).toHaveBeenLastCalledWith({ bodyEffects: { squash: false, dragStretch: true, breathing: true } });
    runtime.dispose(); runtime.dispose(); ready.resolve(next); await rejected;
    expect(runtime.body).toBeNull(); expect(old.dispose).toHaveBeenCalledOnce(); expect(next.dispose).toHaveBeenCalledOnce();
    await expect(runtime.swapBody({})).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('reports retirement failure without rolling back to a partially disposed old body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const old = body(), next = body(); old.dispose.mockImplementation(() => { throw new Error('cleanup failed'); });
      const runtime = createPetSystem(definePetSystem({ createBody: async () => next })); runtime.commitBody(old);
      await runtime.swapBody({});
      expect(runtime.body).toBe(next); expect(runtime.snapshot().bodyCleanupError).toBe('cleanup failed');
    } finally { warn.mockRestore(); }
  });
});
