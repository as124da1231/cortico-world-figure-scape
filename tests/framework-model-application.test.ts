import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelApplication, type ModelLoadReceipt } from '../src/framework/model-application.ts';

function setup() {
  const send = vi.fn((_message: any): boolean => true);
  const application = createModelApplication<{ figure: string }, ModelLoadReceipt>({ send, failure: () => 'No first frame', timeoutMs: 100 });
  const controller = new AbortController();
  return { application, controller, send,
    load: () => application.load({ figure: 'candidate' }, controller.signal),
    request: () => [...send.mock.calls].reverse().find(([m]) => m.t === 'load-figure')![0].request,
  };
}
afterEach(() => vi.useRealTimers());

describe('model application ownership', () => {
  it('waits for a matching first frame, ignoring unsolicited and stale receipts', async () => {
    const f = setup(), task = f.load(), resolved = vi.fn(); task.then(resolved);
    f.application.receive({ id: 'candidate', ok: true });
    f.application.receive({ request: 'old', id: 'candidate', ok: true });
    await Promise.resolve(); expect(resolved).not.toHaveBeenCalled();
    const receipt = { request: f.request(), id: 'candidate', ok: true };
    f.application.receive(receipt); expect(await task).toBe(receipt);
    f.application.disconnected(); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('installs ownership before a synchronous transport acknowledgement', async () => {
    const f = setup();
    f.send.mockImplementation(m => { f.application.receive({ request: m.request, id: 'candidate', ok: true }); return true; });
    expect(await f.load()).toMatchObject({ ok: true });
  });
  it('does not send a cancelled request or pretend an offline selection is applied', async () => {
    const f = setup(); f.controller.abort(new Error('Stopped'));
    await expect(f.load()).rejects.toThrow('Stopped'); expect(f.send).not.toHaveBeenCalled();
    f.send.mockReturnValue(false);
    expect(await f.application.load({ figure: 'candidate' }, new AbortController().signal)).toBeUndefined();
    f.application.disconnected(); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('rejects a wrong candidate and releases ownership for retry', async () => {
    const f = setup(), task = f.load(), failed = expect(task).rejects.toThrow('No first frame');
    f.application.receive({ request: f.request(), id: 'other', ok: true }); await failed;
    expect(f.send.mock.lastCall![0].t).toBe('cancel-figure-load');
    const retry = f.load(); f.application.receive({ request: f.request(), id: 'candidate', ok: true }); await retry;
  });
  it('cancels a disconnected operation once and ignores its late success', async () => {
    const f = setup(), task = f.load(), failed = expect(task).rejects.toThrow('No first frame'), old = f.request();
    f.application.disconnected(); f.application.disconnected(); await failed;
    const retry = f.load(), resolved = vi.fn(); retry.then(resolved);
    f.application.receive({ request: old, id: 'candidate', ok: true });
    await Promise.resolve(); expect(resolved).not.toHaveBeenCalled();
    f.application.receive({ request: f.request(), id: 'candidate', ok: true }); await retry;
    expect(f.send.mock.calls.filter(([m]) => m.t === 'cancel-figure-load')).toHaveLength(1);
  });
  it('bounds waiting and clears timers after abort or success', async () => {
    vi.useFakeTimers(); const f = setup();
    const timeout = expect(f.load()).rejects.toThrow('No first frame');
    await vi.advanceTimersByTimeAsync(100); await timeout; expect(vi.getTimerCount()).toBe(0);
    const cancelled = expect(f.load()).rejects.toThrow('Stopped'); f.controller.abort(new Error('Stopped')); await cancelled;
    expect(vi.getTimerCount()).toBe(0);
    const next = f.application.load({ figure: 'candidate' }, new AbortController().signal);
    f.application.receive({ request: f.request(), id: 'candidate', ok: true }); await next;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects overlapping loads without stealing the active operation', async () => {
    const f = setup(), task = f.load();
    await expect(f.load()).rejects.toThrow('already pending');
    f.application.receive({ request: f.request(), id: 'candidate', ok: true }); await task;
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('settles even if sending or cancellation throws', async () => {
    const f = setup(); f.send.mockImplementation(() => { throw Error('Socket closed'); });
    await expect(f.load()).rejects.toThrow('Socket closed');
    f.send.mockReturnValue(false); expect(await f.load()).toBeUndefined();
  });
});
