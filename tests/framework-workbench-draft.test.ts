// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
const api=vi.hoisted(()=>({invokePanel:vi.fn()}));
vi.mock('../src/webui/coopanion/base/api.ts',()=>api);
vi.mock('../src/webui/coopanion/base/language.ts',()=>({LANGUAGE:'zh'}));
import {workspacePage} from '../src/webui/coopanion/features/framework/index.ts';
import {modelEditor} from '../src/webui/coopanion/features/framework/model-editor.ts';
HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open',''); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
const profile={version:1,fit:{mode:'contain',anchor:'bottom',autoFit:false,zoom:1,padding:[.04,.02],offset:[0,0]}};
const contract={figure:'raw',fields:[{path:'fit.zoom',type:'number',min:.1,max:5,step:.01}],editor:{sourceId:'source',modelFile:'test.model3.json',profile,revision:'r1'},operation:{phase:'idle',saved:false,applied:false,error:null}};
function context(){const root=document.createElement('div');document.body.append(root);const controller=new AbortController();return{root,controller,ctx:{root,signal:controller.signal,ui:{button:(value:string)=>{const b=document.createElement('button');b.textContent=value;return b;}} as any,lifecycle:{interval:()=>0 as any,add:()=>{}}}};}
afterEach(()=>{document.body.replaceChildren();vi.clearAllMocks();vi.restoreAllMocks();});
it('retains one draft across module and model-section navigation without rereading',async()=>{
 api.invokePanel.mockImplementation(async(_p,_panel,method)=>method==='resources'?[{id:'raw',name:'Raw',kind:'live2d-model',active:true}]:method==='modelEditor'?structuredClone(contract):method==='actions'?{figure:'raw',vocabulary:[],available:true}:method==='appearance'?{figure:'raw',axes:[],desired:{picks:{},scheme:''},observed:{status:'applied'},available:true}:{skin:{figure:'raw'},framework:{configuration:{bodyEffects:{fields:[],desired:{},observed:null}},runtime:null}});
 const f=context();
 await workspacePage('framework').mount(f.ctx);
 await vi.waitFor(()=>expect(f.root.querySelector('.studio-model-card[data-active=true]')?.textContent).toContain('编辑'));
 [...f.root.querySelectorAll('button')].find(b=>b.dataset.action==='edit')!.click();
 await vi.waitFor(()=>expect(f.root.querySelector('[data-field="fit.zoom"]')).not.toBeNull());
 const zoom=f.root.querySelector('[data-field="fit.zoom"]') as HTMLInputElement;
 zoom.value='1.4';zoom.dispatchEvent(new Event('input',{bubbles:true}));
 f.controller.abort();
 f.root.remove();
 const actions=context();
 await workspacePage('sound').mount(actions.ctx);
 expect(actions.root.querySelector('dialog[open]')).toBeNull();
 actions.controller.abort();
 actions.root.remove();
 const again=context();
 await workspacePage('framework').mount(again.ctx);
 await vi.waitFor(()=>expect(again.root.querySelector('.studio-model-card[data-active=true]')?.textContent).toContain('编辑'));
 [...again.root.querySelectorAll('button')].find(b=>b.dataset.action==='edit')!.click();
 await vi.waitFor(()=>expect(again.root.querySelector('dialog[open] .studio-editor-nav')).not.toBeNull());
 [...again.root.querySelectorAll<HTMLButtonElement>('dialog[open] .studio-editor-nav button')].find(b=>b.textContent==='动作与表情')!.click();
 await vi.waitFor(()=>expect(again.root.querySelector('[data-editor-section=bindings]:not([hidden])')).not.toBeNull());
 expect(again.root.querySelector('.framework-draft-state')?.textContent).toContain('未保存');
 again.controller.abort();
 again.root.remove();
 const back=context();
 await workspacePage('framework').mount(back.ctx);
 await vi.waitFor(()=>expect(back.root.querySelector('.studio-model-card[data-active=true]')?.textContent).toContain('编辑'));
 [...back.root.querySelectorAll('button')].find(b=>b.dataset.action==='edit')!.click();
 await vi.waitFor(()=>expect(back.root.querySelector('dialog[open] [data-field="fit.zoom"]')).not.toBeNull());
 expect(back.root.querySelector('[data-field="fit.zoom"]')).toBe(zoom);
 expect(zoom.value).toBe('1.4');
 expect(api.invokePanel.mock.calls.filter(c=>c[2]==='modelEditor')).toHaveLength(1);
 expect(back.root.querySelector('.studio-rail')).toBeNull();
 back.controller.abort();
 window.dispatchEvent(new PageTransitionEvent('pagehide'));
});
it('retains a failed draft even when the latest global operation belongs to a different model',async()=>{
 api.invokePanel.mockImplementation(async(_p,_panel,method)=>{if(method==='modelEditor')return structuredClone(contract);if(method==='saveModel')throw Error('Load failed');if(method==='operation.get')return null;return{model:{phase:'failed',saved:true,applied:false}};});
 const f=context(),editor=modelEditor(f.ctx);f.root.append(editor.element);await editor.refresh();
 const zoom=f.root.querySelector('[data-field="fit.zoom"]') as HTMLInputElement;zoom.value='1.4';zoom.dispatchEvent(new Event('input',{bubbles:true}));
 const save=Array.from(f.root.querySelectorAll('button')).find(b=>b.textContent==='保存并应用')!;save.click();
 await vi.waitFor(()=>expect(f.root.textContent).toContain('保存未完成，当前修改已保留'));
 expect((f.root.querySelector('[data-field="fit.zoom"]') as HTMLInputElement).value).toBe('1.4');
 expect(api.invokePanel.mock.calls.filter(c=>c[2]==='modelEditor')).toHaveLength(1);
 editor.modelChanged('another');expect(save.disabled).toBe(true);save.click();
 expect(api.invokePanel.mock.calls.filter(c=>c[2]==='saveModel')).toHaveLength(1);f.controller.abort();
});

