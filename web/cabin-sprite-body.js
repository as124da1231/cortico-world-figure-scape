const SVG = 'http://www.w3.org/2000/svg';
const LM = 384;
const ORIGIN = [192,320];
const WALK = [1,2,3,2];
const CARDINAL = [0,1,1,1,3,2,2,2];
const EXPRESSIONS = {
  happy:'mood_happy', sad:'mood_sad', sleepy:'mood_tired', thinking:'thinking',
  'cabin-stretch':'idle_stretch', 'cabin-yawn':'idle_yawn', 'cabin-pick':'pick_up',
  'cabin-lie':'lie_down', 'cabin-rise':'get_up', 'cabin-phone':'idle_phone', 'cabin-high-five':'high_five',
};

// Cabin World by VADS. The octant and frame timing here follow the game's
// body_language.gd, with screen-positive Y and the same row ordering.
export function cabinOctant(x, y) {
  return (8 + Math.round((Math.atan2(y,x)-Math.PI/2)/(Math.PI/4))) % 8;
}
export function cabinClipFrame(clip, row, elapsed) {
  const length = clip.frames*clip.seconds+(clip.holdSeconds??0);
  if (elapsed < 0 || !clip.loop && elapsed >= length) return null;
  let time = clip.loop ? elapsed % length : elapsed;
  if (clip.holdFrame !== undefined) {
    const holdStart = (clip.holdFrame+1)*clip.seconds;
    if (time > holdStart) time = Math.max(holdStart-.00001,time-clip.holdSeconds);
  }
  const frame = Math.min(clip.frames-1,Math.floor(time/clip.seconds));
  const actual = clip.file === 'idle_phone.png' ? [3,4,5,4][frame%4] : frame;
  return Math.min(clip.rows-1,Math.max(0,row))*clip.frames+Math.min(clip.frames-1,actual);
}

