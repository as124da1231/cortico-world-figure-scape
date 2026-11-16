import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {copyFile,mkdir,mkdtemp,readFile,realpath,rename,rm,stat,writeFile} from 'node:fs/promises';
import {basename,dirname,extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {DirectModelResource,ModelResources,ModelProfile,ModelConfiguration} from '../framework/model-contract.ts';
import {prepareLocalSdk} from './local-sdk.ts';
import {createModelProfileStore} from './model-profile-store.ts';
import {readModelProfile,writeModelProfile,DEFAULT_MODEL_PROFILE} from './model-profile.ts';
// @ts-expect-error Imported DSH resource preparation, provenance in direct-tools/SOURCE.json.
import {snapshotModel} from '../../live2d-runtime/direct-tools/model-source.mjs';
// @ts-expect-error Shared native resource rules.
import {inspectNative,nativeConfig,appendNativeVocab} from '../../live2d-runtime/tools/native-catalog.mjs';
// @ts-expect-error Shared wardrobe rules.
import {wardrobeConfig} from '../../live2d-runtime/pack/backends/wardrobe.js';
// @ts-expect-error Shared framing scheme constants.
import {BODY_CROP_AXIS,BODY_CROP_OPTIONS} from '../../live2d-runtime/pack/backends/crop-config.js';
// @ts-expect-error Timing rule shared with the native player.
import {nativeBindingDuration} from '../../live2d-runtime/pack/backends/native-actions.js';
// @ts-expect-error Existing Figure effect reach budget.
import {EMOTION_EFFECT_REACH} from '../../live2d-runtime/tools/emotion-effect.mjs';
const RUNTIME=fileURLToPath(new URL('../../live2d-runtime/',import.meta.url));
const MODEL_ID=/^live2d-[a-f0-9]{16}-[a-f0-9]{8}$/;
const hash=(data:string)=>createHash('sha256').update(data).digest('hex');
const configurationOf=(profile:ModelProfile,actions?:DirectModelResource['actions']):ModelConfiguration=>({version:1,revision:hash(JSON.stringify(profile)),fit:profile.fit,gaze:profile.gaze??{enabled:true,speed:1},bindings:profile.bindings??[],...(profile.visual?{visual:profile.visual}:{}),...(actions?{actions}:{}),...(profile.touch?{touch:profile.touch}:{})});
const structuralProfile=(profile:ModelProfile)=>{
 // Editors may materialize empty lists/default mouth mode without changing any
 // compiled resources. Compare their meaning, not optional JSON spelling.
 return JSON.stringify([profile.version,profile.crop??null,profile.motion??null,profile.facing??null,profile.touch??null,
  profile.emotionEffect ?? 'native', profile.emotionEffectSize ?? 'medium',
  (profile.wardrobe??[]).filter(group=>group.options.length),profile.mouth??{mode:'auto',targets:[]}]);
};
const FACE_NAMES:Record<string,string>={neutral:'平静',happy:'开心',wink:'眨眼',love:'喜欢',shy:'害羞',surprised:'惊讶',angry:'生气',sad:'难过',sleepy:'困倦',thinking:'思考',smug:'得意',pout:'嘟嘴',worried:'担心',determined:'坚定',flustered:'慌张',scared:'害怕',excited:'兴奋',cry:'哭',confused:'困惑'};
function inside(root:string,name:string):string|null{
 if(!name||isAbsolute(name)||name.includes('\\')||name.split('/').some(p=>!p||p==='.'||p==='..'||p.includes(':')))return null;
 try{const base=realpathSync(root),candidate=realpathSync(join(root,name)),rel=relative(base,candidate);
  return rel&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep)&&lstatSync(candidate).isFile()?candidate:null;
 }catch{return null;}
}
function prepareData(args:string[],signal:AbortSignal){
 signal.throwIfAborted();return new Promise<void>((done,fail)=>{
  const child=spawn(process.execPath,[join(RUNTIME,'direct-tools/prepare-model.mjs'),...args],{cwd:RUNTIME,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
  let output='';const abort=()=>child.kill();signal.addEventListener('abort',abort,{once:true});
  child.stdout?.on('data',d=>{output=(output+d).slice(-8000);});child.stderr?.on('data',d=>{output=(output+d).slice(-8000);});
  child.once('error',e=>{signal.removeEventListener('abort',abort);fail(e);});
  child.once('close',code=>{signal.removeEventListener('abort',abort);if(signal.aborted)fail(signal.reason);else if(code)fail(Error(output.slice(-1800)||'模型数据准备失败'));else done();});
 });
}
/** DSH data preparation + our existing config and candidate ownership. No manifest or private renderer copy per model. */
export function createDirectModelService(options:{dataDir:string;sdkProvider?:(signal:AbortSignal)=>Promise<string>;sdkCache?:()=>Promise<string|null>}):ModelResources{
 const root=resolve(options.dataDir,'desktop-live2d-pet'),directory=join(root,'native-models'),work=join(root,'work'),sdk=join(root,'sdk');
 const sources=join(root,'sources');
 const profiles=createModelProfileStore(directory,sources);
 let sdkRoot=sdk,preparing=false;
 const previewUsers=new Map<string,number>(), pruning=new Set<string>();
 const sourceMarker = '.removed-generations.json';
 const validSource = (id: string) => /^live2d-[a-f0-9]{16}$/.test(id);
 function allModels() {
  let ids: string[];
  try { ids = readdirSync(directory); }
  catch (error) {
   if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
   throw error;
  }
  return ids.map(readResource).filter((resource): resource is DirectModelResource => resource !== null);
 }
 function removed(resource: DirectModelResource) {
  if (inside(directory, resource.id+'/.library-removed')) return true;
  const file = validSource(resource.sourceId) && inside(sources, resource.sourceId+'/'+sourceMarker);
  if (!file) return false;
  const ids: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(ids) && ids.includes(resource.id);
 }
 function directModels() {
  return allModels().filter(resource => !removed(resource));
 }
 function libraryModels(selected: string) {
  const latest = new Map<string, { resource: DirectModelResource; preparedAt: number }>();
  let active: DirectModelResource | undefined;
  for (const resource of directModels()) {
   if (resource.id === selected) active = resource;
   const file = inside(directory, resource.id+'/model-resource.json');
   if (!file) continue;
   const edited = inside(directory, resource.id+'/configuration.json');
   const preparedAt = Math.max(statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0,
    edited ? statSync(edited, { throwIfNoEntry: false })?.mtimeMs ?? 0 : 0);
   const previous = latest.get(resource.sourceId);
   if (!previous || preparedAt >= previous.preparedAt) latest.set(resource.sourceId, { resource, preparedAt });
  }
  // Equivalent historical generations use the active ID. An updated source
  // or saved configuration can still offer a newer generation for selection.
  return Array.from(latest.values(), ({ resource }) =>
   active?.sourceId === resource.sourceId && active.sourceHash === resource.sourceHash &&
    active.configuration?.revision === resource.configuration?.revision ? active : resource);
 }
 function cacheState(protectedIds:readonly string[]){
  const entries:{id:string;removed:boolean;protected:boolean}[]=[];
  for (const resource of allModels()) {
   const { id } = resource;
   entries.push({ id, removed: removed(resource), protected: protectedIds.includes(id)||previewUsers.has(id)||pruning.has(id) });
  }
  return{entries,prunable:entries.filter(entry=>entry.removed&&!entry.protected).map(entry=>entry.id)};
 }
 function actionCatalog(id:string){
  const file=inside(directory,id+'/action-catalog.json');if(!file)return null;
  if(lstatSync(file).size>2*1024*1024)throw Error('Action catalogue is too large');
  return JSON.parse(readFileSync(file,'utf8'));
 }
 function actionsFor(catalog:{base:DirectModelResource['actions'];resources:unknown[]},profile:ModelProfile){
  const actions=structuredClone(catalog.base);appendNativeVocab(actions,profile.bindings??[],catalog.resources);
  for(const binding of profile.bindings??[]){
   const resource=catalog.resources.find((r:any)=>r.id===binding.resource) as {kind:string}|undefined;
   const word=actions.find(w=>w.id===binding.word);
   if(word&&resource?.kind==='motion'){word.kind='motion';word.seconds=nativeBindingDuration(binding,catalog.resources);}
  }
  return actions;
 }
 function readResource(id:string):DirectModelResource|null{
  if(!MODEL_ID.test(id))return null;const file=inside(directory,id+'/model-resource.json');if(!file)return null;
  try{if(lstatSync(file).size>2*1024*1024)return null;const r=JSON.parse(readFileSync(file,'utf8'));
   if(!(r.version===1&&r.kind==='live2d-model'&&r.id===id&&r.entry?.id===id&&Array.isArray(r.appearance)&&Array.isArray(r.actions)))return null;
   if(!r.sourceLabel){
    const record=inside(directory,id+'/source-record.json');
    if(record)try{
     const {modelFile}=JSON.parse(readFileSync(record,'utf8'));
     if(typeof modelFile==='string'){
      r.sourceLabel=basename(dirname(modelFile))+'/'+basename(modelFile);
      if(r.title==='source')r.title=basename(modelFile).replace(/\.model3\.json$/i,'');
     }
    }catch{}
   }
   r.generatedCover = !r.cover && !!inside(directory,id+'/models/'+id+'/cover.generated.png');
   const config=inside(directory,id+'/configuration.json');
   if(config){
    if(lstatSync(config).size>2*1024*1024)return null;
    const profile=readModelProfile(JSON.parse(readFileSync(config,'utf8'))),catalog=actionCatalog(id);
    if(catalog)r.actions=actionsFor(catalog,profile);
    r.configuration=configurationOf(profile,r.actions);
   }
   return r;
  }catch{return null;}
 }
 const { readSaved, ...editor } = profiles;
 const service: ModelResources = {...editor,modelDirectory:directory,provider:'direct-live2d',
  hasModel(id){return readResource(id)!==null;},
  async prepareConfiguration(id,saved){
   const resource=readResource(id),baseline=inside(directory,id+'/prepared-profile.json');
   if(!resource||!baseline||saved.sourceId!==resource.sourceId||saved.loadedCatalogFingerprint!==saved.catalogFingerprint)return null;
   const prepared=readModelProfile(JSON.parse(await readFile(baseline,'utf8')));
   if(structuralProfile(prepared)!==structuralProfile(saved.profile))return null;
   const catalog=actionCatalog(id);
   if(!catalog&&JSON.stringify(prepared.bindings??[])!==JSON.stringify(saved.profile.bindings??[]))return null;
   const actions=catalog?actionsFor(catalog,saved.profile):resource.actions;
   // Desired config is durable before dispatch; a failed/offline renderer can retry
   // or load it next time without rebuilding/copying any model resource.
   await writeModelProfile(join(directory,id,'configuration.json'),saved.profile);
   return configurationOf(saved.profile,actions);
  },
  directModels,
  libraryModels,
  directModel(id){return readResource(id);},
  async resolveLibraryModel(id, signal) {
   const resource = readResource(id);
   if (!resource || removed(resource)) throw Error('The resource is no longer available');
   const saved = await readSaved(resource.sourceId);
   signal.throwIfAborted();
   const profile = saved ?? readModelProfile(DEFAULT_MODEL_PROFILE);
   const revision = configurationOf(profile).revision;
   if (resource.configuration?.revision === revision) return id;
   const available = directModels().find(model => model.sourceId === resource.sourceId &&
    model.sourceHash === resource.sourceHash && model.configuration?.revision === revision);
   if (available) return available.id;

   const state = await editor.editor(id);
   signal.throwIfAborted();
   if (!state) throw Error('Model source is unavailable');
   const configuration = await service.prepareConfiguration!(id, state);
   signal.throwIfAborted();
   return configuration ? id : (await service.prepare(state.modelFile, signal)).id;
  },
  retainPreview(id){
   const resource = readResource(id);
   if(pruning.has(id)||!resource||removed(resource))return null;
   previewUsers.set(id,(previewUsers.get(id)??0)+1);
   return ()=>{const users=previewUsers.get(id)??0;if(users<=1)previewUsers.delete(id);else previewUsers.set(id,users-1);};
  },
  async removeModel(id,protectedIds){
   const resource = readResource(id);
   if (!resource || !validSource(resource.sourceId)) throw Error('Model is unavailable');
   const generations = allModels().filter(model => model.sourceId === resource.sourceId).map(model => model.id);
   if (generations.some(model => protectedIds.includes(model))) {
    throw Error('Select another body before removing this model');
   }
   const location = join(sources, resource.sourceId);
   mkdirSync(location, { recursive: true });
   if (realpathSync(location) !== join(realpathSync(root), 'sources', resource.sourceId)) {
    throw Error('The model source directory is a link');
   }
   const temporary = join(location, '.remove-'+randomUUID()+'.tmp');
   try {
    writeFileSync(temporary, JSON.stringify(generations), { flag:'wx' });
    renameSync(temporary, join(location, sourceMarker));
   } finally { rmSync(temporary, { force:true }); }
   return{id,removed:true};
  },
  cacheState,
  async pruneCache(protectedIds){
   if(preparing)throw Error('A model is being prepared');
   const deleted:string[]=[], failed:{id:string;reason:string}[]=[];
   for(const id of cacheState(protectedIds).prunable){
    if(previewUsers.has(id)||pruning.has(id))continue;
    pruning.add(id);
    try{
     const base=await realpath(directory), location=join(base,id);
     if(!MODEL_ID.test(id)||await realpath(location)!==location||(await lstatSync(location)).isSymbolicLink())throw Error('Unexpected cache directory');
     await rm(location,{recursive:true,force:false});deleted.push(id);
    }catch(error){failed.push({id,reason:String(error instanceof Error?error.message:error)});}
    finally{pruning.delete(id);}
   }
   return{deleted,failed,...cacheState(protectedIds)};
  },
  async saveGeneratedCover(id, png) {
   const resource = readResource(id);
   if (!resource || removed(resource) || !previewUsers.has(id) || pruning.has(id)) return false;
   if (resource.cover || resource.generatedCover) return true;
   const base = join(directory,id,'models',id);
   const actual = await realpath(base);
   if (actual !== join(await realpath(directory),id,'models',id) || removed(resource)) return false;
   const file = join(actual,'cover.generated.png');
   const temporary = join(actual,'.cover-'+randomUUID()+'.tmp');
   try {
    await writeFile(temporary,png,{flag:'wx'});
    await rename(temporary,file);
    return true;
   } finally { await rm(temporary,{force:true}); }
  },
  directAsset(id,name){if(!MODEL_ID.test(id)||!readResource(id)||!name.startsWith('models/')||!['.js','.moc3','.png','.jpg','.jpeg','.webp'].includes(extname(name).toLowerCase()))return null;return inside(join(directory,id),name);},
  runtimeAsset(name){
   if (/^sdk\/(live2dcubismcore\.min|framework|shaders)\.js$/.test(name)) {
    const file = name.slice(4);
    return options.sdkCache ? options.sdkCache().then(cache => cache ? inside(cache, file) : null) : inside(sdkRoot, file);
   }
   if(!/^(backends|vendor)\//.test(name)||!['.js','.json','.css'].includes(extname(name)))return null;
   return inside(join(RUNTIME,'pack'),name);
  },
  async prepare(file,signal,library){
   if(preparing)throw Error('A model preparation is already in progress');preparing=true;let scratch:string|undefined;
   try{
    signal.throwIfAborted();const source=await realpath(file);if(!/\.model3\.json$/i.test(source)||!(await stat(source)).isFile())throw Error('请选择 .model3.json 模型文件');
    const sourceId='live2d-'+hash(process.platform==='win32'?source.toLowerCase():source).slice(0,16);
    const id=sourceId+'-'+randomUUID().slice(0,8);
    sdkRoot=await(options.sdkProvider?.(signal)??prepareLocalSdk(sdk,[join(options.dataDir,'figure/sdk')],signal));
    await mkdir(work,{recursive:true});await mkdir(directory,{recursive:true});scratch=await mkdtemp(join(work,'direct-'));
    const frozen=await snapshotModel({dir:dirname(source),file:basename(source)},join(scratch,'source'),{signal});
    const catalog=await inspectNative({kind:'live2d',dir:frozen.dir,file:frozen.file},{signal});
    const profile=await readSaved(sourceId);
    if((profile?.mouth?.mode==='mapped'||profile?.bindings?.length||profile?.wardrobe?.some(g=>g.options.length))&&profile.catalogFingerprint!==catalog.fingerprint)throw Error('Model resources changed; review bindings before loading');
    const preparedProfile=readModelProfile(profile??DEFAULT_MODEL_PROFILE);
    if (library) {
     const revision = configurationOf(preparedProfile).revision;
     const cached = libraryModels(library.librarySelection).find(model => model.sourceId === sourceId);
     if (cached && cached.sourceHash === frozen.fingerprint && cached.configuration?.revision === revision) {
      signal.throwIfAborted();
      return { id:cached.id, sourceId, directory:join(directory,cached.id) };
     }
    }
    const native=nativeConfig(catalog,profile?.bindings??[],{includeAll:true});
    const overrides=join(scratch,'overrides.json'),out=join(scratch,'data');
    await writeFile(overrides,JSON.stringify({...(profile?{fit:profile.fit,motion:profile.motion}:{}),native,render:{mode:'original',textureLimit:0,canvasLimit:0,strict:true}}),{flag:'wx'});
    await prepareData(['--model',frozen.dir,'--model-file',frozen.file,'--out',out,'--id',id,'--max-texture','0','--source-digest',frozen.fingerprint,'--overrides',overrides],signal);
    const data=JSON.parse(await readFile(join(out,'model-data.json'),'utf8'));if(data.id!==id||data.entry?.id!==id)throw Error('Prepared model identity mismatch');
    const wardrobe=wardrobeConfig(catalog,profile?.wardrobe??[],profile?.bindings??[],0),groups=wardrobe.groups.filter((g:any)=>g.options.length);
    const appearance:DirectModelResource['appearance']=groups.map((g:any)=>({id:g.id,name:{zh:g.name,en:g.en||g.name},options:[{id:'default',name:{zh:'默认',en:'Default'}},...g.options.map((o:any)=>({id:o.id,name:{zh:o.name,en:o.name}}))]}));
    if(profile?.crop){if(appearance.some(a=>a.id===BODY_CROP_AXIS))throw Error('Reserved framing axis');const modes=profile.crop.mode==='upper'?['upper','full']:['full','upper'];appearance.push({id:BODY_CROP_AXIS,name:{zh:'取景',en:'Framing'},options:modes.map(mode=>({id:BODY_CROP_OPTIONS[mode],name:{zh:mode==='full'?'全身':'半身',en:mode}}))});}
    const profileFile=join(out,'models',id,'profile.js'),generated=await readFile(profileFile,'utf8');
    if(!/\n};\s*$/.test(generated))throw Error('Unexpected generated profile');
    const settings={wardrobe:{...wardrobe,groups},...(profile?.touch?{touch:profile.touch}:{}),...(profile?.emotionEffect?{emotionEffect:profile.emotionEffect}:{}),...(profile?.emotionEffectSize?{emotionEffectSize:profile.emotionEffectSize}:{}),...(profile?.crop?{crop:profile.crop}:{}),...(profile?.mouth?{mouth:profile.mouth}:{}),...(profile?.gaze?{gaze:profile.gaze}:{}),...(profile?.facing?{facing:profile.facing}:{}),...(profile?.visual?{visual:profile.visual}:{})};
    await writeFile(profileFile,generated.replace(/\n};\s*$/,()=> '\n'+Object.entries(settings).map(([key,value])=>'  '+key+': '+JSON.stringify(value)+',').join('\n')+'\n};\n'));
    const base:DirectModelResource['actions']=(data.expressions??[]).map((word:string)=>({id:word,kind:'expression',names:{zh:[FACE_NAMES[word]??word]},about:{zh:(FACE_NAMES[word]??word)+'的表情'},seconds:.9}));
    const catalogData={base,resources:native.resources.map(({id,kind,title,seconds,classification}:any)=>({id,kind,title,seconds,classification}))};
    await writeFile(join(out,'action-catalog.json'),JSON.stringify(catalogData),{flag:'wx'});
    const actions=actionsFor(catalogData,preparedProfile);
    const sourceName=basename(source).replace(/\.model3\.json$/i,'');
    const sourceLabel=basename(dirname(source))+'/'+basename(source);
    const cover=inside(frozen.dir,'resources/cover.png');
    if(cover)await copyFile(cover,join(out,'models',id,'cover.png'));
    const resource:DirectModelResource={version:1,kind:'live2d-model',id,sourceId,sourceHash:data.sourceHash,title:data.title==='source'?sourceName:data.title,sourceLabel,cover:!!cover,entry:data.entry,appearance,actions,walk:data.walk,...(profile?.emotionEffect&&profile.emotionEffect!=='native'?{effectsReach:EMOTION_EFFECT_REACH}:{}),configuration:configurationOf(preparedProfile,actions)};
    await writeFile(join(out,'prepared-profile.json'),JSON.stringify(preparedProfile),{flag:'wx'});
    await writeFile(join(out,'model-resource.json'),JSON.stringify(resource),{flag:'wx'});
    await writeFile(join(out,'source-record.json'),JSON.stringify({version:1,provider:'direct-live2d',sourceId,modelFile:source,catalogFingerprint:catalog.fingerprint}),{flag:'wx'});
    const sourceDir=join(root,'sources',sourceId);await mkdir(sourceDir,{recursive:true});
    await writeFile(join(sourceDir,'source.json'),JSON.stringify({version:1,sourceId,modelFile:source}),{flag:'wx'})
     .catch((error:NodeJS.ErrnoException)=>{if(error.code!=='EEXIST')throw error;});
    signal.throwIfAborted();const target=join(directory,id);await rename(out,target);
    return{id,sourceId,directory:target};
   }finally{preparing=false;if(scratch&&resolve(scratch).startsWith(resolve(work)+sep))await rm(scratch,{recursive:true,force:true});}
  },
 };
 return service;
}