it('keeps the save receipt on task changes and reapplies its exact revision without writing new settings',async()=>{
 const f=context();
 let requestId:unknown, revision='r1';
 const invoke=vi.fn(async(method:string,args:unknown[]=[])=>{
  if(method==='modelEditor')return {...structuredClone(contract),editor:{...structuredClone(contract.editor),revision}};
  if(method==='saveLibraryModel'){
   requestId=args[4];revision='r2';
   throw Error('Body disconnected');
  }
  if(method==='operation.get'&&args[0]===requestId)return {saved:true,applied:false,revision,phase:'failed',error:'Body disconnected'};
  if(method==='applySavedModel')return {saved:true,applied:true,revision};
  throw Error(method);
 });
 const editor=modelEditor(f.ctx,{invoke:invoke as never,onDraft:()=>{}});
 f.root.append(editor.element);
 await editor.ensureLoaded('raw');
 const command=(label:string)=>[...f.root.querySelectorAll('button')].find(b=>b.textContent===label)!;
 const save=command('保存并应用');
 expect(save.disabled).toBe(true);
 const zoom=f.root.querySelector<HTMLInputElement>('[data-field="fit.zoom"]')!;
 zoom.value='1.8';zoom.dispatchEvent(new Event('input',{bubbles:true}));
 save.click();
 const retry=command('重新应用已保存版本');
 await vi.waitFor(()=>expect(retry.hidden).toBe(false));
 editor.selectSection('behavior');
 expect(f.root.querySelector('.studio-editor-save-notice')?.textContent).toContain('已保存，应用失败');
 retry.click();
 await vi.waitFor(()=>expect(retry.hidden).toBe(true));
 expect(invoke).toHaveBeenCalledWith('applySavedModel',['raw','r2'],{signal:f.controller.signal});
 expect(invoke.mock.calls.filter(([method])=>method==='saveLibraryModel')).toHaveLength(1);
 f.controller.abort();
});
it('asks before discarding edits and cancellation leaves the draft intact',async()=>{
 api.invokePanel.mockResolvedValue(structuredClone(contract));const f=context(),editor=modelEditor(f.ctx);f.root.append(editor.element);await editor.refresh();
 const dialog=f.root.querySelector('dialog')!;dialog.showModal=()=>dialog.setAttribute('open','');dialog.close=()=>dialog.removeAttribute('open');
 const zoom=f.root.querySelector('[data-field="fit.zoom"]') as HTMLInputElement;zoom.value='1.8';zoom.dispatchEvent(new Event('input',{bubbles:true}));
 const confirmation=editor.confirmDiscard();expect(f.root.querySelector('dialog')?.open).toBe(true);
 Array.from(f.root.querySelectorAll('button')).find(b=>b.textContent==='继续编辑')!.click();expect(await confirmation).toBe(false);expect(zoom.value).toBe('1.8');f.controller.abort();
});
