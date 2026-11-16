import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error browser module
import { heldInputSnapshot, bodyInputReport, applyBodyInput, createInputReceiptState } from '../web/body-input-contract.js';
afterEach(()=>vi.useRealTimers());
describe('held-input body bridge', () => {
 it('validates limited physical codes, deduplicates and accepts clear', () => {
  expect(heldInputSnapshot({keys:['KeyA','KeyA','ShiftLeft'],primary:true,secondary:false})).toEqual({keys:['KeyA','ShiftLeft'],primary:true,secondary:false});
  expect(heldInputSnapshot(null)).toBe(null);
  for (const raw of [{keys:['hello world'],primary:false,secondary:false},{keys:Array(33).fill('KeyA'),primary:false,secondary:false},{keys:['KeyA'],primary:'yes',secondary:false},{keys:[],primary:false,secondary:false,text:'private'},undefined]) expect(()=>heldInputSnapshot(raw)).toThrow('Invalid held-input snapshot');
 });
 it('applies held input and null clear, only emits count/flags in receipts', () => {
  const body={capabilities:{input:{held:true}},inputState:{keyCount:0,primary:false,secondary:false},input(raw:any){this.inputState={keyCount:raw?.keys.length??0,primary:raw?.primary??false,secondary:raw?.secondary??false};}};
  const receipt=applyBodyInput(body,{keys:['KeyA'],primary:true,secondary:false},1);
  expect(receipt).toMatchObject({status:'applied',state:{keyCount:1,primary:true,secondary:false}});
  expect(JSON.stringify(receipt)).not.toContain('KeyA');expect(JSON.stringify(receipt)).not.toContain('keys');
  expect(applyBodyInput(body,null,2)).toMatchObject({status:'applied',state:{keyCount:0,primary:false,secondary:false}});
 });
 it('does not infer legacy support and redacts implementation exceptions', () => {
  expect(bodyInputReport({})).toEqual({supported:{held:false},state:{}});
  expect(applyBodyInput({},null,1).status).toBe('unsupported');
  const body={capabilities:{input:{held:true}},input(){throw Error('secret KeyA');}};
  const receipt=applyBodyInput(body,{keys:['KeyA'],primary:false,secondary:false},1);
  expect(receipt).toMatchObject({status:'failed',error:'Body held-input failed'});expect(JSON.stringify(receipt)).not.toContain('KeyA');
 });
 it('tracks only latest count receipt, times out, clears timers on disposal', () => {
  vi.useFakeTimers();const post=vi.fn(),tracker=createInputReceiptState(post);
  tracker.ready({supported:{held:true},state:{keyCount:0,primary:false,secondary:false}});
  tracker.send({keys:['KeyA'],primary:false,secondary:false});tracker.send(null);
  const requested={keyCount:0,primary:false,secondary:false};
  tracker.receive({seq:1,requested,supported:{held:true},state:requested});expect(tracker.snapshot().status).toBe('pending');
  tracker.receive({seq:2,requested,supported:{held:true},state:requested});expect(tracker.snapshot().status).toBe('applied');
  expect(JSON.stringify(tracker.snapshot())).not.toContain('KeyA');
  tracker.send(null);vi.advanceTimersByTime(2000);expect(tracker.snapshot().status).toBe('timeout');
  tracker.send(null);tracker.dispose();vi.advanceTimersByTime(2000);expect(tracker.snapshot().status).toBe('disposed');
  const count=post.mock.calls.length;tracker.send(null);expect(post).toHaveBeenCalledTimes(count);
 });
});
