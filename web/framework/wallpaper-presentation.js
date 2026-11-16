import { createSceneFrame } from './scene-frame.js';
import { wallpaperPlacement, WALLPAPER_PLACEMENT_LIMITS, sameWallpaperPlacement } from './wallpaper-placement.js';
import { createSceneExit, createSceneGrip } from './scene-grip.js';

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export function createWallpaperSpace({viewport, framePlacement={}, composition}) {
  const frame = createSceneFrame(viewport, ({width,height}) => {
    const w = Math.min(width * .91, height * .86 * 16 / 9);
    const h = w * 9 / 16;
    return {x:(width-w)/2, y:(height-h)/2, w, h};
  }, framePlacement, {minWidth:300});
  const rect = frame.rect, limits = WALLPAPER_PLACEMENT_LIMITS.x;
  let placement = wallpaperPlacement(composition);
  function position(x) {
    const r = rect();
    return {x:r.x+r.w*clamp(Number.isFinite(x) ? x : placement.x,limits.min,limits.max),
      y:r.y+r.h*placement.groundY};
  }
  function normalX(x) {
    const r = rect();
    return clamp((x-r.x)/r.w,limits.min,limits.max);
  }
  return {
    rect, moveFrame:frame.move, resizeFrame:frame.resize,
    setPlacement(value) {
      const next = wallpaperPlacement(value);
      if (sameWallpaperPlacement(placement,next)) return false;
      placement = next;
      return true;
    },
    bounds() {
      const {width,height}=viewport(), r=rect();
      return {W:width,H:height,minX:r.x+r.w*limits.min,maxX:r.x+r.w*limits.max,
        floorY:r.y+r.h*placement.groundY,freeGround:false};
    },
    contains({x,y}) {
      const r=rect();
      return x>=r.x&&x<r.x+r.w&&y>=r.y&&y<r.y+r.h;
    },
    normalize({x}) { return {x:normalX(x),y:placement.groundY}; },
    restore:position,
    plan(_from, target) {
      if (!target || typeof target !== 'object' || !Number.isFinite(target.x)) throw Error('target-unreachable');
      return {path:[position(normalX(target.x))]};
    },
    snapshot:() => ({implementation:'wallpaper-space',status:'mounted',rect:rect(),placement:{...placement},targets:[]}),
  };
}

