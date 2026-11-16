import type { PageContext } from '../../base/page.ts';
import { LANGUAGE } from '../../base/language.ts';
import { studioControls } from './controls.ts';
export type MouthProfile={mode:'auto'|'mapped'|'off';targets:string[]};
export type MouthBehavior={mode:string;supported:boolean;targets:string[];missing:string[];parameters:Array<{id:string;min:number;max:number;default:number;roles:string[]}>;truncated:boolean};
/** Maps only the mouth-open semantic role using the currently loaded model's actual parameter catalogue. */
export function mouthEditor(ctx:PageContext){
 const {root,signal}=ctx,doc=root.ownerDocument,zh=LANGUAGE.startsWith('zh'),text=(cn:string,en:string)=>zh?cn:en;
 const c=studioControls(ctx);
 const element=c.node('section', '', 'studio-mouth-editor'),mode=doc.createElement('select'),targets=doc.createElement('select'),report=c.status('studio-editor-note');
 mode.setAttribute('aria-label',text('嘴部张开映射模式','Mouth-open mapping mode'));targets.setAttribute('aria-label',text('嘴部张开参数','Mouth-open parameters'));targets.multiple=true;targets.size=6;
 for(const[id,cn,en]of [['auto','自动识别','Automatic'],['mapped','指定参数','Mapped parameters'],['off','关闭此语义映射','Disable this role mapping']]){const o=doc.createElement('option');o.value=id;o.textContent=text(cn,en);mode.append(o);}
 const targetField=c.field(text('嘴部张开参数','Mouth-open parameters'),targets,
  text('按住 Ctrl 或 ⌘ 多选，最多 8 项。','Hold Ctrl or ⌘ to select up to 8 parameters.'));
 targetField.classList.add('studio-mouth-targets');
 element.append(c.node('h2',text('口型映射','Mouth mapping')),c.field(text('嘴部张开','Mouth opening'),mode),targetField,report);
 let original:MouthProfile|undefined,edited=false,disabled=false;
 function lock(){mode.disabled=disabled;targets.disabled=disabled||mode.value!=='mapped';targetField.hidden=mode.value!=='mapped';}
 mode.addEventListener('change',()=>{edited=true;targets.setCustomValidity('');lock();},{signal});targets.addEventListener('change',()=>{edited=true;targets.setCustomValidity('');},{signal});
 return {element,
  read(profile:MouthProfile|undefined,behavior:MouthBehavior|null|undefined){
   original=profile&&structuredClone(profile);edited=false;mode.value=profile?.mode??'auto';targets.replaceChildren();targets.setCustomValidity('');
   const selected=profile?.targets??[],known=new Set<string>();
   for(const p of behavior?.parameters??[]){known.add(p.id);const conflict=p.roles.some(role=>role!=='mouthOpen'),o=doc.createElement('option');o.value=p.id;o.selected=selected.includes(p.id);o.disabled=conflict&&!o.selected;
    o.textContent=`${p.id} [${p.min}, ${p.max}], `+text('默认 ','default ')+p.default+(conflict?' · '+text('角色冲突：','Role conflict: ')+p.roles.join(', '):'');targets.append(o);}
   for(const id of selected)if(!known.has(id)){const o=doc.createElement('option');o.value=id;o.selected=true;o.textContent=text('缺失参数，请明确替换或移除：','Missing parameter, replace or remove explicitly: ')+id;targets.append(o);}
   report.textContent=behavior?text('已加载模式：','Loaded mode: ')+behavior.mode+' · '+(behavior.mode==='off'?text('映射已关闭','Mapping disabled'):behavior.supported?text('存在有效目标','Valid targets available'):text('无有效目标','No valid targets'))+' · '+text('实际映射：','Actual targets: ')+(behavior.targets.join(', ')||'—')+(behavior.missing.length?' · '+text('缺失：','Missing: ')+behavior.missing.join(', '):'')+(behavior.truncated?' · '+text('参数目录已截断，未列出的参数不可新增','Parameter catalogue truncated; unlisted targets cannot be added'):''):text('尚无实际身体参数目录，不能新增未知参数。已有引用会保留。','No loaded body parameter catalogue; unknown targets cannot be added. Existing references are preserved.');lock();
  },
  value():MouthProfile|undefined{if(!edited)return original&&structuredClone(original);return {mode:mode.value as MouthProfile['mode'],targets:mode.value==='mapped'?Array.from(targets.selectedOptions).map(o=>o.value):[]};},
  valid(){if(mode.value!=='mapped'){targets.setCustomValidity('');return true;}const n=targets.selectedOptions.length;targets.setCustomValidity(n<1||n>8?text('请选择 1 至 8 个参数','Select 1 to 8 parameters'):'');return targets.reportValidity();},
  disabled(value:boolean){disabled=value;lock();},
 };
}
