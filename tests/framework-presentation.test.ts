import { describe, expect, it, vi } from 'vitest';
import { createPresentationService, type PresentationMode } from '../src/framework/presentation-service.ts';
// @ts-expect-error Browser scene runtime.
import { createRoomSpace, createPhoneSpace } from '../web/framework/room-space.js';
// @ts-expect-error Browser movement runtime.
import { createSceneMovement } from '../web/framework/scene-movement.js';

function fixture() {
  let desired: PresentationMode = 'desktop';
  const send = vi.fn((_message: Record<string, unknown>) => true);
  const service = createPresentationService({ desired: () => desired, persist: mode => { desired = mode; },
    connected: () => true, model: () => 'model', modelBusy: () => false, send, scene: () => null });
  service.receive({ request: null, mode: 'desktop', figure: 'model', ok: true });
  return { service, send };
}

describe('presentation transactions', () => {
  it('uses the first frame and matching model before committing a repeatable request', async () => {
    const { service, send } = fixture();
    const promise = service.select('room', 'same');
    expect(service.select('room', 'same')).toBe(promise);
    const { request } = send.mock.calls[0][0];
    const result = { request, mode: 'room', figure: 'model', ok: true, generation: 2 };
    service.receive(result);
    service.ready({ ...result, figure: 'old-model' });
    expect(service.state().applied).toBe('desktop');
    expect(() => service.select('phone')).toThrow('busy');
    service.ready(result);
    expect(send).toHaveBeenLastCalledWith({ t: 'presentation-confirm', request });
    expect(service.cancel('same')?.phase).toBe('committing');
    service.receive(result);
    await expect(promise).resolves.toMatchObject({ applied: true, phase: 'completed' });
    expect(service.state()).toMatchObject({ desired: 'room', applied: 'room', generation: 2 });
  });
  it('keeps the old wallpaper while replacement is pending or fails', async () => {
    const { service, send } = fixture();
    const commit = vi.fn(async () => {});
    const selected = service.select('wallpaper','first',{payload:{id:'first'},replace:true,commit});
    const first = { request:send.mock.lastCall?.[0].request, mode:'wallpaper', figure:'model', ok:true };
    service.ready(first);
    service.receive({...first,presentation:{wallpaper:{id:'first'}}});
    await expect(selected).resolves.toMatchObject({phase:'completed',applied:true});
    expect(commit).toHaveBeenCalledOnce();
    const replace = vi.fn(async () => {});
    const pending = service.select('wallpaper','next',{payload:{id:'next'},replace:true,commit:replace});
    expect(service.state()).toMatchObject({applied:'wallpaper',details:{wallpaper:{id:'first'}}});
    service.receive({...first,request:send.mock.lastCall?.[0].request,ok:false,reason:'wallpaper-first-frame-failed'});
    await expect(pending).resolves.toMatchObject({phase:'failed',applied:false});
    expect(replace).not.toHaveBeenCalled();
    expect(service.state()).toMatchObject({applied:'wallpaper',details:{wallpaper:{id:'first'}}});
  });
  it('ignores late cancelled receipts and recovers after a failed candidate', async () => {
    const { service, send } = fixture();
    const cancelled = service.select('room', 'cancel');
    const { request } = send.mock.calls[0][0];
    service.cancel('cancel');
    service.ready({ request, mode: 'room', figure: 'model' });
    service.receive({ request, mode: 'room', figure: 'model', ok: true });
    await expect(cancelled).resolves.toMatchObject({ phase: 'cancelled' });
    const failed = service.select('phone');
    service.receive({ request: send.mock.lastCall?.[0].request, figure: 'model', ok: false, reason: 'first-frame' });
    await expect(failed).resolves.toMatchObject({ phase: 'failed', error: 'first-frame' });
    expect(service.state()).toMatchObject({ desired: 'desktop', applied: 'desktop' });
  });
});