export async function createCabinSpriteBody(_base, {host, kit, model, scheme, asset, loadImage}) {
  const {clips, scale, extent, turnSeconds} = model;
  const doc = host.root.ownerDocument;
  const images = new Map(await Promise.all(Array.from(new Set(Object.values(clips).map(clip=>clip.file)),
    async file => [file, await loadImage(asset(file))])));
  const mount = doc.createElementNS(SVG,'foreignObject');
  mount.setAttribute('x',String(128-ORIGIN[0]));
  mount.setAttribute('y',String(256-ORIGIN[1]));
  mount.setAttribute('width',String(LM));
  mount.setAttribute('height',String(LM));
  mount.setAttribute('data-cabin-sprite','');
  const canvas = doc.createElement('canvas');
  canvas.width = canvas.height = LM;
  canvas.style.cssText = 'display:block;width:100%;height:100%;image-rendering:pixelated';
  const paint = canvas.getContext('2d');
  if (!paint) throw Error('Canvas 2D is unavailable');
  paint.imageSmoothingEnabled = false;
  mount.append(canvas);

  const namedWords = {};
  for (const [word,id] of Object.entries(EXPRESSIONS)) {
    const clip = clips[id];
    if (word.startsWith('cabin-') && clip) namedWords[word] = {expression:{like:'neutral',seconds:clip.frames*clip.seconds+(clip.holdSeconds??0)}};
  }
  const motionPreference = doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)');
  let robe = scheme === 'yukata' && !!clips.robe;
  let lastSprite = '', lastFace = '', faceStart = 0;
  let pos, previousTime = 0, direction = 0, faceRow = 0, turnAt = -Infinity, walkTime = 0;
  let wasWalking = false, wasSeated = false, transition = null, transitionStart = 0;
  let idleAfter = 7, idleSince = null, idleClip = null, idleClipAt = 0;
  const usable = (id,row,time) => {
    const clip = clips[id];
    if (!clip) return null;
    const index = cabinClipFrame(clip,row,time);
    return index === null ? null : [id,index];
  };

  function choose(frame) {
    const clock = frame.t;
    const dt = Math.max(0, Math.min(.1, clock-previousTime));
    previousTime = clock;
    const dx = pos ? frame.position.x-pos.x : 0;
    const dy = pos ? frame.position.y-pos.y : 0;
    pos = frame.position;
    const distance = Math.hypot(dx,dy);
    const walking = (frame.mode === 'walk' || frame.mode === 'run') && distance > .018;
    const held = frame.mode === 'drag' || frame.mode === 'air' || frame.mode === 'land';
    if (walking) {
      const next = cabinOctant(dx,dy);
      if (direction !== next) turnAt = clock;
      direction = next;
      faceRow = CARDINAL[direction];
    }
    if (!walking || !wasWalking) walkTime = 0;
    if (walking) {
      const speedRatio = distance/Math.max(.001,dt)/(frame.mode === 'run' ? 250 : 78);
      walkTime += dt*Math.min(1, speedRatio)*(frame.mode === 'run' ? 1.45 : 1);
    }
    wasWalking = walking;
    const seated = frame.mode === 'sit' && !!clips.sit;
    if (seated !== wasSeated) {
      transition = seated ? 'sit_down' : 'stand_up';
      transitionStart = clock;
      wasSeated = seated;
    }
    const rest = robe ? 'robe' : 'walk';
    if (walking) {
      idleSince = idleClip = null;
      transition = null;
      if (!robe) {
        const turn = clock-turnAt;
        const tired = frame.drowse > .64 && usable('walk_tired',faceRow,walkTime);
        const eight = usable('walk8',direction,walkTime);
        const turnFrame = turn < turnSeconds && usable('turn',[0,0,3,1][faceRow],turn);
        if (tired || eight || turnFrame) return tired || eight || turnFrame;
      }
      const step = Math.floor(walkTime/clips[rest].seconds)%4;
      return [rest,faceRow*4+(robe?step:WALK[step])];
    }
    if (held) {
      idleSince = idleClip = null;
      transition = null;
      return [rest,faceRow*4];
    }
    if (!robe && transition) {
      const pose = usable(transition,faceRow,clock-transitionStart);
      if (pose && !motionPreference.matches) return pose;
      transition = null;
    }
    if (lastFace !== frame.face) {
      lastFace = frame.face;
      faceStart = clock;
    }
    if (seated) {
      idleSince = idleClip = null;
      if (robe && clips.robe.rows>4) return usable('robe',4,clock*2/7);
      if (!robe) return frame.talk > .12 && usable('sit_chat',Number(frame.facing>0),clock) || usable('sit',0,clock);
    }
    if (!robe) {
      const speaking = frame.talk > .12 && usable('chat',Number(frame.facing>0),clock);
      const expression = EXPRESSIONS[frame.face];
      const pose = expression && usable(expression,faceRow,clock-faceStart);
      if (speaking || pose) {
        idleSince = idleClip = null;
        return speaking || pose;
      }
      if (frame.mode === 'idle' && !motionPreference.matches) {
        idleSince ??= clock;
        if (idleClip) {
          const animation = usable(idleClip,faceRow,clock-idleClipAt);
          if (animation) return animation;
          idleClip = null;
        }
        if (clock-idleSince >= idleAfter) {
          const choices = ['idle_look','idle_stretch'].filter(name=>!!clips[name]);
          if (choices.length) {
            idleClip = choices[Math.floor(Math.random()*choices.length)];
            idleClipAt = clock;
            idleAfter = clock-idleSince+9+Math.random()*11;
            return usable(idleClip,faceRow,0);
          }
        }
      } else idleSince = idleClip = null;
    } else if (faceRow === 0 && frame.blink > .8) {
      // The original front yukata sheet includes a closed-eye pose.
      return ['robe',1];
    }
    return [rest,faceRow*4];
  }

  const width = extent[2]-extent[0];
  const height = extent[3]-extent[1];
  return kit.createBody(host,{
    words:namedWords,
    figure:{
      directionalFrames:true, extent,
      hits:[.19,.4,.62,.83].map((ratio,i)=>[128,extent[1]+height*ratio,width*(i===0?.21:.26)]),
      groupTilt(mode, tilt) { return mode==='drag' || mode==='air' ? tilt*.55 : 0; },
      colors:{z:'#6b7aab'},
      setScheme(id) { robe = id==='yukata' && !!clips.robe; },
      draw(group,_face,frame) {
        if (!mount.parentNode) group.append(mount);
        const [id,index] = choose(frame);
        const key = id+':'+index;
        if (lastSprite === key) return;
        lastSprite = key;
        const clip = clips[id];
        const [x,y,w,h] = clip.rects[index];
        const [ax,ay] = clip.anchors[index];
        const s = scale*clip.scale;
        paint.clearRect(0,0,LM,LM);
        paint.drawImage(images.get(clip.file),x,y,w,h,Math.round(ORIGIN[0]-ax*s),Math.round(ORIGIN[1]-ay*s),
          Math.max(1,Math.round(w*s)),Math.max(1,Math.round(h*s)));
        mount.dataset.clip = id;
        mount.dataset.frame = String(index);
      },
    },
  });
}
