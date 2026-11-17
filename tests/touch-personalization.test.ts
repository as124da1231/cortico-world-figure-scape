import { describe, expect, it, vi } from 'vitest';
import { assertTouchAreaChange, readTouchProfile, resolvedTouchAreas, touchArea, touchRegionAt, touchRule, touchScreen } from '../web/framework/touch-geometry.js';
import { createEditorBackend } from '../src/framework/editor-backend.ts';
import { mkdtemp, rm } from 'node:fs/promises';
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
    await service.invoke('edit.updateDraft',['model-a',{fit:{zoom:1.4}},'r1','f1']);
    await service.invoke('modelEditor',['model-b']);
    await service.invoke('edit.updateDraft',['model-b',{fit:{zoom:1.2}},'r1','f1']);
    service=createEditorBackend(model as never,()=>directory);
    expect(await service.invoke('modelEditor',['model-a'])).toMatchObject({draft:{profile:{fit:{zoom:1.4}}}});
    expect(await service.invoke('modelEditor',['model-b'])).toMatchObject({draft:{profile:{fit:{zoom:1.2}}}});
    await service.invoke('saveLibraryModel',['model-a',{fit:{zoom:1.4}},'r1','f1','save']);
    expect(await service.invoke('modelEditor',['model-a'])).toMatchObject({draft:null});
    expect(await service.invoke('modelEditor',['model-b'])).toMatchObject({draft:{profile:{fit:{zoom:1.2}}}});
    expect(model.save).toHaveBeenCalledTimes(1);

    model.operation.mockReturnValueOnce(null).mockReturnValue({saved:true,applied:false,revision:'r2'});
    model.save.mockRejectedValueOnce(Error('Application interrupted'));
    await expect(service.invoke('saveLibraryModel',['model-b',{fit:{zoom:1.2}},'r1','f1','second-save'])).rejects.toThrow('Application interrupted');
    expect(await service.invoke('operation.get',['second-save'])).toMatchObject({saved:true,applied:false,revision:'r2'});
    expect(await service.invoke('modelEditor',['model-b'])).toMatchObject({draft:null});
  } finally {
    // Only removes the private directory returned by mkdtemp.
    await rm(directory,{recursive:true,force:true});
  }
});
