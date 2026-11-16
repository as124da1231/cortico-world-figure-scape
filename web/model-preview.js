import { loadBody, onBody } from './body-host.js';
import { touchArea, touchLocal, touchRegionAt, touchShapeFromDrag } from './framework/touch-geometry.js';
import { createTouchOverlay } from './framework/touch-overlay.js';
import { useLanguage, language, t } from './i18n.js';

await useLanguage();
const text = (cn, en) => language().startsWith('zh') ? cn : en;
const viewport = document.getElementById('viewport');
const camera = document.getElementById('camera');
const layer = document.getElementById('model');
const quality = document.getElementById('quality');
const status = document.getElementById('status');
const smaller = document.getElementById('smaller');
const larger = document.getElementById('larger');
const reset = document.getElementById('reset');
const parentOrigin = document.referrer ? new URL(document.referrer).origin : null;
document.getElementById('quality-label').textContent = text('预览画质 ', 'Preview quality ');
document.getElementById('unlimited').textContent = text('无上限', 'Unlimited');
viewport.setAttribute('aria-label', text('拖动平移，滚轮缩放', 'Drag to pan, scroll to zoom'));
smaller.setAttribute('aria-label', text('缩小', 'Zoom out'));
larger.setAttribute('aria-label', text('放大', 'Zoom in'));
reset.textContent = text('复位', 'Reset');

const query = new URLSearchParams(location.search);
const model = query.get('model');
const editing = query.get('edit') === '1';
const touchOverlay = editing ? createTouchOverlay(layer) : null;
let touchTool = null, touchProfile, touchPoints = [], touchStart = null, touchGesture = 'poke', touchEnd = null, touchReplacing = null, touchSelected = null, touchDraftShape;
let modelPaused = false;
const pauseLabel = document.createElement('span');
pauseLabel.className = 'preview-pause-state';
pauseLabel.textContent = text('模型已定住', 'Model frozen');
pauseLabel.setAttribute('role', 'status');
pauseLabel.hidden = true;
if (editing) viewport.append(pauseLabel);
const cover = query.get('cover') === '1';
const coverToken = cover ? new URLSearchParams(location.hash.slice(1)).get('capture') : null;
let coverSaved = false;
if (cover) document.body.classList.add('cover-capture');
const standalone = parent === window && !cover;
let previewTitle, previewNotice, previewMessage, previewRetry;
if (standalone) {
  document.body.classList.add('preview-page');
  const header = document.createElement('header');
  header.className = 'preview-heading';
  previewTitle = document.createElement('h1');
  previewTitle.textContent = text('模型预览', 'Model preview');
  header.append(previewTitle);
  document.body.prepend(header);
  previewNotice = document.createElement('div');
  previewNotice.className = 'preview-notice';
  previewNotice.hidden = true;
  previewMessage = document.createElement('p');
  previewMessage.setAttribute('role', 'status');
  previewRetry = document.createElement('button');
  previewRetry.type = 'button';
  previewRetry.textContent = text('重新加载', 'Reload');
  previewRetry.onclick = () => location.reload();
  previewNotice.append(previewMessage, previewRetry);
  viewport.append(previewNotice);
}
const theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
let controller, body, frame, drag, lease, x = 0, y = 0, zoom = 1;
const reply = data => { if (parentOrigin && parent !== window) parent.postMessage(data, parentOrigin); };
const commandEpoch = new Map();

function bounds() {
  const W = viewport.clientWidth, H = viewport.clientHeight;
  return { W, H, floorY: Math.round(H * .89), S: Math.max(.1, Math.min(W, H) * (standalone ? .87 : .77) / 256) };
}

function transform() {
  camera.style.transform = 'translate(' + x + 'px, ' + y + 'px) scale(' + zoom + ')';
}
function scaleBy(factor) {
  zoom = Math.min(4, Math.max(.35, zoom * factor));
  transform();
}
function note(value, state) {
  if (status.textContent !== value) { status.textContent = value; status.title = value; }
  if (status.dataset.state !== state) status.dataset.state = state;
  if (previewNotice) {
    previewNotice.hidden = state === 'ready';
    previewRetry.hidden = state !== 'error';
    if (state !== 'ready' && previewMessage.textContent !== value) previewMessage.textContent = value;
  }
}
function release() {
  controller?.abort();
  cancelAnimationFrame(frame);
  body?.dispose();
  body = undefined;
}

