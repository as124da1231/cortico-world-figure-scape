// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
const api=vi.hoisted(()=>({invokePanel:vi.fn()}));
vi.mock('../src/webui/coopanion/base/api.ts',()=>api);
vi.mock('../src/webui/coopanion/base/language.ts',()=>({LANGUAGE:'en'}));
import {modelEditor} from '../src/webui/coopanion/features/framework/model-editor.ts';
afterEach(()=>{document.body.replaceChildren();vi.clearAllMocks();});
it('edits source framing and actual native bindings through one framework contract',async()=>{
 const profile={mouth:{mode:'mapped',targets:['MissingMouth']},wardrobe:[{id:'custom1',custom:true,name:'Old group',options:[{id:'old',name:'Old',resource:'expr-dddddddddddddddd'}]}],version:1,fit:{mode:'contain',anchor:'bottom',autoFit:false,zoom:1,offset:[0,0],padding:[.04,.02]},bindings:[{word:'nod',resource:'motion-aaaaaaaaaaaaaaaa',reason:'kept metadata',confidence:.8,overlays:['expr-bbbbbbbbbbbbbbbb'],release:'motion-cccccccccccccccc'}]};
 const contract={figure:'live2d-first',fields:[{path:'fit.zoom',type:'number',min:.1,max:5,step:.01}],operation:{phase:'idle',saved:false,applied:false},editor:{sourceId:'source',profile,revision:'r1',catalogFingerprint:'fp',catalog:{words:{expressions:['happy'],motions:['nod']},resources:[{id:'motion-aaaaaaaaaaaaaaaa',title:'Nod',kind:'motion',classification:'gesture'}]}}};
 api.invokePanel.mockImplementation(async(_p,_panel,method)=>method==='modelEditor'?contract:{saved:true,applied:true});
 const root=document.createElement('div');document.body.append(root);const controller=new AbortController();
 const ui={button:(text:string)=>{const b=document.createElement('button');b.textContent=text;return b;}};
 const editor=modelEditor({root,signal:controller.signal,ui:ui as any,lifecycle:{} as any});root.append(editor.element);await editor.refresh();
 expect(root.querySelectorAll('input[type=range]')).toHaveLength(1);
 (root.querySelector('input[type=range]') as HTMLInputElement).value='1.2';
 (Array.from(root.querySelectorAll('button')).find(b=>b.textContent==='Save and apply') as HTMLButtonElement).click();
 await vi.waitFor(()=>expect(api.invokePanel).toHaveBeenCalledWith('world:desktop-live2d-pet','framework','saveModel',['live2d-first',expect.objectContaining({mouth:profile.mouth,wardrobe:profile.wardrobe,fit:expect.objectContaining({zoom:1.2}),bindings:[expect.objectContaining({word:'nod',resource:'motion-aaaaaaaaaaaaaaaa',reason:'kept metadata',overlays:['expr-bbbbbbbbbbbbbbbb'],release:'motion-cccccccccccccccc'})]}),'r1','fp',expect.any(String)],{signal:controller.signal}));
 controller.abort();
});

it('shows optional eye cursor defaults but materializes them only when gaze is edited',async()=>{
 const profile:any={version:1,fit:{mode:'contain',anchor:'bottom',autoFit:false,zoom:1,offset:[0,0],padding:[.04,.02]}};
 const contract:any={behavior:null,figure:'raw',fields:[{path:'fit.zoom',type:'number',min:.1,max:5,step:.01},{path:'gaze.enabled',type:'boolean',default:true},{path:'gaze.speed',type:'number',min:.25,max:2.5,step:.05,default:1}],operation:{phase:'idle',saved:false,applied:false},editor:{sourceId:'source',profile,revision:'r1'}};
 api.invokePanel.mockImplementation(async(_p,_panel,method)=>method==='modelEditor'?contract:{saved:true,applied:true});
 const root=document.createElement('div');document.body.append(root);const controller=new AbortController();
 const editor=modelEditor({root,signal:controller.signal,ui:{button:(text:string)=>{const b=document.createElement('button');b.textContent=text;return b;}} as any,lifecycle:{} as any});root.append(editor.element);await editor.refresh();
 const field=(path:string)=>root.querySelector(`[data-field="${path}"]`) as HTMLInputElement;
 const save=Array.from(root.querySelectorAll('button')).find(b=>b.textContent==='Save and apply')!;
 expect(root.textContent).toContain('support is unconfirmed');expect(field('gaze.enabled').checked).toBe(true);expect(field('gaze.speed').value).toBe('1');expect(root.textContent).toContain('not motion gaze or head movement');
 field('fit.zoom').value='1.2';save.click();
 await vi.waitFor(()=>expect(api.invokePanel.mock.calls.filter(c=>c[2]==='saveModel')).toHaveLength(1));
 expect(api.invokePanel.mock.calls.find(c=>c[2]==='saveModel')![3][1]).not.toHaveProperty('gaze');
 await vi.waitFor(()=>expect(save.disabled).toBe(false));
 field('gaze.enabled').checked=false;field('gaze.enabled').dispatchEvent(new Event('change'));save.click();
 await vi.waitFor(()=>expect(api.invokePanel.mock.calls.filter(c=>c[2]==='saveModel')).toHaveLength(2));
 expect(api.invokePanel.mock.calls.filter(c=>c[2]==='saveModel')[1][3][1].gaze).toEqual({enabled:false,speed:1});
 await vi.waitFor(()=>expect(save.disabled).toBe(false));
 profile.gaze={enabled:false,speed:.4};contract.behavior={gaze:{supported:false,reason:'no-eye-roles',settings:{enabled:false,speed:.4}}};await editor.refresh();expect(root.textContent).toContain('No mapped eye parameters');expect(root.textContent).toContain('Unsupported; source settings have no current effect');field('fit.zoom').value='1.3';save.click();
 await vi.waitFor(()=>expect(api.invokePanel.mock.calls.filter(c=>c[2]==='saveModel')).toHaveLength(3));
 expect(api.invokePanel.mock.calls.filter(c=>c[2]==='saveModel')[2][3][1].gaze).toEqual({enabled:false,speed:.4});controller.abort();
});

