import { nativeBindingDuration } from './native-actions.js';

const channel = value => value.target + ':' + value.id;
const affine = track => {
  if (!track) return [1,0];
  const {weight=1,value,blend} = track;
  if (blend==='Affine') return [1+(track.scale-1)*weight,value*weight];
  if (blend==='Multiply') return [1+(value-1)*weight,0];
  if (blend==='Add') return [1,value*weight];
  return [1-weight,value*weight];
};
function interpolate(previous, current, fraction) {
  const old=new Map(previous.map(value=>[channel(value),value]));
  const next=new Map(current.map(value=>[channel(value),value]));
  const mix=(a,b)=>a+(b-a)*fraction;
  return [...new Set([...old.keys(),...next.keys()])].flatMap(key=>{
    const a=old.get(key),b=next.get(key),track=b??a;
    if (track.target==='PartOpacity') {
      const weight=mix(a?.weight??0,b?.weight??0);
      return weight>0?[{...track,weight,value:mix((a?.value??0)*(a?.weight??0),(b?.value??0)*(b?.weight??0))/weight}]:[];
    }
    const [sa,va]=affine(a),[sb,vb]=affine(b);
    return [{...track,blend:'Affine',scale:mix(sa,sb),value:mix(va,vb),weight:1}];
  });
}

/** Plays one candidate over the running native tracks, within its own scope and clock. */
export function createNativeDraftLayer(native, resources) {
  let active = null;
  let transition = null, visible = null;
  let state = { status: 'idle', requestId: null, owner: null };
  const fade = duration => { transition = visible && { from:visible, elapsed:0,duration }; };
  return {
    state: () => ({ ...state }),
    checkpoint: () => ({ active, state, transition, visible }),
    restore(checkpoint) { ({ active, state, transition, visible } = checkpoint); },
    play(binding, owner, requestId, mode = 'full', audition = false) {
      if (active && state.owner !== owner) throw Error('The draft action belongs to a different editor');
      const player = native.previewPlayer(binding, audition);
      const resource = resources.find(item => item.id === binding.resource);
      const duration = resource.kind === 'expression' ? Math.max(2, resource.seconds || 1) : nativeBindingDuration(binding, resources);
      fade(.15);
      active = { player, duration, elapsed: 0, word: binding.word, nativePreview: mode === 'native' };
      state = { status: 'playing', owner, requestId };
    },
    stop(owner, requestId) {
      if (active && state.owner !== owner) throw Error('The draft action belongs to a different editor');
      fade(.25);
      active = null;
      state = { status: 'stopped', owner, requestId };
    },
    clear() {
      active = transition = visible = null;
      state = { status: 'idle', owner: null, requestId: null };
    },
    mix(values, frame, dt) {
      if (active && (active.elapsed += dt) >= active.duration) {
        fade(.25);
        active = null;
        state = { ...state, status: 'finished' };
      }
      if (!active && !transition) { visible=null; return { values, covered:null }; }
      const preview = active?.player.update({ ...frame, face: active.word, gesture: null }, dt) ?? [];
      const covered = new Set(preview.map(channel));
      const nativePreview = active?.nativePreview === true;
      const target = nativePreview ? preview : values.filter(value=>!covered.has(channel(value))).concat(preview);
      if (transition) {
        const fraction=Math.min(1,(transition.elapsed+=dt)/transition.duration);
        if (fraction<1) visible=interpolate(transition.from,target,fraction);
        else { transition=null; visible=target; }
      } else visible=target;
      return { values:visible, covered:active?covered:null, nativePreview };
    },
  };
}
