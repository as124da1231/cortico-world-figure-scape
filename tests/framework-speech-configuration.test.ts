import { describe, expect, it, vi } from 'vitest';
import { createSpeechConfiguration } from '../src/framework/speech-configuration.ts';
import type { SpeechSettings } from '../src/config.ts';
describe('framework speech configuration', () => {
  it('preserves presets and custom values in the single live store', () => {
    let cfg: SpeechSettings = { enabled: false, pitch: 'low', pitchHz: 555, speed: 'custom', unitsPerSecond: 12 };
    const order: string[] = [];
    const service = createSpeechConfiguration({ read: () => cfg, persist: p => { order.push('persist'); cfg=p.speech; }, apply: () => { order.push('apply'); } });
    service.patch({ enabled: true });
    expect(cfg).toEqual({ enabled: true, pitch: 'low', pitchHz: 555, speed: 'custom', unitsPerSecond: 12 });
    expect(service.effective()).toEqual({ enabled:true, pitchHz:300, unitsPerSecond:12 });
    cfg.pitch='custom'; expect(service.effective().pitchHz).toBe(555);
    expect(order).toEqual(['persist','apply']);
    expect(service.read({ status:'mounted' }).observed).toEqual({status:'mounted'});
  });
  it('rejects invalid or unknown settings atomically', () => {
    const persist=vi.fn(),apply=vi.fn();
    const service=createSpeechConfiguration({read:()=>({enabled:false,pitch:'mid',pitchHz:400,speed:'mid',unitsPerSecond:13}),persist,apply});
    for(const patch of [{enabled:true,unknown:1},{enabled:'false'},{pitch:'invalid'},{pitchHz:Infinity},{unitsPerSecond:21},[],null]) expect(()=>service.patch(patch)).toThrow();
    expect(persist).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
  });
});
