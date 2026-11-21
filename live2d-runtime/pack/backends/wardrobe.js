import {bindingResourceIds, ParameterConflict} from './native-combination.js';
import {compileCurve} from './native-actions.js';
import {fixedWardrobeGroups} from './wardrobe-slots.js';
const channel=t=>(t.target||'Parameter')+':'+t.id;
export function wardrobeChannels(resource){
  const raw=resource?.raw||resource?.data;
  return [...new Set(resource?.kind==='expression'?(raw?.Parameters||[]).map(p=>'Parameter:'+p.Id):(raw?.Curves||[]).filter(c=>['Parameter','PartOpacity'].includes(c.Target)).map(c=>c.Target+':'+c.Id))];
}
export function wardrobeTracks(resource){
  const raw=resource.raw||resource.data,tracks=resource.kind==='expression'?(raw?.Parameters||[]).map(p=>({id:p.Id,target:'Parameter',value:Number(p.Value),blend:p.Blend||'Add'})):(raw?.Curves||[]).filter(c=>['Parameter','PartOpacity'].includes(c.Target)).map(c=>({id:c.Id,target:c.Target,value:compileCurve(c)(Infinity),blend:'Overwrite'}));
  if(!tracks.length||tracks.length>2048||tracks.some(t=>typeof t.id!=='string'||!t.id||!Number.isFinite(t.value)||!['Add','Multiply','Overwrite'].includes(t.blend))||new Set(tracks.map(channel)).size!==tracks.length)throw Error('资源没有可用的外观状态');
  return tracks;
}
export function wardrobeConfig(catalog,groups=[],bindings=[],axisOffset=1){
  groups=fixedWardrobeGroups(groups);
  const resources=new Map(catalog.resources.map(r=>[r.id,r])),used=new Set(),owners=new Map(),ids=new Set();
  for(const binding of bindings){
    // The native-only motion temporarily owns its curves and releases them at the end.
    if(binding.nativeOnly===true&&resources.get(binding.resource)?.kind==='motion')continue;
    for(const id of bindingResourceIds(binding)){
      const resource=resources.get(id);
      for(const key of wardrobeChannels(resource))owners.set(key,{id,title:resource.title||id,kind:'action',word:binding.word});
    }
  }
  const clean=groups.map(g=>{
    if(!/^[a-z][a-z0-9]{1,24}$/.test(g.id)||ids.has(g.id)||typeof g.name!=='string'||!g.name.trim()||g.name.length>40||!Array.isArray(g.options)||g.options.length>16)throw Error('装扮分组无效');ids.add(g.id);
    const options=new Set(['default']);return {id:g.id,...(g.slot?{slot:g.slot}:{}),...(g.custom?{custom:true}:{}),name:g.name,...(g.en?{en:g.en}:{}),options:g.options.map(o=>{
      if(!/^[a-z0-9]{1,24}$/.test(o.id)||options.has(o.id)||typeof o.name!=='string'||!o.name.trim()||o.name.length>60||!resources.has(o.resource))throw Error('装扮选项无效');options.add(o.id);
      const resource=resources.get(o.resource);
      const title = resource.title || o.name;
      const label = g.name + ' · ' + o.name + (title === o.name ? '' : `（${title}）`);
      const incoming={id:o.resource,title,label,kind:'wardrobe',group:g.id,option:o.id};
      for(const t of wardrobeTracks(resource)){
        const key=channel(t),owner=owners.get(key);
        if(owner&&owner.group!==g.id)throw new ParameterConflict(key,incoming,owner);
        owners.set(key,incoming);
      }
      used.add(o.resource);
      return {id:o.id,name:o.name.trim(),resource:o.resource};
    })};
  });
  return {version:1,axisOffset,groups:clean,resources:[...used].map(id=>({id,tracks:wardrobeTracks(resources.get(id))}))};
}
function wardrobePicks(config, scheme) {
  const parts = String(scheme ?? '').split('-').slice(config?.axisOffset ?? 0);
  return Object.fromEntries((config?.groups ?? []).map((group, index) => [group.id, parts[index] || 'default']));
}

/** A trial validates only the outfit that would actually be worn. */
export function wardrobeTrial(catalog, groups, bindings, saved, scheme, requested) {
  const picks = { ...wardrobePicks(saved, scheme), ...requested };
  const selected = fixedWardrobeGroups(groups).map(group => ({
    ...group, options: group.options.filter(option => option.id === picks[group.id]),
  }));
  for (const [id, option] of Object.entries(requested)) {
    if (option !== 'default' && !selected.some(group => group.id === id && group.options.length)) {
      throw Error('找不到要试穿的装扮选项');
    }
  }
  return { config: wardrobeConfig(catalog, selected, bindings, 0), picks };
}

export function createWardrobe(model,paramIndex,partIndex,defaults={}){
  let config={groups:[],resources:[],axisOffset:1},picks={},owned=new Map();
  const partDefaults=new Map([...partIndex].map(([id,i])=>[id,defaults.parts?.[id]??model.getPartOpacityByIndex(i)]));
  const base=t=>t.target==='PartOpacity'?partDefaults.get(t.id):paramIndex.has(t.id)?defaults.params?.[t.id]??model.getParameterDefaultValue(paramIndex.get(t.id)):undefined;
  function write(t,value){if(!Number.isFinite(value))return;const i=(t.target==='PartOpacity'?partIndex:paramIndex).get(t.id);if(i===undefined)return;if(t.target==='PartOpacity')model.setPartOpacityByIndex(i,Math.max(0,Math.min(1,value)));else model.setParameterValueByIndex(i,Math.max(model.getParameterMinimumValue(i),Math.min(model.getParameterMaximumValue(i),value)));}
  function reset(){for(const t of owned.values())write(t,base(t));}
  return {
    configure(next){reset();config=next||{groups:[],resources:[]};owned=new Map((config.resources||[]).flatMap(r=>r.tracks.map(t=>[channel(t),t])));picks={};},
    select(next){picks={...next};},
    scheme(value){picks=wardrobePicks(config,value);},
    apply(){reset();for(const g of config.groups){const option=g.options.find(o=>o.id===picks[g.id]);const r=option&&config.resources.find(r=>r.id===option.resource);for(const t of r?.tracks||[]){const def=base(t);write(t,t.blend==='Add'?def+t.value:t.blend==='Multiply'?def*t.value:t.value);}}},
    state:()=>({...picks}),
    layoutKey:()=>JSON.stringify(config.groups.map(g=>{const o=g.options.find(o=>o.id===picks[g.id]);return [g.id,o?.id||'default',o?.resource??null];})),
    inspect:()=>[...owned.values()].slice(0,256).map(t=>({id:t.id,target:t.target,value:t.target==='PartOpacity'&&partIndex.has(t.id)?model.getPartOpacityByIndex(partIndex.get(t.id)):paramIndex.has(t.id)?model.getParameterValueByIndex(paramIndex.get(t.id)):undefined})),
  };
}
