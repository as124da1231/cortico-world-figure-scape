import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error browser module
import { bodySpeechReport, applyBodySpeech, createSpeechReceiptState } from '../web/body-speech-contract.js';
afterEach(() => vi.useRealTimers());
describe('body speech contribution bridge', () => {
 it('acknowledges pulse and release contribution without modifying expression state', () => {
  const body = { capabilities: { speech: { pulse:true, release:true } }, speechState:{pulse:0}, expression:'happy', speech(command:any) { this.speechState.pulse=command.kind==='pulse'?1:0; } };
  expect(applyBodySpeech(body,{kind:'pulse'},1)).toMatchObject({status:'applied',seq:1,state:{pulse:1}});
  expect(applyBodySpeech(body,{kind:'release'},2)).toMatchObject({status:'applied',seq:2,state:{pulse:0}});
  expect(body.expression).toBe('happy');
 });
 it('keeps legacy talk, never invents release capability or an applied state', () => {
  const body={talk:vi.fn()};
  expect(bodySpeechReport(body)).toEqual({supported:{pulse:true,release:false},state:{}});
  expect(applyBodySpeech(body,{kind:'pulse'},1).status).toBe('dispatched');
  expect(body.talk).toHaveBeenCalledOnce();
  expect(applyBodySpeech(body,{kind:'release'},2).status).toBe('unsupported');
  expect(body.talk).toHaveBeenCalledOnce();
 });
 it('reports mismatch and thrown implementations rather than acknowledging success', () => {
  const body={capabilities:{speech:{release:true}},speechState:{pulse:1},speech:vi.fn()};
  expect(applyBodySpeech(body,{kind:'release'},1).status).toBe('mismatch');
  body.speech.mockImplementation(()=>{throw Error('release failed');});
  expect(applyBodySpeech(body,{kind:'release'},2)).toMatchObject({status:'failed',error:'Error: release failed'});
 });
 it('correlates commands, expires missing receipts, and ignores receipts after dispose', () => {
  vi.useFakeTimers(); const post=vi.fn(), state=createSpeechReceiptState(post);
  state.ready({supported:{pulse:true,release:true},state:{pulse:0}});
  state.send({kind:'pulse'});state.send({kind:'release'});
  state.receive({seq:1,command:{kind:'pulse'},supported:{pulse:true,release:true},state:{pulse:1}});
  expect(state.snapshot()).toMatchObject({seq:2,status:'pending'});
  state.receive({seq:2,command:{kind:'release'},supported:{pulse:true,release:true},state:{pulse:0}});
  expect(state.snapshot().status).toBe('applied');
  state.send({kind:'pulse'});vi.advanceTimersByTime(2000);expect(state.snapshot().status).toBe('timeout');
  state.dispose();state.receive({seq:3,command:{kind:'pulse'},supported:{pulse:true},state:{pulse:1}});
  expect(state.snapshot().status).toBe('disposed');
  const count=post.mock.calls.length;state.send({kind:'release'});expect(post).toHaveBeenCalledTimes(count);
 });
 it('rejects unsupported commands before posting', () => {
  const post=vi.fn(),state=createSpeechReceiptState(post);
  expect(()=>state.send({kind:'close-all-mouth-parameters'})).toThrow();
  state.send({kind:'release'});expect(state.snapshot().status).toBe('unsupported');expect(post).not.toHaveBeenCalled();state.dispose();
 });
});
