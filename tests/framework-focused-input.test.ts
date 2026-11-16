import {expect,it,vi} from 'vitest';
// @ts-expect-error browser modules
import {createBodyInput} from '../web/framework/desktop-space.js';
// @ts-expect-error owned backend
import {createBongoInput,connectBongoBody} from '../live2d-runtime/pack/backends/bongo.js';
it('forwards only non-text focused physical keys and clears blur/replace without exposing keys',()=>{
 const win=new EventTarget(),doc=Object.assign(new EventTarget(),{hidden:false});
 const body={inputStatus:{supported:{held:true}},input:vi.fn(),pointer:vi.fn()};
 const runtime=createBodyInput({body:{body},events:{window:win,document:doc}});
 const key=(code:string,editable=false)=>{const e=new Event('keydown');Object.defineProperties(e,{code:{value:code},target:{value:{closest:()=>editable?{}:null}}});win.dispatchEvent(e);};
 key('KeyA');key('KeyA');expect(body.input).toHaveBeenCalledTimes(1);expect(body.input).toHaveBeenLastCalledWith({keys:['KeyA'],primary:false,secondary:false});
 expect(JSON.stringify(runtime.snapshot())).not.toContain('KeyA');
 key('KeyB',true);expect(body.input).toHaveBeenLastCalledWith(null);expect(body.pointer).toHaveBeenLastCalledWith('cancel',{});
 key('KeyC');win.dispatchEvent(new Event('blur'));expect(body.input).toHaveBeenLastCalledWith(null);
 runtime.bodyCommitted();expect(runtime.snapshot().held.keyCount).toBe(0);
 runtime.dispose();body.input.mockClear();key('KeyD');expect(body.input).not.toHaveBeenCalled();
});
it('connects held Bongo state and restores authored hand base on the next frame after release',()=>{
 let value=.3;const model={getParameterMinimumValue:()=>0,getParameterMaximumValue:()=>1,getParameterDefaultValue:()=>.3,setParameterValueByIndex:(_:number,v:number)=>{value=v;}};
 const input=createBongoInput({keys:[{keya:{file:'left.png'}},{}]},model,new Map([['CatParamLeftHandDown',0]]),{bounds:()=>({W:100,H:100})});
 const body:any={capabilities:{},pointer:vi.fn((type: string)=>type==='up'),drop:vi.fn(),do:vi.fn(),words:[],dispose:vi.fn()};connectBongoBody(body,input,{},vi.fn());
 expect(body.pointer('up',{x:50,y:50,sceneDrop:1})).toBe(true);
 body.input({keys:['KeyA'],primary:false,secondary:false});expect(input.apply(.016)[0]).toEqual({file:'left.png'});expect(value).toBe(1);
 body.input(null);value=.3; // actual renderer loadParameters restores the pre-input authored base
 expect(input.apply(.016)).toEqual([null,null]);expect(value).toBe(.3);expect(body.inputState).toEqual({keyCount:0,primary:false,secondary:false});
});
