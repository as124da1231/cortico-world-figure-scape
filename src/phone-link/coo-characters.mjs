import {createHash} from 'node:crypto';
import {parse} from 'acorn';

export const cooTargets=Object.freeze({
  'desktop-pet':{label:'Coo 原生桌宠'},
  'desktop-live2d-pet':{label:'Figure Scape · 梦境'},
});
const identity=/^[a-z0-9][a-z0-9_-]{0,80}$/iu;
const sha=value=>createHash('sha256').update(value).digest('hex');
const named=(value,fallback)=>{
  const name=typeof value==='string'?value:value?.zh??value?.['zh-CN']??value?.en??Object.values(value??{})[0];
  return Array.isArray(name)?name[0]??fallback:typeof name==='string'?name:fallback;
};
const conflict=()=>Object.assign(Error('电脑已切换角色或装扮，请重新同步。'),{status:409});
export const deviceAxis=id=>id==='figureframing'||id==='frameworkframing';

function literal(node) {
  if(node?.type==='Literal'&&(node.value===null||['string','number','boolean'].includes(typeof node.value)))return node.value;
  if(node?.type==='UnaryExpression'&&node.operator==='-'&&typeof node.argument.value==='number')return -node.argument.value;
  if(node?.type==='ArrayExpression')return node.elements.map(literal);
  if(node?.type==='ObjectExpression')return Object.fromEntries(node.properties.map(prop=>{
    if(prop.type!=='Property'||prop.computed||prop.method||prop.shorthand||prop.kind!=='init')throw Error('形象文件含动态代码');
    const key=prop.key.name??prop.key.value;
    if(typeof key!=='string'||['__proto__','prototype','constructor'].includes(key))throw Error('形象文件字段无效');
    return [key,literal(prop.value)];
  }));
  throw Error('形象文件含动态代码');
}
/** Extract character data from literal exports without executing figure scripts. */
export function dataModule(text,name) {
  const tree=parse(text,{ecmaVersion:'latest',sourceType:'module'});
  for(const stmt of tree.body){
    if(!name&&stmt.type==='ExportDefaultDeclaration')return literal(stmt.declaration);
    if(name&&stmt.type==='ExportNamedDeclaration'&&stmt.declaration?.type==='VariableDeclaration'){
      const item=stmt.declaration.declarations.find(v=>v.id.name===name);
      if(item?.init)return literal(item.init);
    }
  }
  throw Error('形象文件缺少数据定义');
}
export function assetPath(raw) {
  if(typeof raw!=='string'||raw.length>300||raw.includes('\\')||/[%?#:\u0000-\u001f]/u.test(raw))throw Error('形象资源路径无效');
  const parts=raw.replace(/^\.\//u,'').split('/');
  if(parts.some(part=>!part||part==='.'||part==='..'))throw Error('形象资源路径越界');
  return parts.map(encodeURIComponent).join('/');
}
async function request(origin,path,options={}) {
  const response=await fetch(origin+path,{redirect:'error',signal:AbortSignal.timeout(options.timeout??5000),...options});
  if(response.ok)return response;
  const error=await response.json().catch(()=>null);
  throw Object.assign(Error(error?.error??'Coo 角色资源暂不可用'),{status:response.status});
}
const json=async(origin,path,options)=>(await request(origin,path,options)).json();
export function pickOptions(axes,presets,scheme) {
  const preset=presets?.find(p=>p.id===scheme)?.pick;
  const parts=typeof scheme==='string'?scheme.split('-'):[];
  const picks={};
  for(const [index,axis] of axes.entries()){
    const preferred=preset?.[axis.id]??parts[index];
    const selected=axis.options.find(x=>x.id===preferred)??axis.options[0];
    if(selected)picks[axis.id]=selected.id;
  }
  return picks;
}
/**
 * The two Worlds can fall back to a different free port on startup. Resolve
 * their actual loopback addresses and keep asset plans in the owning relay.
 */
export function createCharacterService({cooOrigin,cooCookie,figureScapeOrigin}) {
  const cached=new Map();
  async function resolveOrigin(target) {
    const address=target==='desktop-live2d-pet' ? figureScapeOrigin() : (await json(cooOrigin,
      '/api/webui/providers/world%3Adesktop-pet/panels/pet/state',{
        headers:{cookie:await cooCookie()},
      })).url;
    const url=address && new URL(address);
    if(!url || url.protocol!=='http:' || url.hostname!=='127.0.0.1' || url.username || url.password)
      throw Object.assign(Error('电脑上的桌宠服务还未就绪。'),{status:404});
    return url.origin;
  }
  async function current(target,requested) {
    const origin=await resolveOrigin(target);
    const {skin}=await json(origin,'/api/state');
    const id=requested??skin?.figure;
    if(!identity.test(id??''))return {origin};
    const body=target==='desktop-live2d-pet'
      ? await json(origin,'/api/bodies/'+encodeURIComponent(id))
      : (await json(origin,'/api/figures')).find(pack=>pack.id===id);
    if(!body)return {origin};
    const axes=(body.axes??[]).filter(axis=>identity.test(axis.id)).map(axis=>({
      id:axis.id,name:named(axis.name,axis.id),options:(axis.options??[]).filter(x=>identity.test(x.id)).map(x=>({id:x.id,name:named(x.name,x.id)})),
    }));
    const scheme=(id===skin?.figure?skin.scheme:body.figureSettings?.scheme)??'';
    const picks=target==='desktop-pet'&&id==='coo'&&id===skin?.figure
      ? {...pickOptions(axes,body.presets,scheme),...Object.fromEntries(axes.filter(axis=>axis.options.some(x=>x.id===skin[axis.id])).map(axis=>[axis.id,skin[axis.id]]))}
      : pickOptions(axes,body.presets,scheme);
    return {origin,body,skin,snapshot:{id,target,version:body.resource?.configuration?.revision??body.resource?.sourceHash??body.version??'',name:named(body.name,id),source:body.kind==='live2d-model'?'live2d':'coo-pack',scheme,axes,picks}};
  }
  async function activeCharacter(target) { return (await current(target)).snapshot??null; }
  async function changeCharacterLook(target,{id,scheme,expected,axis,option}) {
    const {origin,body,skin,snapshot}=await current(target);
    if(!body||snapshot.id!==id||snapshot.scheme!==scheme||(expected!==undefined&&expected!==snapshot.picks[axis]))throw conflict();
    const group=snapshot.axes.find(item=>item.id===axis);
    if(!group||deviceAxis(axis)||!group.options.some(item=>item.id===option))throw Error('装扮选项无效');
    const picks={...snapshot.picks,[axis]:option};
    const selected=body.presets?.find(p=>snapshot.axes.every(group=>p.pick?.[group.id]===picks[group.id]))?.id
      ?? snapshot.axes.map(group=>picks[group.id]).join('-');
    if(target==='desktop-live2d-pet'){
      const cookie=await cooCookie();
      await json(cooOrigin,'/api/webui/providers/world%3Adesktop-live2d-pet/panels/framework/resources.chooseWardrobe',{
        method:'POST',headers:{'content-type':'application/json',origin:cooOrigin,...(cookie?{cookie}:{})},
        body:JSON.stringify({args:[id,selected]}),
      });
    }else{
      const next=id==='coo'?{...skin,...picks}:{...skin,scheme:selected};
      await json(origin,'/api/skin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({skin:next})});
    }
    const applied=await activeCharacter(target);
    if(!applied||applied.id!==id||applied.picks[axis]!==option)throw Error('Coo 还没有确认换装');
    return applied;
  }
  async function prepare(origin,body,snapshot) {
    const bundled=snapshot.target==='desktop-pet'&&['coo','whale'].includes(snapshot.id)&&body.base==='/web/'+snapshot.id+'/';
    if(!bundled&&(typeof body.base!=='string'||!/^\/(?:packs|figure-assets|model-assets)\/[a-z0-9_-]+\/$/iu.test(body.base)))throw Error('Coo 角色目录无效');
    const upstream=name=>body.base+assetPath(name);
    const moduleAt=async(name,exportName)=>dataModule(await (await request(origin,upstream(name))).text(),exportName);
    let entry=body.resource?.entry;
    if(!entry){
      let registry;
      try { registry=await moduleAt('models/index.js','models'); }
      catch(error) {
        if(error.status!==404)throw error;
        return figurePackage(origin,body,snapshot);
      }
      entry=Object.values(snapshot.picks).map(key=>Object.hasOwn(registry,key)?registry[key]:null).find(Boolean)??Object.values(registry)[0];
    }
    if(!entry||!identity.test(entry.id)||!entry.model||!entry.moc||!Array.isArray(entry.textures)||entry.textures.length<1||entry.textures.length>64)
      throw Error('这个角色缺少手机可使用的 Live2D 数据');
    const prefix='models/'+entry.id+'/';
    const modules=new Set(['profile.js',entry.model,entry.cdi,entry.physics,entry.pose,
      ...(entry.motions??[]).map(item=>item.file),...(entry.expressions??[]).map(item=>item.file)].filter(Boolean));
    if(modules.size>400)throw Error('角色动作资源太多');
    const files=new Map();
    for(const name of modules){
      let value=await moduleAt(prefix+name);
      if(name==='profile.js'){
        const config=body.resource?.configuration??{};
        value={...value};
        for(const key of ['fit','gaze','visual','touch'])if(config[key]!==undefined)value[key]=config[key];
        if(Array.isArray(config.bindings)&&value.native)value.native.bindings=config.bindings;
        if(body.figureSettings?.touch)value.touch=body.figureSettings.touch;
      }
      files.set(name,{value:Buffer.from(JSON.stringify(value))});
    }
    for(const name of new Set([entry.moc,...entry.textures])){
      if(files.has(name)||/\.js$/iu.test(name))throw Error('角色的二进制资源引用无效');
      files.set(name,{path:upstream(prefix+name)});
    }
    delete entry.mocFallback;
    const revision=sha(JSON.stringify([snapshot.target,snapshot.id,body.resource?.sourceHash,body.resource?.configuration?.revision,entry,
      [...files].map(([name,file])=>[name,file.value?sha(file.value):file.path])]));
    const descriptor={...snapshot,sourceId:body.resource?.sourceId??body.id,revision,entry,files:[...files.keys()],
      words:(body.vocab??[]).map(item=>({id:item.id,name:named(item.names,item.id),seconds:item.seconds}))};
    return {origin,descriptor,files};
  }
  async function figurePackage(origin,body,snapshot) {
    if(typeof body.entry!=='string'||typeof body.export!=='string'||!/^[a-z_$][a-z0-9_$]*$/iu.test(body.export))
      throw Object.assign(Error('这个形象包缺少 Body API 2 入口。'),{status:422});
    assetPath(body.entry);
    const manifest=await json(origin,body.base+'figure.json').catch(()=>null);
    const thumb=body.thumb??manifest?.thumb;
    const shape={entry:body.entry,export:body.export,model:body.model??null,
      thumb:typeof thumb==='string'?thumb:null,settings:body.figureSettings??null};
    if(shape.model)assetPath(shape.model);
    if(shape.thumb)assetPath(shape.thumb);
    const revision=sha(JSON.stringify([snapshot.target,snapshot.id,manifest?.version,body.version,shape]));
    const descriptor={...snapshot,sourceId:body.id,engine:'body-api-2',revision,shape,
      words:(body.vocab??[]).map(item=>({id:item.id,name:named(item.names,item.id),seconds:item.seconds}))};
    return {origin,descriptor,files:new Map(),base:body.base};
  }

  async function frameFile(target,id,revision,name) {
    let pack=cached.get(revision);
    if(!pack){
      await characterPackage(target,id);
      pack=cached.get(revision);
    }
    if(!pack||pack.descriptor.engine!=='body-api-2'||pack.descriptor.target!==target||pack.descriptor.id!==id
      ||!(/\.(?:m?js|json|png|jpe?g|gif|webp|svg|wasm|moc3|skel|atlas|ogg|mp3|wav|bin)$/iu.test(name??'')))
      throw Object.assign(Error('形象资源已变化，请重新同步。'),{status:404});
    return readBytes(pack.origin,pack.base+assetPath(name));
  }

  async function characterPackage(target, expected) {
    if(!identity.test(expected??''))throw conflict();
    const {body,origin,snapshot}=await current(target,expected);
    if(!body||snapshot.id!==expected)throw conflict();
    const result=await prepare(origin,body,snapshot);
    cached.set(result.descriptor.revision,result);
    if(cached.size>6)cached.delete(cached.keys().next().value);
    return result.descriptor;
  }
  async function characterCatalog(target){
    const origin=await resolveOrigin(target);
    const cookie=target==='desktop-live2d-pet' ? await cooCookie() : '';
    const list=target==='desktop-live2d-pet'
      ? await json(cooOrigin,'/api/webui/providers/world%3Adesktop-live2d-pet/panels/framework/resources',{
        method:'POST',headers:{'content-type':'application/json',origin:cooOrigin,...(cookie?{cookie}:{})},
        body:JSON.stringify({args:[]}),
      }) : await json(origin,'/api/figures');
    const models=await Promise.all(list.slice(0,80).filter(item=>identity.test(item.id)).map(async item=>{
      try{
        const body=target==='desktop-live2d-pet'?await json(origin,'/api/bodies/'+encodeURIComponent(item.id)):item;
        if(!body.resource?.entry&&(!body.entry||!body.export))return null;
        return {id:item.id,name:named(item.name,item.id)};
      }catch {return null;}
    }));
    return models.filter(Boolean);
  }

  async function characterAsset(revision,name) {
    const plan=cached.get(revision);
    const file=plan?.files.get(name);
    if(!file)throw Object.assign(Error('角色资源已过期，请重新同步。'),{status:404});
    if(file.value)return file.value;
    return readBytes(plan.origin,file.path);
  }
  return {activeCharacter,changeCharacterLook,characterAsset,characterCatalog,characterPackage,frameFile};
}

async function readBytes(origin,path){
  const response=await request(origin,path,{timeout:20000});
  const max=80*1024*1024;
  if(Number(response.headers.get('content-length'))>max){await response.body?.cancel();throw Error('角色资源过大');}
  const chunks=[];
  let size=0;
  for await(const chunk of response.body){
    size+=chunk.length;
    if(size>max)throw Error('角色资源过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks,size);
}
