import { invokePanel } from '../../base/api.ts';
import type { PageContext } from '../../base/page.ts';
import { LANGUAGE } from '../../base/language.ts';
const PROVIDER = 'world:desktop-live2d-pet';
type ActionRow = { requestId?: string|null; word?: string; status: string; reason?: string; completion?: string };
type ActionState = { figure: string; available: boolean; busy: boolean;
 vocabulary: Array<{id:string;names?:Record<string,string[]>;about?:Record<string,string>;seconds?:number}>;
 runtime: null|{queued:number;active:null|{word?:string};recent:ActionRow[]} };
/** The controls are projections of the active Action domain, never another vocabulary/configuration store. */
export function actionPanel(ctx:PageContext) {
 const {root,signal,ui}=ctx,doc=root.ownerDocument,zh=LANGUAGE.startsWith('zh');
 const text=(cn:string,en:string)=>zh?cn:en;
 const el=(tag:string,value='')=>{const n=doc.createElement(tag);n.textContent=value;return n;};
 const element=el('article'),catalog=el('div'),summary=el('p'),feedback=el('p'),history=el('ul');
 element.className='framework-card';feedback.setAttribute('role','status');
 element.append(el('h2',text('动作试播','Try an action')),el('p',text('在当前身体上执行已保存的动作。组合修改在「动作与表情」中统一保存。','Execute saved actions on the current body. Save combination edits under Bindings.')),summary,catalog,feedback,history);
 catalog.className='framework-action-catalog';history.className='framework-action-history';
 let current:ActionState|null=null,reading=false,sending=false,key='';
 const requests=new Set<string>(),buttons:HTMLButtonElement[]=[];
 const statuses:Record<string,string>=zh?{accepted:'已接收',running:'执行中',completed:'已完成',failed:'失败',interrupted:'已中断'}:{};
 function enabled(){for(const b of buttons)b.disabled=sending||!current?.available||current.busy;}
 async function submit(word:string){
  if(sending||!current?.available||current.busy)return;
  const figure=current.figure;sending=true;enabled();
  try{
   const result=await invokePanel<{accepted:boolean;requestId:string}>(PROVIDER,'framework','previewActions',[figure,[word]],{signal});
   if(signal.aborted)return;
   if(current?.figure===figure){requests.add(result.requestId);feedback.textContent=text('已接收，等待动作域执行回执。','Accepted; awaiting action execution feedback.');}
  }catch(error){if(!signal.aborted)feedback.textContent=String(error);}
  finally{sending=false;enabled();if(!signal.aborted)await refresh();}
 }
 async function refresh(){
  if(reading||signal.aborted)return;reading=true;
  try{
   const next=await invokePanel<ActionState>(PROVIDER,'framework','actions',[],{signal});
   if(signal.aborted)return;
   if(!Array.isArray(next.vocabulary))throw Error('Action catalog unavailable');
   if(current&&current.figure!==next.figure){requests.clear();feedback.textContent='';}
   current=next;
   const nextKey=JSON.stringify([next.figure,next.vocabulary]);
   if(nextKey!==key){key=nextKey;catalog.replaceChildren();buttons.length=0;
    for(const word of next.vocabulary){const button=ui.button(word.names?.[LANGUAGE]?.[0]||word.names?.[zh?'zh':'en']?.[0]||word.id,{size:'sm'});button.dataset.action=word.id;
     button.title=[word.about?.[LANGUAGE]||word.about?.[zh?'zh':'en'],word.seconds===undefined?'':`${word.seconds} s`].filter(Boolean).join(' · ');
     button.addEventListener('click',()=>void submit(word.id),{signal});catalog.append(button);buttons.push(button);}
   }
   enabled();
   summary.textContent=next.figure+' · '+(!next.available?text('主窗口未连接','Main window disconnected'):next.busy?text('模型准备中','Model loading'):text('可用','Available'))+' · '+text('排队：','Queued: ')+(next.runtime?.queued??0)+' · '+text('执行：','Active: ')+(next.runtime?.active?.word??'—');
   history.replaceChildren();
   for(const row of next.runtime?.recent??[]){if(!row.requestId||!requests.has(row.requestId))continue;
    history.append(el('li',[row.word,statuses[row.status]??row.status,row.reason,row.completion==='duration'?text('按时长结束','Duration elapsed'):row.completion==='body-event'?text('身体完成回执','Body completion event'):null].filter(Boolean).join(' · ')));}
   if(!next.vocabulary.length)summary.textContent+=' · '+text('该身体未声明动作','No actions declared by this body');
  }catch(error){if(!signal.aborted){feedback.textContent=String(error);if(current)current={...current,available:false};enabled();}}
  finally{reading=false;}
 }
 return {element,refresh};
}
