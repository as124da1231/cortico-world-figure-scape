import { invokePanel } from '../../base/api.ts';
import type { PageContext } from '../../base/page.ts';
import { LANGUAGE } from '../../base/language.ts';
const PROVIDER='world:desktop-live2d-pet';
type Names=Record<string,string>;
type Appearance={figure:string;available:boolean;busy:boolean;axes:Array<{id:string;name:Names;options:Array<{id:string;name:Names}>}>;desired:{scheme:string;picks:Record<string,string>};observed:{status:string;scheme:string|null}};
export function appearancePanel(ctx:PageContext){
 const {root,signal,ui}=ctx,doc=root.ownerDocument,zh=LANGUAGE.startsWith('zh'),text=(cn:string,en:string)=>zh?cn:en;
 const el=(tag:string,value='')=>{const e=doc.createElement(tag);e.textContent=value;return e;};
 const name=(names:Names|undefined,id:string)=>names?.[LANGUAGE]??names?.[zh?'zh':'en']??id;
 const element=el('article'),controls=el('div'),status=el('p'),feedback=el('p');element.className='framework-card';feedback.setAttribute('role','status');
 element.append(el('h2',text('当前装扮','Current appearance')),el('p',text('选择后即时保存并应用。创建分组与选项请切换到「装扮规则」。','Selections are saved and applied immediately. Create groups under Appearance rules.')),controls,status,feedback);
 let current:Appearance|null=null,reading=false,saving=false,key='';const selects=new Map<string,HTMLSelectElement>();
 function lock(){for(const input of selects.values())input.disabled=saving||!current?.available||current.busy;}
 async function refresh(){if(reading||signal.aborted)return;reading=true;try{
  const next=await invokePanel<Appearance>(PROVIDER,'framework','appearance',[],{signal});if(signal.aborted)return;
  if(!Array.isArray(next.axes))throw Error('Appearance axes unavailable');current=next;
  const nextKey=JSON.stringify([next.figure,next.axes]);if(nextKey!==key){key=nextKey;controls.replaceChildren();selects.clear();
   for(const axis of next.axes){const label=el('label',name(axis.name,axis.id)+' '),select=doc.createElement('select');label.className='framework-control';select.dataset.axis=axis.id;
    for(const option of axis.options){const o=doc.createElement('option');o.value=option.id;o.textContent=name(option.name,option.id);select.append(o);}selects.set(axis.id,select);label.append(select);controls.append(label);
    select.addEventListener('change',async()=>{if(saving||!current)return;const figure=current.figure;saving=true;lock();try{await invokePanel(PROVIDER,'framework','setAppearance',[figure,{[axis.id]:select.value}],{signal});feedback.textContent=text('已提交，等待方案回执。','Submitted; awaiting scheme feedback.');}catch(e){if(!signal.aborted)feedback.textContent=String(e);}finally{saving=false;lock();await refresh();}},{signal});}
  }
  if(!saving)for(const[id,input]of selects)input.value=next.desired.picks[id]??'';lock();
  const states:Record<string,string>=zh?{applied:'装扮已应用',pending:'正在应用装扮',offline:'桌宠未连接'}:{};
  status.textContent=!next.axes.length?text('当前角色没有可切换的装扮。','No appearance choices for this character.'):(states[next.observed.status]??next.observed.status);
 }catch(e){if(!signal.aborted){feedback.textContent=String(e);if(current)current={...current,available:false};lock();}}finally{reading=false;}}
 return {element,refresh};
}
