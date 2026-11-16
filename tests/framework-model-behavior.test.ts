import {expect,it} from 'vitest';
// @ts-expect-error browser contract
import {modelBehaviorReport} from '../web/model-behavior-contract.js';
it('exposes actual gaze capability and settings without renderer internals',()=>{
 expect(modelBehaviorReport(undefined)).toBeNull();
 expect(modelBehaviorReport({gaze:{supported:false,reason:'no-eye-roles',settings:{enabled:false,speed:.5}},secret:{}})).toEqual({gaze:{supported:false,reason:'no-eye-roles',settings:{enabled:false,speed:.5}}});
 expect(modelBehaviorReport({gaze:{supported:true,settings:{enabled:true,speed:NaN}}})).toBeNull();
});

it('distinguishes compiled movement policy from Bongo effective stand override',()=>{
 expect(modelBehaviorReport({motion:{supported:true,compiledKind:'roam',effectiveKind:'stand',facing:'fixed',reason:'bongo-input'}})).toEqual({motion:{supported:true,compiledKind:'roam',effectiveKind:'stand',facing:'fixed',reason:'bongo-input'}});
 expect(modelBehaviorReport({motion:{supported:true,compiledKind:'roam',effectiveKind:'fly',facing:'fixed'}})).toBeNull();
});

it('reports current body crop configuration without leaking arbitrary renderer state',()=>{
 const settings={mode:'upper',edge:'round',line:.55,curve:1,feather:.05,transition:.24};
 expect(modelBehaviorReport({crop:{supported:true,reason:null,settings},other:{}})).toEqual({crop:{supported:true,reason:null,settings}});
});

it('reports only actual bounded mouth parameter metadata',()=>{
 const report=modelBehaviorReport({mouth:{mode:'mapped',supported:true,targets:['Mouth'],missing:[],parameters:[{id:'Mouth',min:0,max:1,default:0,roles:['mouthOpen'],extra:'omit'},{id:'bad',min:NaN,max:1,default:0,roles:[]}],truncated:false}});
 expect(report.mouth.parameters).toEqual([{id:'Mouth',min:0,max:1,default:0,roles:['mouthOpen']}]);
});
