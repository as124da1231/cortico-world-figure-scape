import { createScene, httpSource } from 'webwallgl';

const parentOrigin = location.origin;
const id = location.pathname.split('/').at(-1)!;
const assetsOrigin = new URL(location.href);
assetsOrigin.hostname = assetsOrigin.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
const surface = document.querySelector<HTMLElement>('#wallpaper')!;
const send = (state: 'ready' | 'failed', reason?: string) => parent.postMessage({type:'live2d-wallpaper-state',state,reason}, parentOrigin);
let ready = false;
let settings = { fit:'cover' as 'cover' | 'contain', volume:0, paused:false };
let disposed = false;

function apply() {
  if (!ready) return;
  instance.setFit(settings.fit);
  instance.setVolume(settings.volume);
  if (settings.paused) instance.pause();
  else instance.resume();
}

addEventListener('message', ({source, origin, data}) => {
  if (source !== parent || origin !== parentOrigin || !data) return;
  if (data.type === 'live2d-wallpaper-options') {
    settings = {
      fit:data.fit === 'contain' ? 'contain' : 'cover',
      volume:Number.isFinite(data.volume) ? Math.min(1, Math.max(0, data.volume)) : 0,
      paused:data.paused === true,
    };
    apply();
  } else if (data.type === 'live2d-wallpaper-pointer' && Number.isFinite(data.x) && Number.isFinite(data.y)) {
    if (ready) instance.pushPointer(data.x, data.y, data.buttons === 1 ? 1 : data.buttons === 2 ? 2 : 0);
  }
});
// CacheStorage is optional in WebWallGL. Chromium throws when its getter is read by an opaque sandbox.
try { void globalThis.caches; } catch { Object.defineProperty(globalThis, 'caches', { value:undefined }); }

const instance = createScene(surface, {
  fps:30,
  renderDpr:1,
  bake:false,
  mountTimeoutMs:12000,
  onError: error => { if (ready && !disposed) send('failed', error.message.slice(0, 400)); },
});
addEventListener('pagehide', () => { disposed = true; instance.destroy(); }, {once:true});
const source = httpSource(assetsOrigin.origin + '/api/wallpaper-assets/' + id + '/', {credentials:'omit'});
void instance.load(source).then(() => {
  if (disposed) return;
  ready = true;
  apply();
  send('ready');
}, (error: Error) => {
  instance.destroy();
  if (!disposed) send('failed', error.message.slice(0, 400));
});
