/** Only expose implemented model behavior, not arbitrary renderer objects. */
export function modelBehaviorReport(value) {
 const report={},gaze=value?.gaze,motion=value?.motion;
 if (gaze && typeof gaze.supported==='boolean' && typeof gaze.settings?.enabled==='boolean' && Number.isFinite(gaze.settings?.speed)) {
  report.gaze={supported:gaze.supported,reason:['bongo-input','no-eye-roles'].includes(gaze.reason)?gaze.reason:null,
   settings:{enabled:gaze.settings.enabled,speed:gaze.settings.speed}};
 }
 if (motion?.supported===true && ['roam','stand'].includes(motion.compiledKind) && ['roam','stand'].includes(motion.effectiveKind) && ['fixed','mirror','host'].includes(motion.facing)) {
  report.motion={supported:true,compiledKind:motion.compiledKind,effectiveKind:motion.effectiveKind,facing:motion.facing,reason:motion.reason==='bongo-input'?'bongo-input':null};
 }
 const crop=value?.crop,c=crop?.settings;
 if (typeof crop?.supported==='boolean' && ['full','upper'].includes(c?.mode) && ['flat','round'].includes(c?.edge)
   && ['line','curve','feather','transition'].every(key=>Number.isFinite(c?.[key]))) {
  report.crop={supported:crop.supported,reason:crop.reason==='bongo-input'?'bongo-input':null,
   settings:{mode:c.mode,edge:c.edge,line:c.line,curve:c.curve,feather:c.feather,transition:c.transition}};
 }
 const mouth=value?.mouth;
 if (['auto','mapped','off'].includes(mouth?.mode) && typeof mouth.supported==='boolean' && Array.isArray(mouth.parameters)) {
  const ids=values=>Array.isArray(values)?values.filter(id=>typeof id==='string'&&id.length<=128).slice(0,512):[];
  report.mouth={mode:mouth.mode,supported:mouth.supported,targets:ids(mouth.targets),missing:ids(mouth.missing),truncated:mouth.truncated===true,
   parameters:mouth.parameters.filter(p=>typeof p.id==='string'&&p.id.length<=128&&[p.min,p.max,p.default].every(Number.isFinite)).slice(0,512).map(p=>({id:p.id,min:p.min,max:p.max,default:p.default,roles:ids(p.roles)}))};
 }
 const visual = value?.visual;
 if (visual && typeof visual.hue === 'boolean' && typeof visual.brightness === 'boolean'
  && [visual.settings, visual.saved].every(v => Number.isFinite(v?.hue) && Number.isFinite(v?.brightness))) {
  report.visual = { hue: visual.hue, brightness: visual.brightness, settings: { ...visual.settings }, saved: { ...visual.saved } };
 }
 return Object.keys(report).length?report:null;
}
