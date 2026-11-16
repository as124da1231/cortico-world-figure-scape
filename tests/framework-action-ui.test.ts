// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
const api=vi.hoisted(()=>({invokePanel:vi.fn()}));
vi.mock('../src/webui/coopanion/base/api.ts',()=>api);
vi.mock('../src/webui/coopanion/base/language.ts',()=>({LANGUAGE:'zh'}));
import {actionPanel} from '../src/webui/coopanion/features/framework/action-panel.ts';
afterEach(()=>{document.body.replaceChildren();vi.clearAllMocks();});
it('derives actions from real vocabulary, preserves buttons on poll and shows only own request receipts',async()=>{
 let state:any={figure:'raw-1',available:true,busy:false,vocabulary:[{id:'happy',names:{zh:['微笑']},about:{zh:'保留原生表情'},seconds:2}],runtime:{queued:0,active:null,recent:[]}};
 api.invokePanel.mockImplementation(async(_p,_panel,method)=>method==='actions'?structuredClone(state):{accepted:true,requestId:'request-1'});
 const root=document.createElement('div');document.body.append(root);const controller=new AbortController();
 const panel=actionPanel({root,signal:controller.signal,ui:{button:(text:string)=>{const b=document.createElement('button');b.textContent=text;return b;}} as any,lifecycle:{interval:()=>0 as any,add:()=>{}}});root.append(panel.element);
 await panel.refresh();const button=root.querySelector('[data-action=happy]') as HTMLButtonElement;
 expect(button.textContent).toBe('微笑');expect(api.invokePanel.mock.calls.some(c=>c[2]==='previewActions')).toBe(false);
 await panel.refresh();expect(root.querySelector('[data-action=happy]')).toBe(button);
 button.click();await vi.waitFor(()=>expect(api.invokePanel).toHaveBeenCalledWith('world:desktop-live2d-pet','framework','previewActions',['raw-1',['happy']],{signal:controller.signal}));
 await vi.waitFor(()=>expect(button.disabled).toBe(false));
 state.runtime={queued:1,active:{word:'happy'},recent:[{requestId:'other',word:'secret',status:'running'},{requestId:'request-1',word:'happy',status:'completed',completion:'duration'}]};
 await panel.refresh();expect(root.querySelectorAll('li')).toHaveLength(1);expect(root.querySelector('li')?.textContent).toContain('按时长结束');expect(root.textContent).not.toContain('secret');
 state={...state,figure:'raw-2',available:false,vocabulary:[{id:'nod',names:{en:['Nod']},seconds:1}]};await panel.refresh();
 expect(root.querySelector('[data-action=happy]')).toBeNull();expect((root.querySelector('[data-action=nod]') as HTMLButtonElement).disabled).toBe(true);expect(root.querySelectorAll('li')).toHaveLength(0);
 controller.abort();
});
