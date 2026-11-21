import { describe, expect, it, vi } from 'vitest';
import { assertTouchAreaChange, readTouchProfile, resolvedTouchAreas, touchArea, touchRegionAt, touchRule, touchScreen } from '../web/framework/touch-geometry.js';
import { createEditorBackend, EditorDraftConflict } from '../src/framework/editor-backend.ts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const a = {id:'ear',name:'耳朵',shape:{kind:'ellipse',center:{x:.2,y:.18},radius:{x:.13,y:.09}}};
const b = {id:'edge',name:'边缘',shape:{kind:'polygon',points:[{x:.08,y:.10},{x:.4,y:.10},{x:.14,y:.4}]}};

describe('model touch', () => {
  it('uses authored priority, mirror and model-space coordinates', () => {
    const profile=readTouchProfile({areas:[a,b],rules:[]});
    const frame={origin:{x:600,y:70},x:{x:-300,y:20},y:{x:20,y:410}};
    const hit=touchScreen(frame,{x:.2,y:.18});
    expect(touchArea(profile,frame,hit)?.id).toBe('ear');
    expect(touchArea({...profile,areas:[...profile.areas].reverse()},frame,hit)?.id).toBe('edge');
    expect(touchArea(profile,frame,touchScreen(frame,{x:.7,y:.18}))).toBeUndefined();
  });
  it('prevents new overlaps with defaults, moved built-ins and contained regions', () => {
    const home = { origin: {x:400,y:100}, x:{x:-200,y:0}, y:{x:0,y:550} };
    const head = { id:'head', name:'头部', shape:{ kind:'ellipse' as const, center:{x:.5,y:.16}, radius:{x:.1,y:.1} } };
    const ear = readTouchProfile({areas:[a],rules:[]}).areas[0];
    expect(() => assertTouchAreaChange([ear])).toThrow('头部');
    expect(() => assertTouchAreaChange([head, ear])).not.toThrow();
    const profile = readTouchProfile({areas:[head, ear],rules:[{gesture:'poke',area:'head',reaction:'none',send:'local'}]});
    const hit = (x: number, y: number) => touchRegionAt(profile, home, null, touchScreen(home, {x,y}));
    expect(hit(.5,.15)).toBe('head');
    expect(hit(.2,.18)).toBe('ear');
    expect(hit(.9,.15)).toBeUndefined();
    expect(hit(.5,.32)).toBe('body');
    expect(() => assertTouchAreaChange([ear], [head, ear])).toThrow('头部');
    expect(() => assertTouchAreaChange([head, ear, {...ear,id:'inside'}])).toThrow('重叠');
    expect(() => assertTouchAreaChange([ear], [ear])).not.toThrow();
  });

  it('accepts shared edges and rejects shared interiors of polygon outlines', () => {
    const head = resolvedTouchAreas().find(area => area.id === 'head')!;
    const shape = (...points: Array<[number,number]>) => ({kind:'polygon' as const,points:points.map(([x,y])=>({x,y}))});
    const left = { ...head, shape: shape([0,0],[.5,0],[.5,.32],[0,.32]) };
    const right = { id:'right', name:'Right', shape:shape([.5,0],[1,0],[1,.32],[.5,.32]) };
    expect(() => assertTouchAreaChange([left,right])).not.toThrow();
    const covering = { ...right, shape:shape([.45,0],[1,0],[1,.32],[.45,.32]) };
    expect(() => assertTouchAreaChange([left,covering])).toThrow('重叠');
  });

  it('keeps independent part descriptions and rejects invalid outlines on edit', () => {
    const profile = readTouchProfile({ areas:[], rules:[], areaNotes:{ head:'  刘海  ' } });
    expect(profile).toEqual({areas:[],rules:[],areaNotes:{head:'刘海'}});
    expect(() => readTouchProfile({...profile,areaNotes:{leg:'Unknown'}})).toThrow('部位说明');
    const crossed = { id:'head', name:'头部', shape:{kind:'polygon' as const, points:[
      {x:.1,y:.02}, {x:.3,y:.26}, {x:.35,y:.04}, {x:.05,y:.18},
    ]} };
    expect(() => assertTouchAreaChange([crossed])).toThrow('不能交叉');
  });

  it('prefers matched rules, falls back to the gesture-wide rule and validates references', () => {
    const profile=readTouchProfile({areas:[a],rules:[
      {gesture:'poke',area:'all',reaction:'default',send:'inherit'},
      {gesture:'poke',area:'ear',reaction:'none',send:'local'},
    ]});
    expect(touchRule(profile,'poke','ear')).toMatchObject({send:'local',reaction:'none'});
    expect(touchRule(profile,'poke','head')).toMatchObject({send:'inherit',reaction:'default'});
    expect(()=>readTouchProfile({...profile,areas:[]})).toThrow();
    expect(()=>readTouchProfile({...profile,areas:[a,a]})).toThrow();
  });
});

