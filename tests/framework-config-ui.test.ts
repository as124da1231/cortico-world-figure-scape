// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
const api=vi.hoisted(()=>({invokePanel:vi.fn(),setConfig:vi.fn(),get:vi.fn(async()=>({groups:[]}))}));
vi.mock('../src/webui/coopanion/base/api.ts',()=>api);
vi.mock('../src/webui/coopanion/base/language.ts',()=>({LANGUAGE:'zh'}));
import { workspacePage } from '../src/webui/coopanion/features/framework/index.ts';
HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open',''); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
afterEach(()=>{document.body.replaceChildren();vi.clearAllMocks();});
it('mounts an owned configuration hierarchy and derives controls from framework fields and uses its mutation contract',async()=>{
 api.invokePanel.mockImplementation(async(_provider,panel,method)=>method==='resources'?[{id:'test-body',name:'Test',kind:'live2d-model',active:true,wardrobe:true}]:method==='resources.characterWardrobe'?{axes:[],presets:[],current:'',active:true}:method==='modelEditor'?{figure:'test-body',editor:null,fields:[],operation:{phase:'idle'}}:{framework:{definition:{id:'desktop-live2d-pet',defaultPresentation:'desktop'},configuration:{bodyEffects:{fields:[{key:'squash',type:'boolean',writableBy:'user'}],desired:{squash:true},observed:{status:'applied'}}},runtime:{domains:{body:{implementation:'figure-body',status:'active'}}}},connected:true,inWindow:true,skin:{figure:'test-body'},modelProvider:'embedded-figure',bodyEffects:{squash:true,dragStretch:true,breathing:true},bodyEffectsFeedback:{status:'applied'}});
 api.setConfig.mockResolvedValue('ok');
 const root=document.createElement('div');document.body.append(root);const controller=new AbortController();
 const ui={button:(text:string)=>{const b=document.createElement('button');b.textContent=text;return b;}};
 await workspacePage('framework').mount({root,signal:controller.signal,ui:ui as any,lifecycle:{interval:()=>0 as any,add:()=>{}}});
 expect(root.dataset.workspacePanel).toBe('framework');
 expect(root.querySelectorAll('iframe')).toHaveLength(0);
 expect(root.querySelector('.studio-rail')).toBeNull();
 await vi.waitFor(()=>expect(root.querySelector('.studio-model-card[data-active=true]')).not.toBeNull());
 const wardrobe = root.querySelector<HTMLButtonElement>('[data-action=wardrobe]')!;
 wardrobe.click();
 const effects = () => Array.from(root.querySelectorAll<HTMLButtonElement>('dialog[open] button')).find(b=>b.textContent==='身体整体效果');
 await vi.waitFor(()=>expect(effects()).toBeDefined());
 effects()!.click();
 await vi.waitFor(()=>expect(root.querySelectorAll('input[type=checkbox]')).toHaveLength(1));
 const input=root.querySelector('input[type=checkbox]') as HTMLInputElement;expect(input.checked).toBe(true);input.checked=false;input.dispatchEvent(new Event('change'));
 await vi.waitFor(()=>expect(api.invokePanel).toHaveBeenCalledWith('world:desktop-live2d-pet','framework','setBodyEffects',[{squash:false}],{signal:controller.signal}));
 root.querySelector('dialog[open]')?.dispatchEvent(new Event('close')); root.querySelector('dialog[open]')?.removeAttribute('open');
 await vi.waitFor(()=>expect(root.querySelector('.studio-model-card[data-active=true]')?.textContent).toContain('编辑'));
 (Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.dataset.action==='edit'))!.click();
 await vi.waitFor(()=>expect(api.invokePanel).toHaveBeenCalledWith('world:desktop-live2d-pet','framework','modelEditor',[],{signal:expect.any(AbortSignal)}));
 controller.abort();window.dispatchEvent(new PageTransitionEvent('pagehide'));
});

it('retries failed settings loads without caching an empty subpanel', async () => {
 api.get.mockRejectedValue(new Error('Connection unavailable'));
 api.invokePanel.mockImplementation(async () => ({ skin:{figure:''}, framework:{configuration:{}} }));
 const root = document.createElement('div'), controller = new AbortController();
 document.body.append(root);
 const ui = { button: (text:string) => { const button=document.createElement('button'); button.textContent=text; return button; } };
 workspacePage('display').mount({root, signal:controller.signal, ui:ui as any, lifecycle:{interval:()=>0 as any,add:()=>{}}});
 try {
   const findRetry=()=>root.querySelector<HTMLButtonElement>('.studio-settings-retry button');
   await vi.waitFor(()=>expect(findRetry()).not.toBeNull());
   expect(root.textContent).toContain('Connection unavailable');
   api.get.mockResolvedValue({ groups:[] });
   findRetry()!.click();
   await vi.waitFor(()=>expect(root.querySelector('[data-task=display] .studio-settings-fields')).not.toBeNull());
 } finally { controller.abort(); }
});

it('derives speech settings from the service and sends no legacy config writes',async()=>{
 api.invokePanel.mockResolvedValue({framework:{definition:{id:'test',defaultPresentation:'desktop'},configuration:{bodyEffects:{fields:[],desired:{},observed:null},speech:{fields:[{key:'pitch',type:'enum',options:['low','custom']},{key:'pitchHz',type:'number',min:200,max:700,enabledWhen:{pitch:'custom'}}],desired:{pitch:'low',pitchHz:555},effective:{enabled:true,pitchHz:300,unitsPerSecond:13},observed:null}},runtime:null},connected:false,inWindow:false,skin:{}});
 const runtime=await api.invokePanel();
 api.invokePanel.mockImplementation(async(_provider,panel,method)=>{
   if (method==='services.state') return {providers:[],models:[],selected:{}};
   if (method==='audio.ttsState') return {enabled:false,provider:'',providers:{},profiles:{},playback:null};
   if (method==='audio.plannerState') return {enabled:false,ready:false};
   if (panel==='voice') return {enabled:false,engine:'funasr',systemSupported:false,server:null,model:{phase:'absent'},api:{model:''},mic:{state:'off'},input:{mode:'hold',hotkey:'',keyLabel:'',deviceId:'',openOnPress:false,devices:[]},level:-60,recent:[]};
   return runtime;
 });
 const root=document.createElement('div');document.body.append(root);const controller=new AbortController();
 await workspacePage('sound').mount({root,signal:controller.signal,ui:{button:(text:string)=>{const b=document.createElement('button');b.textContent=text;return b;}} as any,lifecycle:{interval:()=>0 as any,add:()=>{}}});

 const rows = [...root.querySelectorAll('.studio-settings-row')];
 expect(rows.map(row=>row.querySelector('h2')?.textContent)).toEqual(['音效','说话声','语音输入']);
 expect(root.querySelector('[data-setting=pitch]')).toBeNull();
 const open = rows[1].querySelector('button')!;
 open.focus();
 open.click();
 const dialog = root.querySelector<HTMLDialogElement>('dialog[open]')!;
 expect(dialog.querySelector('h2')?.textContent).toBe('说话声设置');
 expect(dialog.querySelector('[data-setting=pitch]')).toBeNull();
 await vi.waitFor(()=>expect(dialog.textContent).toContain('语音合成'));
 expect(dialog.textContent).not.toContain('音节发声');
 expect(api.setConfig).not.toHaveBeenCalled();
 dialog.close();
 expect(root.querySelector('dialog[open]')).toBeNull();
 expect(document.activeElement).toBe(open);
 expect([...root.querySelectorAll('.studio-settings-row')]).toEqual(rows);
 controller.abort();
});
