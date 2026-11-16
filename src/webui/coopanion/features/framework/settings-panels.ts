import type { PageContext } from '../../base/page.ts';
import { invokePanel } from '../../base/api.ts';
import { LANGUAGE } from '../../base/language.ts';
import { studioControls } from './controls.ts';
export interface SettingField { key:string;type:string;min?:number;max?:number;options?:string[];enabledWhen?:Record<string,string> }
export interface SettingsState { fields:SettingField[];desired:Record<string,string|number|boolean>;observed:{status?:string}|null }
export interface SpeechState extends SettingsState { effective:{enabled:boolean;pitchHz:number;unitsPerSecond:number} }
const labels:Record<string,[string,string]>={squash:['Q 弹','Squash'],dragStretch:['拖动拉伸','Drag stretch'],breathing:['呼吸缩放','Breathing scale'],enabled:['音节朗读','Syllable speech'],pitch:['音高','Pitch'],pitchHz:['自定义音高（Hz）','Custom pitch (Hz)'],speed:['语速','Speed'],unitsPerSecond:['每秒音节数','Syllables per second']};
const names:Record<string,[string,string]>={low:['低','Low'],medium:['中','Medium'],mid:['标准','Standard'],high:['高','High'],normal:['标准','Normal'],slow:['慢','Slow'],fast:['快','Fast'],custom:['自定义','Custom']};
/** Pending controls are local; desired state is always read from the owning domain. */
export function settingsPanel(ctx:PageContext,options:{title:string;hint:string;method:'setBodyEffects'|'setSpeech';refresh:()=>Promise<void>;feedback:(text:string)=>void}){
 const c=studioControls(ctx),doc=c.doc,zh=LANGUAGE.startsWith('zh'),text=(p:[string,string])=>p[zh?0:1];
 const element=doc.createElement('article');element.className='framework-card';
 const heading=doc.createElement('h2'),hint=doc.createElement('p'),controls=doc.createElement('div'),status=doc.createElement('p');
 heading.textContent=options.title;hint.textContent=options.hint;hint.hidden=!options.hint;status.className='framework-setting-status';status.setAttribute('role','status');element.append(heading,hint,controls,status);
 const inputs=new Map<string,HTMLInputElement|HTMLSelectElement>(),pending=new Set<string>(),ranges=new Map<string,ReturnType<typeof c.range>>();
 const editing=new Set<string>();
 let current:SettingsState|undefined;
 function render(state:SettingsState|undefined){if(!state)return;current=state;
  for(const field of state.fields){let input=inputs.get(field.key);
   if(!input){const row=doc.createElement('label');row.className=options.method==='setSpeech'?'framework-control studio-field':'framework-control';const label=doc.createElement('span');label.textContent=text(labels[field.key]??[field.key,field.key]);
    input=field.type==='enum'?doc.createElement('select'):doc.createElement('input');input.dataset.setting=field.key;
    if(input.tagName==='SELECT'){for(const value of field.options??[]){const option=doc.createElement('option');option.value=value;option.textContent=text(names[value]??[value,value]);input.append(option);}}
    else{const control=input as HTMLInputElement;control.type=field.type==='boolean'?'checkbox':'number';if(control.type==='checkbox'){control.setAttribute('role','switch');control.className='pet-switch';}if(field.min!==undefined)control.min=String(field.min);if(field.max!==undefined)control.max=String(field.max);control.step='any';}
    let widget: HTMLElement = input;
    if(options.method==='setSpeech' && input instanceof HTMLInputElement && field.type==='number' && field.min!==undefined && field.max!==undefined){
     const unit=field.key==='pitchHz'?' Hz':zh?' 音节/秒':' syllables/s';
     const slider=c.range(input,field.min,field.max,'any',value=>value+unit);
     input.addEventListener('input',()=>editing.add(field.key),{signal:ctx.signal});
     input.addEventListener('blur',()=>editing.delete(field.key),{signal:ctx.signal});
     ranges.set(field.key,slider);
     widget=slider.element;
    }
    inputs.set(field.key,input);row.append(label,widget);controls.append(row);const control=input;
    control.addEventListener('change',async()=>{
     editing.delete(field.key);
     if(pending.has(field.key))return;
     if(!control.reportValidity()||(field.type==='number'&&!control.value)){if(current)render(current);return;}
     pending.add(field.key);control.disabled=true;
     try{const value=field.type==='boolean'?(control as HTMLInputElement).checked:field.type==='number'?Number(control.value):control.value;
      await invokePanel('world:desktop-live2d-pet','framework',options.method,[{[field.key]:value}],{signal:ctx.signal});options.feedback(zh?'设置已保存，正在确认应用。':'Saved; checking application.');
     }catch(error){if(!ctx.signal.aborted){options.feedback(String(error));if(current){if(field.type==='boolean')(control as HTMLInputElement).checked=current.desired[field.key]===true;else control.value=String(current.desired[field.key]??'');ranges.get(field.key)?.sync();}}}
     finally{pending.delete(field.key);control.disabled=false;await options.refresh();}
    },{signal:ctx.signal});
   }
   if(!pending.has(field.key)){
    const slider=ranges.get(field.key);
    if(slider&&!editing.has(field.key)){input.value=String(state.desired[field.key]??'');slider.sync();}
    else if(!slider&&doc.activeElement!==input){if(field.type==='boolean')(input as HTMLInputElement).checked=state.desired[field.key]===true;else input.value=String(state.desired[field.key]??'');}
    const unavailable=Object.entries(field.enabledWhen??{}).some(([key,value])=>state.desired[key]!==value);input.disabled=unavailable;
    if(options.method==='setSpeech'&&field.enabledWhen)input.closest('.studio-field')?.classList.toggle('studio-speech-secondary',unavailable);}
  }
  const reported=state.observed?.status,states:Record<string,string>=zh?{applied:'已应用',active:'已应用',mounted:'已连接',pending:'正在应用',unsupported:'当前身体不支持',mismatch:'尚未完全应用',timeout:'等待回执超时'}:{};
  status.textContent=reported?(states[reported]??reported):(zh?'等待桌宠连接':'Waiting for the pet');
  if('effective'in state){
   const s=state as SpeechState;
   status.textContent=s.effective.enabled ? `${s.effective.pitchHz} Hz · ${s.effective.unitsPerSecond} `+(zh?'音节/秒':'syllables/s') : '';
  }
 }
 return{element,render};
}
