import {describe,it,expect,vi} from 'vitest';
// @ts-expect-error Owned pure native player.
import {createNativeActions,nativeBindingDuration} from '../live2d-runtime/pack/backends/native-actions.js';
// @ts-expect-error Browser action domain.
import {createBodyActions} from '../web/framework/actions.js';
const expr=(id:string,param:string,value=1)=>({id,kind:'expression',classification:'expression',seconds:1,data:{Parameters:[{Id:param,Value:value,Blend:'Overwrite'}]}});
const motion=(id:string,from:number,to:number,classification='gesture')=>({id,kind:'motion',classification,seconds:.2,data:{Curves:[{Id:'Arm',Target:'Parameter',Segments:[0,from,0,.2,to]}]}});
const frame={face:'happy'};
describe('live native binding changes',()=>{
 it('crossfades a changed combination for the same word and releases removed channels',()=>{
  const player=createNativeActions({resources:[expr('loading','Loading'),expr('eyes','Eyes')],bindings:[{word:'happy',resource:'loading'}]});
  player.update(frame,.1);player.update(frame,.1);
  player.rebind([{word:'happy',resource:'loading',overlays:['eyes']}]);
  player.update(frame,.1);const combined=player.update(frame,.1);
  expect(combined.map((p:any)=>[p.id,p.value])).toEqual([['Loading',1],['Eyes',1]]);
  player.rebind([]);player.update(frame,.1);expect(player.update(frame,.1)).toEqual([]);
 });
 it('rejects a conflict or missing resource before replacing the current bindings',()=>{
  const player=createNativeActions({resources:[expr('eyes','Eyes'),expr('opposite','Eyes',0)],bindings:[{word:'happy',resource:'eyes'}]});
  player.update(frame,.1);player.update(frame,.1);
  expect(()=>player.rebind([{word:'happy',resource:'eyes',overlays:['opposite']}])).toThrow('冲突');
  expect(()=>player.rebind([{word:'happy',resource:'missing'}])).toThrow('unavailable');
  expect(player.update(frame,.1).find((p:any)=>p.id==='Eyes').value).toBe(1);
 });
 it('lets the running pose finish its original release while later triggers use the new binding',()=>{
  const resources=[motion('up',0,1,'pose'),motion('down',1,0),motion('next',0,.5)];
  const binding={word:'nod',resource:'up',release:'down',nativeOnly:true};
  const player=createNativeActions({resources,bindings:[binding]});player.trigger('nod');player.update({},.1);
  player.rebind([{word:'nod',resource:'next'}]);
  const seen=[];for(let i=0;i<22;i++){player.update({},.1);seen.push(player.state().motion);}
  expect(seen).toContain('down');expect(seen).not.toContain('next');
  player.trigger('nod');expect(player.state().motion).toBe('next');expect(nativeBindingDuration(binding,resources)).toBeCloseTo(2.15);
 });
 it('revises future vocabulary without losing the current word or ongoing walk receipt',()=>{
  const body={pack:'raw',layout:{busy:false,x:50,y:10},do:vi.fn(),set:vi.fn(),walk:vi.fn()};const receipt=vi.fn();
  const actions=createBodyActions({body:{body},scene:{target:()=>80,normalize:(p:any)=>p},receipt});
  actions.bodyCommitted({vocab:[{id:'nod',seconds:2}]});actions.enqueue('nod','nod');actions.tick(.1);
  actions.walk({t:'walk',id:9,to:.8});actions.configurationApplied([{id:'wave',seconds:1}],true);
  expect(actions.snapshot()).toMatchObject({queued:0,active:{word:'nod'},pendingWalks:1});
  actions.event('arrived',{walkId:9,x:80});expect(receipt).toHaveBeenCalledWith(expect.objectContaining({t:'arrived',walkId:9}));
  actions.tick(2);actions.enqueue('wave');actions.tick(.1);expect(body.do).toHaveBeenLastCalledWith('wave');
 });
});
