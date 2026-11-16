/** Transient source-profile framing. No paths, renderer globals or arbitrary mutations. */
export function framingFit(raw) {
  const pair = (value, min, max) => Array.isArray(value) && value.length === 2 && value.every(n => Number.isFinite(n) && n >= min && n <= max);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(key => !['mode','anchor','autoFit','zoom','offset','padding'].includes(key))
    || raw.mode !== 'contain' || raw.anchor !== 'bottom' || raw.autoFit !== false
    || !Number.isFinite(raw.zoom) || raw.zoom < .1 || raw.zoom > 5
    || !pair(raw.offset,-2,2) || !pair(raw.padding,0,.45)) throw new TypeError('Invalid framing fit');
  return { mode:'contain', anchor:'bottom', autoFit:false, zoom:raw.zoom, offset:[...raw.offset], padding:[...raw.padding] };
}
export function framingCommand(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !['preview','restore'].includes(raw.kind)
    || Object.keys(raw).some(key => key !== 'kind' && !(raw.kind === 'preview' && ['fit','crop'].includes(key)))) throw new TypeError('Invalid framing command');
  return raw.kind === 'preview' ? {kind:'preview',fit:framingFit(raw.fit),...(raw.crop===undefined?{}:{crop:framingCrop(raw.crop)})} : {kind:'restore'};
}
function framingCrop(crop) {
  const ranges={line:[.2,.95],curve:[0,2],feather:[0,.25],transition:[0,1.2]};
  if (!crop || typeof crop !== 'object' || Array.isArray(crop)
    || Object.keys(crop).some(key=>!['mode','edge',...Object.keys(ranges)].includes(key))
    || !['full','upper'].includes(crop.mode) || !['flat','round'].includes(crop.edge)
    || Object.entries(ranges).some(([k,[min,max]])=>!Number.isFinite(crop[k])||crop[k]<min||crop[k]>max)) throw new TypeError('Invalid framing crop');
  const {mode,edge,line,curve,feather,transition}=crop;
  return {mode,edge,line,curve,feather,transition};
}
function readGeometry(value) {
  if (!value || !['x','y','w','h'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key])) || value.w < 0 || value.h < 0) return null;
  return { x:value.x,y:value.y,w:value.w,h:value.h };
}
export function readFramingReport(report) {
  const state = {};
  try { state.fit = framingFit(report?.state?.fit); } catch {}
  try { state.crop = framingCrop(report?.state?.crop); } catch {}
  if (typeof report?.state?.active === 'boolean') state.active=report.state.active;
  const geometry=readGeometry(report?.state?.geometry);
  if(geometry)state.geometry=geometry;
  if (['bongo-input','not-ready'].includes(report?.state?.reason)) state.reason=report.state.reason;
  return {supported:{preview:report?.supported?.preview===true,restore:report?.supported?.restore===true},state};
}
export function bodyFramingReport(body) {
  return readFramingReport({supported:{preview:typeof body?.framing==='function' && body?.capabilities?.framing?.preview===true,
    restore:typeof body?.framing==='function' && body?.capabilities?.framing?.restore===true},state:body?.framingState});
}
export function framingOutcome(command,report) {
  const clean=readFramingReport(report),state=clean.state;
  return {...clean,status:!clean.supported[command.kind]?'unsupported':!state.fit||!state.geometry||typeof state.active!=='boolean'?'dispatched'
    :state.active!==(command.kind==='preview') || command.kind==='preview' &&
     (JSON.stringify(state.fit)!==JSON.stringify(command.fit)||command.crop&&JSON.stringify(state.crop)!==JSON.stringify(command.crop))?'mismatch':'applied'};
}
export function applyBodyFraming(body,raw,seq) {
  const command=framingCommand(raw);let failed=false;
  if(bodyFramingReport(body).supported[command.kind]){try{body.framing(command);}catch{failed=true;}}
  return {t:'body-framing',seq,command,...framingOutcome(command,bodyFramingReport(body)),...(failed?{status:'failed',error:'Body framing failed'}:{})};
}
export function createFramingReceiptState(post,{timeoutMs=2000}={}) {
  let seq=0,timer=null,disposed=false;
  let state={...readFramingReport(null),status:'unknown',seq:0,command:null};
  const snapshot=()=>structuredClone(state);
  return {snapshot,
    ready(report){if(!disposed)state={...readFramingReport(report),status:'reported',seq,command:null};},
    // Frame observations may change readiness, never acknowledge an outstanding command.
    refresh(report){if(!disposed && state.status!=='pending')state={...state,...readFramingReport(report)};},
    send(raw){const command=framingCommand(raw);clearTimeout(timer);state={...readFramingReport(state),seq:++seq,command,status:disposed?'disposed':state.supported[command.kind]?'pending':'unsupported'};
      if(state.status==='pending'){timer=setTimeout(()=>{state={...state,status:'timeout'};},timeoutMs);post({t:'body-framing',seq,command});}return snapshot();},
    receive(receipt){if(disposed||!seq||receipt?.seq!==seq||state.status!=='pending')return;
      let command;try{command=framingCommand(receipt.command);}catch{return;}
      if(JSON.stringify(command)!==JSON.stringify(state.command))return;
      clearTimeout(timer);state={...state,...framingOutcome(state.command,receipt),...(receipt.status==='failed'?{status:'failed',error:'Body framing failed'}:{})};},
    dispose(){disposed=true;clearTimeout(timer);state={...state,status:'disposed'};},
  };
}