smaller.onclick = () => scaleBy(1 / 1.2);
larger.onclick = () => scaleBy(1.2);
reset.onclick = () => { x = y = 0; zoom = 1; transform(); };
viewport.addEventListener('wheel', event => {
  event.preventDefault();
  scaleBy(event.deltaY < 0 ? 1.12 : 1 / 1.12);
}, { passive: false });
function stagePoint(event) {
  const bounds = layer.getBoundingClientRect();
  return { x:(event.clientX-bounds.left)/zoom, y:(event.clientY-bounds.top)/zoom };
}
function normalized(event) {
  const p = touchLocal(body?.layout?.touchFrame, stagePoint(event));
  return p && { x:Math.max(0,Math.min(1,p.x)), y:Math.max(0,Math.min(1,p.y)) };
}
viewport.addEventListener('pointerdown', event => {
  if (event.button !== 0 || drag) return;
  if (touchTool && !event.altKey && body?.layout?.touchFrame) {
    viewport.setPointerCapture(event.pointerId);
    touchStart = { id:event.pointerId, point:normalized(event) };
    touchEnd = touchStart.point;
    return;
  }
  viewport.setPointerCapture(event.pointerId);
  drag = { id: event.pointerId, x: event.clientX - x, y: event.clientY - y };
});
viewport.addEventListener('pointermove', event => {
  if(touchStart?.id===event.pointerId) { touchEnd=normalized(event); return; }
  if (drag?.id !== event.pointerId) return;
  x = event.clientX - drag.x;
  y = event.clientY - drag.y;
  transform();
});
viewport.addEventListener('pointerup', event => {
  if(touchStart?.id!==event.pointerId) return;
  const p=stagePoint(event), layout=body.layout;
  const custom=touchArea(touchProfile,layout?.touchFrame,p);
  const valid = onBody(layout && { ...layout, touchAreas: [] }, p)
    || custom && p.x >= layout.box.x && p.x <= layout.box.x + layout.box.w && p.y >= layout.box.y && p.y <= layout.box.y + layout.box.h;
  const hit = touchTool === 'test' && (touchGesture === 'drop' || touchGesture === 'shake')
    ? 'all' : valid ? touchRegionAt(touchProfile, layout?.touchFrame, layout?.touchBounds, p) : undefined;
  reply({type:'live2d-editor:touch-point',point:{point:normalized(event),start:touchStart.point,area:hit}});
  touchStart=null;touchEnd=null;
});
viewport.addEventListener('lostpointercapture', () => { drag = undefined;touchStart=null;touchEnd=null; });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.isComposing && parentOrigin && parent !== window) {
    parent.postMessage({ type: 'live2d-preview:close' }, parentOrigin);
  }
});