it('keeps enum defaults absent on framing saves and persists only explicit movement/facing choices',async()=>{
 const profile:any={version:1,fit:{mode:'contain',anchor:'bottom',autoFit:false,zoom:1,offset:[0,0],padding:[.04,.02]}};
 const contract:any={figure:'raw',fields:[{path:'fit.zoom',type:'number',min:.1,max:5,step:.01},{path:'motion.kind',type:'enum',options:['roam','stand'],default:'roam'},{path:'facing',type:'enum',options:['fixed','mirror'],default:'fixed'}],behavior:{motion:{supported:true,compiledKind:'roam',effectiveKind:'stand',facing:'fixed',reason:'bongo-input'}},operation:{phase:'idle',saved:false,applied:false},editor:{sourceId:'source',profile,revision:'r1'}};
 api.invokePanel.mockImplementation(async(_p,_panel,method)=>method==='modelEditor'?contract:{saved:true,applied:true});
 const root=document.createElement('div');document.body.append(root);const controller=new AbortController();
 const editor=modelEditor({root,signal:controller.signal,ui:{button:(text:string)=>{const b=document.createElement('button');b.textContent=text;return b;}} as any,lifecycle:{} as any});root.append(editor.element);await editor.refresh();
 const field=(path:string)=>root.querySelector(`[data-field="${path}"]`) as HTMLInputElement|HTMLSelectElement;
 const save=Array.from(root.querySelectorAll('button')).find(b=>b.textContent==='Save and apply')!;
 expect(field('motion.kind').value).toBe('roam');expect(field('facing').value).toBe('fixed');expect(root.textContent).toContain('not explicit walking commands or dragging');expect(root.textContent).toContain('Bongo input owns this behavior');
 field('fit.zoom').value='1.2';save.click();await vi.waitFor(()=>expect(api.invokePanel.mock.calls.filter(c=>c[2]==='saveModel')).toHaveLength(1));
 const first=api.invokePanel.mock.calls.filter(c=>c[2]==='saveModel')[0][3][1];expect(first).not.toHaveProperty('motion');expect(first).not.toHaveProperty('facing');await vi.waitFor(()=>expect(save.disabled).toBe(false));
 field('motion.kind').value='stand';field('motion.kind').dispatchEvent(new Event('change'));field('facing').value='mirror';field('facing').dispatchEvent(new Event('change'));save.click();
 await vi.waitFor(()=>expect(api.invokePanel.mock.calls.filter(c=>c[2]==='saveModel')).toHaveLength(2));
 const second=api.invokePanel.mock.calls.filter(c=>c[2]==='saveModel')[1][3][1];expect(second.motion).toEqual({kind:'stand'});expect(second.facing).toBe('mirror');expect(second.motion).not.toHaveProperty('speed');controller.abort();
});

