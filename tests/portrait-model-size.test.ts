// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createModelSizeControl, sceneScales, type SceneMode } from '../web/framework/model-size.js';
// @ts-expect-error Browser presentation module.
import { createRoomPresentation } from '../web/framework/room-presentation.js';
// @ts-expect-error Browser frame adapter.
import { loadBody } from '../web/body-host.js';

it('previews a native continuous drag and only persists the final size for that scene', async () => {
  let mode: SceneMode = 'phone';
  const saved = sceneScales(1.25, { phone:1.2, room:.91 });
  const preview = vi.fn();
  const save = vi.fn(async (scene:SceneMode, next:number) => { saved[scene] = next; });
  const control = createModelSizeControl({
    doc:document, text:zh=>zh, mode:()=>mode,
    read:scene=>saved[scene], preview, save, report:vi.fn(),
  });
  const slider = control.element.querySelector('input')!;
  expect(slider.step).toBe('0.0001');
  const press = new MouseEvent('pointerdown',{cancelable:true,button:0});
  slider.dispatchEvent(press);
  expect(press.defaultPrevented).toBe(false);
  for(const value of ['0.5120','0.5125','0.5130']){
    slider.value=value;
    slider.dispatchEvent(new Event('input'));
  }
  const samples = preview.mock.calls.map(call=>call[1]);
  expect(samples[1]-samples[0]).toBeGreaterThan(0);
  expect(samples[1]-samples[0]).toBeLessThan(.005);
  expect(save).not.toHaveBeenCalled();
  slider.dispatchEvent(new Event('change'));
  mode='room';
  control.sync();
  await vi.waitFor(()=>expect(save).toHaveBeenCalledExactlyOnceWith('phone',samples[2]));
  expect(control.element.querySelector('output')!.textContent).toBe('91%');
  expect(saved.desktop).toBe(1.25);
  expect(saved.room).toBe(.91);
});

it('migrates a previous size while preserving the previous portrait limits', () => {
  expect(sceneScales(1.75)).toEqual({desktop:1.75,room:1.75,phone:1.2,wallpaper:1.75});
  expect(sceneScales(1.75, {phone:1.36,wallpaper:.74})).toMatchObject({phone:1.36,wallpaper:.74});
});

it('fits both a wide figure and a tall model between the portrait controls at the default size', () => {
  const stage = document.createElement('div');
  const rect = { x:90, y:42, w:320, h:320*16/9 };
  const scene = {
    rect: () => rect,
    bounds: () => ({ W:540, H:700, minX:rect.x+rect.w*.32, maxX:rect.x+rect.w*.68 }),
    snapshot: () => ({ implementation:'phone-space' }),
  };
  const body = { body: { layout: { restExtent:[41.7,54.4,270.1,257.1] }, set:vi.fn() } };
  const view = createRoomPresentation({ scene, body, surface:{ stage } });
  view.activate();

  for (const extent of [[41.7,54.4,270.1,257.1], [95,26,166,247]]) {
    body.body.layout.restExtent = extent;
    view.tick();
    const { S, floorY, minX, maxX } = view.bounds();
    const reach = Math.max(128-extent[0],extent[2]-128);
    expect(minX-reach*S).toBeGreaterThan(rect.x);
    expect(maxX+reach*S).toBeLessThan(rect.x+rect.w);
    expect(floorY+(extent[1]-256)*S).toBeGreaterThan(rect.y+rect.h*.12);
    expect(floorY+(extent[3]-256)*S).toBeLessThan(rect.y+rect.h*.86);
    view.configure({scale:1.1234});
    expect(view.bounds().S).toBeCloseTo(S*1.1234);
    view.configure({scale:1});
  }
  const stableUpdates = body.body.set.mock.calls.length;
  view.tick();
  expect(body.body.set).toHaveBeenCalledTimes(stableUpdates);
  view.dispose();
});

it('holds a replacement hidden until its own portrait framing has drawn', async () => {
  const layer = document.body.appendChild(document.createElement('div'));
  const bounds = { W:540, H:700, floorY:500, S:1 };
  const pack = { id:'wide', kind:'figure-pack', presets:[], axes:[], vocab:[] };
  const frameBounds = vi.fn(() => ({ ...bounds, floorY:432, S:.8 }));
  const result = loadBody({ layer, pack, start:{}, bounds, staged:true, frameBounds });
  const frame = layer.querySelector('iframe')!;
  const source = frame.contentWindow!;
  const post = vi.spyOn(source,'postMessage').mockImplementation(() => {});
  const receive = (data: object) => window.dispatchEvent(new MessageEvent('message',{source,data}));
  const restExtent = [41.7,54.4,270.1,257.1];
  const layout = { box:{ x:90, y:180, w:240, h:270 }, restExtent };
  receive({t:'ready'});
  receive({t:'frame',frameScope:0,layout});
  expect(frameBounds).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({restExtent}));
  expect(post).toHaveBeenCalledWith({t:'set',state:{bounds:{...bounds,floorY:432,S:.8}}},'*');
  expect(post).toHaveBeenCalledWith({t:'tick',dt:0,draw:true,frameScope:1},'*');
  let resolved = false;
  void result.then(() => { resolved = true; });
  receive({t:'frame',frameScope:0,layout});
  await Promise.resolve();
  expect(resolved).toBe(false);
  expect(frame.parentElement?.style.visibility).toBe('hidden');
  receive({t:'frame',frameScope:1,layout});
  const body = await result;
  expect(body.reportedFrameScope).toBe(1);
  body.reveal();
  expect(frame.parentElement?.style.visibility).toBe('');
  body.dispose();
  layer.remove();
});

