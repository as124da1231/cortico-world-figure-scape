// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
const api=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),setConfig:vi.fn(),invokePanel:vi.fn(),pickPath:vi.fn()}));
vi.mock('../src/webui/coopanion/base/api.ts',()=>api);
import {preferences,preferenceTask} from '../src/webui/coopanion/features/framework/preferences.ts';
import {environmentPrompt} from '../src/webui/coopanion/features/framework/environment-prompt.ts';
const key='worlds.desktop-live2d-pet.sound';
function fixture(){const root=document.createElement('div');document.body.append(root);const ctl=new AbortController();return{root,ctl,ctx:{root,signal:ctl.signal,ui:{} as any,lifecycle:{interval:()=>0 as any,add:()=>{}}}};}
afterEach(()=>{document.body.replaceChildren();vi.clearAllMocks();});
it('assigns controls to framework responsibilities independently of original configuration groups',()=>{
 expect(preferenceTask('worlds.desktop-live2d-pet.window.bubbleSize')).toBe('bubbles');
 expect(preferenceTask('worlds.desktop-live2d-pet.cua.permission')).toBeNull();
 expect(preferenceTask('worlds.desktop-live2d-pet.speech.enabled')).toBeNull();
 expect(preferenceTask('worlds.desktop-pet.roam')).toBeNull();
});
it('writes the original owner and key, and restores saved state after a rejected change',async()=>{
 api.get.mockResolvedValue({groups:[{group:{id:'world:desktop-live2d-pet:sound',schema:{properties:{[key]:{type:'boolean',title:'声音'}}}},values:{[key]:true}}]});
 api.setConfig.mockRejectedValue(Error('write failed'));const f=fixture(),notify=vi.fn(),p=preferences(f.ctx,notify);f.root.append(await p.view('sound-quick'));
 const toggle=f.root.querySelector('input')!;expect(toggle.checked).toBe(true);toggle.focus();toggle.checked=false;toggle.dispatchEvent(new Event('change'));
 await vi.waitFor(()=>expect(toggle.checked).toBe(true));expect(api.setConfig).toHaveBeenCalledWith('world:desktop-live2d-pet:sound',{[key]:false},{signal:f.ctl.signal});expect(notify).toHaveBeenCalledWith('Error: write failed',undefined,'sound-quick');f.ctl.abort();
});
it('updates a slider’s readout while dragging and restores its saved value after a rejected commit',async()=>{
 const key='worlds.desktop-live2d-pet.sounds.volume';
 const group={id:'world:desktop-live2d-pet:sound',schema:{properties:{[key]:{type:'integer',title:'音量',minimum:0,maximum:100}}}};
 api.get.mockResolvedValue({groups:[{group,values:{[key]:90}}]});
 api.setConfig.mockRejectedValue(Error('write failed'));
 const f=fixture(),prefs=preferences(f.ctx,vi.fn());
 f.root.append(await prefs.view('sound-quick'));
 const slider=f.root.querySelector('input[type=range]') as HTMLInputElement;
 expect(slider.getAttribute('aria-valuetext')).toBe('90%');
 slider.focus();
 slider.value='45';
 slider.dispatchEvent(new Event('input'));
 await prefs.refresh();
 expect(slider.value).toBe('45');
 expect(slider.getAttribute('aria-valuetext')).toBe('45%');
 expect(api.setConfig).not.toHaveBeenCalled();
 slider.dispatchEvent(new Event('change'));
 await vi.waitFor(()=>expect(slider.getAttribute('aria-valuetext')).toBe('90%'));
 expect(api.setConfig).toHaveBeenCalledWith(group.id,{[key]:45},{signal:f.ctl.signal});
 f.ctl.abort();
});
it('reads saved custom frame rates and commits presets through the original configuration owner',async()=>{
 const key='worlds.desktop-live2d-pet.window.frameRate';
 const group={id:'world:desktop-live2d-pet',schema:{properties:{[key]:{type:'integer',title:'帧率',minimum:0}}}};
 let saved=75;
 api.get.mockImplementation(async()=>({groups:[{group,values:{[key]:saved}}]}));
 api.setConfig.mockImplementation(async(_group,patch)=>{saved=patch[key];return 'ok';});
 const f=fixture(),prefs=preferences(f.ctx,vi.fn());
 f.root.append(await prefs.view('performance'));
 const mode=f.root.querySelector('select')!;
 const fps=f.root.querySelector<HTMLInputElement>('input[type=number]')!;
 expect(mode.value).toBe('custom');expect(fps.value).toBe('75');
 mode.value='0';mode.dispatchEvent(new Event('change'));
 await vi.waitFor(()=>expect(fps.hidden).toBe(true));
 expect(saved).toBe(0);
 await vi.waitFor(()=>expect(mode.disabled).toBe(false));
 mode.value='custom';mode.dispatchEvent(new Event('change'));
 expect(fps.hidden).toBe(false);expect(saved).toBe(0);
 fps.value='90';fps.dispatchEvent(new Event('change'));
 await vi.waitFor(()=>expect(saved).toBe(90));
 expect(api.setConfig).toHaveBeenCalledWith(group.id,{[key]:90},{signal:f.ctl.signal});
 f.ctl.abort();
});
it('retains prompt edits across navigation and revision conflicts',async()=>{
 api.get.mockResolvedValue({prompts:[{key:'worlds.desktop-live2d-pet.envPrompt',content:'old',revision:'r1',vars:[]}]});api.post.mockRejectedValue(Error('revision conflict'));
 const f=fixture(),notify=vi.fn(),p=environmentPrompt(f.ctx,notify);f.root.append(p.element);await p.refresh();const area=f.root.querySelector('textarea')!;area.value='edited';area.dispatchEvent(new Event('input'));await p.refresh();expect(area.value).toBe('edited');
 Array.from(f.root.querySelectorAll('button')).find(b=>b.textContent==='保存提示词')!.click();await vi.waitFor(()=>expect(notify).toHaveBeenCalled());expect(area.value).toBe('edited');expect(p.dirty()).toBe(true);expect(api.post.mock.calls[0][1]).toEqual({key:'worlds.desktop-live2d-pet.envPrompt',content:'edited',baseRevision:'r1'});f.ctl.abort();
});