describe('bounded scenes', () => {
  const viewport = () => ({ width: 1280, height: 800 });
  it('uses legal orthogonal segments around obstacles, with distinct approach and pose anchors', () => {
    const scene = createRoomSpace({ viewport });
    const door = scene.restore(), { path, posture, pose } = scene.plan(door, 'bed', true);
    expect(posture).toBe('sleep');
    expect(scene.targetAt(pose)).toBe('bed');
    expect(scene.targetAt(path.at(-1))).toBeUndefined();
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      expect(a.x === b.x || a.y === b.y).toBe(true);
      for (let sample = 0; sample <= 20; sample++) {
        const point = { x: a.x + (b.x - a.x) * sample / 20, y: a.y + (b.y - a.y) * sample / 20 };
        for (const { rect } of scene.furniture()) {
          expect(point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y + rect.h * .36 && point.y <= rect.y + rect.h).toBe(false);
        }
      }
    }
    expect(() => scene.plan(door, pose)).toThrow('target-unreachable');
    expect(scene.drop(pose)).toMatchObject({ target: 'bed', posture: 'sleep' });
    expect(scene.contains(scene.drop({ x: -1000, y: 1000 }).point)).toBe(true);
  });
  it.each([createRoomSpace, createPhoneSpace])('moves the frame and its local anchors together', createSpace => {
    const framePlacement = {};
    const scene = createSpace({ viewport, framePlacement });
    const before = scene.rect(), point = scene.restore(.5, .8);
    const local = scene.normalize(point);
    const moved = scene.moveFrame({ x: before.x - 12, y: before.y - 5 });
    expect(moved).toEqual({ x: before.x - 12, y: before.y - 5 });
    const next = scene.restore(.5, .8);
    expect(next).toMatchObject({ x: expect.closeTo(point.x - 12), y: expect.closeTo(point.y - 5) });
    expect(scene.normalize(next)).toEqual({
      x: expect.closeTo(local.x), y: expect.closeTo(local.y),
    });
    expect(createSpace({ viewport, framePlacement }).rect()).toEqual(scene.rect());
    scene.moveFrame({ x: -5000, y: 5000 });
    const edge = scene.rect();
    expect(edge.x).toBe(10);
    expect(edge.y + edge.h).toBeCloseTo(790);
  });
  it.each([createRoomSpace, createPhoneSpace])('resizes around the top-left corner and keeps the scene inside the work area', createSpace => {
    const placement = {};
    const scene = createSpace({ viewport, framePlacement: placement });
    scene.moveFrame({ x: 20, y: 20 });
    const before = scene.rect();
    const smaller = scene.resizeFrame(before.w * .8);
    expect(smaller).toMatchObject({ x: 20, y: 20, w: expect.closeTo(before.w * .8) });
    expect(smaller.w / smaller.h).toBeCloseTo(before.w / before.h);
    expect(createSpace({ viewport, framePlacement: placement }).rect()).toEqual(smaller);
    const largest = scene.resizeFrame(100000);
    expect(largest.x).toBe(20);
    expect(largest.y).toBe(20);
    expect(largest.x + largest.w).toBeLessThanOrEqual(viewport().width - 10 + .001);
    expect(largest.y + largest.h).toBeLessThanOrEqual(viewport().height - 10 + .001);
    expect(largest.w / largest.h).toBeCloseTo(before.w / before.h);
  });
  it('ignores stale room waypoint receipts after drag and bounds explicit phone movement', () => {
    const scene = createRoomSpace({ viewport }), receipt = vi.fn();
    const figure = { layout: scene.restore(), supportsWord: () => true, walk: vi.fn(), stopWalk: vi.fn(), do: vi.fn(), place: vi.fn() };
    const controller = createSceneMovement({ current: () => scene, body: { body: figure }, receipt });
    controller.start({ id: 'walk', target: 'chair', interact: true });
    const walkId = figure.walk.mock.lastCall?.[2];
    controller.drop({ x: -1000, y: 1000 });
    controller.event('arrived', { walkId });
    expect(figure.do).not.toHaveBeenCalledWith('sit');
    expect(receipt).toHaveBeenCalledExactlyOnceWith({ t: 'scene-result', id: 'walk', status: 'cancelled', reason: 'dragged' });
    const phone = createPhoneSpace({ viewport }), r = phone.rect();
    expect(r.w / r.h).toBeCloseTo(9 / 16);
    expect(phone.normalize(phone.plan(r, { x: -1000, y: 5000 }).path[0])).toMatchObject({ x: expect.closeTo(.32), y: expect.closeTo(.78) });
    phone.moveFrame({ x: 10000, y: 30 });
    const edge = phone.rect();
    const bounds = phone.bounds();
    expect(bounds).toMatchObject({ freeGround: false, minX: expect.closeTo(edge.x + edge.w * .32), maxX: expect.closeTo(edge.x + edge.w * .68) });
    expect(phone.restore(.2).x).toBeCloseTo(edge.x + edge.w / 2);
    expect(phone.restore().x).toBeCloseTo(edge.x + edge.w / 2);
    expect(phone.plan(edge, { x: 10000 }).path[0].x).toBeCloseTo(bounds.maxX);
  });
});
