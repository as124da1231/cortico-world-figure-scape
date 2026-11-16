import {afterEach,expect,it} from 'vitest';
import {cp,mkdtemp,mkdir,writeFile,readFile,readdir,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createDirectModelService} from '../src/live2d/direct-model-service.ts';
import {modelForCoo} from '../src/live2d/coo-resource-adapter.ts';
import {PetServer} from '../src/server.ts';
it('reuses a library generation on selection, preserves source identity and only rebuilds for structural edits', async () => {
 const f = await fixture(), signal = new AbortController().signal;
 const first = await f.service.prepare(f.file, signal);
 const duplicate = await f.service.prepare(f.file, signal);
 const otherFolder = join(f.root, 'other');
 await cp(f.model, otherFolder, { recursive: true });
 const other = await f.service.prepare(join(otherFolder, 'test.model3.json'), signal);
 expect(f.service.libraryModels!(first.id).map(model => model.id).sort()).toEqual([first.id, other.id].sort());
 await rename(f.model, join(f.root, 'temporarily-unavailable'));
 for (let i = 0; i < 3; i++) await expect(f.service.resolveLibraryModel!(first.id, signal)).resolves.toBe(first.id);
 expect(await readdir(f.service.modelDirectory)).toHaveLength(3);
 await rename(join(f.root, 'temporarily-unavailable'), f.model);
 const imported = await f.service.prepare(f.file, signal, { librarySelection: first.id });
 expect(imported.id).toBe(first.id);
 const editor = (await f.service.editor!(duplicate.id))!;
 const fitted = await f.service.saveProfile!(duplicate.id, { ...editor.profile,
  fit: { ...editor.profile.fit, zoom: 1.2 },
 }, editor.revision);
 await expect(f.service.resolveLibraryModel!(duplicate.id, signal)).resolves.toBe(duplicate.id);
 expect(f.service.directModel!(duplicate.id)?.configuration?.revision).toBe(fitted.revision);
 expect(await readdir(f.service.modelDirectory)).toHaveLength(3);
 await f.service.saveProfile!(duplicate.id, { ...fitted.profile, motion: { kind: 'stand' } }, fitted.revision);
 const replacement = await f.service.resolveLibraryModel!(duplicate.id, signal);
 expect(replacement).not.toBe(duplicate.id);
 expect(f.service.libraryModels!(replacement).map(model => model.id).sort()).toEqual([other.id, replacement].sort());
 await expect(f.service.removeModel!(replacement, [first.id])).rejects.toThrow('Select another');
 await f.service.removeModel!(replacement, []);
 expect(f.service.libraryModels!('').map(model => model.id)).toEqual([other.id]);
 const reimported = await f.service.prepare(f.file, signal, { librarySelection: 'coo' });
 expect(reimported.id).not.toBe(replacement);
 expect(f.service.directModels!().map(model => model.id).sort()).toEqual([other.id, reimported.id].sort());
 expect(f.service.cacheState!([])).toMatchObject({ prunable: expect.arrayContaining([first.id, duplicate.id, replacement]) });
}, 30000);
const directories:string[]=[],servers:PetServer[]=[];
afterEach(async()=>{for(const s of servers.splice(0))await s.stop();for(const d of directories.splice(0))await rm(d,{recursive:true,force:true});});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'direct-model-'));directories.push(root);const model=join(root,'source'),sdk=join(root,'sdk');await mkdir(model);await mkdir(sdk);
 const moc=Buffer.alloc(64);moc.write('MOC3');await writeFile(join(model,'test.moc3'),moc);
 await writeFile(join(model,'texture.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
 const file=join(model,'test.model3.json');await writeFile(file,JSON.stringify({Version:3,FileReferences:{Moc:'test.moc3',Textures:['texture.png']}}));
 await writeFile(join(model,'smile.exp3.json'),JSON.stringify({Parameters:[{Id:'ParamEyeSmile',Value:1,Blend:'Overwrite'}]}));
 for(const f of ['live2dcubismcore.min.js','framework.js','shaders.js'])await writeFile(join(sdk,f),'// test-only SDK');
 const options={dataDir:root,sdkProvider:async()=>sdk};return{root,model,file,options,service:createDirectModelService(options)};
}
it('prepares immutable data without an installable manifest, carries source configuration across revisions and directly serves the body',async()=>{
 const f=await fixture(),signal=new AbortController().signal;
 const old=await f.service.prepare(f.file,signal),oldEditor=(await f.service.editor!(old.id))!;
 const saved=await f.service.saveProfile!(old.id,{...oldEditor.profile,fit:{...oldEditor.profile.fit,zoom:1.23},bindings:[{word:'happy',resource:oldEditor.catalog!.resources[0].id}]},oldEditor.revision,oldEditor.catalogFingerprint);
 const model=await f.service.prepare(f.file,signal),files=await readdir(model.directory);
 expect(files).not.toContain('figure.json');expect(files).not.toContain('figure.js');expect(files).not.toContain('sdk');expect(files).not.toContain('backends');
 expect(model.sourceId).toBe(old.sourceId);const editor=(await f.service.editor!(model.id))!;expect(editor.profile).toEqual(saved.profile);
 const resource=f.service.directModels!().find(r=>r.id===model.id)!;expect(resource.kind).toBe('live2d-model');expect(resource.actions.some(a=>a.id==='happy')).toBe(true);
 expect(await readFile(join(model.directory,'models',model.id,'profile.js'),'utf8')).toContain('"zoom":1.23');
 const server=new PetServer({port:()=>0,webDir:fileURLToPath(new URL('../web/',import.meta.url)),models:f.service,packs:()=>[modelForCoo(resource)],snapshot:()=>({}),onPetMessage(){},onAudio(){},onPetConnect(){},onPetDisconnect(){},onSkin(){},onPrefs(){},looks:()=>[],onLooks(){}});servers.push(server);await server.start();
 expect((await fetch(server.origin+'/api/figures')).status).toBe(404);
 const descriptor=await(await fetch(server.origin+'/api/bodies/'+model.id)).json() as any;expect(descriptor.kind).toBe('live2d-model');expect(descriptor.entry).toBe('');expect(JSON.stringify(descriptor)).not.toContain(f.root);
 const frame=await fetch(server.origin+'/model-frame?model='+model.id);expect(frame.status).toBe(200);expect(frame.headers.get('content-security-policy')).toContain('/model-assets/'+model.id+'/');
 expect((await fetch(server.origin+'/model-assets/'+model.id+'/models/'+model.id+'/profile.js',{headers:{Origin:'null'}})).headers.get('access-control-allow-origin')).toBe('null');
 expect((await fetch(server.origin+'/model-assets/'+model.id+'/source-record.json')).status).toBe(404);
 expect((await fetch(server.origin+'/packs/'+model.id+'/model-resource.json')).status).toBe(404);
 expect(f.service.directAsset!(model.id,'models/../../source-record.json')).toBeNull();
 expect(f.service.runtimeAsset!('sdk/../source-record.json')).toBeNull();
 expect((await fetch(server.origin+'/model-runtime/backends/live2d.js',{headers:{Origin:'null'}})).status).toBe(200);
 const edited=await f.service.saveProfile!(model.id,{...editor.profile,gaze:{enabled:false,speed:.7}},editor.revision,editor.catalogFingerprint);
 const configuration=await f.service.prepareConfiguration!(model.id,edited);
 expect(configuration).toMatchObject({revision:edited.revision,gaze:{enabled:false,speed:.7}});
 expect(createDirectModelService(f.options).directModels!().find(r=>r.id===model.id)?.configuration).toEqual(configuration);
 expect(f.service.directModels!().map(r=>r.id).sort()).toEqual([old.id,model.id].sort());
 expect(await readFile(join(model.directory,'models',model.id,'profile.js'),'utf8')).not.toContain('"enabled":false');
 expect(await f.service.prepareConfiguration!(model.id,{...edited,profile:{...edited.profile,motion:{kind:'stand'}}})).toBeNull();
 expect(await f.service.prepareConfiguration!(model.id,{...edited,loadedCatalogFingerprint:'changed'})).toBeNull();
 expect(await f.service.prepareConfiguration!(model.id,{...edited,profile:{...edited.profile,wardrobe:[],mouth:{mode:'auto',targets:[]}}})).not.toBeNull();
 expect((await fetch(server.origin+'/model-assets/'+model.id+'/configuration.json')).status).toBe(404);
 const next=await f.service.prepare(f.file,signal);expect(next.id).not.toBe(model.id);expect((await f.service.editor!(next.id))!.revision).toBe(edited.revision);
 expect(await readFile(join(model.directory,'models',model.id,'profile.js'),'utf8')).not.toContain('"enabled":false');
},30000);
it('rejects bad source assets and cancellation without publishing a candidate',async()=>{
 const f=await fixture(),signal=new AbortController().signal;
 await writeFile(join(f.model,'texture.png'),'not a texture');await expect(f.service.prepare(f.file,signal)).rejects.toThrow('贴图');expect(f.service.directModels!()).toEqual([]);
 const controller=new AbortController();controller.abort();await expect(f.service.prepare(f.file,controller.signal)).rejects.toThrow();expect(f.service.directModels!()).toEqual([]);
});
it('updates combinations and motion vocabulary on the same resource and preserves the last save on conflict',async()=>{
 const f=await fixture();
 for(const [name,param,value]of [['loading','Loading',1],['eyes','Eyes',1],['closed','Eyes',0]] as const){
  await writeFile(join(f.model,name+'.exp3.json'),JSON.stringify({Parameters:[{Id:param,Value:value,Blend:'Overwrite'}]}));
 }
 await writeFile(join(f.model,'cheer.motion3.json'),JSON.stringify({Meta:{Duration:2},Curves:[{Id:'Arm',Target:'Parameter',Segments:[0,0,0,1,1,0,2,0]}]}));
 const model=await f.service.prepare(f.file,new AbortController().signal),editor=(await f.service.editor!(model.id))!;
 const id=(title:string)=>editor.catalog!.resources.find(r=>r.title===title)!.id;
 const saved=await f.service.saveProfile!(model.id,{...editor.profile,bindings:[{word:'happy',resource:id('loading'),overlays:[id('eyes')]},{word:'cheer',resource:id('cheer')},{word:'surprised',resource:id('cheer')}]},editor.revision,editor.catalogFingerprint);
 const configuration=await f.service.prepareConfiguration!(model.id,saved);
 expect(configuration?.bindings?.[0].overlays).toEqual([id('eyes')]);
 expect(configuration?.actions).toContainEqual(expect.objectContaining({id:'cheer',kind:'motion',seconds:2.25}));
 expect(configuration?.actions).toContainEqual(expect.objectContaining({id:'surprised',kind:'motion',seconds:2.25}));
 expect(f.service.directModels!()).toHaveLength(1);expect(f.service.directModels!()[0].actions).toEqual(configuration!.actions);
 // A fresh candidate with an already saved combination must keep the v2 native
 // catalogue, not only its bindings in the live configuration descriptor.
 const reopened=await f.service.prepare(f.file,new AbortController().signal);
 const generated=await readFile(join(reopened.directory,'models',reopened.id,'profile.js'),'utf8');
 expect(generated).toContain('native: {"version":2');
 expect(generated).toContain('"overlays":["'+id('eyes')+'"]');
 expect(generated).toContain('"resources":[');
 await expect(f.service.saveProfile!(model.id,{...saved.profile,bindings:[{word:'happy',resource:id('eyes'),overlays:[id('closed')]}]},saved.revision,saved.catalogFingerprint)).rejects.toMatchObject({ detail: { parameter: expect.any(String), incoming: { id: id('closed') }, existing: { id: id('eyes') } } });
 expect((await f.service.editor!(model.id))!.revision).toBe(saved.revision);
 const cleared=await f.service.saveProfile!(model.id,{...saved.profile,bindings:[]},saved.revision,saved.catalogFingerprint);
 const empty=await f.service.prepareConfiguration!(model.id,cleared);
 expect(empty!.actions!.some(word=>word.id==='cheer')).toBe(false);expect(empty!.bindings).toEqual([]);
 expect(createDirectModelService(f.options).directModels!().find(r=>r.id===model.id)!.configuration).toEqual(empty);
},30000);

it('stages BongoCat keyboard artwork as direct model data', async () => {
 const f = await fixture();
 const keys = join(f.model, 'resources', 'left-keys');
 await mkdir(keys, { recursive: true });
 const artwork = await readFile(join(f.model, 'texture.png'));
 await writeFile(join(keys, 'a.png'), artwork);
 await writeFile(join(f.model, 'resources', 'cover.png'), artwork);
 const result = await f.service.prepare(f.file, new AbortController().signal);
 const source = await readFile(join(result.directory, 'models', result.id, 'profile.js'), 'utf8');
 expect(source).toContain('"file":"bongo/left-keys/a.png"');
 expect(f.service.directAsset!(result.id, 'models/' + result.id + '/bongo/left-keys/a.png')).toBeTruthy();
 expect(f.service.directModels!()[0]).toMatchObject({walk:false,cover:true,sourceLabel:'source/test.model3.json',title:'test'});
 expect(await readFile(f.service.directAsset!(result.id, 'models/' + result.id + '/cover.png')!)).toEqual(artwork);
 expect(await readdir(result.directory)).not.toContain('figure.json');
});

it('saves an adaptation to the original source with no prepared body or artifact', async () => {
 const f = await fixture();
 const source = await f.service.source!(f.file);
 const bindings = [{ word: 'happy', resource: source.catalog!.resources[0].id }];
 const fingerprint = source.catalogFingerprint!;
 await expect(f.service.saveSourceProfile!(f.file, bindings, 'stale', fingerprint)).rejects.toThrow('Profile changed');
 const saved = await f.service.saveSourceProfile!(f.file, bindings, source.revision, fingerprint);
 expect(saved.profile.bindings).toEqual([expect.objectContaining(bindings[0])]);
 expect(f.service.directModels!()).toEqual([]);
 const prepared = await f.service.prepare(f.file, new AbortController().signal);
 expect((await f.service.editor!(prepared.id))?.revision).toBe(saved.revision);
 expect(f.service.directModels!()[0].actions.some(action => action.id === 'happy')).toBe(true);
});

it('protects active and preview-referenced revisions and prunes only removed cache', async () => {
 const f = await fixture(), model = await f.service.prepare(f.file, new AbortController().signal);
 const editor = (await f.service.editor!(model.id))!;
 const saved = await f.service.saveProfile!(model.id, { ...editor.profile, visual: { hue: 30, brightness: 1.1 } }, editor.revision);
 expect(await f.service.prepareConfiguration!(model.id, saved)).toMatchObject({ visual: { hue: 30, brightness: 1.1 } });
 await expect(f.service.removeModel!(model.id, [model.id])).rejects.toThrow('Select another');
 const release = f.service.retainPreview!(model.id)!;
 await f.service.removeModel!(model.id, []);
 expect(f.service.directModels!()).toEqual([]);
 expect(f.service.retainPreview!(model.id)).toBeNull();
 expect(await f.service.pruneCache!([])).toMatchObject({ deleted: [], prunable: [] });
 release();
 expect(await f.service.pruneCache!([])).toMatchObject({ deleted: [model.id], failed: [] });
 expect(f.service.hasModel!(model.id)).toBe(false);
 expect(await readFile(f.file, 'utf8')).toContain('Moc');
 expect((await f.service.source!(f.file)).revision).toBe(saved.revision);
});
