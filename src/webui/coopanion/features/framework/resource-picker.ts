import type { PageContext } from '../../base/page.ts';
import { studioControls, studioText as t } from './controls.ts';

export type ResourceChoice = { id: string; title: string; kind: string; problem?: string };

/** A focused resource list: preview and selection are separate commands. */
export function resourcePicker(ctx: PageContext, target: HTMLSelectElement, choices: ResourceChoice[], audition?: (id: string) => void) {
  const c = studioControls(ctx);
  const root = c.node('details', '', 'studio-resource-picker');
  const current = c.node('summary');
  const body = c.node('div', '', 'studio-resource-picker-body');
  const search = c.doc.createElement('input');
  search.type = 'search';
  search.placeholder = t('搜索原生资源', 'Search native resources');
  search.setAttribute('aria-label', search.placeholder);
  const kind = c.doc.createElement('select');
  kind.dataset.previewMode = 'true';
  kind.setAttribute('aria-label', t('资源类型', 'Resource type'));
  for (const [id, name] of [['',t('全部资源','All resources')],['expression',t('表情','Expressions')],['motion',t('动作','Motions')]]) {
    const option = c.doc.createElement('option'); option.value=id; option.textContent=name; kind.append(option);
  }
  const list = c.node('div', '', 'studio-resource-options');
  const controls = c.node('div', '', 'studio-resource-filters');
  controls.append(search,kind);
  body.append(controls,list);root.append(current,body);
  target.hidden = true;
  function selection() {
    current.textContent = choices.find(resource=>resource.id===target.value)?.title
      ?? target.selectedOptions[0]?.textContent ?? t('选择资源','Select resource');
    current.dataset.missing = String(!!target.value && !choices.some(resource=>resource.id===target.value&&!resource.problem));
  }
  function render() {
    const query=search.value.trim().toLocaleLowerCase();
    const matching=choices.filter(r=>(!kind.value||kind.value===r.kind)&&(!query||(r.title+' '+r.id).toLocaleLowerCase().includes(query)));
    list.replaceChildren(...matching.map(resource=>{
      const row=c.node('div','','studio-resource-option');
      const label=c.node('div');
      label.append(c.node('strong',resource.title),c.node('small',resource.problem || (resource.kind==='expression'?t('表情','Expression'):resource.kind==='motion'?t('动作','Motion'):'') ));
      const choose=c.button(resource.id===target.value?t('已选','Selected'):t('选用','Select'),()=>{
        target.value=resource.id;
        target.dispatchEvent(new Event('change',{bubbles:true}));
        root.open=false;current.focus();
      });
      choose.disabled=!!resource.problem||resource.id===target.value;
      choose.setAttribute('aria-label',choose.textContent+' · '+resource.title);
      row.append(label);
      if(audition&&!resource.problem&&resource.id){
        const preview=c.button(t('试一下','Try'),()=>audition(resource.id));
        preview.setAttribute('aria-label',t('试一下','Try')+' · '+resource.title);row.append(preview);
      }
      row.append(choose);return row;
    }));
    if(!matching.length)list.append(c.node('p',t('没有匹配的资源','No matching resources'),'studio-help'));
  }
  search.addEventListener('input',render,{signal:ctx.signal});
  kind.addEventListener('change',render,{signal:ctx.signal});
  target.addEventListener('change',()=>{selection();if(root.open)render();},{signal:ctx.signal});
  root.addEventListener('toggle',()=>{if(root.open){render();search.focus({preventScroll:true});}},{signal:ctx.signal});
  root.addEventListener('keydown',event=>{if(event.key==='Escape'&&root.open){event.stopPropagation();root.open=false;current.focus();}},{signal:ctx.signal});
  selection();
  return root;
}
