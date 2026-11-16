import { attachFocusedInput } from './focused-input.js';
/** Scene owns coordinates only. Body scale/physics and native window geometry are not scene transforms. */
export function createDesktopSpace({ viewport, floorInset }) {
  let disposed = false;
  return {
    bounds() {
      const { width, height } = viewport();
      return { W: width, H: height, floorY: height - floorInset(), freeGround: false, fitDesktopEdges: true };
    },
    contains(point) {
      const { width, height } = viewport();
      return point.x >= 0 && point.y >= 0 && point.x < width && point.y < height;
    },
    restore(x, y) {
      const { width, height } = viewport();
      return { x: x * width, y: typeof y === 'number' ? y * height : null };
    },
    async waitForViewport({ w, h }, { now, frame }) {
      const deadline = now() + 1000;
      let size = viewport();
      while ((Math.abs(size.width - w) > 1 || Math.abs(size.height - h) > 1) && now() < deadline) {
        await frame();
        size = viewport();
      }
    },
    target(to, cursor) { const { width } = viewport(); return to === 'cursor' ? (cursor?.x ?? width / 2) : Math.max(0, Math.min(1, Number(to))) * width; },
    normalize(point) { const { width, height } = viewport(); return { x: point.x / width, ...(typeof point.y === 'number' ? { y: point.y / height } : {}) }; },
    snapshot: () => ({ implementation: 'desktop-space', status: disposed ? 'disposed' : 'mounted', viewport: { ...viewport() } }),
    dispose() { disposed = true; },
  };
}
/** One existing surface is injected. This adapter does not create or replace a window. */
export function createDesktopPresentation({ scene, body, surface }) {
  let disposed = false, scale = 1;
  const bounds = () => ({ ...scene.bounds(), S: .42 * scale });
  const refresh = () => body.body?.set({ bounds: bounds() });
  return {
    bounds,
    refresh,
    configure(patch) { if (typeof patch.scale === 'number') { scale = patch.scale; refresh(); } },
    bodyCommitted() { surface.watchWindows?.(body.body?.needsWindows ?? false); },
    snapshot: () => ({ implementation: 'desktop-presentation', status: disposed ? 'disposed' : 'active', surface: surface.kind, scale }),
    dispose() { disposed = true; surface.watchWindows?.(false); },
  };
}
export function createBodyInput({ body, events }) {
  let disposed = false, keys = new Set(), primary = false, secondary = false, reason = 'initial';
  let lastPreview = null, previewTimer = null;
  const supported = () => body.body?.inputStatus?.supported?.held === true;
  const send = () => { if (supported()) body.body.input({keys:[...keys],primary,secondary}); };
  const api = {
    pointer(kind, point) { if (!disposed) body.body?.pointer(kind, point); },
    hit(point) { return !disposed && !!body.body?.hit(point); },
    key(code, down) {
      if (disposed || !supported() || typeof code !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(code)) return;
      if (down ? keys.has(code) || keys.size >= 32 : !keys.has(code)) return;
      clearTimeout(previewTimer); previewTimer = null;
      if (down) keys.add(code); else keys.delete(code); reason = 'focused-keyboard'; send();
    },
    clear(why='clear') {
      clearTimeout(previewTimer); previewTimer = null;
      keys.clear(); primary = secondary = false; reason = why;
      if (!disposed) { body.body?.pointer?.('cancel', {}); if (supported()) body.body.input(null); }
    },
    preview(snapshot, requestId) {
      if (disposed) return;
      api.clear('preview');
      if (supported()) body.body.input(snapshot);
      lastPreview = {requestId};
      if (snapshot) previewTimer = setTimeout(() => api.clear('preview-ended'), 500);
    },
    bodyCommitted() { api.clear('body-replaced'); },
    snapshot: () => ({ implementation:'body-pointer',status:disposed?'disposed':'mounted',
      scope:'focused-window-excluding-text-entry',globalKeyboard:false,sourceAttached:!!events,
      held:{keyCount:keys.size,primary,secondary},reason,lastPreview:lastPreview&&{...lastPreview},body:body.body?.inputStatus??null }),
    dispose() { if(disposed)return;detach?.();api.clear('disposed');disposed=true; },
  };
  const detach=events?attachFocusedInput(events,api):null;
  return api;
}
