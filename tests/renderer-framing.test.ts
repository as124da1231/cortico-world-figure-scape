import { readFileSync } from 'node:fs';
import { describe,it,expect } from 'vitest';
const source=readFileSync(new URL('../live2d-runtime/pack/backends/live2d.js',import.meta.url),'utf8');
const block=source.slice(source.indexOf('  // Transactional live framing:'),source.indexOf('  const roleNames = new Map();'));
const fit={mode:'contain',anchor:'bottom',autoFit:false,zoom:1,offset:[0,0],padding:[.04,.02]};
function harness(bongo=false){
  // Exercise the renderer's actual contract with deterministic geometry dependencies.
  return new Function('initial','isBongo',`
    let fitState=structuredClone(initial),extent=[0,0,100,100],measuredExtent=extent,hitBands=[],silhouette={},
      wardrobeBaseline={fit:structuredClone(initial),extent,silhouette},wardrobeLayoutDirty=false,wardrobeAdjusted=false,
      crop={},cropDisplay=null,cropTransition=null,cropDirty=false,framingScheme='initial';
    const canvas={style:{filter:''}};
    const profile={bongo:isBongo};let texturesReady=true,picks={},fail=false;
    const gaze={enabled:true,speed:1},gazeCapable=true;let customGaze=false,sampledAt=0;
    const lastLook=[0,0],kitCursorLook=[0,0],adjustedCursorLook=[0,0];
    const body={modelBehavior:{gaze:{settings:{...gaze}}},step:()=>{},get capabilities(){return {speech:{pulse:true}}},layout:()=>({box:{x:0,y:0,w:100*fitState.zoom,h:100*fitState.zoom}})};
    const fitCopy=()=>structuredClone(fitState),applyFit=()=>{},publishInfo=()=>{},updateCrop=()=>{},schemeCrop=()=>({}),setCrop=()=>{};
    const wardrobe={state:()=>({...picks}),select:p=>{picks={...p}},layoutKey:()=>JSON.stringify(picks)};
    const hasWardrobePick=()=>Object.values(picks).some(x=>x!=='default');
    const measureNeutralExtent=()=>fail?null:[0,0,100*fitState.zoom,100*fitState.zoom];
    const settleWardrobe=()=>{fitState=structuredClone(wardrobeBaseline.fit);wardrobeAdjusted=hasWardrobePick();wardrobeLayoutDirty=false;};
    ${block}
    return {body,canvas,pick:p=>{picks=p},picks:()=>picks,fail:()=>{fail=true}};
  `)(fit,bongo);
}
describe('real renderer framing contract',()=>{
 it('restores visual previews to the saved model-specific filter',()=>{
  const h=harness(), visual={hue:22,brightness:1.05};
  h.body.configureModel({fit,gaze:{enabled:true,speed:1},visual});
  h.body.previewVisual({hue:-10,brightness:.9});
  expect(h.canvas.style.filter).toBe('hue-rotate(-10deg) brightness(0.9)');
  h.body.previewVisual(null);
  expect(h.body.modelBehavior.visual).toMatchObject({settings:visual,saved:visual});
  expect(h.canvas.style.filter).toBe('hue-rotate(22deg) brightness(1.05)');
 });
 it('accepts a saved baseline without allowing later preview restore to undo it',()=>{
  const h=harness(),next={...fit,zoom:1.6};h.body.framing({kind:'preview',fit:{...fit,zoom:1.2}});
  h.body.configureModel({fit:next,gaze:{enabled:false,speed:.7}});
  expect(h.body.framingState.active).toBe(false);expect(h.body.framingState.fit).toEqual(next);
  h.body.framing({kind:'restore'});expect(h.body.framingState.fit).toEqual(next);
  expect(h.body.modelBehavior.gaze.settings).toEqual({enabled:false,speed:.7});
 });
 it('restores the previous preview and gaze if a live update fails',()=>{
  const h=harness(),preview={...fit,zoom:1.2};h.body.framing({kind:'preview',fit:preview});h.fail();
  expect(()=>h.body.configureModel({fit:{...fit,zoom:2},gaze:{enabled:false,speed:.7}})).toThrow();
  expect(h.body.framingState).toMatchObject({active:true,fit:preview});expect(h.body.modelBehavior.gaze.settings.enabled).toBe(true);
  h.body.framing({kind:'restore'});expect(h.body.framingState.fit).toEqual(fit);
 });
 it('previews reversibly with capability and measured geometry',()=>{
  const h=harness(), next={...fit,zoom:1.5};
  expect(h.body.capabilities.speech.pulse).toBe(true);
  const report=h.body.framing({kind:'preview',fit:next});
  expect(report.active).toBe(true);expect(report.fit).toEqual(next);expect(report.geometry.w).toBe(150);
  const restored=h.body.framing({kind:'restore'});expect(restored.active).toBe(false);expect(restored.fit).toEqual(fit);expect(restored.geometry.w).toBe(100);
 });
 it('retains later wardrobe choice when restoring and rolls back failed preview',()=>{
  const h=harness();h.body.framing({kind:'preview',fit:{...fit,zoom:1.2}});h.pick({glasses:'on'});
  h.body.framing({kind:'restore'});expect(h.picks()).toEqual({glasses:'on'});
  h.fail();expect(()=>h.body.framing({kind:'preview',fit:{...fit,zoom:2}})).toThrow();
  expect(h.body.framingState.active).toBe(false);expect(h.body.framingState.fit).toEqual(fit);
 });
 it('rejects Bongo and malformed fit without activating a preview',()=>{
  expect(()=>harness(true).body.framing({kind:'preview',fit})).toThrow('unavailable');
  const h=harness();expect(()=>h.body.framing({kind:'preview',fit:{...fit,zoom:Infinity}})).toThrow('Invalid');expect(h.body.framingState.active).toBe(false);
 });
});
