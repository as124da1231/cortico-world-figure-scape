import type { PageContext } from '../../base/page.ts';
import { get, post } from '../../base/api.ts';
import { studioControls } from './controls.ts';
type Prompt={key:string;content:string;revision:string;vars?:Array<{name:string;description:string}>};
/** Edits the host-owned deployment override, never the packaged template. */
export function environmentPrompt(ctx:PageContext,notify:(s:string)=>void){
 const c=studioControls(ctx),element=c.section('环境提示词','描述这个身体能够做什么，以及如何与 Coo 配合。保存到本机部署覆盖，生效时机由 Coo 的会话管理决定。'),input=c.node('textarea'),toolbar=c.node('div','','studio-prompt-actions'),state=c.node('span','未读取','studio-help'),vars=c.node('details'),summary=c.node('summary','可用变量'),variables=c.node('div','','studio-prompt-vars');input.className='studio-prompt-editor';input.setAttribute('aria-label','环境提示词');input.spellcheck=false;vars.append(summary,variables);
 let prompt:Prompt|null=null,loading=false,busy=false;
 const save=c.button('保存提示词',()=>void persist(),true),reload=c.button('重新读取',()=>void refresh(true));toolbar.append(state,reload,save);element.append(vars,input,toolbar);
 function dirty(){return !!prompt&&input.value!==prompt.content;}
 function sync(){save.disabled=!dirty()||busy;reload.disabled=busy||dirty();state.textContent=busy?'正在保存…':dirty()?'有未保存修改':prompt?'已保存':'未读取';element.dataset.dirty=String(dirty());}
 async function refresh(force=false){if(loading||(!force&&prompt))return;loading=true;try{const data=await get<{prompts:Prompt[]}>('/api/prompts',{signal:ctx.signal});const found=data.prompts.find(p=>p.key==='worlds.desktop-live2d-pet.envPrompt');if(!found)throw Error('环境提示词暂不可用');if(ctx.signal.aborted)return;prompt=found;input.value=found.content;variables.replaceChildren(...(found.vars??[]).map(v=>{const item=c.node('p');item.append(c.node('code','{{'+v.name+'}}'),c.node('span',v.description));return item;}));sync();}catch(e){notify(String(e));}finally{loading=false;}}
 async function persist(){if(!prompt||busy)return;busy=true;sync();const content=input.value;try{const result=await post<{revision:string}>('/api/prompts',{key:prompt.key,content,baseRevision:prompt.revision},{signal:ctx.signal});prompt={...prompt,content,revision:result.revision};notify('环境提示词已保存。');}catch(e){notify('保存失败，编辑内容已保留：'+String(e));}finally{busy=false;sync();}}
 input.addEventListener('input',sync,{signal:ctx.signal});sync();return{element,refresh,dirty};
}
