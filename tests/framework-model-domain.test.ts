import { describe, expect, it, vi } from 'vitest';
import { createModelDomain } from '../src/framework/model-domain.ts';
function setup(behavior?:()=>unknown) {
 let selected='old';
 const editor={sourceId:'source',modelFile:'source.model3.json',profile:{} as any,saved:false,revision:'r1'};
 const resources={provider:'embedded-figure' as const,modelDirectory:'models',prepare:vi.fn(async(_file:string,_signal:AbortSignal)=>({id:'new',sourceId:'source',directory:'models/new'})),editor:vi.fn(async()=>editor),saveProfile:vi.fn(async()=>({...editor,saved:true,revision:'r2'}))};
 const load=vi.fn(async()=>({ok:true})),commit=vi.fn((id:string)=>{selected=id;});
 const model=createModelDomain({behavior,resources,selected:()=>selected,available:()=>true,prepare:async(file,signal)=>(await resources.prepare(file,signal)).id,load,applied:r=>r?.ok===true,commit});
 return {model,resources,load,commit,select:(value:string)=>{selected=value;}};
}
describe('framework model domain',()=>{
 it('imports and saves a library model without changing the active body',async()=>{
  const f=setup();
  expect(await f.model.import('source.model3.json')).toMatchObject({candidate:'new',phase:'completed',applied:false});
  expect(await f.model.editor('new')).toMatchObject({figure:'new',active:false});
  expect(await f.model.save('new',{version:1},'r1',undefined,undefined,true)).toMatchObject({saved:true,applied:false});
  expect(f.resources.saveProfile).toHaveBeenCalledWith('new',{version:1},'r1');
  expect(f.load).not.toHaveBeenCalled();
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.model.snapshot().selected).toBe('old');
 });
 it('reserves the operation before inspecting saved model metadata',async()=>{
  const f=setup();let release!:(v:any)=>void;
  f.resources.editor.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
  const saving=f.model.save('old',{},'r1');await Promise.resolve();
  expect(f.model.snapshot()).toMatchObject({busy:true,phase:'saving'});
  await expect(f.model.open('source.model3.json')).rejects.toThrow('already loading');
  await expect(f.model.save('old',{},'r1')).rejects.toThrow('already loading');
  release({modelFile:'source.model3.json',profile:{}});await saving;
  expect(f.resources.saveProfile).toHaveBeenCalledOnce();
 });
 it('does not write a profile after stop during metadata inspection',async()=>{
  const f=setup();let release!:(v:any)=>void;
  f.resources.editor.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
  const failed=expect(f.model.save('old',{},'r1')).rejects.toThrow();await Promise.resolve();
  const stopped=f.model.stop();release({modelFile:'source.model3.json',profile:{}});
  await stopped;await failed;expect(f.resources.saveProfile).not.toHaveBeenCalled();expect(f.load).not.toHaveBeenCalled();
 });
 it('admits mouth mappings only from real unowned/current mouth parameters',async()=>{
  const f=setup(()=>({mouth:{parameters:[{id:'mouth',roles:['mouthOpen']},{id:'eye',roles:['eyeBallX']}]}}));
  await expect(f.model.save('old',{mouth:{mode:'mapped',targets:['missing']}},'r1')).rejects.toThrow('parameter catalogue');
  await expect(f.model.save('old',{mouth:{mode:'mapped',targets:['eye']}},'r1')).rejects.toThrow('another semantic role');
  expect(f.resources.saveProfile).not.toHaveBeenCalled();
  await f.model.save('old',{mouth:{mode:'mapped',targets:['mouth']}},'r1');expect(f.resources.saveProfile).toHaveBeenCalledOnce();
 });
 it('owns save, immutable preparation, first-frame application and commit order',async()=>{
  const f=setup();await f.model.save('old',{version:1},'r1','catalog');
  expect(f.resources.saveProfile).toHaveBeenCalledWith('old',{version:1},'r1','catalog');
  expect(f.resources.saveProfile.mock.invocationCallOrder[0]).toBeLessThan(f.resources.prepare.mock.invocationCallOrder[0]);
  expect(f.load.mock.invocationCallOrder[0]).toBeLessThan(f.commit.mock.invocationCallOrder[0]);
  expect(f.model.snapshot()).toMatchObject({phase:'completed',saved:true,applied:true,selected:'new',busy:false});
 });
 it('preserves a durable save when preparation/application fails and keeps old selection',async()=>{
  const f=setup();f.load.mockRejectedValue(new Error('no first frame'));
  await expect(f.model.save('old',{},'r1')).rejects.toThrow('no first frame');
  expect(f.model.snapshot()).toMatchObject({phase:'failed',saved:true,applied:false,selected:'old'});expect(f.commit).not.toHaveBeenCalled();
 });
 it('does not infer application when no window accepted the candidate',async()=>{
  const f=setup();f.load.mockResolvedValue(undefined as any);
  expect(await f.model.open('source.model3.json')).toMatchObject({applied:false});expect(f.commit).toHaveBeenCalledWith('new',undefined);
 });
 it('rejects stale selection and overlapping operations',async()=>{
  const f=setup();let release!:()=>void;
  f.resources.prepare.mockImplementation(async()=>{await new Promise<void>(r=>{release=r;});return{id:'new',sourceId:'source',directory:'models/new'};});
  const pending=f.model.open('source.model3.json');await Promise.resolve();
  await expect(f.model.open('source.model3.json')).rejects.toThrow('already loading');
  f.select('user-chosen');release();await expect(pending).rejects.toThrow('active model changed');
  expect(f.load).not.toHaveBeenCalled();expect(f.commit).not.toHaveBeenCalled();
 });
 it('correlates duplicate requests and cancels only the specified operation', async () => {
  const f = setup();
  f.resources.prepare.mockImplementation(async (_file, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const first = expect(f.model.open('source.model3.json', 'model-open')).rejects.toThrow();
  const retry = expect(f.model.open('source.model3.json', 'model-open')).rejects.toThrow();
  await expect(f.model.open('other.model3.json', 'model-open')).rejects.toThrow('different request');
  expect(f.model.operation('model-open')).toMatchObject({ operationId: 'model-open', phase: 'preparing' });
  expect(await f.model.cancel('other')).toBeNull();
  expect(await f.model.cancel('model-open')).toMatchObject({ phase: 'cancelled', applied: false });
  await Promise.all([first, retry]);
  expect(f.resources.prepare).toHaveBeenCalledOnce();
  expect(f.commit).not.toHaveBeenCalled();
 });
 it('cancels preparation at lifecycle stop and waits for cleanup',async()=>{
  const f=setup();f.resources.prepare.mockImplementation(async(_file,signal)=>new Promise<{id:string;sourceId:string;directory:string}>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')))));
  const pending=f.model.open('source.model3.json'),rejected=expect(pending).rejects.toThrow('cancelled');await Promise.resolve();
  await f.model.stop();await rejected;expect(f.model.snapshot()).toMatchObject({phase:'cancelled',busy:false});expect(f.commit).not.toHaveBeenCalled();
 });
});
