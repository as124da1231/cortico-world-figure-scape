import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { fileURLToPath } from 'node:url';
import { createFigureLibrary } from '../src/framework/figure-library.ts';
import { createModelDomain } from '../src/framework/model-domain.ts';
import { createResourceConsole } from '../src/framework/resources-console.ts';
import { createModelIntake } from '../src/live2d/model-intake.ts';
import { PetServer } from '../src/server.ts';
// @ts-expect-error Same browser geometry used by the sandbox.
import { createFigureTouch } from '../web/framework/figure-touch.js';

const encode = (text: string) => new TextEncoder().encode(text);
const manifest = {
  manifest: 2, api: 2, id: 'image-pet', name: { zh: '图片身体' }, about: { zh: '非 Live2D 的测试形象' },
  entry: 'body.mjs', export: 'render', model: 'author.json', can: { walk: false },
  axes: [{ id:'dress', name:{zh:'装扮'}, options:[{id:'base',name:{zh:'默认'}},{id:'blue',name:{zh:'蓝色'}}] }],
  presets: [], vocab: [{ id:'nod', kind:'motion', names:{zh:['点头']}, about:{zh:'点头回应'}, seconds:1 }],
};

describe('figure packages in the direct library', () => {
  it('reuses the imported identity for a bundled figure and keeps user settings separate', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'figure-bundled-'));
    try {
      const packaged = join(temp, 'pack'), directory = join(temp, 'library');
      await mkdir(packaged);
      await writeFile(join(packaged,'figure.json'), JSON.stringify(manifest));
      const model = join(packaged,'author.json'), original = '{"pose":"author"}';
      await writeFile(model, original);
      await writeFile(join(packaged,'body.mjs'),'export function render() {}');
      const imported = createFigureLibrary(directory);
      const id = await imported.prepare(join(packaged, 'figure.json'), new AbortController().signal);
      await imported.save(id,{scheme:'blue'});

      const library = createFigureLibrary(directory,{id,directory:packaged});
      expect(library.list()).toMatchObject([{id,builtin:true,dir:packaged}]);
      expect(library.asset(id,'author.json')).toBe(model);
      expect(library.asset(id,'../library')).toBeNull();
      expect(library.settings(id)).toEqual({scheme:'blue'});
      await expect(library.remove(id,[])).rejects.toThrow('内置形象包');
      await expect(library.prepare(join(packaged,'figure.json'),new AbortController().signal)).resolves.toBe(id);
      expect(library.list()).toHaveLength(1);
      expect(await readFile(model,'utf8')).toBe(original);
    } finally { await rm(temp,{recursive:true,force:true}); }
  });

  it('imports directories and ZIPs under one identity and keeps author files byte-for-byte', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'figure-library-'));
    const directory = join(temp,'original');
    const files = {
      'figure.json': encode(JSON.stringify(manifest)),
      'body.mjs': encode('export function render() {}'),
      'author.json': encode('{"pose":"authors-choice"}'),
    };
    try {
      await mkdir(directory);
      await Promise.all(Object.entries(files).map(([name, bytes]) => writeFile(join(directory,name),bytes)));
      const library = createFigureLibrary(join(temp,'library'));
      const intake = createModelIntake(join(temp,'uploads'));
      const model = createModelDomain({
        selected: () => 'current', available: () => true, prepare: library.prepare,
        load: vi.fn(), applied: () => false, commit: vi.fn(),
      });
      const resources = createResourceConsole({
        intake, protectedModels: () => ['current'], modelBusy: () => model.snapshot().busy,
        open: model.open, importModel: model.import, unknownMethod: method => method,
      });
      const source = (await intake.importPaths([directory])).models[0]!;
      expect(source.kind).toBe('figure');
      const imported = await resources('resources.importCandidate', [source.id]);
      expect(imported).toMatchObject({ candidate: expect.stringMatching(/^figure-[a-f0-9]{24}$/), applied: false });
      const id = library.list()[0]!.id;
      const archive = (await intake.importUpload('zip',zipSync(files))).models[0]!;
      expect(await resources('resources.importCandidate', [archive.id])).toMatchObject({ candidate: id });
      expect(model.snapshot().selected).toBe('current');
      expect(library.settings(id)).toEqual({});
      expect(await readFile(library.asset(id,'author.json')!)).toEqual(Buffer.from(files['author.json']));
      const originalRevision = library.revisionOf(library.settings(id));
      await library.save(id,{scheme:'blue'}, originalRevision);
      const libraryAfterRestart = createFigureLibrary(join(temp,'library'));
      expect(libraryAfterRestart.settings(id)).toEqual({scheme:'blue'});
      expect(await readFile(join(directory,'author.json'))).toEqual(Buffer.from(files['author.json']));
      expect(libraryAfterRestart.asset(id,'../profiles/'+id+'.json')).toBeNull();

      const server = new PetServer({
        port:()=>0,webDir:fileURLToPath(new URL('../web',import.meta.url)),snapshot:()=>({}),
        packs:libraryAfterRestart.list,figureAsset:libraryAfterRestart.asset,figureSettings:libraryAfterRestart.settings,
        onPetMessage(){},onAudio(){},onPetConnect(){},onPetDisconnect(){},onSkin(){},onPrefs(){},looks(){return []},onLooks(){},
      });
      try {
        await server.start();
        const descriptor = await fetch(server.origin + '/api/bodies/' + id).then(response => response.json());
        expect(descriptor).toMatchObject({kind:'figure-pack',entry:'body.mjs',model:'author.json',figureSettings:{scheme:'blue'}});
        expect(JSON.stringify(descriptor)).not.toContain(directory);
        const frame=await fetch(server.origin+'/model-frame?model='+id);
        expect(frame.headers.get('content-security-policy')).toContain('/figure-assets/'+id+'/');
        const entry=await fetch(server.origin+descriptor.base+descriptor.entry,{headers:{origin:'null'}});
        expect(entry.status).toBe(200);
        expect(entry.headers.get('access-control-allow-origin')).toBe('null');
        expect((await fetch(server.origin+'/api/bodies/'+id,{headers:{origin:'null'}})).status).toBe(403);
      } finally { await server.stop(); }
      await expect(libraryAfterRestart.save(id, { scheme: null }, originalRevision)).rejects.toThrow('角色配置已更新');
      expect(libraryAfterRestart.settings(id)).toEqual({scheme:'blue'});
      const changedRevision = libraryAfterRestart.revisionOf(libraryAfterRestart.settings(id));
      await libraryAfterRestart.save(id, { scheme: null, touch: null }, changedRevision);
      expect(libraryAfterRestart.settings(id)).toEqual({});
      expect(libraryAfterRestart.revisionOf(libraryAfterRestart.settings(id))).toBe(originalRevision);
      expect(await readFile(libraryAfterRestart.asset(id,'author.json')!)).toEqual(Buffer.from(files['author.json']));
      await libraryAfterRestart.remove(id,[]);
      expect(libraryAfterRestart.find(id)).toBeNull();
      expect(await readFile(join(directory,'figure.json'))).toEqual(Buffer.from(files['figure.json']));
    } finally { await rm(temp, {recursive:true,force:true}); }
  });

  it('adds a touch action for a silent figure while leaving an unconfigured figure alone', () => {
    const box = {x:0,y:0,w:100,h:100};
    const body = {layout:()=>({box,hit:[{x:50,y:50,r:50}]}),do:vi.fn(),pointer:vi.fn()};
    const emitted=vi.fn();
    const baseline=createFigureTouch(undefined,['nod'],body);
    baseline.input('down',{x:50,y:20},emitted);
    baseline.input('up',{x:50,y:20},emitted);
    expect(emitted).not.toHaveBeenCalled();
    expect(body.do).not.toHaveBeenCalled();

    const customized = createFigureTouch({areas:[],rules:[{gesture:'poke',area:'head',reaction:'action',send:'next',action:{word:'nod'}}]},['nod'],body);
    customized.input('down',{x:50,y:20},emitted);
    customized.input('up',{x:50,y:20},(kind:string, event:unknown)=>emitted(kind,customized.event(kind,event)));
    expect(body.do).toHaveBeenCalledExactlyOnceWith('nod');
    expect(emitted).toHaveBeenCalledWith('touch',{kind:'poke',region:'head',reaction:'played'});
  });
});
