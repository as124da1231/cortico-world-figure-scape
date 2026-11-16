// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
vi.mock('../src/webui/coopanion/base/language.ts',async importOriginal=>({
  ...await importOriginal<typeof import('../src/webui/coopanion/base/language.ts')>(), LANGUAGE:'en',
}));
import {mouthEditor,type MouthBehavior} from '../src/webui/coopanion/features/framework/mouth-editor.ts';
function fixture(){const root=document.createElement('div');document.body.append(root);const controller=new AbortController();const editor=mouthEditor({root,signal:controller.signal,ui:{} as any,lifecycle:{} as any});root.append(editor.element);return {root,editor,mode:root.querySelector('select')!,targets:root.querySelectorAll('select')[1]};}
afterEach(()=>document.body.replaceChildren());
it('preserves absent configuration and missing references, blocks new conflicting targets',()=>{
 const {root,editor,targets}=fixture();editor.read(undefined,null);expect(editor.value()).toBeUndefined();expect(root.textContent).toContain('No loaded body parameter catalogue');
 const profile={mode:'mapped' as const,targets:['Missing','OldConflict']};const report:MouthBehavior={mode:'mapped',supported:true,targets:profile.targets,missing:['Missing'],truncated:true,parameters:[{id:'ParamMouth',min:0,max:1,default:0,roles:['mouthOpen']},{id:'NewConflict',min:0,max:1,default:0,roles:['eyeOpen']},{id:'OldConflict',min:0,max:1,default:0,roles:['angleX']}]};
 editor.read(profile,report);expect(editor.value()).toEqual(profile);expect(Array.from(targets.selectedOptions).map(o=>o.value)).toEqual(['OldConflict','Missing']);
 expect(Array.from(targets.options).find(o=>o.value==='NewConflict')!.disabled).toBe(true);expect(Array.from(targets.options).find(o=>o.value==='OldConflict')!.disabled).toBe(false);expect(root.textContent).toContain('Parameter catalogue truncated');
});
it('materializes only edited mode/targets and clears targets on auto or off',()=>{
 const {editor,mode,targets}=fixture();editor.read(undefined,{mode:'auto',supported:true,targets:['ParamMouth'],missing:[],truncated:false,parameters:[{id:'ParamMouth',min:0,max:1,default:0,roles:[]}]});
 mode.value='mapped';mode.dispatchEvent(new Event('change'));targets.options[0].selected=true;targets.dispatchEvent(new Event('change'));expect(editor.valid()).toBe(true);expect(editor.value()).toEqual({mode:'mapped',targets:['ParamMouth']});
 mode.value='off';mode.dispatchEvent(new Event('change'));expect(editor.value()).toEqual({mode:'off',targets:[]});expect(targets.disabled).toBe(true);
 mode.value='auto';mode.dispatchEvent(new Event('change'));expect(editor.value()).toEqual({mode:'auto',targets:[]});
});