if (editing) addEventListener('message', async event => {
  const message = event.data;
  if (event.source !== parent || event.origin !== parentOrigin || message?.type !== 'live2d-editor:preview') return;
  const figure = body;
  if (message.kind === 'touch-config' && figure) {
    if (touchTool !== message.tool) { touchStart = null; touchEnd = null; }
    touchProfile = message.profile;
    touchTool = message.tool;
    touchPoints = message.points ?? [];
    touchDraftShape = message.shape;
    touchGesture = message.gesture;
    touchReplacing = message.replacing;
    touchSelected = message.selected;
    modelPaused = message.paused === true;
    pauseLabel.hidden = !modelPaused;
    viewport.classList.toggle('is-drawing-touch', ['rectangle','ellipse','polygon'].includes(touchTool));
    reply({ type: 'live2d-editor:receipt', id: message.id });
    return;
  }
  const channel = ['touch-test','figure-word'].includes(message.kind) ? 'action' : message.kind;
  const sequence = (commandEpoch.get(channel) ?? 0) + 1;
  commandEpoch.set(channel, sequence);
  const isCurrent = () => sequence === commandEpoch.get(channel) && body === figure;
  const respond = data => {
    if (body === figure) reply({type:'live2d-editor:receipt',id:message.id,...data});
  };
  try {
    if (!figure) throw Error(text('模型预览尚未就绪。', 'The model preview is not ready.'));
    if (message.kind === 'touch-test') {
      let playback;
      if(message.rule?.reaction==='none') playback=text('无动作','No action');
      else if (message.word) {
        await figure.previewWord(message.word, message.id);
        playback = text('动作已试播', 'Action played');
      } else if(message.rule?.reaction==='action'&&!message.binding) throw Error(text('请先选择有效表现','Choose an available action'));
      else if(message.binding) {
        const command={kind:'play',owner:'editor',binding:message.binding,mode:message.binding.nativeOnly?'native':'full'};
        await figure.draftAction(command,message.id);
        playback=text('动作已试播','Action played');
      } else {
        figure.do(({poke:'surprised',pet:'love',shake:'shake',drop:'happy'})[message.gesture]??'happy');
        playback=text('通用反馈','Generic feedback');
      }
      respond(isCurrent()?{playback}:{cancelled:true});
      return;
    } else if (message.kind === 'figure-look') await figure.setScheme(message.scheme, { fade: false });
    else if (message.kind === 'figure-word') await figure.previewWord(message.word, message.id);
    else if (message.kind === 'action') await figure.draftAction(message.command, message.id);
    else if (message.kind === 'framing') figure.framing(message.command);
    else if (message.kind === 'visual') figure.previewVisual(message.value, message.id);
    else if (message.kind === 'wardrobe') figure.draftWardrobe(message.command);
    else if (message.kind === 'mouth') figure.speech(message.command, message.mapping ?? null);
    else if (message.kind === 'release-task') {
      if (message.task === 'bindings' || message.task === 'touch') figure.clearDraftAction();
      if (message.task === 'wardrobe') figure.draftWardrobe({kind:'restore', owner:'editor'});
      if (message.task === 'mouth' && figure.speechStatus?.supported?.release) figure.speech({kind:'release'},null);
    }
    else if (message.kind === 'restore') {
      if (figure.framingStatus?.supported?.restore) figure.framing({kind:'restore'});
      figure.previewVisual(null, null);
      figure.clearDraftAction();
      figure.draftWardrobe({kind:'restore', owner:'editor'});
      if (figure.speechStatus?.supported?.release) figure.speech({kind:'release'}, null);
    } else throw Error('Invalid preview command');
    if (['framing', 'wardrobe', 'mouth'].includes(message.kind)) {
      const report = () => message.kind === 'framing' ? figure.framingStatus
        : message.kind === 'wardrobe' ? figure.wardrobeDraftStatus : figure.speechStatus;
      let status;
      for (let attempt = 0; attempt < 30 && isCurrent(); attempt++) {
        status = report()?.status;
        if (['applied','released','dispatched','failed','unsupported','timeout','mismatch'].includes(status)) break;
        await new Promise(resolve => setTimeout(resolve, 70));
      }
      if (!isCurrent()) { respond({cancelled:true}); return; }
      if (!['applied', 'released', 'dispatched'].includes(status)) throw Error(report()?.error || status || 'Preview receipt timed out');
    }
    respond(isCurrent()?{}:{cancelled:true});
  } catch (error) {
    respond(isCurrent()?{error:String(error?.message ?? error)}:{cancelled:true});
  }
});
const retained = new Promise((resolve, reject) => {
  const params = new URLSearchParams({ role: 'model-preview', model: model ?? '' });
  lease = new WebSocket('ws://' + location.host + '/socket?' + params);
  lease.onmessage = () => resolve();
  lease.onclose = () => { reject(Error('Model preview is unavailable')); release(); note(text('预览连接已关闭。', 'Preview connection closed.'), 'error'); };
});

async function saveCover(png, failure) {
  if (!coverToken || coverSaved) return;
  coverSaved = true;
  cancelAnimationFrame(frame);
  try {
    const prefix = 'data:image/png;base64,';
    const bytes = typeof png === 'string' && png.startsWith(prefix)
      ? Uint8Array.from(atob(png.slice(prefix.length)), char => char.charCodeAt(0)) : null;
    await fetch('/api/model-cover/' + encodeURIComponent(model), {
      method:'POST',
      headers: { 'content-type':bytes ? 'image/png' : 'text/plain', 'x-live2d-cover':coverToken },
      body:bytes ?? String(failure ?? text('模型未能生成静态封面。','The model could not render a cover.')).slice(0,320),
      signal:controller.signal,
    });
  } catch { /* The queue handles connection failure and timeout. */ }
  finally { lease.close(); release(); }
}

