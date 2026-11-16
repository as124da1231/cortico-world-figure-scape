// @vitest-environment jsdom
import {expect,it,vi} from 'vitest';
const api=vi.hoisted(()=>({invokePanel:vi.fn()}));
vi.mock('../src/webui/coopanion/base/api.ts',()=>api);
vi.mock('../src/webui/coopanion/base/language.ts',()=>({LANGUAGE:'en'}));
import {inputPanel} from '../src/webui/coopanion/features/framework/input-panel.ts';
it('shows reported input scope and counts without exposing keys or inventing supported controls',async()=>{
 let state:any={figure:'coo',available:true,runtime:null};api.invokePanel.mockImplementation(async()=>state);
 const root=document.createElement('div'),controller=new AbortController();document.body.append(root);
 const panel=inputPanel({root,signal:controller.signal,ui:{} as any,lifecycle:{add() {}} as any});root.append(panel.element);await panel.refresh();expect(root.textContent).toContain('No input runtime report yet');
 state.runtime={scope:'focused-window-excluding-text-entry',globalKeyboard:false,sourceAttached:true,held:{keyCount:2,primary:true,secondary:false,keys:['SecretKeyName']},reason:null,body:{supported:{held:false},status:'unsupported',state:{keyCount:0,primary:false,secondary:false}}};await panel.refresh();
 expect(root.textContent).toContain('Current body does not support held input');expect(root.textContent).toContain('Key count 2');expect(root.textContent).not.toContain('SecretKeyName');expect(root.querySelector('button')?.disabled).toBe(true);
 state.runtime.body.supported.held=true;state.runtime.body.status='applied';await panel.refresh();expect(root.textContent).toContain('The current model supports held-input testing');expect(root.querySelector('button')?.disabled).toBe(false);
 expect(api.invokePanel.mock.calls.every(c=>c[1]==='framework'&&c[2]==='input')).toBe(true);controller.abort();root.remove();
});
