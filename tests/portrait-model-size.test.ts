// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createModelSizeControl, sceneScales, type SceneMode } from '../web/framework/model-size.js';

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

