// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
const api=vi.hoisted(()=>({invokePanel:vi.fn()}));
vi.mock('../src/webui/coopanion/base/api.ts',()=>api);
vi.mock('../src/webui/coopanion/base/language.ts',()=>({LANGUAGE:'en'}));
import {wardrobeEditor} from '../src/webui/coopanion/features/framework/wardrobe-editor.ts';
import {appearancePanel} from '../src/webui/coopanion/features/framework/appearance-panel.ts';
function context(){const root=document.createElement('div');document.body.append(root);return {root,signal:new AbortController().signal,ui:{button:(text:string)=>{const b=document.createElement('button');b.textContent=text;return b;}} as any,lifecycle:{} as any};}
afterEach(()=>{document.body.replaceChildren();vi.clearAllMocks();});
it('preserves absent legacy wardrobe and missing resources until an explicit removal',()=>{
 const ctx=context(),editor=wardrobeEditor(ctx);ctx.root.append(editor.element);
 editor.read(undefined,[{id:'expr-live',title:'Live',kind:'expression'}]);expect(editor.value()).toBeUndefined();
 const original=[{id:'custom1',custom:true,name:'Glasses',en:'Glasses',options:[{id:'on',name:'On',resource:'expr-missing'}]}];editor.read(original,[{id:'expr-live',title:'Live',kind:'expression'}]);
 expect(editor.value()).toEqual(original);const select=ctx.root.querySelector<HTMLSelectElement>('select[aria-label="Wardrobe resource"]')!;expect(select.value).toBe('expr-missing');expect(select.selectedOptions[0].textContent).toContain('Missing resource');
 (Array.from(ctx.root.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')==='Remove wardrobe option') as HTMLButtonElement).click();expect(editor.value()?.[0].options).toEqual([]);
});
it('renders actual axes and sends only an appearance-domain mutation, retaining DOM across refresh',async()=>{
 const state={figure:'raw',available:true,busy:false,axes:[{id:'outfit',name:{en:'Outfit'},options:[{id:'default',name:{en:'Default'}},{id:'coat',name:{en:'Coat'}}]}],desired:{scheme:'default',picks:{outfit:'default'}},observed:{status:'applied',scheme:'default'}};
 api.invokePanel.mockImplementation(async(_p,_panel,method)=>method==='appearance'?structuredClone(state):{});
 const ctx=context(),panel=appearancePanel(ctx);ctx.root.append(panel.element);await panel.refresh();const select=ctx.root.querySelector('select')!;await panel.refresh();expect(ctx.root.querySelector('select')).toBe(select);
 select.value='coat';select.dispatchEvent(new Event('change'));await vi.waitFor(()=>expect(api.invokePanel).toHaveBeenCalledWith('world:desktop-live2d-pet','framework','setAppearance',['raw',{outfit:'coat'}],{signal:ctx.signal}));
});
