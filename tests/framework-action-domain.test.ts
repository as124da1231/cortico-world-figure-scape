import {expect,it,vi} from 'vitest';
import {createActionDomain} from '../src/framework/action-domain.ts';
it('validates the entire batch against live body vocabulary and sends one correlated request',()=>{
 let selected='a',busy=false,available=true;const send=vi.fn(()=>true),words=[{id:'happy',seconds:1},{id:'nod',seconds:2}];
 const domain=createActionDomain({selected:()=>selected,busy:()=>busy,available:()=>available,vocabulary:()=>words,runtime:()=>null,send});
 expect(()=>domain.preview('a',['happy','missing'])).toThrow();expect(send).not.toHaveBeenCalled();
 const accepted=domain.preview('a',['happy','nod']);expect(send).toHaveBeenCalledWith({t:'act',figure:'a',id:accepted.requestId,actions:['happy','nod']});
 const copy=domain.read();copy.vocabulary[0].id='changed';expect(domain.read().vocabulary[0].id).toBe('happy');
 selected='b';expect(()=>domain.preview('a',['happy'])).toThrow();busy=true;expect(()=>domain.preview('b',['happy'])).toThrow();busy=false;available=false;expect(()=>domain.preview('b',['happy'])).toThrow();
});

// @ts-expect-error browser module
import {createBodyActions} from '../web/framework/actions.js';
it('records a rejected stale-body preview without touching the replacement body',()=>{
 const doWord=vi.fn();const runtime=createBodyActions({body:{body:{do:doWord}},scene:{},receipt:vi.fn()});
 runtime.rejectRequest('request',['happy'],'body-changed');
 expect(runtime.snapshot().recent).toMatchObject([{requestId:'request',word:'happy',status:'failed',reason:'body-changed'}]);
 expect(doWord).not.toHaveBeenCalled();
});