export function createWallpaperPresentation({body,scene,surface,wallpaper}) {
  const {stage}=surface, doc=stage.ownerDocument, win=doc.defaultView;
  const figure=stage.querySelector('.figure-layer');
  const bg=doc.createElement('section'), screen=doc.createElement('div');
  bg.className='pet-space pet-space-wallpaper';
  bg.dataset.wallpaperStaged='true';
  screen.className='wallpaper-media';
  const zh=doc.documentElement.lang.startsWith('zh');
  const t=(cn,en)=>zh?cn:en;
  bg.setAttribute('aria-label',t('壁纸场景','Wallpaper scene'));
  const move=createSceneGrip(doc,'move',t('移动壁纸窗口','Move wallpaper window'),t('拖动或按方向键移动','Drag or use the arrow keys to move'));
  const resize=createSceneGrip(doc,'resize',t('缩放壁纸窗口','Resize wallpaper window'),t('拖动或按方向键缩放','Drag or use the arrow keys to resize'));
  const guide = doc.createElement('div');
  guide.className = 'wallpaper-live-guide';
  guide.hidden = true;
  guide.setAttribute('aria-hidden','true');
  bg.append(screen,guide,move,resize);
  const exit=surface.exitScene?createSceneExit(doc,surface.exitScene):null;
  if(exit)bg.append(exit.element);
  const owner=Symbol('wallpaper');
  const events=new AbortController();
  let active=false, committed=false, disposed=false, shown=true, kind='loading', media, lastForward=0, hasPointer=false;
  let modelScale=1;
  let options=wallpaper?.options??{};
  let composition = {placement:wallpaperPlacement(wallpaper?.composition?.placement), revision:wallpaper?.composition?.revision ?? 0};
  function position() {
    const r=scene.rect();
    Object.assign(bg.style,{left:r.x+'px',top:r.y+'px',width:r.w+'px',height:r.h+'px'});
  }
  function bounds() {
    const area=scene.bounds();
    return {...area,S:Math.max(.09,scene.rect().h / 256 * .52 * modelScale)};
  }
  function refresh() {
    position();
    if (!active) return;
    if (figure) {
      const area=scene.rect(), {W,H}=scene.bounds();
      figure.presentationClipOwner=owner;
      figure.style.clipPath=`inset(${area.y}px ${W-area.x-area.w}px ${H-area.y-area.h}px ${area.x}px round 14px)`;
    }
    body.body?.set({bounds:bounds(),roam:'off'});
  }
  function post(message) { if (media?.tagName==='IFRAME') media.contentWindow?.postMessage(message,'*'); }
  function playback() {
    const paused=!!options.paused||!committed||!shown||doc.hidden;
    screen.style.setProperty('--wallpaper-fit',options.fit==='contain'?'contain':'cover');
    screen.style.setProperty('--wallpaper-scale',options.scale??1);
    if (paused||!options.interactive) releasePointer();
    if (media?.tagName==='VIDEO') {
      media.volume=options.volume??0;
      media.muted=!committed||!options.volume;
      if(paused)media.pause();
      else void media.play().catch(()=>{});
    } else post({type:'live2d-wallpaper-options',paused,fit:options.fit,volume:committed?options.volume:0});
  }
  function attach(node) { media=node;screen.replaceChildren(node);return node; }
  function awaitMedia(node, signal, event, timeout=4500) {
    return new Promise((resolve,reject)=>{
      if (signal?.aborted) { reject(signal.reason); return; }
      const controller=new AbortController(), listen={once:true,signal:controller.signal};
      const timer=setTimeout(()=>finish(Error('wallpaper-media-timeout')),timeout);
      function finish(error) {
        clearTimeout(timer);
        signal?.removeEventListener('abort',cancel);
        controller.abort();
        error ? reject(error) : resolve();
      }
      const cancel=()=>finish(signal.reason??Error('cancelled'));
      signal?.addEventListener('abort',cancel,{once:true});
      if(event==='message') {
        win.addEventListener('message', e=>{
          if(e.source!==node.contentWindow||e.origin!=='null'||e.data?.type!=='live2d-wallpaper-state')return;
          finish(e.data.state==='ready'?null:Error('wallpaper-renderer-failed'));
        },{signal:controller.signal});
      } else node.addEventListener(event,()=>finish(),listen);
      node.addEventListener('error',()=>finish(Error('wallpaper-media-failed')),listen);
    });
  }
  async function showVideo(url, signal) {
    const node=doc.createElement('video');
    node.muted=true;node.loop=true;node.playsInline=true;node.preload='auto';
    attach(node);
    const first=awaitMedia(node,signal,'loadeddata');
    node.src=url;
    await first;
  }
  async function showImage(url, signal) {
    const node=doc.createElement('img');
    node.alt='';node.draggable=false;
    attach(node);
    const first=awaitMedia(node,signal,'load');
    node.src=url;
    await first;
  }
  async function fallback(signal) {
    if(wallpaper.video) {
      try {await showVideo(wallpaper.video,signal);kind='fallback-video';playback();return;}
      catch(error) {if(signal?.aborted)throw error;}
    }
    if(wallpaper.poster) {
      await showImage(wallpaper.poster,signal);kind='fallback-image';playback();return;
    }
    throw Error('wallpaper-no-usable-frame');
  }
  function releasePointer() {
    if (hasPointer) post({type:'live2d-wallpaper-pointer',x:-1,y:-1,buttons:0});
    hasPointer=false;
  }
  function pointer(event) {
    if (!committed||!shown||options.paused||!options.interactive||media?.tagName!=='IFRAME') return;
    const point={x:event.clientX,y:event.clientY};
    if (!scene.contains(point)||surface.wallpaperPointerBlocked?.(point,event.target)) {
      releasePointer();
      return;
    }
    if(event.type==='pointermove' && performance.now()-lastForward<30)return;
    const r=scene.rect();
    lastForward=performance.now();
    hasPointer=true;
    const scale=options.scale??1;
    const x=((point.x-r.x)/r.w-.5)/scale+.5, y=((point.y-r.y)/r.h-.5)/scale+.5;
    if (x<0||x>1||y<0||y>1) {releasePointer();return;}
    post({type:'live2d-wallpaper-pointer',x,y,buttons:event.buttons&1});
  }
  return {
    bounds,refresh,exitState:exit?.update,
    setComposition(next) {
      if (next?.id !== wallpaper?.id || !next?.composition) return false;
      if (next.composition.revision < composition.revision) return false;
      composition = next.composition;
      return scene.setPlacement(composition.placement);
    },
    previewPlacement(value) {
      guide.hidden = !value;
      if (!value) return;
      const preview = wallpaperPlacement(value);
      guide.style.setProperty('--wallpaper-guide-x',preview.x * 100 + '%');
      guide.style.setProperty('--wallpaper-guide-y',preview.groundY * 100 + '%');
    },
    async ready(signal) {
      if(!wallpaper?.id)throw Error('wallpaper-source-unavailable');
      position();
      stage.prepend(bg);
      if(wallpaper.kind==='image'||wallpaper.kind==='video') {
        try {
          await (wallpaper.kind==='image'?showImage:showVideo)(wallpaper.media,signal);
          kind=wallpaper.kind;
        } catch(error) {
          if(signal?.aborted)throw error;
          throw Error('wallpaper-first-frame-failed');
        }
        return;
      }
      const node=doc.createElement('iframe');
      node.setAttribute('sandbox','allow-scripts');
      node.title=t('壁纸画面','Wallpaper artwork');node.tabIndex=-1;
      attach(node);
      const first=awaitMedia(node,signal,'message',13500);
      node.src='/wallpaper-frame/'+wallpaper.id;
      try { await first; kind='live'; }
      catch(error) {
        if(signal?.aborted)throw error;
        try {await fallback(signal);}
        catch(failure) {if(signal?.aborted)throw failure;throw Error('wallpaper-first-frame-failed');}
      }
    },
    activate() {
      active=true;
      surface.watchWindows?.(false);
      refresh();playback();
      doc.addEventListener('visibilitychange',playback,{signal:events.signal});
      win.addEventListener('blur',releasePointer,{signal:events.signal});
      stage.addEventListener('pointerleave',releasePointer,{signal:events.signal});
      stage.addEventListener('pointercancel',releasePointer,{signal:events.signal});
      for(const type of ['pointermove','pointerdown','pointerup']) stage.addEventListener(type,pointer,{capture:true,signal:events.signal});
      win.addEventListener('message', event=>{
        if(disposed||media?.tagName!=='IFRAME'||event.source!==media.contentWindow||event.origin!=='null'||event.data?.type!=='live2d-wallpaper-state'||event.data.state!=='failed')return;
        kind='recovering';
        void fallback(events.signal).catch(()=>{ if(!disposed) {kind='failed';screen.replaceChildren();} });
      },{signal:events.signal});
    },
    configure(patch) {
      if(typeof patch.scale==='number') {modelScale=patch.scale;refresh();}
      if(patch.wallpaper && patch.wallpaper.id===wallpaper?.id) {options=patch.wallpaper.options;playback();}
    },
    setVisible(value) {shown=value;playback();},
    bodyCommitted() {committed=true;delete bg.dataset.wallpaperStaged;playback();refresh();},
    hit:point=>scene.contains(point),
    snapshot:()=>({implementation:'wallpaper-presentation',status:committed?'active':'staged',rect:scene.rect(),scale:modelScale,wallpaper:{id:wallpaper?.id,title:wallpaper?.title,kind,paused:!!options.paused,composition}}),
    dispose() {
      disposed=true;active=committed=false;events.abort();playback();
      if(figure?.presentationClipOwner===owner) {delete figure.presentationClipOwner;figure.style.clipPath='';}
      bg.remove();
    },
  };
}
