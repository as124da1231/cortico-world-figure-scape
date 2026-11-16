import { invokePanel } from '../../base/api.ts';
import type { PageContext } from '../../base/page.ts';
import { LANGUAGE } from '../../base/language.ts';
const PROVIDER='world:desktop-live2d-pet';
type Counts={keyCount:number;primary:boolean;secondary:boolean};
type InputState={figure:string;available:boolean;runtime:null|{scope:string;globalKeyboard:boolean;sourceAttached:boolean;held:Counts;reason:string|null;body:null|{supported:{held:boolean};status:string;state?:Counts}}};
/** Read-only capability/receipt projection. No keyboard hooks and no key identity collection. */
export function inputPanel(ctx:PageContext){
 const {root,signal}=ctx,doc=root.ownerDocument,zh=LANGUAGE.startsWith('zh'),text=(cn:string,en:string)=>zh?cn:en;
 const el=(tag:string,value='')=>{const e=doc.createElement(tag);e.textContent=value;return e;};
 const element=el('article'),status=el('p'),details=el('dl');element.className='framework-card';status.setAttribute('role','status');
 element.append(el('h2',text('聚焦窗口按键','Focused window keys')),el('p',text('可以测试当前模型的键鼠动作。仅在桌宠窗口聚焦时接收按键。','Test the active model’s keyboard and mouse action while the pet window has focus.')),status,details);
 let reading=false;
 let target: string | undefined;
 const test = el('button',text('测试模型按键','Test model input')) as HTMLButtonElement;
 test.type='button';test.disabled=true;element.append(test);
 let testing=false;
 async function release(){
  if(!testing||!target)return;testing=false;
  await invokePanel(PROVIDER,'framework','previewHeldInput',[target,null],{keepalive:true}).catch(()=>{});
 }
 test.addEventListener('click',async()=>{
  if(!target||testing||signal.aborted)return;testing=true;
  try{
   await invokePanel(PROVIDER,'framework','previewHeldInput',[target,{keys:[],primary:true,secondary:false}],{signal});
   await new Promise(resolve=>setTimeout(resolve,350));
  }catch(error){status.textContent=String(error);}
  finally{await release();void refresh();}
 },{signal});
 ctx.lifecycle.add(()=>{void release();});
 const counts=(value:Counts|undefined)=>value?text('按键数量 ','Key count ')+value.keyCount+' · '+text('主键 ','Primary ')+(value.primary?'1':'0')+' · '+text('次键 ','Secondary ')+(value.secondary?'1':'0'):'—';
 async function refresh(){if(reading||signal.aborted)return;reading=true;try{
  const state=await invokePanel<InputState>(PROVIDER,'framework','input',[],{signal});if(signal.aborted)return;
  const runtime=state.runtime,body=runtime?.body;details.replaceChildren();
  if(target!==state.figure&&testing)void release();target=state.figure;test.disabled=!(state.available&&body?.supported.held);
  status.textContent=state.figure+' · '+(!state.available?text('主窗口未连接','Main window disconnected'):!runtime?text('尚无输入运行报告','No input runtime report yet'):body?.supported.held===true?text('当前模型可测试按住动作','The current model supports held-input testing'):body?text('当前身体不支持按住输入','Current body does not support held input'):text('尚无身体输入能力报告','No body input capability report yet'));
  if(runtime){
   const rows=[[text('范围','Scope'),runtime.scope],[text('全局键盘','Global keyboard'),runtime.globalKeyboard?text('报告异常：不应启用','Unexpected report: should not be enabled'):text('未启用','Not enabled')],[text('输入源','Input source'),runtime.sourceAttached?text('已连接','Attached'):text('未连接','Detached')],[text('窗口按住状态','Window held state'),counts(runtime.held)],[text('身体回执','Body receipt'),body?.status??'—'],[text('身体状态','Body state'),counts(body?.state)],[text('原因','Reason'),runtime.reason??'—']];
   for(const[label,value]of rows)details.append(el('dt',label),el('dd',value));
  }
 }catch(error){if(!signal.aborted){status.textContent=String(error);details.replaceChildren();}}finally{reading=false;}}
 return {element,refresh};
}
