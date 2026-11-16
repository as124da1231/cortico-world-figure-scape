import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error browser runtime
import { createPetRuntime } from '../web/framework/runtime.js';
import { DESKTOP_PET_DEFINITION, definePetDefinition } from '../web/framework/definition.js';
// @ts-expect-error browser domains
import { createDesktopSpace, createDesktopPresentation, createBodyInput } from '../web/framework/desktop-space.js';
// @ts-expect-error browser domain
import { createBodyActions } from '../web/framework/actions.js';
function fixture() {
  const receipt = vi.fn(), watchWindows = vi.fn();
  const made: any[] = [], callbacks: any[] = [];
  const makeBody = vi.fn(async (options: any) => {
    callbacks.push(options);
    const b = { pack: options.pack.id, layout: { x: 600, y: 400, busy: false }, needsWindows: true,
      set: vi.fn(), reveal: vi.fn(), dispose: vi.fn(), do: vi.fn(), walk: vi.fn(), move: vi.fn(), stopWalk: vi.fn(),
      pointer: vi.fn(), hit: vi.fn(() => true), talk: vi.fn(), tick: vi.fn() };
    made.push(b); return b;
  });
  let onUnit: () => void = () => {};
  const speech = { stop: vi.fn(), dispose: vi.fn() };
  const registry: any = {
    body: { 'figure-body': makeBody }, scene: { 'desktop-space': createDesktopSpace },
    presentation: { 'desktop-presentation': createDesktopPresentation }, actions: { 'body-vocabulary': createBodyActions },
    input: { 'body-pointer': createBodyInput }, speech: { 'speech-playback': (p: any) => { onUnit = p.onUnit; return speech; } },
  };
  const ports = { scene: { viewport: () => ({ width: 1000, height: 800 }), floorInset: () => 20 },
    surface: { kind: 'existing-native-window', watchWindows }, audio: {}, receipt };
  return { registry, ports, made, callbacks, receipt, watchWindows, speech, unit: () => onUnit() };
}
const pack = (id: string) => ({ id, vocab: [{ id: 'smile', seconds: 2 }] });
describe('product definition to assembled runtime', () => {
  it('keeps definition serializable and immutable; bindings are separate', () => {
    expect(JSON.parse(JSON.stringify(DESKTOP_PET_DEFINITION))).toEqual(DESKTOP_PET_DEFINITION);
    const input = structuredClone(DESKTOP_PET_DEFINITION); const def = definePetDefinition(input);
    (input.body as any).implementation = 'other'; expect(def.body.implementation).toBe('figure-body');
    expect(Object.isFrozen(def.presentations.desktop)).toBe(true);
  });
  it('rejects missing implementations before creating any domain', () => {
    const f = fixture(); delete f.registry.input['body-pointer'];
    expect(() => createPetRuntime(DESKTOP_PET_DEFINITION, f.registry, f.ports)).toThrow('Unbound input');
    expect(f.registry.body['figure-body']).not.toHaveBeenCalled();
  });
  it('rolls back mounted domains when a later factory fails', () => {
    const f = fixture(), dispose = vi.fn();
    f.registry.scene['desktop-space'] = () => ({ dispose });
    f.registry.presentation['desktop-presentation'] = () => { throw new Error('mount failure'); };
    expect(() => createPetRuntime(DESKTOP_PET_DEFINITION, f.registry, f.ports)).toThrow('mount failure');
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('integrates scene, effects, action, speech and input in one injected surface', async () => {
    const f = fixture(), runtime = createPetRuntime(DESKTOP_PET_DEFINITION, f.registry, f.ports);
    runtime.configuration.apply({ bodyEffects: { squash: false }, scale: 1.2 });
    const body = await runtime.swapBody({ pack: pack('first'), layer: 'existing-layer' });
    expect(f.callbacks[0].bounds).toEqual({ W: 1000, H: 800, floorY: 780, S: .42 * 1.2, freeGround: false, fitDesktopEdges: true });
    expect(body.set).toHaveBeenCalledWith({ bodyEffects: { squash: false, breathing: true, dragStretch: true } });
    runtime.input.pointer('down', { x: 1, y: 2 }); expect(body.pointer).toHaveBeenCalledWith('down', { x: 1, y: 2 });
    expect(runtime.input.hit({ x: 1, y: 2 })).toBe(true);
    f.unit(); expect(body.talk).toHaveBeenCalledOnce();
    runtime.actions.enqueue('smile'); runtime.actions.tick(.1); expect(body.do).toHaveBeenCalledWith('smile');
    runtime.actions.walk({ t: 'walk', id: 7, to: .25, run: true }); expect(body.walk).toHaveBeenCalledWith(250, true, 7);
    f.callbacks[0].onEvent('arrived', { walkId: 7, x: 250, y: 400 });
    expect(f.receipt).toHaveBeenCalledWith({ t: 'arrived', walkId: 7, x: .25, y: .5, by: undefined });
    runtime.tick(.01, true); expect(body.tick).toHaveBeenCalledWith(.01, true);
    expect(runtime.snapshot().domains.presentation.status).toBe('active');
    expect(runtime.snapshot().domains.body.status).toBe('active');
    runtime.dispose(); runtime.dispose(); expect(body.dispose).toHaveBeenCalledOnce(); expect(f.speech.dispose).toHaveBeenCalledOnce();
    f.unit(); expect(body.talk).toHaveBeenCalledOnce();
  });
  it('interrupts pending work on replacement, rejects late old-body events, preserves disabled policy', async () => {
    const f = fixture(), runtime = createPetRuntime(DESKTOP_PET_DEFINITION, f.registry, f.ports);
    await runtime.swapBody({ pack: pack('first') }); runtime.configuration.apply({ bodyEffects: { breathing: false } });
    runtime.actions.walk({ t: 'walk', id: 8, to: 1 }); runtime.actions.enqueue('smile');
    await runtime.swapBody({ pack: pack('second') });
    expect(f.receipt).toHaveBeenCalledWith(expect.objectContaining({ t: 'interrupted', walkId: 8, by: 'body-replaced' }));
    f.receipt.mockClear(); f.callbacks[0].onEvent('arrived', { walkId: 8, x: 1000 }); expect(f.receipt).not.toHaveBeenCalled();
    runtime.actions.tick(.1); expect(f.made[1].do).not.toHaveBeenCalled();
    expect(runtime.snapshot().bodyEffects.breathing).toBe(false);
  });
  it('failed replacement leaves the active actions and body intact', async () => {
    const f = fixture(), runtime = createPetRuntime(DESKTOP_PET_DEFINITION, f.registry, f.ports);
    const old = await runtime.swapBody({ pack: pack('first') }); runtime.actions.enqueue('smile');
    await expect(runtime.swapBody({ pack: pack('bad') }, { configure() { throw new Error('bad candidate'); } })).rejects.toThrow('bad candidate');
    expect(runtime.body).toBe(old); runtime.actions.tick(.1); expect(old.do).toHaveBeenCalledWith('smile');
    expect(f.made[1].dispose).toHaveBeenCalledOnce();
  });
  it('uses the definition scene unless a presentation explicitly overrides it', () => {
    const f = fixture(), configured = vi.fn(createDesktopSpace);
    f.registry.scene['custom-space'] = configured;
    const def = definePetDefinition({ ...DESKTOP_PET_DEFINITION, scene: { implementation: 'custom-space' } });
    const runtime = createPetRuntime(def, f.registry, f.ports);
    expect(configured).toHaveBeenCalledOnce(); runtime.dispose();
  });
  it('reports post-commit failures without rejecting an already installed body', async () => {
    const f = fixture(), runtime = createPetRuntime(DESKTOP_PET_DEFINITION, f.registry, f.ports);
    await runtime.swapBody({ pack: pack('first') });
    runtime.actions.bodyCommitted = () => { throw new Error('action observer failed'); };
    f.watchWindows.mockClear();
    const next = await runtime.swapBody({ pack: pack('second') });
    expect(runtime.body).toBe(next); expect(f.made[0].dispose).toHaveBeenCalledOnce();
    expect(f.watchWindows).toHaveBeenCalledWith(true);
    expect(f.speech.stop).toHaveBeenLastCalledWith('body-changed');
    expect(runtime.snapshot().diagnostics).toContainEqual(expect.objectContaining({ domain: 'actions' }));
  });

  it('keeps actions accepted during initial body loading until the first body is available', async () => {
    const f = fixture(), runtime = createPetRuntime(DESKTOP_PET_DEFINITION, f.registry, f.ports);
    runtime.actions.enqueue('smile'); runtime.actions.tick(.1);
    const body = await runtime.swapBody({ pack: pack('first') });
    runtime.actions.tick(.1); expect(body.do).toHaveBeenCalledWith('smile');
  });

  it('guards framing restore by editor owner and clears ownership on body replacement', async () => {
    const f=fixture(), runtime=createPetRuntime(DESKTOP_PET_DEFINITION,f.registry,f.ports);
    const body=await runtime.swapBody({pack:pack('first')}); body.framing=vi.fn();
    runtime.framing.command({kind:'preview'},'a','1');
    runtime.framing.command({kind:'preview'},'b','2');
    runtime.framing.command({kind:'restore'},'a','3');
    expect(body.framing).toHaveBeenCalledTimes(2);
    runtime.framing.restore(); expect(body.framing).toHaveBeenLastCalledWith({kind:'restore'});
    await runtime.swapBody({pack:pack('second')});
    expect(runtime.framing.snapshot().owner).toBe(null);
  });

});
