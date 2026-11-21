import { sceneScale } from './model-size.js';
import { phoneBodyBounds } from './phone-layout.js';
import { createSceneExit, createSceneGrip } from './scene-grip.js';

const ASSETS = '/web/vendor/feiyu-house/';

/** Presents the imported room with its own artwork beneath the existing body. */
export function createRoomPresentation({ scene, body, surface }) {
  const { stage } = surface;
  if (!stage) throw Error('The window has no presentation surface');
  const doc = stage.ownerDocument;
  const figureLayer = stage.querySelector('.figure-layer');
  const owner = Symbol('presentation');
  const background = doc.createElement('div'), foreground = doc.createElement('div');
  const kind = scene.snapshot().implementation === 'room-space' ? 'room' : 'phone';
  background.className = 'pet-space pet-space-' + kind;
  foreground.className = 'pet-space-foreground';
  const image = (file, alt = '') => {
    const node = doc.createElement('img');
    node.src = ASSETS + file;
    node.alt = alt;
    node.draggable = false;
    return node;
  };
  const art = kind === 'room' ? image('interior.png', '小屋') : null;
  const exit = art && surface.exitScene ? createSceneExit(doc, surface.exitScene) : null;
  if (art) {
    art.className = 'pet-space-art';
    const english = doc.documentElement.lang.startsWith('en');
    const move = createSceneGrip(doc, 'move', english ? 'Move room' : '移动小屋',
      english ? 'Drag or use the arrow keys to move the room' : '拖动或按方向键移动小屋');
    const resize = createSceneGrip(doc, 'resize', english ? 'Resize room' : '缩放小屋',
      english ? 'Drag or use the arrow keys to resize the room' : '拖动或按方向键缩放小屋');
    background.append(art, move, resize);
    if (exit) background.append(exit.element);
  }
  const layers = (scene.foregrounds?.() ?? []).map(({ image: file }) => {
    const node = image(file);
    node.className = 'pet-space-furniture';
    node.hidden = true;
    foreground.append(node);
    return node;
  });
  let active = false, scale = 1, lastExtent;
  const restExtent = () => body.body?.layout?.restExtent;
  const position = (node, r) => Object.assign(node.style, {
    left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px',
  });
  const frameBounds = layout => phoneBodyBounds(scene.bounds(), scene.rect(), sceneScale('phone', scale), layout?.restExtent);
  const bounds = () => {
    if (kind === 'phone') return frameBounds(body.body?.layout);
    const area = scene.bounds();
    const rect = scene.rect();
    return { ...area, S: Math.max(.12, (area.S ?? Math.min(rect.w / 400, .6)) * scale) };
  };
  function tick() {
    if (!active) return;
    if (kind === 'phone') {
      const extent = restExtent()?.join(',');
      if (lastExtent !== extent) {
        lastExtent = extent;
        body.body?.set({ bounds: bounds() });
      }
      return;
    }
    const layout = body.body?.layout;
    for (const [index, { id, rect }] of (scene.foregrounds?.() ?? []).entries()) {
      layers[index].hidden = id === 'bed' ? layout?.mode !== 'sleep' || scene.targetAt(layout) !== 'bed'
        : !layout || layout.y >= rect.y + rect.h;
    }
  }
  function refresh() {
    const area = scene.rect();
    position(background, area);
    for (const [index, { rect }] of (scene.foregrounds?.() ?? []).entries()) position(layers[index], rect);
    if (!active) return;
    if (figureLayer) {
      const { W, H } = scene.bounds();
      figureLayer.presentationClipOwner = owner;
      figureLayer.style.clipPath = 'inset(' + area.y + 'px ' + (W - area.x - area.w) + 'px ' + (H - area.y - area.h) + 'px ' + area.x + 'px round ' + (kind === 'phone' ? '26px' : '12px') + ')';
    }
    lastExtent = kind === 'phone' ? restExtent()?.join(',') : undefined;
    body.body?.set({ bounds: bounds(), roam: 'off' });
    tick();
  }
  return {
    bounds, refresh, tick, exitState: exit?.update, ...(kind === 'phone' ? { frameBounds } : {}),
    activate() {
      stage.prepend(background);
      figureLayer?.after(foreground);
      surface.watchWindows?.(false);
      active = true;
      refresh();
    },
    async ready(signal) {
      if (art) await Promise.all([art, ...layers].map(node => node.decode()));
      signal?.throwIfAborted();
    },
    configure(patch) { if (typeof patch.scale === 'number') scale = patch.scale; if (active) refresh(); },
    bodyCommitted() { refresh(); },
    hit(point) { return scene.contains(point); },
    occludes(point) {
      return layers.some(node => {
        if (node.hidden) return false;
        const r = node.getBoundingClientRect();
        return point.x >= r.left && point.x < r.right && point.y >= r.top && point.y < r.bottom;
      });
    },
    snapshot: () => ({ implementation: kind + '-presentation', status: active ? 'active' : 'staged', rect: scene.rect(), scale,
      ...(art ? { layoutSource: 'feiyu-house@71f32f7', artworkReady: art.complete && art.naturalWidth > 0 } : {}) }),
    dispose() {
      active = false;
      if (figureLayer?.presentationClipOwner === owner) {
        delete figureLayer.presentationClipOwner;
        figureLayer.style.clipPath = '';
      }
      background.remove();
      foreground.remove();
    },
  };
}