it('separates per-source editor drafts from the committed profile across editor restarts', async () => {
  const directory=await mkdtemp(join(tmpdir(),'live2d-editor-'));
  const editor=vi.fn(async (figure: unknown)=> ({figure:String(figure),editor:{sourceId:String(figure),revision:'r1',catalogFingerprint:'f1'}}));
  const model={editor,save:vi.fn(async()=>({saved:true,applied:false})),applySaved:vi.fn(),snapshot:vi.fn(),operation:vi.fn(),previewParameters:vi.fn()};
  try {
    let service=createEditorBackend(model as never,()=>directory);
    await service.invoke('modelEditor',['model-a']);
    const aVersion = randomUUID(), bVersion = randomUUID();
    await service.invoke('edit.updateDraft',['model-a',{fit:{zoom:1.4}},'r1','f1',null,aVersion]);
    await service.invoke('modelEditor',['model-b']);
    await service.invoke('edit.updateDraft',['model-b',{fit:{zoom:1.2}},'r1','f1',null,bVersion]);
    service=createEditorBackend(model as never,()=>directory);
    expect(await service.invoke('modelEditor',['model-a'])).toMatchObject({draft:{profile:{fit:{zoom:1.4}}}});
    expect(await service.invoke('modelEditor',['model-b'])).toMatchObject({draft:{profile:{fit:{zoom:1.2}}}});
    await service.invoke('saveLibraryModel',['model-a',{fit:{zoom:1.4}},'r1','f1','save',aVersion]);
    expect(await service.invoke('modelEditor',['model-a'])).toMatchObject({draft:null});
    expect(await service.invoke('modelEditor',['model-b'])).toMatchObject({draft:{profile:{fit:{zoom:1.2}}}});
    expect(model.save).toHaveBeenCalledTimes(1);

    model.operation.mockReturnValueOnce(null).mockReturnValue({saved:true,applied:false,revision:'r2'});
    model.save.mockRejectedValueOnce(Error('Application interrupted'));
    await expect(service.invoke('saveLibraryModel',['model-b',{fit:{zoom:1.2}},'r1','f1','second-save',bVersion])).rejects.toThrow('Application interrupted');
    expect(await service.invoke('operation.get',['second-save'])).toMatchObject({saved:true,applied:false,revision:'r2'});
    expect(await service.invoke('modelEditor',['model-b'])).toMatchObject({draft:null});
  } finally {
    // Only removes the private directory returned by mkdtemp.
    await rm(directory,{recursive:true,force:true});
  }
});

it('compares per-source draft versions before writing, saving or clearing beyond the owning tab', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scape-editor-versions-'));
  const editor = async () => ({figure:'model',editor:{sourceId:'model',revision:'r1',catalogFingerprint:'f1'}});
  const model = {editor,operation:vi.fn(),save:vi.fn()};
  try {
    const original = {revision:'r1',catalogFingerprint:'f1',profile:{fit:{zoom:1.1}}};
    await writeFile(join(directory,'model.json'),JSON.stringify(original));
    const service = createEditorBackend(model as never, () => directory);
    const first = await service.invoke('character.open',['model']) as {draftVersion:string};
    const second = await service.invoke('character.open',['model']) as {draftVersion:string};
    expect(first.draftVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(second.draftVersion).toBe(first.draftVersion);
    const written = randomUUID(), edit = {fit:{zoom:1.4}};
    const args = ['model',edit,'r1','f1',first.draftVersion,written];
    await expect(service.invoke('edit.updateDraft',args)).resolves.toMatchObject({draftVersion:written});
    await expect(service.invoke('edit.updateDraft',args)).resolves.toMatchObject({draftVersion:written});
    const newer = randomUUID(), otherEdit = {fit:{zoom:1.8}};
    await expect(service.invoke('edit.updateDraft',['model',otherEdit,'r1','f1',second.draftVersion,newer])).rejects.toBeInstanceOf(EditorDraftConflict);
    await expect(service.invoke('edit.clearDraft',['model',second.draftVersion])).rejects.toBeInstanceOf(EditorDraftConflict);
    await expect(service.invoke('saveLibraryModel',['model',otherEdit,'r1','f1','stale-save',second.draftVersion])).rejects.toBeInstanceOf(EditorDraftConflict);
    expect(model.save).not.toHaveBeenCalled();
    await expect(service.invoke('character.open',['model'])).resolves.toMatchObject({draftVersion:written,draft:{profile:edit}});
    await expect(service.invoke('edit.updateDraft',['model',otherEdit,'r1','f1',written,newer])).resolves.toMatchObject({draftVersion:newer});
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
});

it('accepts the JSON null placeholder for a packaged draft with no native catalog', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scape-package-draft-'));
  const character = {id:'figure-test',sourceId:'figure-test',kind:'figure-pack'};
  const figures = {read:()=>({character,revision:'r1'})};
  const backend = createEditorBackend({} as never, () => directory, undefined, figures as never);
  try {
    await backend.invoke('character.open',[character.id]);
    const write = randomUUID();
    const draft = {visual:{hue:35,brightness:.8}};
    await expect(backend.invoke('edit.updateDraft',[character.id,draft,'r1',null,null,write])).resolves.toEqual({retained:true,draftVersion:write});
    await expect(backend.invoke('character.open',[character.id])).resolves.toMatchObject({draft:{profile:draft},draftVersion:write});
  } finally { await rm(directory,{recursive:true,force:true}); }
});
