import type { PageContext } from '../../base/page.ts';
import { LANGUAGE } from '../../base/language.ts';
import { resourcePicker } from './resource-picker.ts';
// @ts-expect-error Owned Figure slot schema is shipped as JavaScript.
import { WARDROBE_SLOTS } from '../../../../../live2d-runtime/pack/backends/wardrobe-slots.js';
type Option={id:string;name:string;resource:string};
type Group={id:string;slot?:'outfit'|'parts'|'accessories';custom?:boolean;name:string;en?:string;options:Option[]};
type Resource={id:string;title:string;kind:string;wardrobeError?:string};
/** Source wardrobe definition only. Current runtime choices belong to the Wardrobe domain. */
export function wardrobeEditor(ctx:PageContext,onTry?:(picks:Record<string,string>,candidate?:{group:string;option:string;resource:string},label?:string)=>void){
 const {root,ui,signal}=ctx,doc=root.ownerDocument,zh=LANGUAGE.startsWith('zh'),text=(cn:string,en:string)=>zh?cn:en;
 const el=(tag:string,value='')=>{const e=doc.createElement(tag);e.textContent=value;return e;};
 const element=el('section'),groups=el('div'),add=doc.createElement('button');
 element.className='studio-wardrobe-editor';
 add.type='button';
 add.className='studio-button is-primary';
 add.textContent=text('新建分组','New group');
 const header = el('header');
 header.className = 'studio-binding-bar';
 header.append(el('h2',text('装扮分组','Outfit groups')),add);
 const empty = el('p', text('新建分组后，为每个装扮选项选择原生资源。', 'Create a group, then choose a native resource for each outfit.'));
 empty.className = 'studio-help';
 groups.className = 'studio-wardrobe-groups';
 element.append(header,empty,groups);
 let resources:Resource[]=[],disabled=false,present=false;
 const rows:Array<{node:HTMLElement;value:()=>Group;syncTry:()=>void}>=[];
 const slots=WARDROBE_SLOTS as Array<{slot:Group['slot'];id:string;name:string;en:string}>;
 function input(value:string,label:string){const i=doc.createElement('input');i.type='text';i.value=value;i.setAttribute('aria-label',label);return i;}
 function changed(){present=true;}
 function lock(){for(const c of element.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement>('input,button,select'))if(!c.closest('.studio-resource-picker'))c.disabled=disabled;
  for(const control of element.querySelectorAll<HTMLElement>('.studio-resource-picker'))control.inert=disabled;
  for(const row of rows)row.syncTry();
  add.disabled=disabled||!resources.length;empty.hidden=rows.length>0;}
 function groupRow(original:Group){
  const node=el('fieldset'),name=input(original.name,text('分组名称','Group name')),en=input(original.en??'',text('英文名称','English name'));
  name.required=true;name.readOnly=!!original.slot;en.readOnly=!!original.slot;const options=el('div'),optionRows:Array<{node:HTMLElement;value:()=>Option;syncTry:()=>void}>=[];
  const title=el('legend',original.name);
  options.className='studio-wardrobe-options';
  name.addEventListener('input',()=>{title.textContent=name.value||original.name;},{signal});
  const addOption=ui.button(text('添加装扮选项','Add wardrobe option'),{size:'sm'}),remove=ui.button(text('移除装扮分组','Remove wardrobe group'),{size:'sm'});
  addOption.dataset.draftChange=remove.dataset.draftChange='true';
  function optionRow(originalOption:Option){
   const row=el('div'),optionName=input(originalOption.name,text('选项名称','Option name')),resource=doc.createElement('select');optionName.required=true;resource.required=true;resource.setAttribute('aria-label',text('装扮资源','Wardrobe resource'));
   const all=[{id:'',title:text('选择资源','Select resource'),kind:''},...resources];
   if(originalOption.resource&&!all.some(r=>r.id===originalOption.resource))all.push({id:originalOption.resource,title:text('失效资源，请明确替换：','Missing resource, replace explicitly: ')+originalOption.resource,kind:'missing'});
   for(const r of all){const o=doc.createElement('option');o.value=r.id;o.textContent=r.title;resource.append(o);}resource.value=originalOption.resource;
   const trial=(id:string)=>{
    if(!id||!resources.some(r=>r.id===id&&!r.wardrobeError))return;
    onTry?.({[original.id]:originalOption.id},{group:original.id,option:originalOption.id,resource:id},resources.find(r=>r.id===id)?.title);
   };
   const picker=resourcePicker(ctx,resource,resources.map(r=>({...r,problem:r.wardrobeError})),onTry?trial:undefined);
   const del=ui.button(text('移除','Remove'),{size:'sm'});del.dataset.draftChange='true';del.setAttribute('aria-label',text('移除装扮选项','Remove wardrobe option'));row.className='studio-wardrobe-option';const tryOn=ui.button(text('试穿','Try on'),{size:'sm'});tryOn.addEventListener('click',()=>trial(resource.value),{signal});const commands=el('div');commands.className='studio-inline studio-wardrobe-option-actions';commands.append(...(onTry?[tryOn]:[]),del);row.append(optionName,resource,picker,commands);options.append(row);
   const syncTry=()=>{tryOn.disabled=disabled||!resource.value||!resources.some(item=>item.id===resource.value&&!item.wardrobeError);};
   const item={node:row,syncTry,value:()=>({...originalOption,name:optionName.value,resource:resource.value})};optionRows.push(item);
   resource.addEventListener('change',syncTry,{signal});
   for(const c of [optionName,resource])c.addEventListener('change',changed,{signal});
   del.addEventListener('click',()=>{if(disabled)return;changed();optionRows.splice(optionRows.indexOf(item),1);row.remove();},{signal});
  }
  for(const option of original.options)optionRow(option);
  addOption.addEventListener('click',()=>{if(disabled)return;changed();let n=1;const ids=new Set(optionRows.map(r=>r.value().id));while(ids.has('option'+n))n++;optionRow({id:'option'+n,name:text('新选项','New option'),resource:''});lock();},{signal});
  const item={node,syncTry:()=>optionRows.forEach(option=>option.syncTry()),value:()=>({...original,name:name.value,...(en.value?{en:en.value}:{en:undefined}),options:optionRows.map(r=>r.value())})};rows.push(item);
  for(const c of [name,en])c.addEventListener('change',changed,{signal});
  remove.addEventListener('click',()=>{if(disabled)return;changed();rows.splice(rows.indexOf(item),1);node.remove();lock();},{signal});
  const names = el('div');
  names.className = 'studio-wardrobe-names';
  name.placeholder = text('分组名称','Group name');
  en.placeholder = text('英文名称（可选）','English name (optional)');
  names.append(name,en);
  names.hidden = !!original.slot;
  const actions = el('div');
  actions.className = 'studio-inline studio-wardrobe-actions';
  actions.append(addOption,remove);
  node.className='studio-wardrobe-group';node.append(title,names,options,actions);groups.append(node);
 }
 const kind=doc.createElement('select');kind.hidden=true;kind.dataset.previewMode='true';kind.setAttribute('aria-label',text('分组类型','Group type'));header.append(kind);
 add.addEventListener('click',()=>{
  if(disabled||!resources.length)return;
  const values=rows.map(r=>r.value()),available=slots.filter(s=>!values.some(g=>g.slot===s.slot||g.id===s.id));
  kind.replaceChildren(...[['',text('选择分组类型','Choose group type')],...available.map(s=>[s.id,zh?s.name:s.en]),['custom',text('自定义分组','Custom group')]].map(([id,label])=>{const o=doc.createElement('option');o.value=id;o.textContent=label;return o;}));
  kind.hidden=false;kind.focus();
 },{signal});
 kind.addEventListener('change',()=>{
  if(!kind.value||disabled)return;
  changed();
  const fixed=slots.find(s=>s.id===kind.value);
  if(fixed)groupRow({id:fixed.id,slot:fixed.slot,name:fixed.name,en:fixed.en,options:[]});
  else {let n=1;while(rows.some(r=>r.value().id==='custom'+n))n++;groupRow({id:'custom'+n,custom:true,name:text('自定义分组','Custom group'),options:[]});}
  kind.hidden=true;lock();add.focus();
  element.dispatchEvent(new Event('input',{bubbles:true}));
 },{signal});
 return {element,
  read(value:Group[]|undefined,catalog:Resource[]){resources=catalog;present=value!==undefined;rows.length=0;groups.replaceChildren();for(const g of value??[])groupRow(structuredClone(g));lock();},
  value:()=>present?rows.map(r=>r.value()):undefined,
  valid:(strict=false)=>{
   for(const i of element.querySelectorAll<HTMLInputElement|HTMLSelectElement>('input,select')){
    if(i instanceof HTMLSelectElement&&i.required&&(!i.value||strict&&!resources.some(r=>r.id===i.value&&!r.wardrobeError))){
     i.parentElement?.querySelector<HTMLElement>('summary')?.focus();return false;
    }
    if(!i.reportValidity())return false;
   }
   return true;
  },
  disabled(value:boolean){disabled=value;lock();},
 };
}
