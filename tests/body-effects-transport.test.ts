// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error browser JS
import { loadBody } from '../web/body-host.js';
// @ts-expect-error browser JS
import { createBody } from '../web/kit/body.js';
// @ts-expect-error browser JS
import { bodyEffectReport, applyBodyState, readEffectReport } from '../web/body-effects-contract.js';
// @ts-expect-error browser JS
import { definePetSystem, createPetSystem } from '../web/system.js';
const effects = { squash: true, dragStretch: true, breathing: true };
const bounds = { W: 1000, H: 800, floorY: 700, S: 1 };
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.useRealTimers(); document.body.replaceChildren(); });
async function setup(report: unknown, editorPreview = false) {
  const layer = document.createElement('div'); document.body.append(layer);
  const promise = loadBody({ layer, pack: { id: 'coo', vocab: [], base: '/coo/' }, start: {}, bounds, editorPreview });
  const frame = layer.querySelector('iframe')!;
  const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
  const receive = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow!, data }));
  receive({ t: 'ready', bodyEffects: report, draftAction: { supported: true, status: 'idle' } });
  const adapter = await promise; cleanup.push(() => adapter.dispose());
  return { adapter, post, receive };
}
describe('body effect transport and actual kit', () => {
  it('rejects malformed capability claims rather than treating strings as support', () => {
    expect(readEffectReport({ supported: 'squash', values: { squash: true } })).toEqual({ supported: [], values: {} });
    expect(readEffectReport({ supported: ['squash', 'unknown'], values: { squash: 'false' } })).toEqual({ supported: ['squash'], values: {} });
  });
  it('runs system -> host message -> frame state handler -> real kit -> correlated receipt', async () => {
    const root = document.createElement('div'); document.body.append(root);
    const kit = createBody({ root, bounds: () => bounds, emit() {}, sound() {} }, { figure: { draw() {} }, roam: 'off' });
    cleanup.push(() => kit.dispose());
    const { adapter, post, receive } = await setup(bodyEffectReport(kit));
    const system = createPetSystem(definePetSystem({ createBody: () => adapter }));
    system.commitBody(adapter);
    system.setUserBodyEffects({ squash: false, dragStretch: false, breathing: false });
    expect(system.snapshot().bodyEffectsStatus.status).toBe('pending');
    const request = post.mock.calls.at(-1)![0] as any;
    receive(applyBodyState(kit, request.state, request.effectSeq));
    kit.cue('bounce'); kit.step(1 / 60);
    expect(system.snapshot().bodyEffectsStatus).toMatchObject({ status: 'applied', values: { squash: false, dragStretch: false, breathing: false } });
    expect(root.querySelector('svg > g')!.getAttribute('transform')).toContain('scale(1.0000 1.0000)');
    expect(root.querySelector('ellipse')!.getAttribute('rx')).toBe('72');
  });
  it('does not claim success for legacy bodies, mismatches, stale acknowledgements or missing responses', async () => {
    vi.useFakeTimers();
    const legacy = await setup(undefined);
    legacy.adapter.set({ bodyEffects: effects });
    expect(legacy.adapter.bodyEffectsStatus.status).toBe('unsupported');
    const { adapter, post, receive } = await setup({ supported: Object.keys(effects), values: effects });
    adapter.set({ bodyEffects: { squash: false } });
    const first = (post.mock.calls.at(-1)![0] as any).effectSeq;
    adapter.set({ bodyEffects: { squash: true } });
    const current = (post.mock.calls.at(-1)![0] as any).effectSeq;
    receive({ t: 'body-effects', seq: first, report: { supported: Object.keys(effects), values: { ...effects, squash: false } } });
    expect(adapter.bodyEffectsStatus.status).toBe('pending');
    vi.advanceTimersByTime(2000);
    expect(adapter.bodyEffectsStatus.status).toBe('timeout');
    receive({ t: 'body-effects', seq: current, report: { supported: Object.keys(effects), values: { ...effects, squash: false } } });
    expect(adapter.bodyEffectsStatus.status).toBe('mismatch');
    adapter.dispose(); expect(adapter.bodyEffectsStatus.status).toBe('disposed');
  });
});

it('limits editor render backlog without blocking or misreporting a native action', async () => {
  const { adapter, post, receive } = await setup(undefined, true);
  for (let frame = 0; frame < 120; frame++) adapter.tick(.016);
  expect(post.mock.calls).toEqual([[expect.objectContaining({ t: 'tick', dt: .016 }), '*']]);

  const play = adapter.draftAction({ kind: 'play', owner: 'editor', binding: {
    word: 'happy', resource: 'expr-0123456789abcdef',
  } }, 'play-1');
  const request = post.mock.calls.at(-1)![0] as { t: string; seq: number };
  expect(request.t).toBe('body-draft-action');
  const report = { supported: true, requestId: 'play-1', owner: 'editor', status: 'playing' };
  receive({ t: 'body-draft-action', seq: request.seq - 1, ok: true, report });
  expect(adapter.draftActionStatus.status).toBe('idle');
  receive({ t: 'body-draft-action', seq: request.seq, ok: true, report });
  await expect(play).resolves.toMatchObject(report);

  receive({ t: 'frame', draftAction: report });
  adapter.tick(.016);
  expect(post.mock.calls.at(-1)![0]).toMatchObject({ t: 'tick', dt: .05 });
  const stop = adapter.draftAction({ kind: 'stop', owner: 'editor' }, 'stop-1');
  const next = post.mock.calls.at(-1)![0] as { seq: number };
  receive({ t: 'body-draft-action', seq: next.seq, ok: true, report });
  await expect(stop).rejects.toThrow('did not match');
});
