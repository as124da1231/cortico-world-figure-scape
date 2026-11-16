import {visualSettings} from './body-visual-contract.js';
import {framingFit} from './body-framing-contract.js';
import { readTouchProfile } from './framework/touch-geometry.js';

export function bindingsValue(value){
  if(!Array.isArray(value)||value.length>40)throw Error('Invalid native bindings');
  const used=new Set(),resource=id=>typeof id==='string'&&/^(motion|expr)-[a-f0-9]{16}$/.test(id);
  return value.map(b=>{
    if(!b||Object.keys(b).some(k=>!['word','resource','overlays','release','nativeOnly','reason','confidence'].includes(k))
      ||typeof b.word!=='string'||!/^[a-z][a-z0-9-]{0,39}$/.test(b.word)||b.word==='constructor'||used.has(b.word)||!resource(b.resource))throw Error('Invalid native binding');
    used.add(b.word);
    if(b.overlays!==undefined&&(!Array.isArray(b.overlays)||b.overlays.length>7||b.overlays.some(id=>!resource(id))||new Set([b.resource,...b.overlays]).size!==b.overlays.length+1))throw Error('Invalid expression combination');
    if(b.release!==undefined&&!resource(b.release)||b.nativeOnly!==undefined&&typeof b.nativeOnly!=='boolean'
      ||b.reason!==undefined&&(typeof b.reason!=='string'||b.reason.length>200)
      ||b.confidence!==undefined&&(!Number.isFinite(b.confidence)||b.confidence<0||b.confidence>1))throw Error('Invalid native binding options');
    return {word:b.word,resource:b.resource,...(b.overlays?{overlays:[...b.overlays]}:{}),...(b.release?{release:b.release}:{}),...(b.nativeOnly!==undefined?{nativeOnly:b.nativeOnly}:{}),...(b.reason!==undefined?{reason:b.reason}:{}),...(b.confidence!==undefined?{confidence:b.confidence}:{})};
  });
}
function actionValues(value){
  if(!Array.isArray(value)||value.length>64)throw Error('Invalid action vocabulary');
  const used=new Set(),localized=(raw,array)=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length>8)throw Error('Invalid action labels');
    return Object.fromEntries(Object.entries(raw).map(([language,text])=>{
      if(!/^[a-z]{2}(?:-[A-Za-z]{2,8})?$/.test(language))throw Error('Invalid action language');
      const values=array?text:[text];
      if(!Array.isArray(values)||values.length>8||values.some(v=>typeof v!=='string'||v.length>512))throw Error('Invalid action text');
      return [language,array?[...values]:text];
    }));
  };
  return value.map(w=>{
    if(!w||Object.keys(w).some(k=>!['id','kind','names','about','seconds'].includes(k))||typeof w.id!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(w.id)
      ||used.has(w.id)||!['expression','motion'].includes(w.kind)||!Number.isFinite(w.seconds)||w.seconds<.05||w.seconds>125)throw Error('Invalid action');
    used.add(w.id);return {id:w.id,kind:w.kind,names:localized(w.names,true),about:localized(w.about,false),seconds:w.seconds};
  });
}

export function modelConfiguration(raw) {
  if (!raw || raw.version !== 1 || typeof raw.revision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.revision)
    || Object.keys(raw).some(key => !['version','revision','fit','gaze','bindings','actions','visual','touch'].includes(key))) throw Error('Invalid model configuration');
  const gaze=raw.gaze;
  if (!gaze || Object.keys(gaze).some(key=>!['enabled','speed'].includes(key)) || typeof gaze.enabled!=='boolean'
    || !Number.isFinite(gaze.speed) || gaze.speed<.25 || gaze.speed>2.5) throw Error('Invalid gaze configuration');
  return {version:1,revision:raw.revision,fit:framingFit(raw.fit),gaze:{enabled:gaze.enabled,speed:gaze.speed},
    ...(raw.visual!==undefined?{visual:visualSettings(raw.visual)}:{}),...(raw.bindings!==undefined?{bindings:bindingsValue(raw.bindings)}:{}),...(raw.actions!==undefined?{actions:actionValues(raw.actions)}:{}),...(raw.touch!==undefined?{touch:readTouchProfile(raw.touch)}:{})};
}

/** Atomic body-side mutation. Validation failures never enter the renderer. */
export function applyModelConfiguration(body,raw,seq) {
  try {
    const configuration=modelConfiguration(raw);
    if(typeof body?.configureModel!=='function')throw Error('This body requires a reload to change model settings');
    body.configureModel(configuration);
    return {t:'model-configuration',seq,ok:true,configuration};
  }catch(error){return {t:'model-configuration',seq,ok:false,reason:String(error.message||error)};}
}

export function createModelConfigurationState(post,initial,{timeoutMs=8000}={}) {
  let applied=initial?modelConfiguration(initial):null,seq=0,pending=null,disposed=false;
  const fail=error=>{if(pending){clearTimeout(pending.timer);pending.reject(error);pending=null;}};
  return {
    snapshot:()=>applied&&structuredClone(applied),
    send(raw) {
      if(disposed)return Promise.reject(Error('Body was disposed'));
      if(pending)return Promise.reject(Error('A model configuration is already being applied'));
      let configuration;try{configuration=modelConfiguration(raw);}catch(error){return Promise.reject(error);}
      return new Promise((resolve,reject)=>{
        const ticket=++seq;
        pending={resolve,reject,configuration,timer:setTimeout(()=>fail(Error('Model configuration acknowledgement timed out; running state is unconfirmed')),timeoutMs)};
        try{post({t:'model-configuration',seq:ticket,configuration});}catch(error){fail(error);}
      });
    },
    receive(message) {
      if(!pending||message?.seq!==seq)return false;
      if(message.ok!==true){fail(Error(message.reason||'Model configuration failed'));return false;}
      let actual;try{actual=modelConfiguration(message.configuration);}catch{return false;}
      if(JSON.stringify(actual)!==JSON.stringify(pending.configuration))return false;
      const done=pending;pending=null;clearTimeout(done.timer);applied=actual;done.resolve(structuredClone(actual));return true;
    },
    dispose(){disposed=true;fail(Error('Body was replaced before configuration was acknowledged'));},
  };
}
