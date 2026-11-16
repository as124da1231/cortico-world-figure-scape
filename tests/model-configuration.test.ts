import {afterEach,describe,expect,it,vi} from 'vitest';
// @ts-expect-error Shared browser boundary.
import {applyModelConfiguration,createModelConfigurationState} from '../web/model-configuration-contract.js';
import {DEFAULT_MODEL_PROFILE} from '../src/live2d/model-profile.ts';
import {createModelApplication} from '../src/framework/model-application.ts';
import {createModelDomain} from '../src/framework/model-domain.ts';
import type {ModelConfiguration} from '../src/framework/model-contract.ts';
const configuration:ModelConfiguration={version:1,revision:'a'.repeat(64),fit:DEFAULT_MODEL_PROFILE.fit,gaze:{enabled:false,speed:.7}};
afterEach(()=>vi.useRealTimers());

describe('model configuration acknowledgements',()=>{
 it('validates before mutation and never accepts stale or mismatched receipts',async()=>{
  const configureModel=vi.fn();expect(applyModelConfiguration({configureModel},{...configuration,fit:{...configuration.fit,zoom:99}},1).ok).toBe(false);expect(configureModel).not.toHaveBeenCalled();
  const post=vi.fn(),state=createModelConfigurationState(post,null);const applied=state.send(configuration);
  await expect(state.send(configuration)).rejects.toThrow('already');
  expect(state.receive({seq:2,ok:true,configuration})).toBe(false);
  expect(state.receive({seq:1,ok:true,configuration:{...configuration,revision:'b'.repeat(64)}})).toBe(false);
  expect(state.snapshot()).toBeNull();
  expect(state.receive(applyModelConfiguration({configureModel},configuration,1))).toBe(true);
  expect(await applied).toEqual(configuration);expect(state.snapshot()).toEqual(configuration);
 });
 it('retains last confirmed settings on failure, missing receipt or disposal',async()=>{
  vi.useFakeTimers();const state=createModelConfigurationState(()=>{},configuration,{timeoutMs:100});
  const changed={...configuration,revision:'b'.repeat(64)};
  const failed=expect(state.send(changed)).rejects.toThrow('measurement');state.receive({seq:1,ok:false,reason:'measurement failed'});await failed;
  const timeout=expect(state.send(changed)).rejects.toThrow('unconfirmed');await vi.advanceTimersByTimeAsync(100);await timeout;
  const disposed=expect(state.send(changed)).rejects.toThrow('replaced');state.dispose();await disposed;
  expect(state.receive({seq:3,ok:true,configuration:changed})).toBe(false);expect(state.snapshot()).toEqual(configuration);expect(vi.getTimerCount()).toBe(0);
 });
 it('shares one application owner and reconciles a synchronous commit after cancellation',async()=>{
  const send=vi.fn((_message:unknown)=>true),app=createModelApplication({send,failure:()=> 'unconfirmed',timeoutMs:100});const abort=new AbortController();
  const pending=app.configure('raw',configuration,abort.signal);const message:any=send.mock.calls[0][0];
  await expect(app.load({figure:'another'},new AbortController().signal)).rejects.toThrow('already');
  abort.abort();app.receive({request:message.request,id:'raw',ok:true,configurationRevision:configuration.revision});
  expect(await pending).toMatchObject({ok:true});expect(send).toHaveBeenCalledTimes(1);
 });
});

describe('model domain configuration versus resource replacement',()=>{
 function setup(){
  const editor={sourceId:'source',modelFile:'test.model3.json',profile:DEFAULT_MODEL_PROFILE,saved:true,revision:'r1'};
  const resources={provider:'direct-live2d',modelDirectory:'models',editor:vi.fn(async()=>editor),saveProfile:vi.fn(async()=>editor),prepare:vi.fn(),prepareConfiguration:vi.fn(async():Promise<ModelConfiguration|null>=>configuration)};
  const prepare=vi.fn(async()=> 'new'),load=vi.fn(async()=>({ok:true})),configure=vi.fn(async():Promise<{ok:boolean}|undefined>=>({ok:true})),commit=vi.fn();
  const model=createModelDomain({resources,selected:()=> 'raw',available:()=>true,prepare,load,configure,commit,applied:r=>r?.ok===true});return{model,resources,prepare,load,configure,commit};
 }
 it('updates current body without preparing assets, changing selection or reapplying its outfit',async()=>{
  const f=setup();const result=await f.model.save('raw',DEFAULT_MODEL_PROFILE,'r1');
  expect(result).toMatchObject({saved:true,applied:true,operation:{application:'configuration',candidate:'raw'}});
  expect(f.prepare).not.toHaveBeenCalled();expect(f.load).not.toHaveBeenCalled();expect(f.commit).not.toHaveBeenCalled();
 });
 it('keeps saved/offline and saved/failed outcomes separate without implicit reload',async()=>{
  const f=setup();f.configure.mockResolvedValueOnce(undefined);expect(await f.model.save('raw',DEFAULT_MODEL_PROFILE,'r1')).toMatchObject({saved:true,applied:false});
  f.configure.mockRejectedValueOnce(Error('measurement failed'));await expect(f.model.save('raw',DEFAULT_MODEL_PROFILE,'r1')).rejects.toThrow('measurement failed');
  expect(f.model.snapshot()).toMatchObject({saved:true,applied:false,phase:'failed',selected:'raw'});expect(f.load).not.toHaveBeenCalled();
 });
 it('uses the existing candidate transaction when resource-sensitive settings change',async()=>{
  const f=setup();f.resources.prepareConfiguration.mockResolvedValue(null);const result=await f.model.save('raw',DEFAULT_MODEL_PROFILE,'r1');
  expect(result.operation.application).toBe('replacement');expect(f.configure).not.toHaveBeenCalled();expect(f.load).toHaveBeenCalledWith('new',expect.any(AbortSignal));expect(f.commit).toHaveBeenCalledOnce();
 });
});