it('keeps crop optional until edited, then writes its complete displayed defaults without turning it into a presentation mode',async()=>{
 const defaults={mode:'full',edge:'flat',line:.6,curve:1,feather:.05,transition:.24};
 const fields=[{path:'fit.zoom',type:'number',min:.1,max:5,step:.01},...Object.entries(defaults).map(([key,value])=>({path:'crop.'+key,type:typeof value==='string'?'enum':'number',default:value,...(key==='mode'?{options:['full','upper']}:key==='edge'?{options:['flat','round']}:{min:0,max:2,step:.01})}))];
 const contract:any={figure:'raw',fields,behavior:{crop:{supported:true,reason:null,settings:defaults}},operation:{phase:'idle',saved:false,applied:false},editor:{sourceId:'source',profile:{version:1,fit:{mode:'contain',anchor:'bottom',autoFit:false,zoom:1,offset:[0,0],padding:[.04,.02]}},revision:'r1'}};
 api.invokePanel.mockImplementation(async(_p,_panel,method)=>method==='modelEditor'?contract:{saved:true,applied:true});
 const root=document.createElement('div');document.body.append(root);const controller=new AbortController();
 const editor=modelEditor({root,signal:controller.signal,ui:{button:(text:string)=>{const b=document.createElement('button');b.textContent=text;return b;}} as any,lifecycle:{} as any});root.append(editor.element);await editor.refresh();
 const field=(path:string)=>root.querySelector(`[data-field="${path}"]`) as HTMLInputElement|HTMLSelectElement;
 const save=Array.from(root.querySelectorAll('button')).find(b=>b.textContent==='Save and apply')!;
 const cropGroup=field('crop.mode').closest('.studio-editor-group')!;
 expect(cropGroup.querySelector('h2')?.textContent).toBe('Crop');
 expect(cropGroup.textContent).toContain('An existing full/upper-body choice is kept');
 field('fit.zoom').value='1.2';save.click();await vi.waitFor(()=>expect(api.invokePanel.mock.calls.filter(c=>c[2]==='saveModel')).toHaveLength(1));expect(api.invokePanel.mock.calls.filter(c=>c[2]==='saveModel')[0][3][1]).not.toHaveProperty('crop');await vi.waitFor(()=>expect(save.disabled).toBe(false));
 field('crop.line').value='.7';field('crop.line').dispatchEvent(new Event('change'));save.click();await vi.waitFor(()=>expect(api.invokePanel.mock.calls.filter(c=>c[2]==='saveModel')).toHaveLength(2));expect(api.invokePanel.mock.calls.filter(c=>c[2]==='saveModel')[1][3][1].crop).toEqual({...defaults,line:.7});controller.abort();
});

it('previews complete framing without saving or replacing form edits and restores only its owner on close',async()=>{
 const fit={mode:'contain',anchor:'bottom',autoFit:false,zoom:1,offset:[0,0],padding:[.04,.02]};let owner='',command:any;
 const contract={figure:'raw',fields:[{path:'fit.zoom',type:'number',min:.1,max:5,step:.01}],framing:{supported:{preview:true,restore:true},status:'reported',state:{fit,active:false}},operation:{phase:'idle',saved:false,applied:false},editor:{sourceId:'source',profile:{version:1,fit},revision:'r1'}};
 api.invokePanel.mockImplementation(async(_p,_panel,method,args)=>{
  if(method==='modelEditor')return contract;
  if(method==='previewFraming'){command=args[1];owner=args[2];return {requestId:'preview-1'};}
  if(method==='framing')return {supported:{preview:true,restore:true},status:'applied',owner,requestId:'preview-1',state:{fit:command.fit??fit,active:command.kind==='preview',geometry:{x:0,y:0,w:100,h:200}}};
 });
 const root=document.createElement('div');document.body.append(root);const controller=new AbortController();
 const editor=modelEditor({root,signal:controller.signal,ui:{button:(text:string)=>{const b=document.createElement('button');b.textContent=text;return b;}} as any,lifecycle:{} as any});root.append(editor.element);await editor.refresh();
 const zoom=root.querySelector('[data-field="fit.zoom"]') as HTMLInputElement;zoom.value='1.4';
 (Array.from(root.querySelectorAll('button')).find(b=>b.textContent==='Preview framing (not saved)') as HTMLButtonElement).click();
 await vi.waitFor(()=>expect(root.textContent).toContain('Temporary preview, not saved'));
 expect(command).toEqual({kind:'preview',fit:{...fit,zoom:1.4}});expect(zoom.value).toBe('1.4');expect(api.invokePanel.mock.calls.some(c=>c[2]==='saveModel')).toBe(false);expect(api.invokePanel.mock.calls.filter(c=>c[2]==='modelEditor')).toHaveLength(1);
 editor.deactivate();await vi.waitFor(()=>expect(api.invokePanel).toHaveBeenCalledWith('world:desktop-live2d-pet','framework','previewFraming',['raw',{kind:'restore'},owner],{keepalive:true}));
 expect(zoom.value).toBe('1.4');controller.abort();
});