async function load() {
  release();
  controller = new AbortController();
  const { signal } = controller;
  const size = cover ? 512 : quality.value === 'unlimited' ? 'unlimited' : Number(quality.value);
  note(text('正在准备预览…', 'Preparing preview…'), 'loading');
  try {
    await retained;
    signal.throwIfAborted();
    const response = await fetch('/api/bodies/' + encodeURIComponent(model ?? ''), { signal });
    if (!response.ok) throw Error(text('这个模型已不可用。', 'This model is unavailable.'));
    const pack = await response.json();
    if (!['live2d-model', 'figure-pack'].includes(pack.kind)) throw Error(text('这个角色暂不可用。', 'This character is unavailable.'));
    const packaged = pack.kind === 'figure-pack';
    quality.closest('label').hidden = packaged;
    if (previewTitle) {
      const name = text(pack.name?.zh, pack.name?.en) || pack.name?.zh || pack.name?.en;
      if (name) {
        previewTitle.textContent = name;
        document.title = [name, text('模型预览', 'Model preview'), t('pet.title')].join(' · ');
      }
    }
    const area = bounds();
    const next = await loadBody({
      layer, pack, start: { x: area.W / 2, y: area.floorY, facing: 1, scheme: pack.figureSettings?.scheme ?? '' }, theme,
      bounds: area, staged: true, signal, previewSize: size, editorPreview: editing,
      onCover: coverToken && !packaged ? png => void saveCover(png) : undefined,
      onError: error => {
        if (signal.aborted) return;
        note(error.message, 'error');
        if (cover) void saveCover(null,error.message);
      },
    });
    if (signal.aborted) { next.dispose(); return; }
    body = next;
    next.place(area.W / 2, 1, area.floorY);
    next.reveal();
    if (editing) reply({type:'live2d-editor:ready',behavior:next.modelBehavior,words:next.words});
    if (packaged) note(text('形象包已就绪', 'Figure is ready'), 'ready');
    else note(text('等待画质回执…', 'Waiting for render quality…'), 'loading');
    let previous = performance.now();
    let lastAction = '';
    function draw(now) {
      if (signal.aborted) return;
      if (!modelPaused) next.tick(Math.min(.05, Math.max(0, (now - previous) / 1000)), true);
      previous = now;
      const action = next.draftActionStatus;
      if (editing && action?.requestId && action.requestId+':'+action.status !== lastAction) {
        lastAction = action.requestId+':'+action.status;
        reply({type:'live2d-editor:action-state',id:action.requestId,status:action.status});
      }
      if(touchOverlay) {
        const candidate=[...(touchProfile?.areas??[])];
        if (touchTool === 'polygon' && touchPoints.length) {
          candidate.push({ draft:true, vertices:true, shape:{ kind:'polygon', points:touchPoints } });
        } else {
          const shape = touchShapeFromDrag(touchTool, touchStart?.point, touchEnd) ?? touchDraftShape;
          if (shape) candidate.push({ draft:true, shape });
        }
        touchOverlay.render(touchTool ? next.layout : null, !language().startsWith('zh'), null, candidate, touchReplacing, touchSelected);
      }
      const report = next.renderQuality;
      if (cover && report?.error) { void saveCover(null,report.error); return; }
      if (report) {
        const canvas = report.canvas.join(' × ');
        const texture = Math.max(0, ...report.textures.map(image => Math.max(image.width, image.height)));
        const hardware = report.limits?.texture;
        note(report.error || [text('实际画布 ', 'Canvas ') + canvas,
          texture && text('纹理 ', 'Texture ') + texture,
          hardware && text('设备上限 ', 'Device limit ') + hardware,
          ...report.warnings].filter(Boolean).join(' · '), report.error ? 'error' : 'ready');
      }
      frame = requestAnimationFrame(draw);
    }
    frame = requestAnimationFrame(draw);
  } catch (error) {
    if (!signal.aborted) {
      note(text('无法显示预览。', 'Could not display the preview.') + ' ' + String(error), 'error');
      if (cover) void saveCover(null,error);
    }
  }
}
const observer = new ResizeObserver(() => {
  if (!body) return;
  const area = bounds();
  body.set({ bounds: area });
  body.place(area.W / 2, 1, area.floorY);
});
observer.observe(viewport);
quality.onchange = () => void load();
addEventListener('pagehide', () => { observer.disconnect(); lease.close(); release(); }, { once: true });
void load();

