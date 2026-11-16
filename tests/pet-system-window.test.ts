// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error browser JS
import { loadBody } from '../web/body-host.js';
// @ts-expect-error browser JS
import { definePetSystem, createPetSystem } from '../web/system.js';
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); document.body.replaceChildren(); vi.useRealTimers(); });
function setup() {
  const layer = document.createElement('div'); document.body.append(layer);
  const runtime = createPetSystem(definePetSystem({ createBody: loadBody })); cleanups.push(() => runtime.dispose());
  const old = { set: vi.fn(), dispose: vi.fn() }; runtime.commitBody(old);
  const options = { layer, pack: { id: 'coo', base: '/coo/', vocab: [] }, start: {}, bounds: { W: 1000, H: 800, floorY: 700, S: 1 } };
  return { layer, runtime, old, options };
}
function transport(layer: HTMLElement) {
  const frame = layer.querySelector('iframe')!;
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
  return (data: unknown) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow!, data }));
}
describe('system replacement with the real window body loader', () => {
  it('keeps the candidate hidden and old body alive until a valid first layout arrives', async () => {
    const { layer, runtime, old, options } = setup();
    const work = runtime.swapBody(options); const receive = transport(layer);
    expect(layer.querySelector<HTMLElement>('.figure-clip')!.style.visibility).toBe('hidden');
    receive({ t: 'ready' }); await Promise.resolve();
    expect(runtime.body).toBe(old); expect(old.dispose).not.toHaveBeenCalled();
    receive({ t: 'frame', layout: null }); await Promise.resolve();
    expect(runtime.body).toBe(old); expect(layer.querySelector<HTMLElement>('.figure-clip')!.style.visibility).toBe('hidden');
    receive({ t: 'frame', layout: {} }); const next = await work;
    expect(runtime.body).toBe(next); expect(old.dispose).toHaveBeenCalledOnce();
    expect(layer.querySelector<HTMLElement>('.figure-clip')!.style.visibility).toBe('');
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
  });
  it('cancels a pending candidate without closing the old body or leaving an iframe', async () => {
    const { layer, runtime, old, options } = setup();
    const work = runtime.swapBody(options); transport(layer);
    const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    runtime.cancelBodySwap(); await rejected;
    expect(runtime.body).toBe(old); expect(old.dispose).not.toHaveBeenCalled(); expect(layer.children).toHaveLength(0);
  });
  it('times out a ready body with no usable frame and retains the old one', async () => {
    vi.useFakeTimers();
    const { layer, runtime, old, options } = setup();
    const work = runtime.swapBody(options), rejected = expect(work).rejects.toThrow();
    const receive = transport(layer); receive({ t: 'ready' }); receive({ t: 'frame', layout: null });
    vi.advanceTimersByTime(20000); await rejected;
    expect(runtime.body).toBe(old); expect(old.dispose).not.toHaveBeenCalled(); expect(layer.children).toHaveLength(0);
  });
});
