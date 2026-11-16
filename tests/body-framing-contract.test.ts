import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error browser module
import { framingFit, framingCommand, applyBodyFraming, createFramingReceiptState } from '../web/body-framing-contract.js';
const fit={mode:'contain',anchor:'bottom',autoFit:false,zoom:1,offset:[0,0],padding:[.04,.02]};
const geometry={x:1,y:2,w:30,h:60};
afterEach(()=>vi.useRealTimers());
describe('live framing body bridge',()=>{
 it('accepts only complete bounded source fit and restore without arbitrary options',()=>{
  expect(framingFit(fit)).toEqual(fit);expect(framingCommand({kind:'restore'})).toEqual({kind:'restore'});
  for(const bad of [{...fit,zoom:9},{...fit,padding:[0,.5]},{...fit,offset:[0,Infinity]},{...fit,autoFit:true},{...fit,code:'run'}])expect(()=>framingFit(bad)).toThrow();
  expect(()=>framingCommand({kind:'restore',fit})).toThrow();
 });
 it('acknowledges actual fit and geometry then restores without changing source',()=>{
  const body={capabilities:{framing:{preview:true,restore:true}},framingState:{fit,active:false,geometry},framing(command:any){this.framingState={fit:command.kind==='preview'?command.fit:fit,active:command.kind==='preview',geometry};}};
  const target={...fit,zoom:1.5};
  expect(applyBodyFraming(body,{kind:'preview',fit:target},1)).toMatchObject({status:'applied',state:{fit:target,active:true,geometry}});
  expect(applyBodyFraming(body,{kind:'restore'},2)).toMatchObject({status:'applied',state:{fit,active:false,geometry}});expect(fit.zoom).toBe(1);
 });
 it('never invents support or successful geometry; retains mismatch and failed',()=>{
  expect(applyBodyFraming({}, {kind:'restore'},1).status).toBe('unsupported');
  const body={capabilities:{framing:{preview:true}},framingState:{fit,active:true,geometry:null as any},framing:vi.fn()};
  expect(applyBodyFraming(body,{kind:'preview',fit},1).status).toBe('dispatched');
  body.framingState.geometry=geometry;
  expect(applyBodyFraming(body,{kind:'preview',fit:{...fit,zoom:2}},2).status).toBe('mismatch');
  body.framing.mockImplementation(()=>{throw Error('not ready');});expect(applyBodyFraming(body,{kind:'preview',fit},3).status).toBe('failed');
 });
 it('requires current seq and command, times out and stops on disposal',()=>{
  vi.useFakeTimers();const post=vi.fn(),tracker=createFramingReceiptState(post);tracker.ready({supported:{preview:true,restore:true},state:{fit,active:false,geometry}});
  tracker.send({kind:'preview',fit});tracker.send({kind:'restore'});
  const receipt={seq:2,command:{kind:'restore'},supported:{preview:true,restore:true},state:{fit,active:false,geometry}};
  tracker.receive({...receipt,seq:1});expect(tracker.snapshot().status).toBe('pending');tracker.receive(receipt);expect(tracker.snapshot().status).toBe('applied');
  tracker.send({kind:'restore'});vi.advanceTimersByTime(2000);expect(tracker.snapshot().status).toBe('timeout');tracker.dispose();tracker.receive({...receipt,seq:3});expect(tracker.snapshot().status).toBe('disposed');
 });
 it('refreshes current readiness without rewriting command status or seq',()=>{
  vi.useFakeTimers();const tracker=createFramingReceiptState(vi.fn());
  tracker.ready({supported:{preview:true,restore:true},state:{fit,active:false,reason:'not-ready'}});
  tracker.refresh({supported:{preview:true,restore:true},state:{fit,active:false,geometry}});
  expect(tracker.snapshot()).toMatchObject({status:'reported',seq:0,state:{geometry}});expect(tracker.snapshot().state.reason).toBeUndefined();
  tracker.send({kind:'preview',fit});tracker.refresh({supported:{preview:true,restore:true},state:{fit,active:true,geometry}});
  expect(tracker.snapshot()).toMatchObject({status:'pending',seq:1,state:{active:false}});
  tracker.receive({seq:1,command:{kind:'preview',fit},supported:{preview:true,restore:true},state:{fit,active:false,geometry},status:'failed'});
  tracker.refresh({supported:{preview:true,restore:true},state:{fit,active:false,geometry}});
  expect(tracker.snapshot()).toMatchObject({status:'failed',seq:1,command:{kind:'preview',fit}});
  tracker.dispose();tracker.refresh({supported:{preview:false,restore:false},state:{}});expect(tracker.snapshot().status).toBe('disposed');
 });

});