it('waits for framing readiness with lightweight reports without overwriting form edits',async()=>{
 const fit={mode:'contain',anchor:'bottom',autoFit:false,zoom:1,offset:[0,0],padding:[.04,.02]};
 const contract={figure:'raw',fields:[{path:'fit.zoom',type:'number',min:.1,max:5,step:.01}],framing:{supported:{preview:true,restore:true},status:'reported',state:{fit,active:false,reason:'not-ready'}},operation:{phase:'idle',saved:false,applied:false},editor:{sourceId:'source',profile:{version:1,fit},revision:'r1'}};
 api.invokePanel.mockImplementation(async(_p,_panel,method)=>method==='modelEditor'?contract:{supported:{preview:true,restore:true},status:'reported',state:{fit,active:false,reason:null,geometry:{x:0,y:0,w:100,h:200}}});
 const root=document.createElement('div');document.body.append(root);const controller=new AbortController();
 const editor=modelEditor({root,signal:controller.signal,ui:{button:(text:string)=>{const b=document.createElement('button');b.textContent=text;return b;}} as any,lifecycle:{} as any});root.append(editor.element);await editor.refresh();
 const preview=Array.from(root.querySelectorAll('button')).find(b=>b.textContent==='Preview framing (not saved)')!;
 expect(preview.disabled).toBe(true);const zoom=root.querySelector('[data-field="fit.zoom"]') as HTMLInputElement;zoom.value='1.7';
 await vi.waitFor(()=>expect(preview.disabled).toBe(false));expect(zoom.value).toBe('1.7');expect(root.textContent).toContain('geometry is ready');expect(api.invokePanel.mock.calls.filter(c=>c[2]==='modelEditor')).toHaveLength(1);expect(api.invokePanel.mock.calls.some(c=>c[2]==='previewFraming')).toBe(false);controller.abort();
});

it('composes fast try-on selections by group before the previous preview finishes', async () => {
 const outfit = { id:'outfit', slot:'outfit', name:'Outfit', options:[
  { id:'first', name:'First', resource:'expr-aaaaaaaaaaaaaaaa' },
  { id:'second', name:'Second', resource:'expr-bbbbbbbbbbbbbbbb' },
 ] };
 const parts = { id:'parts', slot:'parts', name:'Parts', options:[{ id:'part', name:'Part', resource:'expr-cccccccccccccccc' }] };
 const profile = { version:1, fit:{mode:'contain',anchor:'bottom',autoFit:false,zoom:1,offset:[0,0],padding:[.04,.02]}, wardrobe:[outfit,parts] };
 const resources = [...outfit.options,...parts.options].map(option=>({id:option.resource,title:option.name,kind:'expression'}));
 const contract = { figure:'raw', fields:[], operation:{ phase:'idle',saved:false,applied:false },editor:{ sourceId:'source',profile,revision:'r1',catalog:{words:{expressions:[],motions:[]},resources} } };
 api.invokePanel.mockImplementation(async(_page,_panel,method)=>method==='modelEditor'?contract:{});
 const root = document.createElement('div');
 document.body.append(root);
 const controller = new AbortController();
 let releaseFirst: (value: Record<string, unknown>) => void = () => {};
 const firstPreview = new Promise<Record<string, unknown>>(resolve => { releaseFirst = resolve; });
 const sent: unknown[] = [];
 const preview = vi.fn(async (kind: string, input?: Record<string, unknown>) => {
  if (kind!=='wardrobe') return {};
  sent.push(input?.command);
  return sent.length===1 ? firstPreview : {};
 });
 const onDraft=vi.fn();
 const editor=modelEditor({root,signal:controller.signal,ui:{button:(text:string)=>{const node=document.createElement('button');node.textContent=text;node.type='button';return node;}} as any,lifecycle:{} as any},{preview,onDraft});
 root.append(editor.element);
 await editor.refresh();
 editor.selectSection('wardrobe');
 const trials=Array.from(root.querySelectorAll<HTMLButtonElement>('.studio-wardrobe-option-actions button')).filter(button=>button.textContent==='Try on');
 trials[0].click();
 await vi.waitFor(()=>expect(sent).toHaveLength(1));
 trials[1].click();
 trials[2].click();
 expect(sent).toHaveLength(1);
 releaseFirst({});
 await vi.waitFor(()=>expect(root.textContent).toContain('Trying on · Second · Part'));
 expect(sent).toHaveLength(2);
 expect(sent[1]).toMatchObject({ picks:{ outfit:'second',parts:'part' } });
 expect(onDraft).not.toHaveBeenCalled();
 controller.abort();
});
